import type { FSWatcher } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewArchives } from './archive';
import type { Repository } from './git';
import { HANDOFF_INSTRUCTION, type HandoffResult } from './handoff';
import type { ParseResult } from './model';
import { parse } from './parser';
import { renderNotes, recordsFromText, visibleNotes } from './reviewStorage';

/** Central JSON persistence; Markdown remains an internal projection for the existing UI. */
export class ReviewStore implements vscode.Disposable {
  readonly uri: vscode.Uri;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly busyChanges = new vscode.EventEmitter<void>();
  readonly onDidChangeBusy = this.busyChanges.event;
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private disposed = false;
  private readonly ready: Promise<void>;

  constructor(_repo: Repository, public readonly archives: ReviewArchives) {
    this.uri = vscode.Uri.file(path.join(archives.storage.directory, 'notes.json'));
    this.ready = archives.storage.watch(() => this.scheduleChange()).then(watcher => {
      if (this.disposed) { watcher.close(); } else { this.watcher = watcher; }
    });
    // Initialization failures are rethrown by reads/writes, not unhandled in the constructor.
    void this.ready.catch(() => {});
  }

  get busy(): boolean { return this.pending > 0; }

  private assertActive(): void {
    if (this.disposed) { throw new Error('Review store has been disposed.'); }
  }

  private assertClean(): void {
    this.assertActive();
    if (vscode.workspace.textDocuments.some(document => !document.isClosed && document.isDirty
      && document.uri.toString() === this.uri.toString())) {
      throw new Error('The internal Review Notes storage file has unsaved changes. Close or discard that buffer before continuing. Edit Review Notes in the gutter or panel.');
    }
  }

  async read(): Promise<string | undefined> {
    await this.ready;
    this.assertActive();
    const document = await this.archives.storage.notes();
    this.assertActive();
    const text = renderNotes(document.notes, this.archives.prefix);
    return text || undefined;
  }

  async load(): Promise<{ text: string | undefined; parsed: ParseResult }> {
    const text = await this.read();
    return { text, parsed: parse(text ?? '') };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    this.pending++;
    this.busyChanges.fire();
    const result = this.queue.then(async () => {
      await this.ready;
      this.assertClean();
      return this.archives.storage.locked(operation);
    }).finally(() => {
      this.pending--;
      if (!this.disposed) { this.busyChanges.fire(); }
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  async mutate(change: (text: string) => string, validate?: () => Promise<void>, validateInput?: () => void): Promise<boolean> {
    return this.serialize(async () => {
      const document = await this.archives.storage.notes();
      const text = renderNotes(document.notes, this.archives.prefix);
      const next = change(text);
      if (next === text) { return false; }
      const local = recordsFromText(next, this.archives.prefix, document.notes);
      const visible = new Set(visibleNotes(document.notes, this.archives.prefix).map(note => note.id));
      await validate?.();
      this.assertClean();
      validateInput?.();
      // Cross-window writers hold the same lock. A direct edit is unsupported, but refuse
      // a detected external change rather than overwrite it.
      if (JSON.stringify(await this.archives.storage.notes()) !== JSON.stringify(document)) {
        throw new Error('Review Notes changed on disk; retry the operation.');
      }
      this.assertClean();
      validateInput?.();
      await this.archives.storage.write('notes.json', { ...document,
        notes: [...document.notes.filter(note => !visible.has(note.id)), ...local] });
      this.fireChange();
      return true;
    });
  }

  async restore(id: string, validateInput?: () => void): Promise<boolean> {
    return this.serialize(async () => {
      validateInput?.();
      const document = await this.archives.storage.notes();
      // Recovery is checkout-wide: never overwrite notes from another subfolder window.
      if (document.notes.length) { return false; }
      const notes = await this.archives.records(id);
      this.assertClean();
      validateInput?.();
      if (JSON.stringify(await this.archives.storage.notes()) !== JSON.stringify(document)) {
        throw new Error('Review Notes changed on disk; retry recovery.');
      }
      this.assertClean();
      validateInput?.();
      await this.archives.storage.write('notes.json', { ...document, notes });
      this.fireChange();
      return true;
    });
  }

  async handoff(validateInput?: () => void): Promise<(HandoffResult | { status: 'cancelled' }) & { clipboardCopied?: boolean; archived?: boolean }> {
    return this.serialize(async () => {
      validateInput?.();
      const document = await this.archives.storage.notes();
      const notes = visibleNotes(document.notes, this.archives.prefix);
      if (!notes.length) { return { status: 'empty', clipboardCopied: false, archived: false }; }
      this.assertClean();
      validateInput?.();
      // Handoff paths are checkout-relative even from a subfolder window.
      const text = renderNotes(notes);
      try {
        await vscode.env.clipboard.writeText(`${HANDOFF_INSTRUCTION}\n\n${text}`);
      } catch (error) { return { status: 'copyFailed', error, clipboardCopied: false, archived: false }; }
      try {
        this.assertClean();
        validateInput?.();
        await this.archives.saveRecords(notes);
      } catch (error) { return { status: 'archiveFailed', error, clipboardCopied: true, archived: false }; }
      try {
        this.assertClean();
        validateInput?.();
        if (JSON.stringify(await this.archives.storage.notes()) !== JSON.stringify(document)) {
          throw new Error('Review Notes changed on disk; retry the handoff.');
        }
        this.assertClean();
        validateInput?.();
        const copied = new Set(notes.map(note => note.id));
        await this.archives.storage.write('notes.json', { ...document, notes: document.notes.filter(note => !copied.has(note.id)) });
        this.fireChange();
        return { status: 'copied', count: notes.length, clipboardCopied: true, archived: true };
      } catch (error) { return { status: 'deleteFailed', error, clipboardCopied: true, archived: true }; }
    });
  }

  private scheduleChange(): void {
    if (this.disposed) { return; }
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => this.fireChange(), 100);
  }

  private fireChange(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.disposed) { this.changes.fire(); }
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    if (this.timer) { clearTimeout(this.timer); }
    this.changes.dispose();
    this.busyChanges.dispose();
  }
}
