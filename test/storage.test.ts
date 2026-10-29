import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import type * as vscode from 'vscode';
import type { Repository } from '../src/git';
import type { ReviewStore } from '../src/store';
import type { ReviewArchives } from '../src/archive';
import { parse } from '../src/parser';
import { appendComment, appendGeneralNote, deleteComment, editComment } from '../src/writer';
import { ReviewStorage, storageDirectory, validateNotes } from '../src/reviewStorage';

class Uri {
  readonly scheme = 'file';
  constructor(readonly fsPath: string) {}
  get path(): string { return this.fsPath; }
  static file(value: string): Uri { return new Uri(value); }
  static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(path.join(base.fsPath, ...parts)); }
  toString(): string { return `file://${this.fsPath}`; }
}

class EventEmitter {
  private listeners = new Set<() => void>();
  readonly event = (listener: () => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(): void { for (const listener of this.listeners) { listener(); } }
  dispose(): void { this.listeners.clear(); }
}

async function fixture(t: TestContext) {
  // Only disposable synthetic storage is ever read or written by this suite.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dejareview-central-'));
  const copies: string[] = [];
  const documents: { uri: Uri; isClosed: boolean; isDirty: boolean }[] = [];
  const mock = { Uri, EventEmitter, workspace: { textDocuments: documents },
    env: { clipboard: { async writeText(text: string) { copies.push(text); } } } };
  const loader = require('node:module') as { _load: (id: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  const load = t.mock.method(loader, '_load', function (this: unknown, id: string, ...args: unknown[]) {
    return id === 'vscode' ? mock : original.call(this, id, ...args);
  });
  let Store: typeof import('../src/store').ReviewStore;
  let Archives: typeof import('../src/archive').ReviewArchives;
  try {
    delete require.cache[require.resolve('../src/store')];
    delete require.cache[require.resolve('../src/archive')];
    Store = (require('../src/store') as typeof import('../src/store')).ReviewStore;
    Archives = (require('../src/archive') as typeof import('../src/archive')).ReviewArchives;
  } finally { load.mock.restore(); }
  const stores: ReviewStore[] = [];
  const make = (checkout = 'checkout', folder = ''): { store: ReviewStore; archives: ReviewArchives } => {
    const root = new Uri(path.join(temporary, checkout));
    const opened = Uri.joinPath(root, folder);
    const archives = new Archives(new Uri(path.join(temporary, 'storage')) as vscode.Uri,
      root as vscode.Uri, opened as vscode.Uri);
    const store = new Store({ rootUri: opened } as Repository, archives);
    stores.push(store);
    return { store, archives };
  };
  t.after(async () => {
    stores.forEach(store => store.dispose());
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return { temporary, make, copies, documents, mock };
}

const line = (body: string, file = 'src/a.ts') => appendComment('', {
  path: file, origin: 'changed', side: 'document', startLine: 1, endLine: 1, anchorText: 'synthetic code', body,
});

test('central storage is checkout-path keyed, shared by subfolders and isolated across worktrees', async t => {
  const f = await fixture(t);
  const root = f.make();
  const child = f.make('checkout', 'packages/app');
  const other = f.make('checkout-feature');
  assert.equal(root.store.uri.fsPath, child.store.uri.fsPath);
  assert.notEqual(root.store.uri.fsPath, other.store.uri.fsPath);
  await child.store.mutate(() => line('child note'));
  assert.equal(parse(await root.store.read() ?? '').comments[0].path, 'packages/app/src/a.ts');
  assert.equal(parse(await child.store.read() ?? '').comments[0].path, 'src/a.ts');
  assert.equal(await other.store.read(), undefined);
  const raw = JSON.parse(await fs.readFile(root.store.uri.fsPath, 'utf8')) as unknown;
  const document = validateNotes(raw, root.archives.storage.checkoutPath);
  assert.equal(document.notes.length, 1);
  assert.equal(document.notes[0].note.body, 'child note');
  assert.equal(await fs.stat(path.join(f.temporary, 'checkout', 'REVIEW-NOTES.md')).then(() => true, () => false), false);
});

test('two independent stores serialize writes without losing either window’s notes', async t => {
  const f = await fixture(t);
  const first = f.make().store;
  const second = f.make().store;
  await Promise.all([
    first.mutate(text => appendGeneralNote(text, 'first window')),
    second.mutate(text => appendGeneralNote(text, 'second window')),
  ]);
  assert.deepEqual(parse(await first.read() ?? '').generalNotes.map(note => note.body).sort(), ['first window', 'second window']);
});

test('separate Node processes coordinate through the same checkout lock', async t => {
  const f = await fixture(t);
  const storagePath = path.join(f.temporary, 'process-storage');
  const checkoutPath = path.join(f.temporary, 'process-checkout');
  const modulePath = require.resolve('../src/reviewStorage');
  const script = `
    const { ReviewStorage } = require(process.argv[1]);
    const { randomUUID } = require('node:crypto');
    const storage = new ReviewStorage(process.argv[2], process.argv[3]);
    storage.locked(async () => {
      const document = await storage.notes();
      await new Promise(resolve => setTimeout(resolve, 100));
      document.notes.push({ id: randomUUID(), note: { kind: 'general', body: process.argv[4] } });
      await storage.write('notes.json', document);
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await Promise.all(['first process', 'second process'].map(body => promisify(execFile)(process.execPath,
    ['-e', script, modulePath, storagePath, checkoutPath, body], { timeout: 10000 })));
  const document = await new ReviewStorage(storagePath, checkoutPath).notes();
  assert.deepEqual(document.notes.map(note => note.note.body).sort(), ['first process', 'second process']);
});

test('structured storage round-trips bodies, duplicate notes and removed-code comparisons', async t => {
  const f = await fixture(t);
  const { store, archives } = f.make();
  const body = ' \n## Heading\n```\n💬 Body: fenced\n\t';
  await store.mutate(() => appendComment(line(body), {
    path: 'old.ts', origin: 'head', side: 'left', startLine: 2, endLine: 3,
    anchorText: 'removed code', body: 'remove/change context',
    comparison: { left: { path: 'old.ts', origin: 'head' }, right: { path: 'new.ts', origin: 'changed' } },
  }));
  const notes = parse(await store.read() ?? '').comments;
  assert.equal(notes[0].body, body);
  assert.equal(notes[1].comparison?.right.path, 'new.ts');
  const before = await archives.storage.notes();
  await store.mutate(text => appendGeneralNote(text, 'another note'));
  const appended = await archives.storage.notes();
  assert.equal(appended.notes[0].id, before.notes[0].id);
  assert.equal(appended.notes[1].id, before.notes[1].id);
  await store.mutate(text => editComment(text, parse(text).comments[0], 'edited'));
  const after = await archives.storage.notes();
  assert.equal(after.notes[0].id, before.notes[0].id);
  assert.equal(after.notes[1].id, before.notes[1].id);
  await store.mutate(text => deleteComment(text, parse(text).comments[0]));
  assert.equal(parse(await store.read() ?? '').comments[0].body, 'remove/change context');
});

test('watching the directory sees atomic replacement from another store', async t => {
  const f = await fixture(t);
  const first = f.make().store;
  const second = f.make().store;
  await first.read();
  const changed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Watcher did not publish external change')), 3000);
    const subscription = first.onDidChange(() => { clearTimeout(timeout); subscription.dispose(); resolve(); });
  });
  await second.mutate(() => line('external save'));
  await changed;
  assert.equal(parse(await first.read() ?? '').comments[0].body, 'external save');
});

test('subfolder editing never retargets a comparison endpoint outside its scope', async t => {
  const f = await fixture(t);
  const root = f.make();
  const child = f.make('checkout', 'packages/app');
  await root.store.mutate(() => appendComment('', {
    path: 'packages/app/a.ts', origin: 'changed', side: 'right', startLine: 1, endLine: 1, body: 'cross-folder rename',
    comparison: { left: { path: 'a.ts', origin: 'head' }, right: { path: 'packages/app/a.ts', origin: 'changed' } },
  }));
  const projected = parse(await child.store.read() ?? '').comments[0];
  assert.equal(projected.comparison, undefined, 'The child view must not open root a.ts as child a.ts');
  await child.store.mutate(text => editComment(text, parse(text).comments[0], 'edited safely'));
  const saved = parse(await root.store.read() ?? '').comments[0];
  assert.equal(saved.side, 'right');
  assert.equal(saved.comparison?.left.path, 'a.ts');
  assert.equal(saved.comparison?.right.path, 'packages/app/a.ts');
  assert.equal(saved.body, 'edited safely');
  await child.store.handoff();
  assert.match(f.copies[0], /packages\/app\/a\.ts/);
  assert.match(f.copies[0], /`a\.ts` @ HEAD/);
});

test('handoff keeps one recovery batch, uses checkout paths, and preserves unrelated folder notes', async t => {
  const f = await fixture(t);
  const root = f.make();
  const child = f.make('checkout', 'packages/app');
  await root.store.mutate(() => line('outside'));
  await child.store.mutate(() => line('inside'));
  assert.deepEqual(await child.store.handoff(), { status: 'copied', count: 1, clipboardCopied: true, archived: true },
    'Only notes visible in the subfolder are copied and counted');
  assert.match(f.copies[0], /packages\/app\/src\/a\.ts/);
  assert.equal(parse(await root.store.read() ?? '').comments.length, 1);
  const [first] = await root.archives.list();
  assert.ok(first);
  assert.equal(await root.store.restore(first.id), false, 'Recovery must not overwrite another folder’s notes');
  await root.store.handoff();
  const list = await root.archives.list();
  assert.equal(list.length, 1);
  assert.notEqual(list[0].id, first.id);
  await assert.rejects(root.archives.read(first.id), /changed/);
  assert.equal(await root.store.restore(list[0].id), true);
  assert.equal(parse(await root.store.read() ?? '').comments[0].body, 'outside');
  assert.equal((await root.archives.list())[0].id, list[0].id);
});

test('copy failure keeps notes and previous recovery; recovery-write failure never clears', async t => {
  const f = await fixture(t);
  const { store, archives } = f.make();
  await store.mutate(() => line('first batch'));
  await store.handoff();
  const [previous] = await archives.list();
  await store.mutate(() => line('second batch'));
  const copy = t.mock.method(f.mock.env.clipboard, 'writeText', async () => { throw new Error('clipboard unavailable'); });
  assert.equal((await store.handoff()).status, 'copyFailed');
  copy.mock.restore();
  assert.equal((await archives.list())[0].id, previous.id);
  const write = t.mock.method(archives.storage, 'write', async () => { throw new Error('storage unavailable'); });
  assert.equal((await store.handoff()).status, 'archiveFailed');
  write.mock.restore();
  assert.equal(parse(await store.read() ?? '').comments[0].body, 'second batch');
  assert.equal((await archives.list())[0].id, previous.id);
});

test('clear failure leaves both live notes and the new recovery batch', async t => {
  const f = await fixture(t);
  const { store, archives } = f.make();
  await store.mutate(() => line('recoverable'));
  const original = archives.storage.write.bind(archives.storage);
  t.mock.method(archives.storage, 'write', async (name: string, value: unknown) => {
    if (name === 'notes.json') { throw new Error('clear failed'); }
    await original(name, value);
  });
  const result = await store.handoff();
  assert.equal(result.status, 'deleteFailed');
  assert.equal(result.archived, true);
  assert.equal(parse(await store.read() ?? '').comments[0].body, 'recoverable');
  assert.equal((await archives.list()).length, 1);
});

test('invalid JSON, metadata and symbolic links fail closed without overwriting storage', async t => {
  const f = await fixture(t);
  const { store, archives } = f.make();
  await store.read();
  await fs.writeFile(store.uri.fsPath, '{broken');
  await assert.rejects(store.mutate(() => line('no overwrite')), { message: 'Invalid Review Notes JSON or UTF-8 encoding.' });
  assert.equal(await fs.readFile(store.uri.fsPath, 'utf8'), '{broken');
  await fs.writeFile(store.uri.fsPath, JSON.stringify({ version: 1, checkoutPath: '/different', notes: [] }));
  await assert.rejects(store.read(), /metadata/);
  await fs.unlink(store.uri.fsPath);
  const target = path.join(f.temporary, 'synthetic-target');
  await fs.writeFile(target, 'untouched');
  await fs.symlink(target, store.uri.fsPath);
  await assert.rejects(archives.storage.notes(), /regular file/);
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
});

test('cancelled validation releases the lock and a subsequent write succeeds', async t => {
  const f = await fixture(t);
  const { store } = f.make();
  await assert.rejects(store.mutate(() => line('cancelled'), async () => { throw new Error('cancel'); }), /cancel/);
  await store.mutate(() => line('next write'));
  assert.equal(parse(await store.read() ?? '').comments[0].body, 'next write');
  f.documents.push({ uri: new Uri(store.uri.fsPath), isDirty: true, isClosed: false });
  await assert.rejects(store.mutate(() => line('dirty')), /internal Review Notes storage/);
});

test('an existing crash lock is never stolen and gives a bounded recovery error', async t => {
  const f = await fixture(t);
  const { store, archives } = f.make();
  await store.read();
  const lock = path.join(archives.storage.directory, 'write.lock');
  await fs.writeFile(lock, 'synthetic crash lock');
  await assert.rejects(store.mutate(() => line('blocked')), /close all windows.*write.lock/);
  assert.equal(await fs.readFile(lock, 'utf8'), 'synthetic crash lock');
  assert.equal(store.busy, false);
  await fs.unlink(lock); // This lock is inside this test's disposable fixture only.
  await store.mutate(() => line('retry succeeds'));
  assert.equal(parse(await store.read() ?? '').comments[0].body, 'retry succeeds');
});

test('disk path determines storage identity, not branch or repository metadata', () => {
  assert.notEqual(storageDirectory('/storage', '/work/main'), storageDirectory('/storage', '/work/feature'));
  assert.equal(storageDirectory('/storage', '/work/main/.'), storageDirectory('/storage', '/work/main'));
  const storage = new ReviewStorage('/storage', '/work/main');
  assert.equal(storage.checkoutPath, '/work/main');
});
