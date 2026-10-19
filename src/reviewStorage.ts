import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeComment, normalizeResource, parsedNotes, isGeneralNote, type ReviewComment, type GeneralReviewNote } from './model';
import { parse } from './parser';
import { appendComment, appendGeneralNote, assertUtf8Text } from './writer';

export type StoredNote = { id: string; note: ReviewComment | GeneralReviewNote };
export interface NotesDocument {
  version: 1;
  checkoutPath: string;
  notes: StoredNote[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Review Notes storage record.');
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('Unexpected Review Notes storage field.');
  }
}

function resource(value: unknown): { path: string; origin: ReviewComment['origin'] } {
  const fields = object(value);
  keys(fields, ['path', 'origin']);
  if (typeof fields.path !== 'string' || typeof fields.origin !== 'string') {
    throw new Error('Invalid Review Note resource.');
  }
  // normalizeResource performs runtime origin narrowing and path validation.
  return normalizeResource({ path: fields.path, origin: fields.origin });
}

export function validateNotes(value: unknown, checkoutPath: string): NotesDocument {
  const fields = object(value);
  keys(fields, ['version', 'checkoutPath', 'notes', 'id', 'createdAt', 'commentCount']);
  if (fields.version !== 1 || fields.checkoutPath !== checkoutPath || !Array.isArray(fields.notes)) {
    throw new Error('Invalid Review Notes storage metadata.');
  }
  const ids = new Set<string>();
  const notes = fields.notes.map((entry: unknown): StoredNote => {
    const record = object(entry);
    keys(record, ['id', 'note']);
    if (typeof record.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.id) || ids.has(record.id)) {
      throw new Error('Invalid or duplicate Review Note ID.');
    }
    ids.add(record.id);
    const note = object(record.note);
    if (typeof note.body !== 'string') { throw new Error('Invalid Review Note body.'); }
    assertUtf8Text(note.body);
    if (note.kind === 'general') {
      keys(note, ['kind', 'body']);
      return { id: record.id, note: { kind: 'general', body: note.body } };
    }
    keys(note, ['path', 'origin', 'startLine', 'endLine', 'side', 'comparison', 'anchorText', 'elided', 'wholeFile', 'body']);
    if (typeof note.startLine !== 'number' || typeof note.endLine !== 'number'
      || (note.side !== 'document' && note.side !== 'left' && note.side !== 'right')
      || (note.anchorText !== undefined && typeof note.anchorText !== 'string')
      || (note.wholeFile !== undefined && typeof note.wholeFile !== 'boolean')
      || (note.elided !== undefined && typeof note.elided !== 'boolean')) {
      throw new Error('Invalid Review Note location.');
    }
    const comparison = note.comparison === undefined ? undefined : object(note.comparison);
    if (comparison) { keys(comparison, ['left', 'right']); }
    if (typeof note.anchorText === 'string') { assertUtf8Text(note.anchorText); }
    return { id: record.id, note: normalizeComment({
      ...resource({ path: note.path, origin: note.origin }), body: note.body,
      startLine: note.startLine, endLine: note.endLine, side: note.side,
      anchorText: note.anchorText, wholeFile: note.wholeFile, elided: note.elided,
      comparison: comparison ? { left: resource(comparison.left), right: resource(comparison.right) } : undefined,
    }) };
  });
  return { version: 1, checkoutPath, notes };
}

function general(note: ReviewComment | GeneralReviewNote): note is GeneralReviewNote {
  return 'kind' in note;
}

export function visibleNotes(notes: StoredNote[], prefix: string): StoredNote[] {
  return notes.filter(({ note }) => general(note) || !prefix || note.path.startsWith(prefix));
}

function translate(note: ReviewComment, transform: (value: string) => string): ReviewComment {
  return { ...note, path: transform(note.path), comparison: note.comparison ? {
    left: { ...note.comparison.left, path: transform(note.comparison.left.path) },
    right: { ...note.comparison.right, path: transform(note.comparison.right.path) },
  } : undefined };
}

/** Markdown is an internal UI/clipboard projection, never the persisted database. */
export function renderNotes(notes: StoredNote[], prefix = ''): string {
  let text = '';
  for (const { note } of visibleNotes(notes, prefix)) {
    if (general(note)) { text = appendGeneralNote(text, note.body); continue; }
    const projected = translate(note, value => value.startsWith(prefix) ? value.slice(prefix.length) : value);
    // A subfolder adapter cannot safely open an endpoint outside its scope. Display
    // the selected revision alone there; the checkout record and handoff keep the full pair.
    const crossFolder = prefix && note.comparison
      && [note.comparison.left.path, note.comparison.right.path].some(value => !value.startsWith(prefix));
    text = appendComment(text, crossFolder ? { ...projected, side: 'document', comparison: undefined } : projected);
  }
  return text;
}

