import * as assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { posix } from 'node:path';
import { inspect } from 'node:util';
import type * as vscode from 'vscode';
import type { Repository } from '../src/git';
import type { ReviewStore } from '../src/store';
import type { ReviewArchives } from '../src/archive';
import { parse } from '../src/parser';

class Uri implements Pick<vscode.Uri, 'path' | 'toString'> {
  constructor(readonly path: string) {}
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(posix.join(base.path, ...parts));
  }
  toString(): string {
    return `file://${this.path}`;
  }
}

class FileSystemError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class EventEmitter {
  private listeners = new Set<() => void>();
  event = (listener: () => void) => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  assert.ok(resolve);
  return { promise, resolve };
}

// All note/archive IO below goes to this map, never to the host filesystem.
function fixture(t: TestContext) {
  const files = new Map<string, { bytes: Uint8Array; mtime: number; type: number }>();
  let clock = 0;
  const calls = { writes: [] as string[], renames: [] as { from: string; to: string; overwrite: boolean }[],
    deletes: [] as string[], reads: [] as string[], copies: [] as string[], directories: 0, prompts: 0 };
  const hooks: {
    read?: (uri: Uri) => void | Promise<void>;
    copy?: () => void | Promise<void>;
    write?: (uri: Uri, bytes: Uint8Array) => void | Promise<void>;
    stat?: (uri: Uri) => void;
    directory?: () => Promise<void>;
    rename?: () => void;
    delete?: () => void;
  } = {};
  const put = (uri: Uri, text: string, type = 1) => {
    files.set(uri.path, { bytes: new TextEncoder().encode(text), mtime: ++clock, type });
  };
  const get = (uri: Uri) => {
    const file = files.get(uri.path);
    if (!file) { throw new FileSystemError('FileNotFound'); }
    return file;
  };
  const text = (uri: Uri) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(get(uri).bytes);
  const fs = {
    async stat(uri: Uri) {
      hooks.stat?.(uri);
      const file = get(uri);
      return { type: file.type, ctime: 0, mtime: file.mtime, size: file.bytes.length };
    },
    async readFile(uri: Uri) {
      calls.reads.push(uri.path);
      await hooks.read?.(uri);
      return get(uri).bytes.slice();
    },
    async writeFile(uri: Uri, bytes: Uint8Array) {
      calls.writes.push(uri.path);
      if (hooks.write) { await hooks.write(uri, bytes); }
      files.set(uri.path, { bytes: bytes.slice(), mtime: ++clock, type: 1 });
    },
    async rename(from: Uri, to: Uri, options: { overwrite: boolean }) {
      calls.renames.push({ from: from.path, to: to.path, overwrite: options.overwrite });
      hooks.rename?.();
      if (!options.overwrite && files.has(to.path)) { throw new FileSystemError('FileExists'); }
      const file = get(from);
      files.set(to.path, file);
      files.delete(from.path);
    },
    async delete(uri: Uri, options: { recursive: boolean; useTrash: boolean }) {
      assert.deepEqual(options, { recursive: false, useTrash: false });
      calls.deletes.push(uri.path);
      hooks.delete?.();
      if (!files.delete(uri.path)) { throw new FileSystemError('FileNotFound'); }
    },
    async createDirectory() {},
    async readDirectory(uri: Uri) {
      calls.directories++;
      const entries = [...files].filter(([path]) => posix.dirname(path) === uri.path)
        .map(([path, file]) => [posix.basename(path), file.type] as [string, number]);
      await hooks.directory?.();
      return entries;
    },
  };
  const root = new Uri('/synthetic/project');
  const notes = Uri.joinPath(root, 'REVIEW-NOTES.md');
  const document = {
    uri: notes,
    isClosed: false,
    isDirty: false,
    async save(): Promise<boolean> {
      document.isDirty = false;
      return true;
    },
  };
  const workspace = {
    fs, textDocuments: [document], onDidSaveTextDocument: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ dispose() {},
      onDidCreate: () => ({ dispose() {} }), onDidChange: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }),
    }),
  };
  const vscode = { Uri, FileSystemError, EventEmitter, FileType: { File: 1, SymbolicLink: 64 },
    RelativePattern: class {}, workspace,
    env: {
      clipboard: {
        async writeText(text: string): Promise<void> {
          await hooks.copy?.();
          calls.copies.push(text);
        },
      },
    },
    window: {
      async showWarningMessage(): Promise<string> {
        calls.prompts++;
        return 'Cancel';
      },
    },
  };
  // The CommonJS loader mock is scoped to loading these two modules and restored immediately.
  const loader = require('node:module') as { _load: (id: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  const load = t.mock.method(loader, '_load', function (this: unknown, id: string, ...args: unknown[]) {
    return id === 'vscode' ? vscode : original.call(this, id, ...args);
  });
  let store: ReviewStore;
  let archives: ReviewArchives;
  try {
    delete require.cache[require.resolve('../src/store')];
    delete require.cache[require.resolve('../src/archive')];
    const { ReviewArchives: Archives } = require('../src/archive') as typeof import('../src/archive');
    const { ReviewStore: Store } = require('../src/store') as typeof import('../src/store');
    // Only the URI and repository members consumed by storage are modeled here.
    const repo = { rootUri: root as vscode.Uri } satisfies Pick<Repository, 'rootUri'>;
    archives = new Archives(new Uri('/synthetic/storage') as vscode.Uri, repo.rootUri);
    store = new Store(repo as Repository, archives);
  } finally {
    load.mock.restore();
  }
  t.after(() => store.dispose());
  const archiveUri = (id: string): Uri => {
    const path = [...files.keys()].find(path => path.endsWith(`/${id}.json`));
    assert.ok(path, 'expected the synthetic archive to exist');
    return new Uri(path);
  };
  const temporaryFiles = () => [...files.keys()].filter(path => path.endsWith('.tmp'));
  return { files, calls, hooks, put, get, text, fs, notes, document, store, archives, archiveUri, temporaryFiles };
}

test('mutation publishes complete sibling bytes and preserves BOM/CRLF; no-ops never write', async t => {
  const f = fixture(t);
  assert.equal(await f.store.mutate(text => text), false);
  assert.equal(f.files.size, 0);
  const original = '\uFEFFsynthetic original\r\n';
  f.put(f.notes, original);
  assert.equal(await f.store.mutate(text => text), false);
  assert.equal(f.calls.writes.length, 0);
  let changes = 0;
  f.store.onDidChange(() => { changes++; });
  f.hooks.write = (uri, bytes) => {
    assert.equal(posix.dirname(uri.path), posix.dirname(f.notes.path));
    assert.notEqual(uri.path, f.notes.path);
    assert.equal(f.text(f.notes), original);
    assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), `${original}more\r\n`);
  };
  assert.equal(await f.store.mutate(text => `${text}more\r\n`), true);
  assert.equal(f.text(f.notes), `${original}more\r\n`);
  assert.equal(f.calls.renames[0].overwrite, true);
  assert.equal(changes, 1);
  assert.deepEqual(f.temporaryFiles(), []);
});

