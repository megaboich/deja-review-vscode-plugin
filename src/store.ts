import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ReviewArchives } from './archive';
import type { Repository } from './git';
import { copyAndClear } from './handoff';
import type { HandoffResult } from './handoff';
import type { ParseResult } from './model';
import { parse } from './parser';
import { assertUtf8Text } from './writer';

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

export class ReviewStore implements vscode.Disposable {
  readonly uri: vscode.Uri;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this.changes.event;
  private readonly busyChanges = new vscode.EventEmitter<void>();
  readonly onDidChangeBusy: vscode.Event<void> = this.busyChanges.event;
  private readonly subscriptions: vscode.Disposable[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private disposed = false;

  constructor(repo: Repository, public readonly archives: ReviewArchives) {
    this.uri = vscode.Uri.joinPath(repo.rootUri, 'REVIEW-NOTES.md');
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repo.rootUri, 'REVIEW-NOTES.md'));
    this.subscriptions = [
      watcher,
      watcher.onDidCreate(() => this.scheduleChange()),
      watcher.onDidChange(() => this.scheduleChange()),
      watcher.onDidDelete(() => this.scheduleChange()),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document.uri.toString() === this.uri.toString()) {
          this.scheduleChange();
        }
      }),
    ];
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Review store has been disposed.');
    }
  }

  private dirtyDocuments(): vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter(document => !document.isClosed && document.isDirty
      && document.uri.toString() === this.uri.toString());
  }

  /** Reject links (including File | SymbolicLink) before every filesystem operation. */
  private async stat(): Promise<boolean> {
    this.assertActive();
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(this.uri);
    } catch (error) {
      this.assertActive();
      if (isFileNotFound(error)) {
        return false;
      }
      throw error;
    }
    this.assertActive();
    if (stat.type & vscode.FileType.SymbolicLink) {
      throw new Error('Refusing to access REVIEW-NOTES.md because it is a symbolic link.');
    }
    if (!(stat.type & vscode.FileType.File)) {
      throw new Error('REVIEW-NOTES.md is not a regular file.');
    }
    return true;
  }

  async read(): Promise<string | undefined> {
    if (!await this.stat()) {
      return undefined;
    }

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(this.uri);
    } catch (error) {
      this.assertActive();
      if (isFileNotFound(error)) {
        return undefined;
      }
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
        'REVIEW-NOTES.md has unsaved changes. Save it before continuing.',
        { modal: true }, 'Save and retry', 'Cancel');
      this.assertActive();
      if (choice !== 'Save and retry') {
        return false;
      }
      for (const document of this.dirtyDocuments()) {
        await this.stat();
        if (!document.isClosed && document.isDirty && !await document.save()) {
          return false;
        }
        this.assertActive();
      }
    }
    return true;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    this.pending++;
    this.busyChanges.fire();
    const result = this.queue.then(() => {
      this.assertActive();
      return operation();
    }).finally(() => {
      this.pending--;
      if (!this.disposed) {
        this.busyChanges.fire();
      }
    });
    // A failed operation must not poison subsequent queued operations.
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * The callback receives current disk text; only an explicit append should create missing content.
   * Async validation runs after temporary writing; validateInput is synchronous and runs just before rename.
   */
  async mutate(
    change: (text: string) => string,
    validate?: () => Promise<void>,
    validateInput?: () => void,
  ): Promise<boolean> {
    return this.serialize(async () => {
      while (await this.ensureSaved()) {
        const snapshot = await this.read();
        if (this.dirtyDocuments().length) {
          continue;
        }

        const next = change(snapshot ?? '');
        if (next === (snapshot ?? '')) {
          return false;
        }

        const published = await this.publish(next, snapshot !== undefined, async () => {
          await validate?.();

          const current = await this.read();
          if (this.dirtyDocuments().length) {
            return false;
          }
          if (current !== snapshot) {
            throw new Error('REVIEW-NOTES.md changed on disk; retry the operation.');
          }

          const exists = await this.stat();
          if (this.dirtyDocuments().length) {
            return false;
          }
          if (exists !== (snapshot !== undefined)) {
            throw new Error('REVIEW-NOTES.md was created or deleted on disk; retry the operation.');
          }
          return true;
        }, validateInput);
        if (published) {
          return true;
        }
      }
      return false;
    });
  }

  private async publish(
    text: string,
    overwrite: boolean,
    validate: () => Promise<boolean>,
    validateInput?: () => void,
  ): Promise<boolean> {
    assertUtf8Text(text);
    const temporary = vscode.Uri.joinPath(this.uri, '..', `.REVIEW-NOTES.md.${randomUUID()}.tmp`);
    let published = false;
    try {
      this.assertActive();
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(text));

      if (!await validate()) {
        return false;
      }
      // These synchronous checks also cover changes while the async validator was returning.
      if (this.dirtyDocuments().length) {
        return false;
      }
      this.assertActive();
      validateInput?.();

      // Rename prevents partial writes to live feedback, but is not compare-and-swap against external writers.
      await vscode.workspace.fs.rename(temporary, this.uri, { overwrite });
      published = true;
      this.fireChange();
      return true;
    } finally {
      if (!published) {
        try {
          await vscode.workspace.fs.delete(temporary, { recursive: false, useTrash: false });
        } catch (error) {
          if (!isFileNotFound(error)) {
            console.warn('Could not remove temporary review notes:', error);
          }
        }
      }
    }
  }

  async restore(id: string, validateInput?: () => void): Promise<boolean> {
    return this.serialize(async () => {
      const assertClean = (): void => {
        this.assertActive();
        validateInput?.();
        if (this.dirtyDocuments().length) {
          throw new Error('REVIEW-NOTES.md has unsaved changes; save or discard them before recovering an archive.');
        }
      };

      assertClean();
      const snapshot = await this.read();
      assertClean();
      if (snapshot?.trim()) {
        return false;
      }

      const text = await this.archives.read(id);
      assertClean();

      return this.publish(text, snapshot !== undefined, async () => {
        const current = await this.read();
        assertClean();
        if (current !== snapshot || current?.trim()) {
          return false;
        }

        const exists = await this.stat();
        assertClean();
        return exists === (snapshot !== undefined);
      }, assertClean);
    });
  }

  async handoff(validateInput?: () => void): Promise<(HandoffResult | { status: 'cancelled' }) & { clipboardCopied?: boolean }> {
    return this.serialize(async () => {
      validateInput?.();
      if (!await this.ensureSaved()) {
        return { status: 'cancelled', clipboardCopied: false };
      }
      validateInput?.();

      let clipboardCopied = false;
      const dirtyBeforeDelete = new Error('REVIEW-NOTES.md has unsaved changes; retry the handoff.');
      const changedBeforeDelete = new Error('REVIEW-NOTES.md changed on disk; retry the handoff.');
      const result = await copyAndClear({
        read: async () => {
          const text = await this.read();
          validateInput?.();
          return text;
        },
        isDirty: () => this.dirtyDocuments().length > 0,
        copy: async text => {
          this.assertActive();
          validateInput?.();
          await vscode.env.clipboard.writeText(text);
          clipboardCopied = true;
        },
        archive: async snapshot => {
          this.assertActive();
          validateInput?.();
          await this.archives.save(snapshot);
          this.fireChange();
        },
        remove: async snapshot => {
          const current = await this.read();
          validateInput?.();
          if (this.dirtyDocuments().length) {
            throw dirtyBeforeDelete;
          }
          if (current === undefined) {
            return;
          }
          if (current !== snapshot) {
            throw changedBeforeDelete;
          }

          const exists = await this.stat();
          validateInput?.();
          if (this.dirtyDocuments().length) {
            throw dirtyBeforeDelete;
          }
          if (!exists) {
            return;
          }

          // As with writes, stat/snapshot checks cannot make deletion transactional.
          try {
            await vscode.workspace.fs.delete(this.uri, { recursive: false, useTrash: false });
          } catch (error) {
            if (!isFileNotFound(error)) {
              throw error;
            }
          }
        },
      });
      if (result.status === 'copied') {
        this.fireChange();
      }
      if (result.status === 'deleteFailed' && result.error === dirtyBeforeDelete) {
        return { status: 'dirty', clipboardCopied };
      }
      if (result.status === 'deleteFailed' && result.error === changedBeforeDelete) {
        return { status: 'changed', clipboardCopied };
      }
      return { ...result, clipboardCopied };
    });
  }

  private scheduleChange(): void {
    if (this.disposed) {
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.fireChange(), 300);
  }

  private fireChange(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.disposed) {
      this.changes.fire();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.changes.dispose();
    this.busyChanges.dispose();
  }
}