export function recordsFromText(text: string, prefix = '', previous: StoredNote[] = []): StoredNote[] {
  const result = parse(text);
  if (result.diagnostics.length) { throw new Error('Cannot save malformed Review Notes.'); }
  const parsed = parsedNotes(result);
  // Only extension-produced projections are accepted; arbitrary opaque Markdown is not storage.
  const previousView = visibleNotes(previous, prefix);
  const previousBlocks = previousView.map(record => ({ record, text: renderNotes([record], prefix) }));
  const used = new Set<string>();
  return parsed.map((note, index) => {
    const block = isGeneralNote(note) ? appendGeneralNote('', note.body) : appendComment('', note);
    const match = previousBlocks.find(({ record, text }) => !used.has(record.id) && text === block)?.record;
    const positional = parsed.length === previousView.length ? previousView[index] : undefined;
    const original = match ?? (positional && !used.has(positional.id) ? positional : undefined);
    // A root-captured comparison can have its opposite endpoint outside this subfolder.
    // Preserve that endpoint rather than prefixing it a second time during a body edit.
    const originalNote = original && !general(original.note) ? original.note : undefined;
    const hiddenComparison = prefix && originalNote?.comparison
      && [originalNote.comparison.left.path, originalNote.comparison.right.path].some(value => !value.startsWith(prefix))
      ? originalNote.comparison : undefined;
    const toCheckout = (value: string, old?: string): string => old !== undefined
      && (old.startsWith(prefix) ? old.slice(prefix.length) : old) === value ? old : prefix + value;
    const clean = isGeneralNote(note) ? { kind: 'general' as const, body: note.body }
      : normalizeComment({
        path: toCheckout(note.path, originalNote?.path), origin: note.origin,
        side: hiddenComparison ? originalNote?.side ?? note.side : note.side, startLine: note.startLine,
        endLine: note.endLine, body: note.body, wholeFile: note.wholeFile,
        comparison: note.comparison ? {
          left: { ...note.comparison.left, path: toCheckout(note.comparison.left.path, originalNote?.comparison?.left.path) },
          right: { ...note.comparison.right, path: toCheckout(note.comparison.right.path, originalNote?.comparison?.right.path) },
        } : hiddenComparison,
        anchorText: note.anchorText, elided: note.elided,
      });
    const id = original?.id ?? randomUUID();
    used.add(id);
    return { id, note: clean };
  });
}

function code(error: unknown, expected: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === expected;
}

/** Local checkout path, never the remote URL, branch or shared worktree Git directory. */
export function storageDirectory(storagePath: string, checkoutPath: string): string {
  return path.join(storagePath, 'checkouts', createHash('sha256').update(path.resolve(checkoutPath)).digest('hex'));
}

export class ReviewStorage {
  readonly directory: string;
  readonly checkoutPath: string;
  constructor(storagePath: string, checkoutPath: string) {
    this.checkoutPath = path.resolve(checkoutPath);
    this.directory = storageDirectory(storagePath, this.checkoutPath);
  }

  async read(name: string): Promise<unknown | undefined> {
    const target = path.join(this.directory, name);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error('Review storage is not a regular file.'); }
      const bytes = await fs.readFile(target);
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      } catch {
        // JSON.parse errors can quote raw feedback; never propagate those to host logs.
        throw new Error('Invalid Review Notes JSON or UTF-8 encoding.');
      }
    } catch (error) {
      if (code(error, 'ENOENT')) { return undefined; }
      throw error;
    }
  }

  async notes(): Promise<NotesDocument> {
    const value = await this.read('notes.json');
    return value === undefined ? { version: 1, checkoutPath: this.checkoutPath, notes: [] }
      : validateNotes(value, this.checkoutPath);
  }

  async write(name: string, value: unknown): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `${name}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, path.join(this.directory, name));
    } finally {
      await fs.unlink(temporary).catch(error => { if (!code(error, 'ENOENT')) { throw error; } });
    }
  }

  /** A filesystem lock serializes separate extension hosts, not just this window. */
  async locked<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true });
    const lock = path.join(this.directory, 'write.lock');
    let handle: fs.FileHandle | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { handle = await fs.open(lock, 'wx', 0o600); break; }
      catch (error) { if (!code(error, 'EEXIST')) { throw error; } }
      await delay(50);
    }
    if (!handle) {
      throw new Error(`Review Notes storage is busy. Retry; if a previous VS Code process crashed, close all windows using this checkout before removing ${lock}.`);
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return await operation();
    } finally {
      await handle.close();
      await fs.unlink(lock);
    }
  }

  async watch(changed: () => void): Promise<FSWatcher> {
    await fs.mkdir(this.directory, { recursive: true });
    const watcher = watch(this.directory, (_event, name) => {
      if (name === 'notes.json' || name === 'last-copy.json' || name === null) { changed(); }
    });
    // Refresh reports the filesystem failure; watcher errors must not crash the host.
    watcher.on('error', changed);
    return watcher;
  }
}
