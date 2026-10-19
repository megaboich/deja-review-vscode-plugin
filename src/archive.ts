import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ReviewStorage, recordsFromText, renderNotes, validateNotes, type NotesDocument, type StoredNote } from './reviewStorage';

export interface ReviewArchive {
  id: string;
  createdAt: string;
  commentCount: number;
}

interface LastCopy extends NotesDocument, ReviewArchive {}

/** One recovery snapshot per local checkout, replaced only after the next copy succeeds. */
export class ReviewArchives {
  readonly storage: ReviewStorage;
  readonly prefix: string;

  constructor(storageUri: vscode.Uri, checkoutUri: vscode.Uri, folderUri = checkoutUri) {
    this.storage = new ReviewStorage(storageUri.fsPath, checkoutUri.fsPath);
    const relative = path.relative(checkoutUri.fsPath, folderUri.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('The review folder is outside its checkout.');
    }
    this.prefix = relative ? relative.split(path.sep).join('/') + '/' : '';
  }

  private async snapshot(): Promise<LastCopy | undefined> {
    const value = await this.storage.read('last-copy.json');
    if (value === undefined) { return undefined; }
    const document = validateNotes(value, this.storage.checkoutPath);
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string'
      || !/^[0-9a-f-]{36}$/.test(value.id) || !('createdAt' in value) || typeof value.createdAt !== 'string'
      || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
      || !('commentCount' in value) || value.commentCount !== document.notes.length || !document.notes.length) {
      throw new Error('Invalid last copied Review Notes metadata.');
    }
    return { ...document, id: value.id, createdAt: value.createdAt, commentCount: document.notes.length };
  }

  async list(): Promise<ReviewArchive[]> {
    const snapshot = await this.snapshot();
    return snapshot ? [{ id: snapshot.id, createdAt: snapshot.createdAt, commentCount: snapshot.commentCount }] : [];
  }

  /** Caller holds the checkout write lock, covering recovery publication and clearing. */
  async saveRecords(notes: StoredNote[]): Promise<ReviewArchive> {
    if (!notes.length) { throw new Error('Cannot save an empty recovery snapshot.'); }
    const snapshot: LastCopy = {
      version: 1, checkoutPath: this.storage.checkoutPath, notes,
      id: randomUUID(), createdAt: new Date().toISOString(), commentCount: notes.length,
    };
    await this.storage.write('last-copy.json', snapshot);
    return { id: snapshot.id, createdAt: snapshot.createdAt, commentCount: snapshot.commentCount };
  }

  async save(text: string): Promise<ReviewArchive> {
    return this.storage.locked(() => this.saveRecords(recordsFromText(text, this.prefix)));
  }

  async records(id: string): Promise<StoredNote[]> {
    const snapshot = await this.snapshot();
    if (!snapshot || snapshot.id !== id) { throw new Error('The last copied Review Notes changed. Refresh and retry.'); }
    return snapshot.notes;
  }

  async read(id: string): Promise<string> {
    return renderNotes(await this.records(id), this.prefix);
  }
}