test('publication rejects unpaired UTF-16 before any write and keeps the mutation queue usable', async t => {
  const f = fixture(t);
  const original = '\uFEFFsynthetic original\r\n';
  f.put(f.notes, original);
  let changes = 0;
  f.store.onDidChange(() => { changes++; });
  for (const invalid of ['\uD800', '\uDBFF', '\uDC00', '\uDFFF', 'x\uD800y', '\uDC00\uD800']) {
    await assert.rejects(f.store.mutate(text => text + invalid), /unpaired UTF-16 surrogate/);
    assert.equal(f.text(f.notes), original);
    assert.equal(f.store.busy, false);
  }
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.renames, []);
  assert.deepEqual(f.calls.deletes, []);
  assert.equal(changes, 0);

  const unicode = '\u96EA \uD83D\uDE80 e\u0301 \u00E9 \uFFFD \uD800\uDC00 \uDBFF\uDFFF\r\n';
  assert.equal(await f.store.mutate(text => text + unicode), true);
  assert.equal(await f.store.read(), original + unicode);
  assert.deepEqual(f.get(f.notes).bytes, new TextEncoder().encode(original + unicode));
  assert.equal(changes, 1);
});

test('archive save and escaped-surrogate recovery reject loss without changing live or archived bytes', async t => {
  const f = fixture(t);
  t.mock.method(console, 'warn', () => {});
  for (const invalid of ['\uD800', '\uDC00']) {
    await assert.rejects(f.archives.save(`synthetic ${invalid}`), /unpaired UTF-16 surrogate/);
  }
  assert.deepEqual(f.calls.writes, []);

  const saved = await f.archives.save('synthetic original archive');
  const uri = f.archiveUri(saved.id);
  const original: unknown = JSON.parse(f.text(uri));
  assert.ok(original && typeof original === 'object' && !Array.isArray(original));
  for (const invalid of ['\uD800', '\uDC00', '\uD800x\uDC00']) {
    const record: string = JSON.stringify({ ...original, text: `synthetic ${invalid}` });
    f.put(uri, record);
    for (const snapshot of [undefined, '\uFEFF \r\n']) {
      if (snapshot === undefined) {
        f.files.delete(f.notes.path);
      } else {
        f.put(f.notes, snapshot);
      }
      await assert.rejects(f.archives.read(saved.id), /unpaired UTF-16 surrogate/);
      await assert.rejects(f.store.restore(saved.id), /unpaired UTF-16 surrogate/);
      assert.equal(await f.store.read(), snapshot);
      assert.equal(f.text(uri), record);
      assert.equal(f.store.busy, false);
    }
    assert.deepEqual(await f.archives.list(), []);
  }
  assert.equal(f.calls.writes.length, 1, 'only the initial valid archive was written');
  assert.equal(f.calls.renames.length, 1);
  assert.deepEqual(f.calls.deletes, []);
  assert.deepEqual(f.temporaryFiles(), []);
});

