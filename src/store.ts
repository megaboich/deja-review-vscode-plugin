import * as vscode from 'vscode';
import { Repository } from './git';
import { copyAndClear, HandoffResult } from './handoff';
import { ParseResult } from './model';
import { parse } from './parser';

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

export class ReviewStore implements vscode.Disposable {
  readonly uri: vscode.Uri;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this.changes.event;
  private readonly subscriptions: vscode.Disposable[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private disposed = false;

  constructor(repo: Repository) {
    this.uri = vscode.Uri.joinPath(repo.rootUri, 'COMMENTS.md');
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repo.rootUri, 'COMMENTS.md'));
    this.subscriptions = [watcher,
      watcher.onDidCreate(() => this.scheduleChange()),
      watcher.onDidChange(() => this.scheduleChange()),
      watcher.onDidDelete(() => this.scheduleChange()),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document.uri.toString() === this.uri.toString()) { this.scheduleChange(); }
      }),
    ];
  }

  get busy(): boolean { return this.pending > 0; }

  private assertActive(): void {
    if (this.disposed) { throw new Error('Review store has been disposed.'); }
  }

  private dirtyDocuments(): vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter(document => !document.isClosed && document.isDirty
      && document.uri.toString() === this.uri.toString());
  }

  /** Reject links (including File | SymbolicLink) before every filesystem operation. */
  private async stat(): Promise<boolean> {
    this.assertActive();
    let stat: vscode.FileStat;
    try { stat = await vscode.workspace.fs.stat(this.uri); }
    catch (error) {
      this.assertActive();
      if (isFileNotFound(error)) { return false; }
      throw error;
    }
    this.assertActive();
    if (stat.type & vscode.FileType.SymbolicLink) {
      throw new Error('Refusing to access COMMENTS.md because it is a symbolic link.');
    }
    if (!(stat.type & vscode.FileType.File)) {
      throw new Error('COMMENTS.md is not a regular file.');
    }
    return true;
  }

  async read(): Promise<string | undefined> {
    if (!await this.stat()) { return undefined; }
    let bytes: Uint8Array;
    try { bytes = await vscode.workspace.fs.readFile(this.uri); }
    catch (error) {
      this.assertActive();
      if (isFileNotFound(error)) { return undefined; }
      throw error;
    }
    this.assertActive();
    // Preserve a BOM as content so a read/write round trip remains lossless.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  }

  async load(): Promise<{ text: string | undefined; parsed: ParseResult }> {
    const text = await this.read();
    return { text, parsed: parse(text ?? '') };
  }

  async ensureSaved(): Promise<boolean> {
    this.assertActive();
    while (this.dirtyDocuments().length) {
      const choice = await vscode.window.showWarningMessage(
        'COMMENTS.md has unsaved changes. Save it before continuing.',
        { modal: true }, 'Save and retry', 'Cancel');
      this.assertActive();
      if (choice !== 'Save and retry') { return false; }
      for (const document of this.dirtyDocuments()) {
        await this.stat();
        if (!document.isClosed && document.isDirty && !await document.save()) { return false; }
        this.assertActive();
      }
    }
    return true;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    this.pending++;
    const result = this.queue.then(() => {
      this.assertActive();
      return operation();
    }).finally(() => { this.pending--; });
    // A failed operation must not poison subsequent queued operations.
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  /** The callback receives current disk text; only an explicit append should create missing content. */
  async mutate(change: (text: string) => string): Promise<boolean> {
    return this.serialize(async () => {
      while (await this.ensureSaved()) {
        const snapshot = await this.read();
        if (this.dirtyDocuments().length) { continue; }
        const next = change(snapshot ?? '');
        if (next === (snapshot ?? '')) { return false; }
        const current = await this.read();
        if (this.dirtyDocuments().length) { continue; }
        if (current !== snapshot) {
          throw new Error('COMMENTS.md changed on disk; retry the operation.');
        }
        const exists = await this.stat();
        if (this.dirtyDocuments().length) { continue; }
        if (exists !== (snapshot !== undefined)) {
          throw new Error('COMMENTS.md was created or deleted on disk; retry the operation.');
        }
        // workspace.fs has no atomic compare-and-write; external filesystem races remain possible.
        await vscode.workspace.fs.writeFile(this.uri, new TextEncoder().encode(next));
        this.fireChange();
        return true;
      }
      return false;
    });
  }

  async handoff(): Promise<(HandoffResult | { status: 'cancelled' }) & { clipboardCopied?: boolean }> {
    return this.serialize(async () => {
      if (!await this.ensureSaved()) { return { status: 'cancelled', clipboardCopied: false }; }
      let clipboardCopied = false;
      const dirtyBeforeDelete = new Error('COMMENTS.md has unsaved changes; retry the handoff.');
      const result = await copyAndClear({
        read: () => this.read(),
        isDirty: () => this.dirtyDocuments().length > 0,
        copy: async text => {
          this.assertActive();
          await vscode.env.clipboard.writeText(text);
          clipboardCopied = true;
        },
        remove: async () => {
          const exists = await this.stat();
          if (this.dirtyDocuments().length) { throw dirtyBeforeDelete; }
          if (!exists) { return; }
          // As with writes, stat/snapshot checks cannot make deletion transactional.
          try { await vscode.workspace.fs.delete(this.uri, { recursive: false, useTrash: false }); }
          catch (error) { if (!isFileNotFound(error)) { throw error; } }
        },
      });
      if (result.status === 'copied') { this.fireChange(); }
      if (result.status === 'deleteFailed' && result.error === dirtyBeforeDelete) {
        return { status: 'dirty', clipboardCopied };
      }
      return { ...result, clipboardCopied };
    });
  }

  private scheduleChange(): void {
    if (this.disposed) { return; }
    if (this.timer !== undefined) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => this.fireChange(), 300);
  }

  private fireChange(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.disposed) { this.changes.fire(); }
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    this.changes.dispose();
  }
}