test('recovery publication independently rejects invalid text returned by an archive reader', async t => {
  const f = fixture(t);
  const snapshot = ' \r\n';
  f.put(f.notes, snapshot);
  t.mock.method(f.archives, 'read', async () => 'synthetic \uD800');
  await assert.rejects(f.store.restore('synthetic-id'), /unpaired UTF-16 surrogate/);
  assert.equal(f.text(f.notes), snapshot);
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.deletes, []);
  assert.equal(f.store.busy, false);
});

test('valid Unicode survives archive JSON, publication and recovery with exact bytes and schema', async t => {
  const f = fixture(t);
  const raw = '\uFEFFsynthetic \u96EA \uD83D\uDE80 e\u0301 \u00E9 \uFFFD \uD800\uDC00 \uDBFF\uDFFF\r\n';
  const saved = await f.archives.save(raw);
  const uri = f.archiveUri(saved.id);
  const bytes = f.get(uri).bytes.slice();
  assert.deepEqual(JSON.parse(f.text(uri)), {
    version: 1, id: saved.id, repoUri: 'file:///synthetic/project', text: raw,
    createdAt: saved.createdAt, commentCount: 0,
  });
  assert.equal(await f.archives.read(saved.id), raw);
  assert.equal(await f.store.restore(saved.id), true);
  assert.deepEqual(f.get(f.notes).bytes, new TextEncoder().encode(raw));
  assert.deepEqual(f.get(uri).bytes, bytes);
});

test('partial temporary write preserves original and cleans up; failed mutation does not poison queue', async t => {
  const f = fixture(t);
  f.put(f.notes, 'original');
  f.hooks.write = uri => {
    f.put(uri, 'partial');
    throw new Error('disk full');
  };
  await assert.rejects(f.store.mutate(() => 'replacement'), /disk full/);
  assert.equal(f.text(f.notes), 'original');
  assert.deepEqual(f.temporaryFiles(), []);
  assert.equal(f.calls.renames.length, 0);
  assert.equal(f.store.busy, false);
  f.hooks.write = undefined;
  assert.equal(await f.store.mutate(() => 'replacement'), true);
});

test('submission validation runs after queued work and temporary writing, before publication', async t => {
  const f = fixture(t);
  f.put(f.notes, 'original');
  let changed = false;
  f.hooks.write = () => { changed = true; };
  await assert.rejects(f.store.mutate(() => 'new draft', async () => {
    assert.equal(changed, true);
    throw new Error('captured revision changed');
  }), /captured revision changed/);
  assert.equal(f.text(f.notes), 'original');
  assert.equal(f.calls.renames.length, 0);
  assert.deepEqual(f.temporaryFiles(), []);
});

for (const stage of ['snapshot', 'stat']) {
  for (const change of ['folder', 'input']) {
    test(`mutation final input guard rejects ${change} changes during the last ${stage}`, async t => {
      const f = fixture(t);
      const original = '\uFEFFsynthetic original\r\n';
      f.put(f.notes, original);
      let changed = false;
      let finalChecks = 0;
      const blocked = new Error(`${change} changed before publication`);
      await assert.rejects(f.store.mutate(() => 'replacement', async () => {
        assert.equal(changed, false, 'async validation passes before the late change');
        if (stage === 'snapshot') {
          f.hooks.read = async uri => {
            if (uri.path === f.notes.path) {
              await Promise.resolve();
              changed = true;
            }
          };
        } else {
          let stats = 0;
          f.hooks.stat = uri => {
            if (uri.path === f.notes.path && ++stats === 2) { changed = true; }
          };
        }
      }, () => {
        finalChecks++;
        if (changed) { throw blocked; }
      }), error => error === blocked);
      assert.equal(finalChecks, 1);
      assert.equal(changed, true);
      assert.equal(f.text(f.notes), original);
      assert.equal(f.calls.renames.length, 0);
      assert.equal(f.calls.writes.length, 1);
      assert.deepEqual(f.calls.deletes, f.calls.writes, 'only the temporary file is removed');
      assert.notEqual(f.calls.writes[0], f.notes.path);
      assert.deepEqual(f.temporaryFiles(), []);
      assert.equal(f.store.busy, false);
    });
  }
}

test('final snapshot check retains external changes made while writing the temporary file', async t => {
  const f = fixture(t);
  f.put(f.notes, 'original');
  f.hooks.write = () => { f.put(f.notes, 'external edit'); };
  await assert.rejects(f.store.mutate(() => 'replacement'), /changed on disk/);
  assert.equal(f.text(f.notes), 'external edit');
  assert.equal(f.calls.renames.length, 0);
  assert.deepEqual(f.temporaryFiles(), []);
});

test('dirty buffer during temporary write cancels without publishing or clearing input', async t => {
  const f = fixture(t);
  f.put(f.notes, 'original');
  f.hooks.write = () => { f.document.isDirty = true; };
  assert.equal(await f.store.mutate(() => 'replacement'), false);
  assert.equal(f.text(f.notes), 'original');
  assert.equal(f.document.isDirty, true);
  assert.equal(f.calls.prompts, 1);
  assert.equal(f.calls.renames.length, 0);
  assert.deepEqual(f.temporaryFiles(), []);
});

test('final stat rejects a new symlink and checks dirty state after the last await', async t => {
  for (const dirty of [false, true]) {
    const f = fixture(t);
    f.put(f.notes, 'original');
    f.hooks.write = () => {
      let stats = 0;
      f.hooks.stat = uri => {
        if (uri.path === f.notes.path && ++stats === 2) {
          if (dirty) { f.document.isDirty = true; }
          else { f.get(f.notes).type = 65; }
        }
      };
    };
    if (dirty) { assert.equal(await f.store.mutate(() => 'replacement'), false); }
    else { await assert.rejects(f.store.mutate(() => 'replacement'), /symbolic link/); }
    assert.equal(f.text(f.notes), 'original');
    assert.equal(f.calls.renames.length, 0);
    assert.deepEqual(f.temporaryFiles(), []);
  }
});

test('rename failure cleans only temporary file; absent target uses non-overwriting rename', async t => {
  const f = fixture(t);
  f.hooks.rename = () => { f.put(f.notes, 'concurrent creation'); };
  await assert.rejects(f.store.mutate(() => 'new notes'), /FileExists/);
  assert.equal(f.calls.renames[0].overwrite, false);
  assert.equal(f.text(f.notes), 'concurrent creation');
  assert.deepEqual(f.temporaryFiles(), []);
  assert.ok(f.calls.deletes.every(path => path !== f.notes.path));
});

test('cleanup failure does not mask the write failure or touch live feedback', async t => {
  const f = fixture(t);
  const warnings: unknown[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  f.put(f.notes, 'original');
  f.hooks.write = uri => {
    f.put(uri, 'partial');
    throw new Error('write failure');
  };
  f.hooks.delete = () => { throw new Error('cleanup failure'); };
  await assert.rejects(f.store.mutate(() => 'replacement'), /write failure/);
  assert.equal(f.text(f.notes), 'original');
  assert.equal(warnings.length, 1);
  assert.ok(f.calls.deletes.every(path => path !== f.notes.path));
});

test('mutations remain serialized while publication is pending', async t => {
  const f = fixture(t);
  f.put(f.notes, 'start');
  const started = deferred();
  const finish = deferred();
  f.hooks.write = async () => {
    started.resolve();
    await finish.promise;
  };
  const first = f.store.mutate(text => `${text}:one`);
  await started.promise;
  let secondStarted = false;
  const second = f.store.mutate(text => {
    secondStarted = true;
    return `${text}:two`;
  });
  assert.equal(f.store.busy, true);
  assert.equal(secondStarted, false);
  finish.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(f.text(f.notes), 'start:one:two');
  assert.equal(f.store.busy, false);
});

test('disposal during temporary write prevents publication but still cleans up', async t => {
  const f = fixture(t);
  f.put(f.notes, 'original');
  f.hooks.write = () => { f.store.dispose(); };
  await assert.rejects(f.store.mutate(() => 'replacement'), /disposed/);
  assert.equal(f.text(f.notes), 'original');
  assert.deepEqual(f.temporaryFiles(), []);
});

test('recovery uses guarded publication and restores exact bytes without removing archive', async t => {
  const f = fixture(t);
  const raw = '\uFEFFsynthetic recovered feedback\r\n';
  const saved = await f.archives.save(raw);
  f.put(f.notes, ' \r\n');
  f.hooks.write = uri => {
    f.put(uri, 'partial');
    throw new Error('disk full');
  };
  await assert.rejects(f.store.restore(saved.id), /disk full/);
  assert.equal(f.text(f.notes), ' \r\n');
  assert.deepEqual(f.temporaryFiles(), []);
  f.hooks.write = () => { f.put(f.notes, 'new feedback'); };
  assert.equal(await f.store.restore(saved.id), false);
  assert.equal(f.text(f.notes), 'new feedback');
  f.put(f.notes, '');
  f.hooks.write = () => { f.document.isDirty = true; };
  await assert.rejects(f.store.restore(saved.id), /unsaved changes/);
  assert.equal(f.text(f.notes), '');
  assert.deepEqual(f.temporaryFiles(), []);
  f.document.isDirty = false;
  f.hooks.write = undefined;
  assert.equal(await f.store.restore(saved.id), true);
  assert.equal(f.text(f.notes), raw);
  assert.equal(await f.archives.read(saved.id), raw);
});

for (const stage of ['initial input', 'initial snapshot', 'archive read', 'temporary write',
  'final snapshot', 'final stat', 'publication continuation']) {
  test(`recovery retains dashboard input activated during ${stage}`, async t => {
    const f = fixture(t);
    const raw = '\uFEFFsynthetic recovered feedback\r\n';
    const saved = await f.archives.save(raw);
    const archiveUri = f.archiveUri(saved.id);
    const archiveBytes = f.text(archiveUri);
    const snapshot = ' \r\n';
    f.put(f.notes, snapshot);
    let active = stage === 'initial input';
    let reads = 0;
    let stats = 0;
    let validations = 0;
    f.hooks.read = async uri => {
      await Promise.resolve();
      if (uri.path === archiveUri.path && stage === 'archive read') { active = true; }
      if (uri.path === f.notes.path) {
        reads++;
        if ((stage === 'initial snapshot' && reads === 1)
          || (stage === 'final snapshot' && reads === 2)) { active = true; }
      }
    };
    f.hooks.write = async () => {
      await Promise.resolve();
      if (stage === 'temporary write') { active = true; }
    };
    f.hooks.stat = uri => {
      if (uri.path === f.notes.path && ++stats === 3 && stage === 'final stat') { active = true; }
    };
    const renames = f.calls.renames.length;
    await assert.rejects(f.store.restore(saved.id, () => {
      if (active) { throw new Error('Finish the active dashboard editor.'); }
      // Activate after the async snapshot validator returns, before publish resumes.
      if (++validations === 5 && stage === 'publication continuation') {
        queueMicrotask(() => { active = true; });
      }
    }), /active dashboard editor/);
    assert.equal(active, true);
    assert.equal(f.text(f.notes), snapshot);
    assert.equal(f.text(archiveUri), archiveBytes);
    assert.equal(f.calls.renames.length, renames);
    assert.ok(f.calls.deletes.every(path => path !== f.notes.path));
    assert.deepEqual(f.temporaryFiles(), []);
    assert.equal(f.store.busy, false);
    active = false;
    f.hooks.read = undefined;
    f.hooks.write = undefined;
    f.hooks.stat = undefined;
    assert.equal(await f.store.restore(saved.id, () => { assert.equal(active, false); }), true);
    assert.equal(f.text(f.notes), raw);
  });
}

for (const [stage, status, copied, archived] of [
  ['initial input', 'rejected', false, false],
  ['save wait', 'rejected', false, false],
  ['initial snapshot', 'readFailed', false, false],
  ['clipboard write', 'archiveFailed', true, false],
  ['archive save', 'readFailed', true, true],
  ['snapshot recheck', 'readFailed', true, true],
  ['missing snapshot', 'readFailed', true, true],
  ['final snapshot', 'deleteFailed', true, true],
  ['final stat', 'deleteFailed', true, true],
] as const) {
  test(`handoff retains dashboard input activated during ${stage}`, async t => {
    const f = fixture(t);
    const raw = '\uFEFFsynthetic handoff feedback\r\n';
    f.put(f.notes, raw);
    let active = stage === 'initial input';
    let reads = 0;
    let stats = 0;
    if (stage === 'save wait') {
      t.mock.method(f.store, 'ensureSaved', async () => {
        await Promise.resolve();
        active = true;
        return true;
      });
    }
    f.hooks.read = async uri => {
      if (uri.path !== f.notes.path) { return; }
      await Promise.resolve();
      reads++;
      if ((stage === 'initial snapshot' && reads === 1)
        || (stage === 'snapshot recheck' && reads === 2)
        || (stage === 'final snapshot' && reads === 3)) { active = true; }
    };
    f.hooks.copy = async () => {
      await Promise.resolve();
      if (stage === 'clipboard write') { active = true; }
    };
    f.hooks.write = async () => {
      await Promise.resolve();
      if (stage === 'archive save') { active = true; }
    };
    f.hooks.stat = uri => {
      if (uri.path !== f.notes.path) { return; }
      stats++;
      if (stage === 'final stat' && stats === 4) { active = true; }
      if (stage === 'missing snapshot' && stats === 2) {
        f.files.delete(f.notes.path);
        active = true;
      }
    };
    const blocked = new Error('Finish the active dashboard editor.');
    const result = f.store.handoff(() => {
      if (active) {
        throw blocked;
      }
    });
    if (status === 'rejected') { await assert.rejects(result, error => error === blocked); }
    else {
      const outcome = await result;
      assert.equal(outcome.status, status);
      assert.equal(outcome.clipboardCopied, copied);
      assert.ok('error' in outcome && outcome.error === blocked);
    }
    assert.equal(active, true);
    assert.equal(f.calls.copies.length, copied ? 1 : 0);
    if (copied) { assert.ok(f.calls.copies[0].endsWith(`\n\n${raw}`)); }
    assert.ok(!f.calls.deletes.includes(f.notes.path));
    if (stage === 'missing snapshot') { assert.equal(f.files.has(f.notes.path), false); }
    else { assert.equal(f.text(f.notes), raw); }
    const history = await f.archives.list();
    assert.equal(history.length, archived ? 1 : 0);
    if (archived) { assert.equal(await f.archives.read(history[0].id), raw); }
    assert.deepEqual(f.temporaryFiles(), []);
    assert.equal(f.store.busy, false);
  });
}

test('handoff with an inactive input guard copies, archives and deletes only saved feedback', async t => {
  const f = fixture(t);
  const raw = '\uFEFFsynthetic handoff feedback\r\n';
  f.put(f.notes, raw);
  assert.deepEqual(await f.store.handoff(() => {}), { status: 'copied', clipboardCopied: true });
  assert.deepEqual(f.calls.deletes, [f.notes.path]);
  assert.equal(f.calls.copies.length, 1);
  assert.ok(f.calls.copies[0].endsWith(`\n\n${raw}`));
  const [saved] = await f.archives.list();
  assert.equal(await f.archives.read(saved.id), raw);
  assert.equal(f.store.busy, false);
});

test('concurrent archive lists share one scan and unchanged records cache metadata only', async t => {
  const f = fixture(t);
  const saved = await f.archives.save('synthetic private feedback');
  const lists = await Promise.all([f.archives.list(), f.archives.list(), f.archives.list()]);
  assert.equal(f.calls.directories, 1);
  assert.equal(f.calls.reads.length, 1);
  assert.deepEqual(lists[0], [saved]);
  lists[0][0].commentCount = 999;
  assert.deepEqual(lists[1], [saved]);
  assert.deepEqual(await f.archives.list(), [saved]);
  assert.equal(f.calls.directories, 2);
  assert.equal(f.calls.reads.length, 1);
  const cache: unknown = Reflect.get(f.archives, 'metadata');
  assert.ok(cache instanceof Map);
  assert.doesNotMatch(inspect([...cache]), /synthetic private feedback|repoUri|version/);
});

test('archive metadata invalidates on mtime, size, removal and symlink changes; recovery always reads', async t => {
  const f = fixture(t);
  t.mock.method(console, 'warn', () => {});
  const saved = await f.archives.save('synthetic feedback');
  const uri = f.archiveUri(saved.id);
  await f.archives.list();
  const original = f.text(uri);
  f.put(uri, original.replace(saved.createdAt, '2020-01-01T00:00:00.000Z'));
  assert.equal((await f.archives.list())[0].createdAt, '2020-01-01T00:00:00.000Z');
  assert.equal(f.calls.reads.length, 2);
  const mtime = f.get(uri).mtime;
  f.put(uri, f.text(uri) + ' ');
  f.get(uri).mtime = mtime;
  await f.archives.list();
  assert.equal(f.calls.reads.length, 3);
  // Same-size/same-mtime changes may fool metadata, but never a recovery read.
  f.get(uri).bytes[0] = '!'.charCodeAt(0);
  await assert.rejects(f.archives.read(saved.id), /Invalid review archive JSON/);
  assert.equal(f.calls.reads.length, 4);
  f.get(uri).type = 65;
  assert.deepEqual(await f.archives.list(), []);
  await assert.rejects(f.archives.read(saved.id), /not a regular file/);
  f.files.delete(uri.path);
  assert.deepEqual(await f.archives.list(), []);
  f.put(uri, original);
  assert.deepEqual(await f.archives.list(), [saved]);
  assert.equal(f.calls.reads.length, 5);
});

test('save invalidates an in-flight listing and includes the new record without rereading unchanged ones', async t => {
  const f = fixture(t);
  const first = await f.archives.save('first synthetic record');
  await f.archives.list();
  const started = deferred();
  const finish = deferred();
  f.hooks.directory = async () => {
    started.resolve();
    await finish.promise;
  };
  const listing = f.archives.list();
  await started.promise;
  const second = await f.archives.save('second synthetic record');
  const concurrent = f.archives.list();
  finish.resolve();
  const [result, other] = await Promise.all([listing, concurrent]);
  assert.deepEqual(new Set(result.map(item => item.id)), new Set([first.id, second.id]));
  assert.deepEqual(other, result);
  assert.equal(f.calls.directories, 3);
  assert.equal(f.calls.reads.length, 2);
});

test('invalid JSON cannot leak a synthetic private marker through listing logs or read callers', async t => {
  const f = fixture(t);
  const messages: unknown[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { messages.push(args); });
  const saved = await f.archives.save('synthetic valid record');
  const marker = 'PRIVATE_SYNTHETIC_MARKER_731';
  f.put(f.archiveUri(saved.id), `{"text":"${marker}" BROKEN}`);
  assert.deepEqual(await f.archives.list(), []);
  await assert.rejects(f.archives.read(saved.id), error => {
    messages.push(error);
    assert.match(String(error), /Invalid review archive JSON or encoding/);
    assert.ok(error instanceof Error);
    assert.equal(error.cause, undefined);
    return true;
  });
  f.put(f.notes, '');
  await assert.rejects(f.store.restore(saved.id), error => {
    messages.push(error);
    return true;
  });
  assert.equal(messages.length, 3);
  assert.doesNotMatch(inspect(messages), new RegExp(marker));
  assert.equal(f.calls.writes.length, 1, 'failed recovery must not publish notes');
});

test('failed shared listing is retryable and failed archive publication leaves existing history intact', async t => {
  const f = fixture(t);
  const saved = await f.archives.save('existing synthetic record');
  f.hooks.directory = async () => { throw new Error('directory unavailable'); };
  const results = await Promise.allSettled([f.archives.list(), f.archives.list()]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(f.calls.directories, 1);
  f.hooks.directory = undefined;
  assert.deepEqual(await f.archives.list(), [saved]);
  f.hooks.write = uri => {
    f.put(uri, 'partial');
    throw new Error('archive disk full');
  };
  await assert.rejects(f.archives.save('new synthetic record'), /archive disk full/);
  assert.deepEqual(f.temporaryFiles(), []);
  assert.deepEqual(await f.archives.list(), [saved]);
  assert.equal(await f.archives.read(saved.id), 'existing synthetic record');
});

for (const commentCount of [0, 7]) {
  test(`stored archive count ${commentCount} remains independent of the current parsed count`, async t => {
    const f = fixture(t);
    const text = '\uFEFF# Synthetic review\r\r## `a.ts`:1\rSelected: Working tree\r\rSynthetic feedback\r'
      + '\r## General Review Note\r\rSynthetic general feedback\r';
    assert.equal(parse(text).comments.length, 1);
    assert.equal(parse(text).generalNotes.length, 1);
    const saved = await f.archives.save(text);
    assert.equal(saved.commentCount, 2, 'new saves count file and general notes');
    const uri = f.archiveUri(saved.id);
    assert.equal(JSON.parse(f.text(uri)).commentCount, 2);
    assert.deepEqual(await f.archives.list(), [saved]);
    const record = JSON.stringify({ ...JSON.parse(f.text(uri)), commentCount });
    f.put(uri, record);
    const metadata = { ...saved, commentCount };
    assert.deepEqual(await f.archives.list(), [metadata]);
    assert.deepEqual(await f.archives.list(), [metadata], 'cached metadata retains the stored count');
    assert.equal(await f.archives.read(saved.id), text);
    assert.equal(await f.store.restore(saved.id), true);
    assert.equal(f.text(f.notes), text);
    assert.equal((await f.store.load()).parsed.comments.length, 1);
    assert.equal((await f.store.load()).parsed.generalNotes.length, 1);
    assert.equal(f.text(uri), record, 'reading and recovery never rewrite the archive');
  });
}

test('archive reads still validate metadata and IDs, and listing retains only the newest ten for display', async t => {
  const f = fixture(t);
  t.mock.method(console, 'warn', () => {});
  const ids: string[] = [];
  for (let index = 0; index < 12; index++) {
    const saved = await f.archives.save(`synthetic record ${index}`);
    ids.push(saved.id);
    const uri = f.archiveUri(saved.id);
    const record = JSON.parse(f.text(uri));
    record.createdAt = new Date(2026, 0, index + 1).toISOString();
    f.put(uri, JSON.stringify(record));
  }
  assert.deepEqual((await f.archives.list()).map(item => item.id), ids.slice(2).reverse());
  assert.equal(await f.archives.read(ids[0]), 'synthetic record 0');
  const uri = f.archiveUri(ids[11]);
  const original = JSON.parse(f.text(uri));
  for (const change of [{ repoUri: 'file:///another-folder' }, { id: ids[0] }, { version: 2 },
    { text: '' }, { createdAt: 'bad date' }, { commentCount: -1 }, { commentCount: 0.5 },
    { commentCount: Number.MAX_SAFE_INTEGER + 1 }, { commentCount: '0' }, { commentCount: null }]) {
    f.put(uri, JSON.stringify({ ...original, ...change }));
    await assert.rejects(f.archives.read(ids[11]), /Invalid review archive metadata/);
    assert.ok((await f.archives.list()).every(item => item.id !== ids[11]));
  }
  const reads = f.calls.reads.length;
  await assert.rejects(f.archives.read('../outside'), /Invalid review archive ID/);
  assert.equal(f.calls.reads.length, reads);
  assert.equal(f.files.size, 12);
});

test('archive validation narrows unknown JSON shapes and preserves historical counts and extra fields', async t => {
  const f = fixture(t);
  t.mock.method(console, 'warn', () => {});
  const saved = await f.archives.save('synthetic archive feedback');
  const uri = f.archiveUri(saved.id);
  const original: unknown = JSON.parse(f.text(uri));
  assert.ok(original && typeof original === 'object' && !Array.isArray(original));
  const invalid: unknown[] = [null, false, 1, 'record', [], [original], {},
    { ...original, text: [] }, { ...original, text: ' \r\n' },
    { ...original, createdAt: [] }, { ...original, createdAt: '2026-01-01' },
    { ...original, createdAt: '2026-02-30T00:00:00.000Z' },
    { ...original, repoUri: null }, { ...original, id: {} }, { ...original, version: '1' }];
  for (const value of invalid) {
    const record = JSON.stringify(value);
    f.put(uri, record);
    await assert.rejects(f.archives.read(saved.id), /Invalid review archive/);
    assert.deepEqual(await f.archives.list(), []);
    assert.equal(f.text(uri), record);
  }

  // Persisted records are not dashboard messages: retain the existing tolerance of extra keys.
  const record = JSON.stringify({ ...original, commentCount: Number.MAX_SAFE_INTEGER, extra: 'untouched' });
  f.put(uri, record);
  assert.equal(await f.archives.read(saved.id), 'synthetic archive feedback');
  assert.deepEqual(await f.archives.list(), [{ ...saved, commentCount: Number.MAX_SAFE_INTEGER }]);
  assert.equal(f.text(uri), record);
});
