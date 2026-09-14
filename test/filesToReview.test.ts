import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import type { GitResources, Repository } from '../src/git';

class Uri implements vscode.Uri {
  scheme = 'file';
  authority = '';
  path = '';
  query = '';
  fragment = '';
  get fsPath(): string { return this.path; }
  static file(value: string): Uri { return Uri.from({ path: value }); }
  static from(value: Partial<Uri>): Uri { return Object.assign(new Uri(), value); }
  static joinPath(base: Uri, ...parts: string[]): Uri { return Uri.from({ ...base, path: path.posix.join(base.path, ...parts) }); }
  toString(): string { return `${this.scheme}://${this.authority}${this.path}?${this.query}#${this.fragment}`; }
  with(change: Parameters<vscode.Uri['with']>[0]): Uri {
    return Uri.from({
      scheme: change.scheme ?? this.scheme,
      authority: change.authority === null ? '' : change.authority ?? this.authority,
      path: change.path === null ? '' : change.path ?? this.path,
      query: change.query === null ? '' : change.query ?? this.query,
      fragment: change.fragment === null ? '' : change.fragment ?? this.fragment,
    });
  }
  toJSON(): object {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
}

class EventEmitter {
  readonly listeners = new Set<() => void>();
  event = (listener: () => void) => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(): void { this.listeners.forEach(listener => listener()); }
  dispose(): void { this.listeners.clear(); }
}

const GitStatus = {
  IndexModified: 0, IndexAdded: 1, IndexDeleted: 2, IndexRenamed: 3, IndexCopied: 4,
  Modified: 5, Deleted: 6, Untracked: 7, Ignored: 8, IntentToAdd: 9, IntentToRename: 10,
  TypeChanged: 11, AddedByUs: 12, AddedByThem: 13, DeletedByUs: 14, DeletedByThem: 15,
  BothAdded: 16, BothDeleted: 17, BothModified: 18,
};
const file = (value: string): vscode.Uri => Uri.file(value);
type GitChange = NonNullable<Repository['state']['workingTreeChanges']>[number];
type SourceDocument = { -readonly [Key in 'uri' | 'isClosed' | 'isDirty']: vscode.TextDocument[Key] };
const change = (value: string, status?: number): GitChange => ({ uri: file(value), status });
const missing = () => Object.assign(new Error('missing synthetic file'), { code: 'FileNotFound' });
const patch = 'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n';

test('files to review with a synthetic in-memory VS Code host', async t => {
  let git!: GitResources;
  let repository!: Repository;
  let repositories: Repository[] = [];
  let markers = new Map<string, number | Error>();
  let files = new Map<string, { type: number; size: number; mtime?: number; bytes: Uint8Array }>();
  let diffs = new Map<string, string | Error>();
  let reads: string[] = [];
  let diffCalls: string[] = [];
  let stats: string[] = [];
  let addCalls: string[][] = [];
  let cleanCalls: string[][] = [];
  let onAdd: () => Promise<void> = async () => {};
  let onClean: () => Promise<void> = async () => {};
  let documents: SourceDocument[] | undefined;
  let onStat: (uri: Uri) => Promise<void> = async () => {};
  let onRead: (uri: Uri) => Promise<void> = async () => {};
  let onDiff: (target: string) => Promise<void> = async () => {};
  let readBudget = new Map<string, number>();
  let closedHandles: string[] = [];
  let readChunk = Number.MAX_SAFE_INTEGER;
  let onOpen: (target: string) => void = () => {};
  let gitChanged = new EventEmitter();
  const workspace = {
    workspaceFolders: [{ uri: Uri.file('/repo') }],
    get textDocuments() {
      if (!documents) { throw new Error('statistics and staging must never inspect unsaved buffers'); }
      return documents;
    },
    fs: {
      stat: async (uri: Uri) => {
        stats.push(uri.path);
        await onStat(uri);
        const marker = markers.get(uri.path);
        if (marker instanceof Error) { throw marker; }
        if (marker !== undefined) { return { type: marker, size: 0 }; }
        const entry = files.get(uri.path);
        if (!entry) {
          if (['/repo/src', '/repo/packages', '/repo/packages/app', '/repo/packages/app/src'].includes(uri.path)) {
            return { type: 2, size: 0 };
          }
          throw missing();
        }
        return { type: entry.type, size: entry.size, mtime: entry.mtime };
      },
      readFile: async (uri: Uri) => {
        reads.push(uri.path);
        await onRead(uri);
        const entry = files.get(uri.path);
        if (!entry) { throw missing(); }
        assert.equal(entry.type, 1, 'only synthetic regular source files may be read');
        return entry.bytes;
      },
    },
  };
  const api = { get repositories() { return repositories; }, state: 'initialized' };
  const mock = { Uri, EventEmitter, FileType: { File: 1, Directory: 2, SymbolicLink: 64 }, workspace,
    extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => api }) }) } };
  const moduleLoader = require('node:module') as { _load(request: string, ...args: unknown[]): unknown };
  const load = moduleLoader._load;
  const boundedFs = {
    async open(target: string, flags: number) {
      assert.equal(typeof flags, 'number');
      onOpen(target);
      const entry = files.get(target);
      if (!entry) { throw missing(); }
      reads.push(target);
      return {
        async stat() { return { isFile: () => entry.type === 1, size: entry.size }; },
        async read(buffer: Buffer, offset: number, length: number, position: number) {
          await onRead(Uri.file(target));
          const bytesRead = Math.min(length, readChunk, Math.max(0, entry.bytes.length - position));
          buffer.set(entry.bytes.subarray(position, position + bytesRead), offset);
          readBudget.set(target, (readBudget.get(target) ?? 0) + bytesRead);
          assert.ok(position + length <= 5 * 1024 * 1024 + 1, 'every request respects the hard budget');
          return { bytesRead, buffer };
        },
        async close() { closedHandles.push(target); },
      } satisfies Pick<import('node:fs/promises').FileHandle, 'close'> & {
        read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }>;
        stat(): Promise<Pick<import('node:fs').Stats, 'isFile' | 'size'>>;
      };
    },
  };
  t.mock.method(moduleLoader, '_load', function (this: unknown, request: string, ...args: unknown[]) {
    if (request === 'node:fs/promises') { return boundedFs; }
    return request === 'vscode' ? mock : load.call(this, request, ...args);
  });
  const { GitResources } = require('../src/git') as typeof import('../src/git');
  const reset = (): void => {
    git?.dispose();
    markers = new Map();
    files = new Map();
    diffs = new Map();
    reads = [];
    diffCalls = [];
    stats = [];
    addCalls = [];
    onAdd = async () => {};
    cleanCalls = [];
    onClean = async () => {};
    documents = undefined;
    onStat = async () => {};
    onRead = async () => {};
    onDiff = async () => {};
    readBudget = new Map();
    closedHandles = [];
    readChunk = Number.MAX_SAFE_INTEGER;
    onOpen = () => {};
    workspace.workspaceFolders = [{ uri: Uri.file('/repo') }];
    gitChanged = new EventEmitter();
    let workingTreeChanges: Repository['state']['workingTreeChanges'] = [];
    let untrackedChanges: Repository['state']['untrackedChanges'] = [];
    repository = {
      rootUri: file('/repo'),
      state: {
        get workingTreeChanges() { return workingTreeChanges; },
        set workingTreeChanges(value) { workingTreeChanges = value; gitChanged.fire(); },
        get untrackedChanges() { return untrackedChanges; },
        set untrackedChanges(value) { untrackedChanges = value; gitChanged.fire(); },
        indexChanges: [], onDidChange: gitChanged.event,
      },
      getCommit: async () => assert.fail('no commit lookups'),
      show: async () => assert.fail('no revision reads'),
      async add(paths) {
        assert.equal(this, repository, 'staging binds the current containing Git wrapper');
        assert.equal(paths.length, 1);
        assert.ok(path.isAbsolute(paths[0]));
        addCalls.push([...paths]);
        await onAdd();
      },
      async clean(paths) {
        assert.equal(this, repository, 'clean binds the current containing Git wrapper');
        assert.equal(paths.length, 1);
        assert.ok(path.isAbsolute(paths[0]));
        cleanCalls.push([...paths]);
        await onClean();
      },
      async diffWithHEAD(target) {
        assert.equal(this, repository, 'adapter binds the current underlying Git wrapper');
        assert.ok(path.isAbsolute(target), 'Git receives a per-file absolute path');
        diffCalls.push(target);
        await onDiff(target);
        const diff = diffs.get(target) ?? patch;
        if (diff instanceof Error) { throw diff; }
        return diff;
      },
    };
    repositories = [repository];
    git = new GitResources();
  };
  const put = (target: string, content: string | Uint8Array, type = 1, size?: number, mtime?: number) => {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    files.set(target, { bytes, type, size: size ?? bytes.length, mtime });
  };
  const discover = async (noted: ReadonlySet<string> = new Set()): ReturnType<GitResources['filesToReview']> => {
    // Older statistics fixtures describe tracked disk files by their synthetic diff.
    // Materialize their metadata now that candidate discovery validates file leaves.
    for (const entry of repository.state.workingTreeChanges ?? []) {
      if (entry.status !== GitStatus.Deleted && entry.status !== GitStatus.Untracked
        && !files.has(entry.uri.fsPath) && !repository.state.untrackedChanges?.some(change => change.uri.toString() === entry.uri.toString())) {
        put(entry.uri.fsPath, 'source\n');
      }
    }
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    return git.filesToReview(repo, noted);
  };
  const list = async (noted: ReadonlySet<string> = new Set()): Promise<{ path: string; insertions?: number; deletions?: number }[]> => {
    const candidates = await discover(noted);
    const repo = await git.workspaceRepository();
    if (!repo) { return candidates.map(candidate => ({ path: candidate.path })); }
    const statistics = await git.fileStatistics(repo, candidates, () => true);
    return candidates.map(candidate => ({ path: candidate.path, ...statistics.get(candidate.path) }));
  };

  for (const root of ['/repo', '/repo/packages/app']) {
    await t.test(`statistics cache reuses 64 unchanged files after one of 65 is staged under ${root}`, async () => {
      reset();
      workspace.workspaceFolders = [{ uri: Uri.file(root) }];
      const changes = Array.from({ length: 65 }, (_, index) => change(`${root}/src/file-${index}.ts`, GitStatus.Modified));
      for (const entry of changes) { put(entry.uri.fsPath, 'source\n', 1, undefined, 100); }
      repository.state.workingTreeChanges = changes;
      const objects: string[] = [];
      repository.getObjectDetails = async function (ref, target) {
        assert.equal(this, repository);
        assert.equal(ref, '', 'the index, never HEAD');
        assert.ok(target.startsWith(`${root}/src/`), 'containing Git receives the absolute subfolder path');
        objects.push(target);
        return { object: 'a'.repeat(40), mode: '100644', size: 7 };
      };

      assert.equal((await list()).length, 65);
      assert.equal(diffCalls.length, 65);
      assert.equal(objects.length, 130, 'capture and recheck each index identity');
      diffCalls = [];
      // Simulate reviewer staging through Git state, never invoke workspace Git.
      repository.state.workingTreeChanges = changes.slice(1);
      repository.state.indexChanges = [changes[0]];
      for (let event = 0; event < 3; event++) {
        gitChanged.fire();
        repository = { ...repository }; // vscode.git allocates fresh wrappers.
        repositories = [repository];
        const rows = await list();
        assert.equal(rows.length, 64);
        assert.ok(rows.every(row => row.insertions === 2 && row.deletions === 1));
        assert.deepEqual(diffCalls, [], 'unrelated status events do not rerun unchanged diffs');
      }

      repository.state.workingTreeChanges = changes;
      await list();
      assert.deepEqual(diffCalls, [changes[0].uri.fsPath], 'removed candidates were evicted');
      assert.deepEqual(reads, []);
      assert.deepEqual(addCalls, []);
      assert.deepEqual(cleanCalls, []);
    });
  }

  await t.test('direct statistics calls refresh mtime, size, index object and mode changes, and support force', async () => {
    reset();
    const target = '/repo/source.ts';
    put(target, 'source\n', 1, undefined, 100);
    repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
    let object = 'a'.repeat(40);
    let mode = '100644';
    repository.getObjectDetails = async () => ({ object, mode, size: 7 });
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    const candidates = [{ path: 'source.ts', uri: file(target), untracked: false }];
    const expected = new Map([['source.ts', { insertions: 2, deletions: 1 }]]);
    assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), expected);
    assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), expected);
    assert.equal(diffCalls.length, 1);

    for (const mutation of ['mtime', 'size', 'object', 'mode', 'force'] as const) {
      switch (mutation) {
        case 'mtime': put(target, 'source\n', 1, undefined, 101); break;
        case 'size': put(target, 'source!\n', 1, undefined, 101); break;
        case 'object': object = 'b'.repeat(40); break;
        case 'mode': mode = '100755'; break;
      }
      diffCalls = [];
      assert.deepEqual(await git.fileStatistics(repo, candidates, () => true, mutation === 'force'), expected);
      assert.deepEqual(diffCalls, [target], mutation);
      assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), expected);
      assert.equal(diffCalls.length, 1, 'the successful fresh result is reusable');
    }
    assert.equal(repository.state.workingTreeChanges?.[0].status, GitStatus.Modified);
  });

  for (const kind of ['no API', 'lookup failure', 'unknown object', 'unknown mode', 'no mtime', 'invalid mtime',
    'missing disk', 'diff failure', 'binary', 'no diff API'] as const) {
    await t.test(`statistics cache falls back without reuse for ${kind}`, async () => {
      reset();
      const target = '/repo/source.ts';
      put(target, 'source\n', 1, undefined, 100);
      repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
      repository.getObjectDetails = async () => ({ object: 'a'.repeat(40), mode: '100644', size: 7 });
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      const candidates = [{ path: 'source.ts', uri: file(target), untracked: false }];
      await git.fileStatistics(repo, candidates, () => true);
      diffCalls = [];
      switch (kind) {
        case 'no API': repository.getObjectDetails = undefined; break;
        case 'lookup failure': repository.getObjectDetails = async () => { throw new Error('index unavailable'); }; break;
        case 'unknown object': repository.getObjectDetails = async () => ({ object: '', mode: '100644', size: 7 }); break;
        case 'unknown mode': repository.getObjectDetails = async () => ({ object: 'a'.repeat(40), mode: '', size: 7 }); break;
        case 'no mtime': put(target, 'source\n'); break;
        case 'invalid mtime': put(target, 'source\n', 1, undefined, NaN); break;
        case 'missing disk': files.delete(target); break;
        case 'diff failure': diffs.set(target, new Error('diff unavailable')); break;
        case 'binary': diffs.set(target, 'Binary files a/source.ts and b/source.ts differ\n'); break;
        case 'no diff API': repository.diffWithHEAD = undefined; break;
      }
      const unavailable = kind === 'diff failure' || kind === 'binary' || kind === 'no diff API';
      // Force first to exercise failures even when their source signature stayed equal.
      for (const force of [true, false, false]) {
        assert.deepEqual(await git.fileStatistics(repo, candidates, () => true, force),
          new Map([['source.ts', unavailable ? {} : { insertions: 2, deletions: 1 }]]));
      }
      assert.equal(diffCalls.length, kind === 'no diff API' ? 0 : 3);
    });
  }

  await t.test('untracked cache needs complete disk metadata and never consults the index', async () => {
    reset();
    const target = '/repo/new.ts';
    put(target, 'one\ntwo\n', 1, undefined, 100);
    repository.state.untrackedChanges = [change(target, GitStatus.Untracked)];
    repository.getObjectDetails = async () => assert.fail('untracked files have no index signature');
    assert.deepEqual(await list(), [{ path: 'new.ts', insertions: 2, deletions: 0 }]);
    gitChanged.fire();
    await list();
    assert.deepEqual(reads, [target]);

    put(target, 'one two\n', 1, undefined, 101);
    assert.deepEqual(await list(), [{ path: 'new.ts', insertions: 1, deletions: 0 }]);
    assert.deepEqual(reads, [target, target]);
    put(target, 'one two\n');
    await list();
    await list();
    assert.equal(reads.length, 4, 'absent mtime always reads fresh');
  });

  for (const mutation of ['disk', 'index', 'untracked'] as const) {
    await t.test(`${mutation} change while counts are read cannot cache counts under the new signature`, async () => {
      reset();
      const target = '/repo/source.ts';
      const untracked = mutation === 'untracked';
      put(target, 'one\ntwo\n', 1, undefined, 100);
      repository.state.workingTreeChanges = [change(target, untracked ? GitStatus.Untracked : GitStatus.Modified)];
      let object = 'a'.repeat(40);
      repository.getObjectDetails = async () => ({ object, mode: '100644', size: 8 });
      const mutate = async (): Promise<void> => {
        if (mutation === 'index') { object = 'b'.repeat(40); }
        else { put(target, 'one two\n', 1, undefined, 101); }
      };
      if (untracked) { onRead = mutate; }
      else { onDiff = mutate; }
      await list();
      onRead = async () => {};
      onDiff = async () => {};
      diffs.set(target, '@@ -1 +1 @@\n-old\n+new\n');
      assert.deepEqual(await list(), [{ path: 'source.ts', insertions: 1, deletions: untracked ? 0 : 1 }]);
      await list();
      assert.equal(untracked ? reads.length : diffCalls.length, 2, 'only the stable second read can be reused');
    });
  }

  await t.test('cache hit rechecks metadata after index awaits and falls back to fresh counts on a race', async () => {
    reset();
    const target = '/repo/source.ts';
    put(target, 'source\n', 1, undefined, 100);
    repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
    repository.getObjectDetails = async () => ({ object: 'a'.repeat(40), mode: '100644', size: 7 });
    await list();
    let lookups = 0;
    repository.getObjectDetails = async () => {
      if (++lookups === 2) { put(target, 'source!\n', 1, undefined, 101); }
      return { object: 'a'.repeat(40), mode: '100644', size: 7 };
    };
    diffs.set(target, '@@ -1 +1 @@\n-old\n+new\n');
    assert.deepEqual(await list(), [{ path: 'source.ts', insertions: 1, deletions: 1 }]);
    assert.equal(diffCalls.length, 2);
    await list();
    assert.equal(diffCalls.length, 3, 'the raced retry was not cached');
    await list();
    assert.equal(diffCalls.length, 3);
  });

  for (const mutation of ['ownership failure', 'membership', 'cancel', 'dispose'] as const) {
    await t.test(`cached statistics still reject ${mutation} during index validation`, async () => {
      reset();
      const target = '/repo/src/source.ts';
      put(target, 'source\n', 1, undefined, 100);
      repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
      repository.getObjectDetails = async () => ({ object: 'a'.repeat(40), mode: '100644', size: 7 });
      const candidates = await discover();
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      await git.fileStatistics(repo, candidates, () => true);
      let current = true;
      const failure = Object.assign(new Error('boundary unavailable'), { code: 'NoPermissions' });
      repository.getObjectDetails = async () => {
        switch (mutation) {
          case 'ownership failure': markers.set('/repo/src/.git', failure); break;
          case 'membership': repository.state.workingTreeChanges = []; break;
          case 'cancel': current = false; break;
          case 'dispose': git.dispose(); break;
        }
        return { object: 'a'.repeat(40), mode: '100644', size: 7 };
      };
      const work = git.fileStatistics(repo, candidates, () => current);
      if (mutation === 'ownership failure') { await assert.rejects(work, { cause: failure }); }
      else { assert.deepEqual(await work, new Map()); }
      assert.equal(diffCalls.length, 1, 'cache validation never launches another diff');
      assert.equal(gitChanged.listeners.size, 0);
    });
  }

  await t.test('cache is isolated by folder and repository lifetime and cleared on disposal', async () => {
    reset();
    const target = '/repo/packages/app/src/source.ts';
    put(target, 'source\n', 1, undefined, 100);
    repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
    repository.getObjectDetails = async () => ({ object: 'a'.repeat(40), mode: '100644', size: 7 });
    await list();
    await list();
    assert.equal(diffCalls.length, 1);

    workspace.workspaceFolders = [{ uri: Uri.file('/repo/packages/app') }];
    assert.deepEqual(await list(), [{ path: 'src/source.ts', insertions: 2, deletions: 1 }]);
    assert.equal(diffCalls.length, 2, 'opening a subfolder does not reuse the parent projection cache');
    repository.state = { ...repository.state, onDidChange: new EventEmitter().event };
    await list();
    assert.equal(diffCalls.length, 3, 'a new underlying repository event identity invalidates the cache');
    git.dispose();
    git = new GitResources();
    await list();
    assert.equal(diffCalls.length, 4);
  });

  await t.test('cache pruning follows saved-note and archive exclusions without reading excluded metadata', async () => {
    reset();
    const target = '/repo/src/source.ts';
    put(target, 'source\n', 1, undefined, 100);
    repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
    repository.getObjectDetails = async () => ({ object: 'a'.repeat(40), mode: '100644', size: 7 });
    await list();
    assert.deepEqual(await list(new Set(['src/source.ts'])), []);
    await list();
    assert.equal(diffCalls.length, 2, 'saved-note exclusions evict old source statistics');
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    stats = [];
    const candidates = await git.filesToReview(repo, new Set(), [file('/repo/src')]);
    assert.deepEqual(candidates, []);
    assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), new Map());
    assert.deepEqual(stats, [], 'excluded archive location gets no metadata or content reads');
    await list();
    assert.equal(diffCalls.length, 3);
  });

  await t.test('nonstandard tracked statuses always compute fresh even with valid metadata and object identity', async () => {
    reset();
    const target = '/repo/source.ts';
    put(target, 'source\n', 1, undefined, 100);
    repository.getObjectDetails = async () => ({ object: 'a'.repeat(40), mode: '100644', size: 7 });
    repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
    await list();
    for (const status of [undefined, GitStatus.IntentToAdd, GitStatus.TypeChanged, GitStatus.BothModified]) {
      repository.state.workingTreeChanges = [change(target, status)];
      diffCalls = [];
      await list();
      await list();
      assert.deepEqual(diffCalls, [target, target]);
    }
  });

  await t.test('an older overlapping statistics batch cannot repopulate a newer candidate subset', async () => {
    reset();
    const target = '/repo/source.ts';
    put(target, 'source\n', 1, undefined, 100);
    repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
    repository.getObjectDetails = async () => ({ object: 'a'.repeat(40), mode: '100644', size: 7 });
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    const candidates = [{ path: 'source.ts', uri: file(target), untracked: false }];
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started = (): void => {};
    const diffStarted = new Promise<void>(resolve => { started = resolve; });
    onDiff = async () => { started(); await gate; };
    const older = git.fileStatistics(repo, candidates, () => true);
    try {
      await diffStarted;
      assert.deepEqual(await git.fileStatistics(repo, [], () => true), new Map());
    } finally {
      release();
    }
    await older;
    onDiff = async () => {};
    await git.fileStatistics(repo, candidates, () => true);
    assert.equal(diffCalls.length, 2, 'the older completed counts were not retained');
  });

  await t.test('a Git event cancelling cache-hit validation retains unchanged entries for the next refresh', async () => {
    reset();
    const targets = ['/repo/a.ts', '/repo/b.ts'];
    for (const target of targets) { put(target, 'source\n', 1, undefined, 100); }
    repository.state.workingTreeChanges = targets.map(target => change(target, GitStatus.Modified));
    repository.getObjectDetails = async () => ({ object: 'a'.repeat(40), mode: '100644', size: 7 });
    const candidates = await discover();
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    const expected = new Map([
      ['a.ts', { insertions: 2, deletions: 1 }],
      ['b.ts', { insertions: 2, deletions: 1 }],
    ]);
    assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), expected);
    diffCalls = [];

    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started = (): void => {};
    const validationStarted = new Promise<void>(resolve => { started = resolve; });
    let lookups = 0;
    repository.getObjectDetails = async () => {
      // All initial lookups finish before the final validation batch starts.
      if (++lookups === 3) { started(); await gate; }
      return { object: 'a'.repeat(40), mode: '100644', size: 7 };
    };
    let current = true;
    const listener = gitChanged.event(() => { current = false; });
    const pending = git.fileStatistics(repo, candidates, () => current);
    try {
      await validationStarted;
      gitChanged.fire();
      assert.deepEqual(await git.filesToReview(repo, new Set()), candidates);
    } finally {
      release();
      listener.dispose();
    }
    assert.deepEqual(await pending, new Map(), 'the obsolete job must not publish');
    assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), expected);
    assert.deepEqual(diffCalls, [], 'cancellation does not consume valid cached counts');
    assert.equal(gitChanged.listeners.size, 0);
  });

  for (const refresh of ['identical', 'classification', 'folder'] as const) {
    await t.test(`${refresh} discovery during a blocked initial diff preserves only matching snapshot jobs`, async () => {
      reset();
      const target = '/repo/packages/app/src/source.ts';
      put(target, 'source\n', 1, undefined, 100);
      repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
      repository.getObjectDetails = async () => ({ object: 'a'.repeat(40), mode: '100644', size: 7 });
      const candidates = await discover();
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      let release = (): void => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      let started = (): void => {};
      const diffStarted = new Promise<void>(resolve => { started = resolve; });
      onDiff = async () => { started(); await gate; };
      const pending = git.fileStatistics(repo, candidates, () => true);
      try {
        await diffStarted;
        switch (refresh) {
          case 'identical':
            assert.deepEqual(await git.filesToReview(repo, new Set()), candidates);
            assert.deepEqual(await git.filesToReview(repo, new Set()), candidates);
            break;
          case 'classification':
            repository.state.workingTreeChanges = [change(target, GitStatus.Untracked)];
            assert.deepEqual(await git.filesToReview(repo, new Set()), [{ ...candidates[0], untracked: true }]);
            repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
            assert.deepEqual(await git.filesToReview(repo, new Set()), candidates);
            break;
          case 'folder': {
            workspace.workspaceFolders = [{ uri: Uri.file('/repo/packages/app') }];
            const subfolder = await git.workspaceRepository();
            assert.ok(subfolder);
            assert.deepEqual(await git.filesToReview(subfolder, new Set()), [
              { path: 'src/source.ts', uri: file(target), untracked: false },
            ]);
            workspace.workspaceFolders = [{ uri: Uri.file('/repo') }];
            assert.deepEqual(await git.filesToReview(repo, new Set()), candidates);
            break;
          }
        }
      } finally {
        release();
      }
      const expected = new Map([['packages/app/src/source.ts', { insertions: 2, deletions: 1 }]]);
      assert.deepEqual(await pending, expected);
      onDiff = async () => {};
      assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), expected);
      assert.equal(diffCalls.length, refresh === 'identical' ? 1 : 2,
        'only identical scoped candidate snapshots let the blocked job populate the active cache');
      assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), expected);
      assert.equal(diffCalls.length, refresh === 'identical' ? 1 : 2);
    });
  }

  await t.test('candidate discovery performs no tracked diff or untracked content read', async () => {
    reset();
    put('/repo/tracked.ts', 'tracked\n');
    put('/repo/new.ts', 'new\n');
    repository.state.workingTreeChanges = [change('/repo/tracked.ts', GitStatus.Modified)];
    repository.state.untrackedChanges = [change('/repo/new.ts', GitStatus.Untracked)];
    onDiff = async () => assert.fail('discovery must not await a diff');
    onOpen = () => assert.fail('discovery must not open source contents');
    const repo = await git.workspaceRepository();
    assert.ok(repo);

    assert.deepEqual(await git.filesToReview(repo, new Set()), [
      { path: 'new.ts', uri: file('/repo/new.ts'), untracked: true },
      { path: 'tracked.ts', uri: file('/repo/tracked.ts'), untracked: false },
    ]);
    assert.deepEqual(diffCalls, []);
    assert.deepEqual(reads, []);
  });

  await t.test('discovery bounds ownership checks and enumerates snapshot maps only twice', async child => {
    reset();
    const changes = Array.from({ length: 65 }, (_, index) => change(`/repo/file-${index}.ts`, GitStatus.Modified));
    for (const entry of changes) { put(entry.uri.fsPath, 'source\n'); }
    const untracked: GitChange[] = [];
    repository.state.workingTreeChanges = changes;
    repository.state.untrackedChanges = untracked;
    let enumerations = 0;
    for (const entries of [changes, untracked]) {
      const iterator = entries[Symbol.iterator].bind(entries);
      entries[Symbol.iterator] = () => {
        enumerations++;
        return iterator();
      };
    }
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    const repositoryFor = git.repositoryFor.bind(git);
    let active = 0;
    let peak = 0;
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let batchStarted = (): void => {};
    const started = new Promise<void>(resolve => { batchStarted = resolve; });
    child.mock.method(git, 'repositoryFor', async (uri?: vscode.Uri) => {
      active++;
      peak = Math.max(peak, active);
      if (active === 8) { batchStarted(); }
      await gate;
      try { return await repositoryFor(uri); }
      finally { active--; }
    });

    const result = git.filesToReview(repo, new Set());
    try {
      await started;
      assert.equal(active, 8);
    } finally {
      release();
    }
    assert.equal((await result).length, 65);
    assert.equal(peak, 8);
    assert.equal(active, 0);
    assert.equal(enumerations, 4, 'each Git group is enumerated for capture and final membership only');
    assert.deepEqual(diffCalls, []);
    assert.deepEqual(reads, []);
  });

  await t.test('candidate discovery rejects unsupported leaves but keeps all Git-listed missing paths', async () => {
    reset();
    for (const [name, type] of [['directory', 2], ['unknown', 0], ['symlink', 65]] as const) {
      put(`/repo/${name}`, '', type);
    }
    repository.state.workingTreeChanges = [
      change('/repo/directory', GitStatus.Modified), change('/repo/unknown', GitStatus.Modified),
      change('/repo/symlink', GitStatus.Modified), change('/repo/missing', GitStatus.Modified),
      change('/repo/deleted', GitStatus.Deleted),
    ];
    repository.state.untrackedChanges = [change('/repo/untracked-missing', GitStatus.Untracked)];
    const repo = await git.workspaceRepository();
    assert.ok(repo);

    assert.deepEqual(await git.filesToReview(repo, new Set()), [
      { path: 'deleted', uri: file('/repo/deleted'), untracked: false },
      { path: 'missing', uri: file('/repo/missing'), untracked: false },
      { path: 'untracked-missing', uri: file('/repo/untracked-missing'), untracked: true },
    ]);
    assert.deepEqual(diffCalls, []);
    assert.deepEqual(reads, []);
  });

  for (const untracked of [false, true]) {
    await t.test(`${untracked ? 'untracked' : 'tracked'} URI-key work scales linearly with fresh API arrays and state wrappers`, async () => {
      const measurements: { discovery: number; statistics: number }[] = [];
      for (const count of [32, 128]) {
        reset();
        let comparisons = 0;
        let arrayReads = 0;
        const changes = Array.from({ length: count }, (_, index) => {
          const uri = new class extends Uri {
            override toString(): string { comparisons++; return super.toString(); }
          }();
          uri.path = `/repo/file-${index}.ts`;
          put(uri.fsPath, 'source\n');
          return { uri, status: untracked ? GitStatus.Untracked : GitStatus.Modified } satisfies GitChange;
        });
        Object.defineProperty(repository, 'state', {
          get: () => ({
            get workingTreeChanges() { arrayReads++; return changes.map(entry => ({ ...entry })); },
            get untrackedChanges() { arrayReads++; return []; },
            onDidChange: gitChanged.event,
          } satisfies Repository['state']),
        });
        const repo = await git.workspaceRepository();
        assert.ok(repo);

        const candidates = await git.filesToReview(repo, new Set());
        const discovery = comparisons;
        assert.equal(candidates.length, count);
        assert.equal(arrayReads, 4, 'one union capture and one forced final capture');
        comparisons = 0;
        arrayReads = 0;
        assert.equal((await git.fileStatistics(repo, candidates, () => true)).size, count);
        measurements.push({ discovery, statistics: comparisons });
        assert.equal(arrayReads, 4, 'statistics reuse the full Git list between state events');
        assert.equal(gitChanged.listeners.size, 0);
      }
      for (const phase of ['discovery', 'statistics'] as const) {
        assert.ok(measurements[1][phase] <= measurements[0][phase] * 4.2,
          `${phase}: quadrupling files must not quadruple repeated full-list scans: ${JSON.stringify(measurements)}`);
      }
    });
  }

  for (const mutation of ['remove', 'classification', 'event source'] as const) {
    await t.test(`${mutation} invalidates local membership before an untracked content read`, async child => {
      reset();
      const target = '/repo/source.ts';
      put(target, 'source\n');
      const changes = [change(target, GitStatus.Untracked)];
      repository.state.workingTreeChanges = changes;
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      const candidates = await git.filesToReview(repo, new Set());
      const repositoryFor = git.repositoryFor.bind(git);
      let changed = false;
      const replacementEvents = new EventEmitter();
      child.mock.method(git, 'repositoryFor', async (uri?: vscode.Uri) => {
        const owner = await repositoryFor(uri);
        if (!changed) {
          changed = true;
          if (mutation === 'event source') {
            repository.state = { ...repository.state, workingTreeChanges: [], onDidChange: replacementEvents.event };
          } else {
            // Same array identity, including a same-length classification change.
            changes.splice(0, 1, ...(mutation === 'classification' ? [change(target, GitStatus.Modified)] : []));
            gitChanged.fire();
          }
        }
        return owner;
      });

      assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), new Map());
      assert.deepEqual(reads, []);
      assert.deepEqual(diffCalls, []);
      assert.equal(gitChanged.listeners.size, 0);
      assert.equal(replacementEvents.listeners.size, 0);
    });
  }

  for (const phase of ['candidates', 'statistics'] as const) {
    await t.test(`${phase} live state getter failures reject and dispose membership listeners`, async child => {
      reset();
      const target = '/repo/source.ts';
      put(target, 'source\n');
      repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      const candidates = await git.filesToReview(repo, new Set());
      const state = repository.state;
      const failure = new Error('Synthetic live state access failure');
      let fail = false;
      Object.defineProperty(repository, 'state', { get: () => {
        if (fail) { throw failure; }
        return state;
      } });
      const repositoryFor = git.repositoryFor.bind(git);
      child.mock.method(git, 'repositoryFor', async (uri?: vscode.Uri) => {
        const owner = await repositoryFor(uri);
        fail = true;
        return owner;
      });

      const result = phase === 'candidates' ? git.filesToReview(repo, new Set()) : git.fileStatistics(repo, candidates, () => true);
      await assert.rejects(result, error => error === failure);
      assert.equal(gitChanged.listeners.size, 0);
      assert.deepEqual(diffCalls, []);
      assert.deepEqual(reads, []);
    });
  }

  for (const untracked of [false, true]) {
    await t.test(`missing ${untracked ? 'untracked' : 'tracked'} disk content cannot confirm candidate removal`, async () => {
      reset();
      const target = '/repo/source.ts';
      put(target, 'source\n');
      repository.state.workingTreeChanges = [change(target, untracked ? GitStatus.Untracked : GitStatus.Modified)];
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      const candidates = await git.filesToReview(repo, new Set());
      assert.equal(candidates.length, 1);

      files.delete(target);
      diffs.set(target, new Error('Synthetic unavailable diff'));
      assert.deepEqual(await git.filesToReview(repo, new Set()), candidates, 'wait for Git state, not disk disappearance');
      assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), new Map([['source.ts', {}]]));
      assert.equal(candidates.length, 1);

      repository.state.workingTreeChanges = [];
      assert.deepEqual(await git.filesToReview(repo, new Set()), [], 'Git confirmation removes the candidate');
    });
  }

  for (const phase of ['initial', 'final'] as const) {
    await t.test(`obsolete discovery drains its ${phase} ownership batch and stops further work`, async child => {
      reset();
      const changes = Array.from({ length: 65 }, (_, index) => change(`/repo/file-${index}.ts`, GitStatus.Modified));
      repository.state.workingTreeChanges = changes;
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      let current = true;
      let active = 0;
      let calls = 0;
      let release = (): void => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      let batchStarted = (): void => {};
      const started = new Promise<void>(resolve => { batchStarted = resolve; });
      const repositoryFor = git.repositoryFor.bind(git);
      child.mock.method(git, 'repositoryFor', async (uri?: vscode.Uri) => {
        calls++;
        const owner = await repositoryFor(uri);
        if (phase === 'initial' || calls > 65) {
          active++;
          if (active === 8) { batchStarted(); }
          await gate;
          active--;
        }
        return owner;
      });
      let settled = false;
      const result = git.filesToReview(repo, new Set(), [], () => current).finally(() => { settled = true; });
      try {
        await started;
        current = false;
        assert.equal(settled, false);
        stats = [];
      } finally {
        release();
      }

      assert.deepEqual(await result, []);
      assert.equal(active, 0);
      assert.equal(calls, phase === 'initial' ? 8 : 73);
      assert.equal(gitChanged.listeners.size, 0, 'cancelled discovery releases its local listener');
      assert.deepEqual(stats, [], 'no leaf validation follows cancelled ownership awaits');
      assert.deepEqual(diffCalls, []);
      assert.deepEqual(reads, []);
      child.mock.method(git, 'workspaceRepository', async () => assert.fail('obsolete discovery must not initialize'));
      assert.deepEqual(await git.filesToReview(repo, new Set(), [], () => false), []);
    });
  }

  await t.test('discovery cancelled during workspace validation never launches candidate ownership work', async child => {
    reset();
    repository.state.workingTreeChanges = [change('/repo/source.ts', GitStatus.Modified)];
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    let current = true;
    child.mock.method(git, 'workspaceRepository', async () => {
      current = false;
      return repo;
    });
    child.mock.method(git, 'repositoryFor', async () => assert.fail('cancelled discovery must not validate candidates'));

    assert.deepEqual(await git.filesToReview(repo, new Set(), [], () => current), []);
    assert.deepEqual(stats, []);
  });

  for (const untracked of [false, true]) {
    await t.test(`cancelled background ${untracked ? 'reads' : 'diffs'} drain the batch and launch no further work`, async () => {
      reset();
      const changes = Array.from({ length: 65 }, (_, index) => change(`/repo/file-${index}.ts`,
        untracked ? GitStatus.Untracked : GitStatus.Modified));
      for (const entry of changes) { put(entry.uri.fsPath, 'source\n'); }
      repository.state.workingTreeChanges = changes;
      const candidates = await discover();
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      let current = true;
      let active = 0;
      let operations = 0;
      let release = (): void => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      let batchStarted = (): void => {};
      const started = new Promise<void>(resolve => { batchStarted = resolve; });
      const wait = async (): Promise<void> => {
        operations++;
        active++;
        if (active === 8) { batchStarted(); }
        await gate;
        active--;
      };
      if (untracked) { onRead = wait; }
      else { onDiff = wait; }
      let settled = false;
      const result = git.fileStatistics(repo, candidates, () => current).finally(() => { settled = true; });
      try {
        await started;
        current = false;
        assert.equal(settled, false);
        assert.equal(active, 8);
      } finally {
        release();
      }

      assert.deepEqual(await result, new Map());
      assert.equal(operations, 8, 'no second read or later batch begins');
      assert.equal(active, 0);
      assert.equal(candidates.length, 65, 'cancellation cannot alter the candidate snapshot');
      assert.equal(gitChanged.listeners.size, 0, 'cancelled statistics release their local listener');
      if (untracked) { assert.equal(closedHandles.length, 8); }
      stats = [];
      assert.deepEqual(await git.fileStatistics(repo, candidates, () => false), new Map());
      assert.deepEqual(stats, [], 'already obsolete work does not even validate ownership');
    });
  }

  for (const phase of ['ownership', 'stat', 'open', 'final'] as const) {
    await t.test(`background cancellation during ${phase} prevents further asynchronous work`, async child => {
      reset();
      const target = '/repo/src/new.ts';
      put(target, 'source\n');
      repository.state.untrackedChanges = [change(target, GitStatus.Untracked)];
      const candidates = await discover();
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      let current = true;
      let ownershipChecks = 0;
      const repositoryFor = git.repositoryFor.bind(git);
      child.mock.method(git, 'repositoryFor', async (uri?: vscode.Uri) => {
        ownershipChecks++;
        const owner = await repositoryFor(uri);
        if (phase === 'ownership' || (phase === 'final' && ownershipChecks === 5)) { current = false; }
        return owner;
      });
      let leafStats = 0;
      onStat = async uri => {
        if (uri.fsPath === target && ++leafStats === 3 && phase === 'stat') { current = false; }
      };
      onOpen = () => {
        if (phase === 'open') { current = false; }
      };

      assert.deepEqual(await git.fileStatistics(repo, candidates, () => current), new Map());
      assert.equal(current, false, 'the requested cancellation phase was reached');
      assert.deepEqual(diffCalls, []);
      if (phase === 'ownership' || phase === 'stat') {
        assert.deepEqual(reads, []);
        assert.equal(ownershipChecks, 1, 'untracked validation callback observes cancellation');
      } else {
        assert.deepEqual(closedHandles, [target]);
      }
      if (phase !== 'final') { assert.deepEqual(readBudget, new Map()); }
    });
  }

  await t.test('discovery final ownership rejects a boundary introduced after the initial validation', async child => {
    reset();
    const target = '/repo/src/a.ts';
    put(target, 'source\n');
    repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    const repositoryFor = git.repositoryFor.bind(git);
    let checks = 0;
    child.mock.method(git, 'repositoryFor', async (uri?: vscode.Uri) => {
      if (++checks === 2) { markers.set('/repo/src/.git', 2); }
      return repositoryFor(uri);
    });

    assert.deepEqual(await git.filesToReview(repo, new Set()), []);
    assert.equal(checks, 2);
    assert.deepEqual(diffCalls, []);
  });

  await t.test('archive storage inside an opened folder is excluded before any stats reads', async () => {
    reset();
    repository.state.workingTreeChanges = [change('/repo/storage/reviews/batch.json'), change('/repo/source.ts')];
    repository.state.untrackedChanges = [change('/repo/storage/reviews/new.json', GitStatus.Untracked)];
    put('/repo/source.ts', 'source\n');
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    const result = await git.filesToReview(repo, new Set(), [file('/repo/storage')]);
    assert.deepEqual(result.map(row => row.path), ['source.ts']);
    assert.deepEqual(diffCalls, []);
    assert.deepEqual(reads, []);
    assert.ok(stats.every(target => !target.startsWith('/repo/storage')));
  });

  await t.test('notes exclude paths regardless of provenance until cleared; staging is reviewer-controlled', async () => {
    reset();
    const target = change('/repo/src/a.ts');
    const noted = new Set(['src\\a.ts']); // A caller may collect this path from any origin, including stale notes.
    repository.state.workingTreeChanges = [target];
    assert.deepEqual(await list(noted), []);
    assert.deepEqual(diffCalls, []);
    noted.clear();
    assert.deepEqual(await list(noted), [{ path: 'src/a.ts', insertions: 2, deletions: 1 }]);
    repository.state.indexChanges = [target];
    repository.state.workingTreeChanges = [];
    assert.deepEqual(await list(), [], 'index-only files are not candidates');
    repository.state.indexChanges = [];
    repository.state.workingTreeChanges = [target];
    assert.equal((await list()).length, 1, 'unstaging restores the disk change');
    repository.state.indexChanges = [target];
    diffs.set(target.uri.fsPath, '@@ -1 +1 @@\n-staged\n+unstaged\n');
    assert.deepEqual(await list(), [{ path: 'src/a.ts', insertions: 1, deletions: 1 }], 'partial staging retains only index-to-disk counts');
    repository.state.workingTreeChanges = [];
    assert.deepEqual(await list(), []);
  });

  await t.test('unions and deduplicates groups and sorts paths without locale dependence', async () => {
    reset();
    repository.state.workingTreeChanges = [change('/repo/z.ts'), change('/repo/A.ts'), change('/repo/z.ts'), change('/repo/new.ts', GitStatus.Untracked)];
    repository.state.untrackedChanges = [change('/repo/new.ts'), change('/repo/a.ts')];
    put('/repo/new.ts', 'new\n');
    put('/repo/a.ts', 'one\ntwo');
    assert.deepEqual(await list(), [
      { path: 'A.ts', insertions: 2, deletions: 1 }, { path: 'a.ts', insertions: 2, deletions: 0 },
      { path: 'new.ts', insertions: 1, deletions: 0 }, { path: 'z.ts', insertions: 2, deletions: 1 },
    ]);
    assert.deepEqual(diffCalls, ['/repo/A.ts', '/repo/z.ts']);
    assert.deepEqual(reads, ['/repo/a.ts', '/repo/new.ts']);
    repository.state.workingTreeChanges = undefined;
    repository.state.untrackedChanges = undefined;
    assert.deepEqual(await list(), []);
  });

  for (const untracked of [false, true]) {
    await t.test(`65 ${untracked ? 'untracked reads' : 'tracked diffs'} overlap with bounded concurrency`, async () => {
      reset();
      const targets = Array.from({ length: 65 }, (_, index) => `/repo/file-${String(index).padStart(2, '0')}.ts`);
      const changes = targets.map(target => change(target, untracked ? GitStatus.Untracked : GitStatus.Modified));
      if (untracked) {
        repository.state.untrackedChanges = changes;
        for (const target of targets) { put(target, 'source\n'); }
      } else {
        repository.state.workingTreeChanges = changes;
      }
      let release = (): void => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      let batchStarted = (): void => {};
      const started = new Promise<void>(resolve => { batchStarted = resolve; });
      let active = 0;
      let peak = 0;
      const wait = async (): Promise<void> => {
        active++;
        peak = Math.max(peak, active);
        if (active === 8) { batchStarted(); }
        await gate;
        active--;
      };
      if (untracked) { onRead = wait; }
      else { onDiff = wait; }

      const result = list();
      try {
        await started;
        assert.equal(active, 8, 'multiple independent files progress before the first completes');
      } finally {
        release();
      }

      assert.deepEqual(await result, targets.map(target => ({
        path: target.slice('/repo/'.length), insertions: untracked ? 1 : 2, deletions: untracked ? 0 : 1,
      })));
      assert.equal(peak, 8, 'large lists do not start unbounded Git processes or allocate unbounded read buffers');
      assert.equal(active, 0);
      assert.deepEqual(untracked ? reads : diffCalls, targets);
      if (untracked) { assert.deepEqual(closedHandles, targets); }
    });
  }

  await t.test('a failed parallel ownership check drains outstanding reads and starts no later batch', async () => {
    reset();
    repository.state.workingTreeChanges = Array.from({ length: 65 }, (_, index) => change(`/repo/file-${index}.ts`));
    const candidates = await discover();
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    const failure = Object.assign(new Error('Synthetic boundary failure'), { code: 'NoPermissions' });
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let batchStarted = (): void => {};
    const started = new Promise<void>(resolve => { batchStarted = resolve; });
    let failed = false;
    onStat = async uri => {
      if (uri.path === '/repo/file-0.ts') {
        failed = true;
        throw failure;
      }
    };
    let active = 0;
    onDiff = async () => {
      active++;
      if (active === 7) { batchStarted(); }
      await gate;
      active--;
    };
    let settled = false;
    const result = git.fileStatistics(repo, candidates, () => true).finally(() => { settled = true; });
    const rejected = assert.rejects(result, { cause: failure });
    try {
      await started;
      assert.equal(failed, true);
      assert.equal(settled, false, 'refresh cannot finish while its other reads are still running');
    } finally {
      release();
    }
    await rejected;
    assert.equal(active, 0);
    assert.equal(diffCalls.length, 7, 'failure stops work before the next batch');
    assert.deepEqual(addCalls, []);
    assert.deepEqual(cleanCalls, []);
  });

  await t.test('final ownership pass rejects a boundary that changed after statistics validation', async child => {
    reset();
    const target = '/repo/src/a.ts';
    repository.state.workingTreeChanges = [change(target)];
    const candidates = await discover();
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    const repositoryFor = git.repositoryFor.bind(git);
    let checks = 0;
    child.mock.method(git, 'repositoryFor', async (uri?: vscode.Uri) => {
      if (uri?.fsPath === target && ++checks === 3) {
        markers.set('/repo/src/.git', 2);
      }
      return repositoryFor(uri);
    });

    assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), new Map());
    assert.deepEqual(candidates.map(candidate => candidate.path), ['src/a.ts'], 'statistics cannot remove the published candidate');
    assert.equal(checks, 3);
    assert.deepEqual(diffCalls, [target]);
  });

  for (const phase of ['candidates', 'statistics'] as const) {
    await t.test(`${phase} final membership excludes a validated result removed while a sibling final check waits`, async child => {
      reset();
      let changes = [change('/repo/a.ts'), change('/repo/b.ts')];
      repository.state.workingTreeChanges = changes;
      const candidates = await discover();
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      const finalCheck = phase === 'candidates' ? 2 : 3;
      const repositoryFor = git.repositoryFor.bind(git);
      const checks = new Map<string, number>();
      let firstChecked = (): void => {};
      const first = new Promise<void>(resolve => { firstChecked = resolve; });
      let firstOwnershipFinished = false;
      repository.state = {
        ...repository.state,
        get workingTreeChanges() { return changes; },
      };
      onStat = async uri => {
        // Release only when a's final ownership walk has returned to leaf validation.
        if (uri.path === '/repo/a.ts' && firstOwnershipFinished) { firstChecked(); }
      };
      child.mock.method(git, 'repositoryFor', async (uri?: vscode.Uri) => {
        assert.ok(uri);
        const count = (checks.get(uri.fsPath) ?? 0) + 1;
        checks.set(uri.fsPath, count);
        if (uri.fsPath === '/repo/b.ts' && count === finalCheck) {
          await first;
          // Deliberately omit an event: the forced final read must still catch it.
          changes = [change('/repo/b.ts')];
        }
        const owner = await repositoryFor(uri);
        if (uri.fsPath === '/repo/a.ts' && count === finalCheck) { firstOwnershipFinished = true; }
        return owner;
      });

      if (phase === 'candidates') {
        assert.deepEqual((await git.filesToReview(repo, new Set())).map(candidate => candidate.path), ['b.ts']);
        assert.deepEqual(diffCalls, []);
      } else {
        assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), new Map([['b.ts', { insertions: 2, deletions: 1 }]]));
      }
      assert.deepEqual(candidates.map(candidate => candidate.path), ['a.ts', 'b.ts']);
      assert.equal(checks.get('/repo/a.ts'), finalCheck);
      assert.equal(checks.get('/repo/b.ts'), finalCheck);
    });
  }

  for (const phase of ['candidates', 'statistics'] as const) {
    await t.test(`${phase} final ownership failure drains sibling checks without starting another validation batch`, async child => {
      reset();
      repository.state.workingTreeChanges = Array.from({ length: 65 }, (_, index) => change(`/repo/file-${index}.ts`));
      const candidates = await discover();
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      const finalCheck = phase === 'candidates' ? 2 : 3;
      const repositoryFor = git.repositoryFor.bind(git);
      const checks = new Map<string, number>();
      const failure = new Error('Synthetic final ownership failure');
      let release = (): void => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      let batchStarted = (): void => {};
      const started = new Promise<void>(resolve => { batchStarted = resolve; });
      let active = 0;
      child.mock.method(git, 'repositoryFor', async (uri?: vscode.Uri) => {
        assert.ok(uri);
        const count = (checks.get(uri.fsPath) ?? 0) + 1;
        checks.set(uri.fsPath, count);
        if (count === finalCheck) {
          if (uri.fsPath === '/repo/file-0.ts') { throw failure; }
          active++;
          if (active === 7) { batchStarted(); }
          await gate;
          active--;
        }
        return repositoryFor(uri);
      });
      let settled = false;
      const work = phase === 'candidates' ? git.filesToReview(repo, new Set()) : git.fileStatistics(repo, candidates, () => true);
      const result = work.finally(() => { settled = true; });
      const rejected = assert.rejects(result, error => error === failure);
      try {
        await started;
        assert.equal(settled, false);
        assert.equal(diffCalls.length, phase === 'candidates' ? 0 : 65);
      } finally {
        release();
      }
      await rejected;
      assert.equal(active, 0);
      assert.equal([...checks.values()].filter(count => count === finalCheck).length, 8);
      const laterPath = phase === 'candidates' ? '/repo/file-8.ts' : candidates[8].uri.fsPath;
      assert.equal(checks.get(laterPath), finalCheck - 1, 'no later validation batch starts');
    });
  }

  await t.test('excludes review filenames and temporary siblings anywhere, not metadata-like source names', async () => {
    reset();
    const excluded = ['REVIEW-NOTES.md', '.REVIEW-NOTES.md.id.tmp',
      'nested/REVIEW-NOTES.md', 'nested/.REVIEW-NOTES.md.any.part.tmp'];
    const allowed = ['REVIEW-NOTES.md.ts', 'other.md', 'nested/other.md', '.REVIEW-NOTES.md.id.tmp.ts',
      'Comparison: Original -> Modified.ts', 'Selected: HEAD.ts', '+++.ts', '---.ts', 'space name.ts'];
    repository.state.workingTreeChanges = [...excluded, ...allowed].map(name => change(`/repo/${name}`));
    repository.state.untrackedChanges = excluded.map(name => change(`/repo/${name}`, GitStatus.Untracked));
    assert.deepEqual((await list()).map(row => row.path), [...allowed].sort());
    assert.deepEqual([...diffCalls].sort(), allowed.map(name => `/repo/${name}`).sort());
    assert.deepEqual(reads, []);
    assert.ok(stats.every(target => !excluded.some(name => target === `/repo/${name}`)), 'no review data is statted or read');
  });

  await t.test('subfolder adapters exclude outside, nested, undiscovered, and submodule resources before statistics', async () => {
    reset();
    workspace.workspaceFolders = [{ uri: Uri.file('/repo/packages/app') }];
    repositories.push({ ...repository, rootUri: file('/repo/packages/app/nested') });
    repository.state.submodules = [{ path: 'packages/app/module' }];
    markers.set('/repo/packages/app/closed/.git', 1);
    const rejected = ['/repo/outside.ts', '/repo/packages/other.ts', '/repo/packages/app/nested/a.ts',
      '/repo/packages/app/closed/a.ts', '/repo/packages/app/module/a.ts'];
    repository.state.workingTreeChanges = [...rejected.map(target => change(target)), change('/repo/packages/app/src/a.ts')];
    repository.state.untrackedChanges = rejected.map(target => change(target, GitStatus.Untracked));
    assert.deepEqual(await list(), [{ path: 'src/a.ts', insertions: 2, deletions: 1 }]);
    assert.deepEqual(diffCalls, ['/repo/packages/app/src/a.ts']);
    assert.deepEqual(reads, []);
    assert.ok(stats.every(target => !target.endsWith('/REVIEW-NOTES.md')));
    assert.deepEqual(await list(new Set(['src/a.ts'])), []);
  });

  await t.test('unsupported and malformed URIs fail closed without diff or source reads', async () => {
    reset();
    repository.state.workingTreeChanges = [
      Uri.from({ scheme: 'git', path: '/repo/a.ts', query: 'broken' }),
      Uri.from({ scheme: 'untitled', path: '/repo/a.ts' }),
      Uri.from({ path: '/repo/a.ts', query: 'query' }),
      Uri.from({ path: '/repo/a.ts', fragment: 'fragment' }),
      Uri.from({ path: '/repo/a.ts', authority: 'remote' }),
      Uri.file('/repo/../outside.ts'), Uri.file('/repo'), Uri.file('/repo/back`tick.ts'),
    ].map(uri => ({ uri } satisfies GitChange));
    assert.deepEqual(await list(), []);
    assert.deepEqual(diffCalls, []);
    assert.deepEqual(reads, []);
  });

  await t.test('initial repository discovery errors reject instead of confirming an empty batch', async child => {
    reset();
    const adapter = await git.workspaceRepository();
    assert.ok(adapter);
    const failure = new Error('Synthetic discovery failure');
    child.mock.getter(api, 'repositories', () => { throw failure; });

    await assert.rejects(git.filesToReview(adapter, new Set()), error => error === failure);
    assert.deepEqual(diffCalls, []);
    assert.deepEqual(reads, []);
  });

  for (const phase of ['enumeration', 'membership'] as const) {
    await t.test(`Git state access failure during ${phase} rejects instead of excluding candidates`, async () => {
      reset();
      const changes = [change('/repo/a.ts')];
      let armed = phase === 'enumeration';
      let failures = 0;
      const failure = new Error('Synthetic Git state unavailable');
      repository.state = {
        ...repository.state,
        get workingTreeChanges() {
          if (armed && failures === 0) {
            failures++;
            throw failure;
          }
          return changes;
        },
      };
      onDiff = async () => { armed = true; gitChanged.fire(); };

      await assert.rejects(list(), error => error === failure);
      assert.equal(failures, 1);
      assert.deepEqual(await list(), [{ path: 'a.ts', insertions: 2, deletions: 1 }]);
    });
  }

  for (const phase of ['workspace', 'resource', 'after diff', 'final batch'] as const) {
    await t.test(`one-shot boundary stat failure during ${phase} rejects the whole candidate batch`, async () => {
      reset();
      workspace.workspaceFolders = [{ uri: Uri.file('/repo/packages/app') }];
      const first = '/repo/packages/app/src/a.ts';
      const second = '/repo/packages/app/src/b.ts';
      repository.state.workingTreeChanges = [change(first), change(second)];
      const adapter = await git.workspaceRepository();
      assert.ok(adapter);
      const failure = Object.assign(new Error('Synthetic boundary access failure'), { code: 'NoPermissions' });
      let armed = phase === 'workspace' || phase === 'resource';
      let failures = 0;
      onDiff = async target => {
        if (phase === 'after diff' || (phase === 'final batch' && target === second)) {
          armed = true;
        }
      };
      onStat = async uri => {
        const target = phase === 'workspace' ? '/repo/packages/app' : first;
        if (armed && failures === 0 && uri.path === target) {
          failures++;
          throw failure;
        }
      };

      await assert.rejects(list(), { cause: failure });
      assert.equal(failures, 1);
      assert.deepEqual(await list(), [
        { path: 'src/a.ts', insertions: 2, deletions: 1 },
        { path: 'src/b.ts', insertions: 2, deletions: 1 },
      ], 'A later refresh can retry, but the failed batch must not publish partial rows');
    });
  }

  for (const phase of ['after stat', 'after open'] as const) {
    await t.test(`untracked ownership failure ${phase} is not swallowed as unavailable statistics`, async child => {
      reset();
      const target = '/repo/src/new.ts';
      put(target, 'source\n');
      repository.state.untrackedChanges = [change(target, GitStatus.Untracked)];
      const candidates = await discover();
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      const failure = Object.assign(new Error('Synthetic ownership failure'), { code: 'Unavailable' });
      const repositoryFor = git.repositoryFor.bind(git);
      let checks = 0;
      child.mock.method(git, 'repositoryFor', async (uri?: vscode.Uri) => {
        if (++checks === (phase === 'after stat' ? 2 : 3)) {
          markers.set(target, failure);
        }
        return repositoryFor(uri);
      });

      await assert.rejects(git.fileStatistics(repo, candidates, () => true), { cause: failure });
      assert.deepEqual(readBudget, new Map());
      assert.deepEqual(closedHandles, phase === 'after open' ? [target] : []);
      markers.delete(target);
      assert.deepEqual(await list(), [{ path: 'src/new.ts', insertions: 1, deletions: 0 }]);
    });
  }

  await t.test('untracked statistics-only stat failure retains an authorized row with unavailable counts', async () => {
    reset();
    const target = '/repo/src/new.ts';
    put(target, 'source\n');
    repository.state.untrackedChanges = [change(target, GitStatus.Untracked)];
    const candidates = await discover();
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    let fileStats = 0;
    onStat = async uri => {
      if (uri.path === target && ++fileStats === 3) {
        throw Object.assign(new Error('Synthetic statistics failure'), { code: 'Unavailable' });
      }
    };

    assert.deepEqual(await git.fileStatistics(repo, candidates, () => true), new Map([['src/new.ts', {}]]));
    assert.deepEqual(candidates.map(candidate => candidate.path), ['src/new.ts']);
    assert.deepEqual(reads, []);
  });

  await t.test('counts only hunk lines, including literal +++/--- source, multiple hunks and deletions', async () => {
    reset();
    repository.state.workingTreeChanges = [change('/repo/literal.ts'), change('/repo/deleted.ts'), change('/repo/mode.ts')];
    diffs.set('/repo/literal.ts', ['diff --git a/literal.ts b/literal.ts', '--- a/literal.ts', '+++ b/literal.ts',
      '@@ -1,3 +1,3 @@ function', ' context', '--- old source', '-old', '+++ new source', '+new',
      '\\ No newline at end of file', '@@ -20,0 +21 @@', '+last', '\\ No newline at end of file',
      '--- outside hunk', '+++ outside hunk', ''].join('\n'));
    diffs.set('/repo/deleted.ts', '--- a/deleted.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-first\n-second\n');
    diffs.set('/repo/mode.ts', 'diff --git a/mode.ts b/mode.ts\nold mode 100644\nnew mode 100755\n');
    assert.deepEqual(await list(), [
      { path: 'deleted.ts', insertions: 0, deletions: 2 }, { path: 'literal.ts', insertions: 3, deletions: 2 },
      { path: 'mode.ts', insertions: 0, deletions: 0 },
    ]);
    assert.deepEqual(reads, [], 'deleted disk paths are never read');
  });

  await t.test('binary and failed diffs retain rows without counts; unavailable API remains unavailable on live adapters', async () => {
    reset();
    repository.state.workingTreeChanges = ['binary', 'patch', 'failure', 'empty'].map(name => change(`/repo/${name}`));
    diffs.set('/repo/binary', 'diff --git a/binary b/binary\nBinary files a/binary and b/binary differ\n');
    diffs.set('/repo/patch', 'diff --git a/patch b/patch\nGIT binary patch\nliteral 123\n');
    diffs.set('/repo/failure', new Error('synthetic Git failure'));
    diffs.set('/repo/empty', '');
    assert.deepEqual(await list(), [{ path: 'binary' }, { path: 'empty', insertions: 0, deletions: 0 }, { path: 'failure' }, { path: 'patch' }]);
    const adapter = await git.workspaceRepository();
    assert.ok(adapter);
    repository = { ...repository, diffWithHEAD: undefined };
    repositories = [repository];
    assert.equal(adapter.diffWithHEAD, undefined);
    assert.deepEqual(await list(), ['binary', 'empty', 'failure', 'patch'].map(path => ({ path })));
    repository.diffWithHEAD = async function (target) {
      assert.equal(this, repository);
      assert.ok(target.startsWith('/repo/'));
      return patch;
    };
    assert.ok((await list()).every(row => row.insertions === 2));
  });

  await t.test('untracked status 7 in mixed working groups uses bounded disk byte statistics', async () => {
    reset();
    const contents = new Map<string, string | Uint8Array>([
      ['empty', ''], ['terminated', 'one\ntwo\n'], ['unterminated', 'one\ntwo'], ['crlf', 'one\r\ntwo\r\n'],
      ['cr', 'one\rtwo'], ['blank', '\n'], ['bom', '\ufeff'], ['utf8', 'caf\u00e9\n'],
      ['binary', new Uint8Array([97, 0, 10])], ['invalid', new Uint8Array([0xc3, 0x28])],
      ['nul7999', new Uint8Array([...new Uint8Array(7999).fill(97), 0])],
      ['nul8000', new Uint8Array([...new Uint8Array(8000).fill(97), 0])],
      ['oversized', 'not read'], ['grew', new Uint8Array(5 * 1024 * 1024 + 1).fill(97)],
    ]);
    for (const [name, bytes] of contents) {
      let size: number | undefined;
      if (name === 'oversized') {
        size = 5 * 1024 * 1024 + 1;
      } else if (name === 'grew') {
        size = 1;
      }
      put(`/repo/${name}`, bytes, 1, size);
    }
    repository.state.workingTreeChanges = [...contents.keys()].map(name => change(`/repo/${name}`, GitStatus.Untracked));
    const result = new Map((await list()).map(row => [row.path, row]));
    for (const [name, count] of [['empty', 0], ['terminated', 2], ['unterminated', 2], ['crlf', 2], ['cr', 1],
      ['blank', 1], ['bom', 1], ['utf8', 1], ['nul8000', 1]] as const) {
      assert.deepEqual(result.get(name), { path: name, insertions: count, deletions: 0 });
    }
    for (const name of ['binary', 'invalid', 'nul7999', 'oversized', 'grew']) { assert.deepEqual(result.get(name), { path: name }); }
    assert.equal(reads.includes('/repo/oversized'), false);
    assert.deepEqual(diffCalls, []);
  });

  await t.test('untracked directories and symlinks are rejected; missing leaves and read errors preserve rows', async () => {
    reset();
    for (const [name, type] of [['directory', 2], ['symlink', 64], ['symlinkFile', 65], ['symlinkDir', 66], ['unknown', 0]] as const) {
      put(`/repo/${name}`, 'never read', type);
    }
    put('/repo/readError', 'source');
    onRead = async () => { throw new Error('synthetic read failure'); };
    repository.state.untrackedChanges = ['directory', 'symlink', 'symlinkFile', 'symlinkDir', 'unknown', 'statError', 'readError']
      .map(name => change(`/repo/${name}`));
    assert.deepEqual(await list(), [{ path: 'readError' }, { path: 'statError' }]);
    assert.deepEqual(reads, ['/repo/readError']);
    assert.deepEqual(diffCalls, []);
  });

  await t.test('bounded reads handle short reads, exact limits, growth and always close handles', async () => {
    const limit = 5 * 1024 * 1024;
    for (const kind of ['short', 'exact', 'grew', 'openGrowth', 'failure'] as const) {
      reset();
      const target = '/repo/source';
      const content = kind === 'short' ? 'one\ntwo\n' : new Uint8Array(limit + (kind === 'grew' ? 100 : 0)).fill(97);
      put(target, content, 1, kind === 'grew' ? 1 : undefined);
      repository.state.untrackedChanges = [change(target, GitStatus.Untracked)];
      readChunk = kind === 'short' ? 2 : 1024 * 1024;
      if (kind === 'openGrowth') {
        onOpen = () => { put(target, 'not read', 1, limit + 1); };
      }
      if (kind === 'failure') {
        onRead = async () => { throw new Error('synthetic read failure'); };
      }

      const rows = await list();

      if (kind === 'short' || kind === 'exact') {
        assert.deepEqual(rows, [{ path: 'source', insertions: kind === 'short' ? 2 : 1, deletions: 0 }]);
      } else {
        assert.deepEqual(rows, [{ path: 'source' }]);
      }
      const expectedBytes = { short: 8, exact: limit, grew: limit + 1, openGrowth: 0, failure: 0 };
      assert.equal(readBudget.get(target) ?? 0, expectedBytes[kind]);
      assert.deepEqual(closedHandles, [target]);
    }
  });

  await t.test('POSIX backslash identities never alias a row or mutation target', async () => {
    if (path.sep !== '/') { return; }
    reset();
    documents = [];
    const literal = '/repo/src\\a.ts';
    const normalized = '/repo/src/a.ts';
    put(literal, 'literal');
    put(normalized, 'normalized');
    repository.state.workingTreeChanges = [change(literal, GitStatus.Modified), change(normalized, GitStatus.Modified)];
    const repo = await git.workspaceRepository();
    assert.ok(repo);

    assert.deepEqual(await list(), [{ path: 'src/a.ts', insertions: 2, deletions: 1 }]);
    assert.deepEqual(diffCalls, [normalized]);
    for (const action of ['stageFile', 'revertFile'] as const) {
      await assert.rejects(git[action](repo, 'src\\a.ts', new Set(), [], () => {}), /backslashes/);
    }
    assert.deepEqual(addCalls, []);
    assert.deepEqual(cleanCalls, []);
  });

  await t.test('symlink ancestors block tracked/untracked statistics and both mutations', async () => {
    for (const type of [64, 65, 66]) {
      reset();
      documents = [];
      put('/repo/src', '', type);
      put('/repo/src/a.ts', 'outside source');
      repository.state.workingTreeChanges = [change('/repo/src/a.ts', GitStatus.Modified)];
      repository.state.untrackedChanges = [change('/repo/src/new.ts', GitStatus.Untracked)];
      const repo = await git.workspaceRepository();
      assert.ok(repo);

      assert.deepEqual(await list(), []);
      for (const action of ['stageFile', 'revertFile'] as const) {
        await assert.rejects(git[action](repo, 'src/a.ts', new Set(), [], () => {}), /boundary/);
      }
      assert.deepEqual(reads, []);
      assert.deepEqual(diffCalls, []);
      assert.deepEqual(addCalls, []);
      assert.deepEqual(cleanCalls, []);
    }
  });

  await t.test('final leaf validation rejects type or disappearance changes during ownership awaits', async () => {
    for (const action of ['stageFile', 'revertFile'] as const) {
      for (const replacement of [0, 2, 65, 'missing'] as const) {
        reset();
        documents = [];
        const target = '/repo/src/a.ts';
        put(target, 'source');
        repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
        const repo = await git.workspaceRepository();
        assert.ok(repo);
        let fileStats = 0;
        let replaced = false;
        onStat = async uri => {
          if (uri.path === target) { fileStats++; }
          // First ownership, initial type check, then final ownership's leaf stat.
          // Replace the leaf only when that last ownership walk reaches a parent.
          if (!replaced && fileStats >= 3 && uri.path.endsWith('/.git')) {
            replaced = true;
            if (replacement === 'missing') { files.delete(target); }
            else { put(target, '', replacement); }
          }
        };

        await assert.rejects(git[action](repo, 'src/a.ts', new Set(), [], () => {}), /regular file|missing/);
        assert.equal(replaced, true);
        assert.deepEqual(addCalls, []);
        assert.deepEqual(cleanCalls, []);
      }
    }
  });

  for (const operation of ['ownership', 'stat', 'read', 'diff'] as const) {
    for (const mutation of ['stage', 'remove', 'folder', 'close', 'nested', 'boundaryError'] as const) {
      await t.test(`${mutation} during ${operation} prevents publication`, async () => {
        reset();
        const target = '/repo/src/a.ts';
        const untracked = operation === 'stat' || operation === 'read';
        repository.state.workingTreeChanges = [change(target, untracked ? GitStatus.Untracked : undefined)];
        put(target, 'disk\n');
        const adapter = await git.workspaceRepository();
        assert.ok(adapter);
        const candidates = operation === 'read' || operation === 'diff' ? await git.filesToReview(adapter, new Set()) : undefined;
        let triggered = false;
        const mutate = async () => {
          if (triggered) { return; }
          triggered = true;
          await Promise.resolve();
          if (mutation === 'stage' || mutation === 'remove') {
            repository.state.workingTreeChanges = [];
            repository.state.indexChanges = mutation === 'stage' ? [change(target)] : [];
          }
          if (mutation === 'folder') { workspace.workspaceFolders = [{ uri: Uri.file('/other') }]; }
          if (mutation === 'close') { repositories = []; }
          if (mutation === 'nested') { repositories.push({ ...repository, rootUri: file('/repo/src') }); }
          if (mutation === 'boundaryError') { markers.set('/repo/src/.git', Object.assign(new Error('denied'), { code: 'NoPermissions' })); }
        };
        if (operation === 'ownership') {
          onStat = async uri => {
            if (uri.path.endsWith('/.git')) { await mutate(); }
          };
        }
        if (operation === 'stat') {
          onStat = async uri => {
            if (uri.path === target) { await mutate(); }
          };
        }
        if (operation === 'read') { onRead = mutate; }
        if (operation === 'diff') { onDiff = mutate; }
        if (mutation === 'boundaryError') {
          const result = candidates ? git.fileStatistics(adapter, candidates, () => true) : git.filesToReview(adapter, new Set());
          await assert.rejects(result, /Cannot validate Git repository boundaries/);
        } else if (candidates) {
          assert.deepEqual(await git.fileStatistics(adapter, candidates, () => true), new Map());
          assert.deepEqual(candidates.map(candidate => candidate.path), ['src/a.ts']);
        } else {
          assert.deepEqual(await git.filesToReview(adapter, new Set()), []);
        }
        assert.equal(triggered, true);
        if (operation === 'ownership' || operation === 'stat') {
          assert.deepEqual(reads, []);
          assert.deepEqual(diffCalls, []);
        }
      });
    }
  }

  await t.test('final statistics membership drops counts, not earlier candidates staged while another file awaits', async () => {
    reset();
    repository.state.workingTreeChanges = [change('/repo/a.ts'), change('/repo/b.ts')];
    onDiff = async target => {
      if (target === '/repo/b.ts') {
        await Promise.resolve();
        repository.state.workingTreeChanges = [change('/repo/b.ts')];
        repository.state.indexChanges = [change('/repo/a.ts')];
      }
    };
    assert.deepEqual(await list(), [{ path: 'a.ts' }, { path: 'b.ts', insertions: 2, deletions: 1 }]);
  });

  await t.test('changed tracking classification invalidates statistics and disposal invalidates the batch', async () => {
    for (const mutation of ['classification', 'dispose'] as const) {
      reset();
      repository.state.untrackedChanges = [change('/repo/a.ts')];
      put('/repo/a.ts', 'disk\n');
      onRead = async () => {
        if (mutation === 'dispose') { git.dispose(); }
        else {
          repository.state.untrackedChanges = [];
          repository.state.workingTreeChanges = [change('/repo/a.ts')];
        }
      };
      assert.deepEqual(await list(), [{ path: 'a.ts' }]);
    }
  });
  for (const root of ['/repo', '/repo/packages/app']) {
    await t.test(`Stage File delegates exactly one absolute path from ${root}`, async () => {
      reset();
      workspace.workspaceFolders = [{ uri: Uri.file(root) }];
      const target = `${root}/src/space name.ts`;
      put(target, 'synthetic disk text');
      repository.state.workingTreeChanges = [change(target), change(`${root}/other.ts`), change(target)];
      repository.state.untrackedChanges = [change(target)];
      const adapter = await git.workspaceRepository();
      assert.ok(adapter);
      // Cached adapters must follow replacement Git wrappers, not bind the original wrapper.
      repository = { ...repository };
      repositories = [repository];
      let validations = 0;
      await git.stageFile(adapter, 'src/space name.ts', new Set(), [], () => {
        validations++;
        assert.ok(stats.includes(target), 'host validation follows file stat');
        assert.deepEqual(addCalls, []);
      });
      assert.equal(validations, 1);
      assert.deepEqual(addCalls, [[target]]);
      assert.deepEqual(reads, []);
      assert.deepEqual(diffCalls, []);
      assert.equal(repository.state.workingTreeChanges?.length, 3, 'no optimistic candidate removal');
    });
  }

  await t.test('Stage File accepts binary, new, oversized, deleted and partially staged candidates without statistics', async () => {
    for (const kind of ['binary', 'untracked', 'status7', 'oversized', 'deleted', 'partial']) {
      reset();
      const target = `/repo/${kind}`;
      if (kind !== 'deleted') { put(target, new Uint8Array([0, 255]), 1, kind === 'oversized' ? 6 * 1024 * 1024 : 2); }
      if (kind === 'untracked') { repository.state.untrackedChanges = [change(target)]; }
      else {
        let status = GitStatus.Modified;
        if (kind === 'deleted') {
          status = GitStatus.Deleted;
        } else if (kind === 'status7') {
          status = GitStatus.Untracked;
        }
        repository.state.workingTreeChanges = [change(target, status)];
      }
      if (kind === 'partial') { repository.state.indexChanges = [change(target)]; }
      repository.diffWithHEAD = undefined;
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      await git.stageFile(repo, kind, new Set(), [], () => {});
      assert.deepEqual(addCalls, [[target]], kind);
      assert.deepEqual(reads, []);
      assert.deepEqual(diffCalls, []);
    }
  });

  for (const action of ['stageFile', 'revertFile'] as const) {
    await t.test(`${action} refuses invalid paths, review data, archives, noted and index-only files before source stat`, async () => {
      const rejected = ['', '.', '..', '../outside.ts', '/repo/a.ts', 'C:\\repo\\a.ts', 'src//a.ts', 'a\0.ts',
        '*', '*.ts', '?', '[ab].ts', ':/*', 'REVIEW-NOTES.md', '.REVIEW-NOTES.md.id.tmp',
        'nested/REVIEW-NOTES.md', 'nested/.REVIEW-NOTES.md.id.tmp',
        'storage/reviews/batch.json', 'src/noted.ts', 'index-only.ts', 'unchanged.ts'];
      for (const name of rejected) {
        reset();
        if (action === 'revertFile') { documents = []; }
        const target = `/repo/${name}`;
        put(target, 'synthetic placeholder, never read');
        repository.state.workingTreeChanges = name === 'index-only.ts' || name === 'unchanged.ts' ? [] : [change(target, GitStatus.Modified)];
        repository.state.indexChanges = [change(target, GitStatus.IndexDeleted)];
        const adapter = await git.workspaceRepository();
        assert.ok(adapter);
        stats = [];
        await assert.rejects(git[action](adapter, name, new Set(['src\\noted.ts']), [file('/repo/storage')],
          () => assert.fail('excluded candidates must not reach the host guard')), /path|wildcard|Review Notes|archive|unstaged/i);
        assert.deepEqual(addCalls, [], name);
        assert.deepEqual(cleanCalls, [], name);
        assert.deepEqual(stats, [], name);
        assert.deepEqual(reads, []);
        assert.deepEqual(diffCalls, []);
      }
    });

    await t.test(`${action} rejects nested, undiscovered, submodule and outside-folder ownership`, async () => {
      reset();
      if (action === 'revertFile') { documents = []; }
      workspace.workspaceFolders = [{ uri: Uri.file('/repo/packages/app') }];
      repositories.push({ ...repository, rootUri: file('/repo/packages/app/nested') });
      repository.state.submodules = [{ path: 'packages/app/module' }];
      markers.set('/repo/packages/app/closed/.git', 1);
      markers.set('/repo/packages/app/denied/.git', Object.assign(new Error('denied'), { code: 'NoPermissions' }));
      const adapter = await git.workspaceRepository();
      assert.ok(adapter);
      for (const name of ['nested/a.ts', 'module/a.ts', 'closed/a.ts', 'denied/a.ts', '../other.ts', '/repo/outside.ts']) {
        const target = path.posix.resolve(adapter.rootUri.fsPath, name);
        put(target, 'synthetic source');
        repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
        await assert.rejects(git[action](adapter, name, new Set(), [], () => assert.fail('invalid ownership')),
          /repository|boundar|repo-relative/);
        assert.deepEqual(reads, []);
      }
      assert.deepEqual(addCalls, []);
      assert.deepEqual(cleanCalls, []);
      assert.deepEqual(reads, []);
      assert.deepEqual(diffCalls, []);
    });

    await t.test(`${action} refuses directories, symlinks, unknown types, missing nondeletions and stat failures`, async () => {
      for (const type of [0, 2, 64, 65, 66, 'missing', 'denied'] as const) {
        reset();
        if (action === 'revertFile') { documents = []; }
        const target = '/repo/a.ts';
        repository.state.workingTreeChanges = [change(target, type === 'missing' ? GitStatus.Modified : GitStatus.Deleted)];
        if (typeof type === 'number') { put(target, '', type); }
        if (type === 'denied') { markers.set(target, Object.assign(new Error('synthetic access denied'), { code: 'NoPermissions' })); }
        const repo = await git.workspaceRepository();
        assert.ok(repo);
        await assert.rejects(git[action](repo, 'a.ts', new Set(), [], () => {}),
          /regular file|missing|denied|boundary|boundaries/);
        assert.deepEqual(addCalls, []);
        assert.deepEqual(cleanCalls, []);
        assert.deepEqual(reads, []);
        assert.deepEqual(diffCalls, []);
      }
    });

    for (const phase of ['ownership', 'fileStat', 'finalOwnership', 'hostGuard']) {
      for (const mutation of ['membership', 'notes', 'excluded', 'folder', 'closed', 'nested', 'boundary', 'disposed', 'deletedStatus']) {
        if (phase === 'hostGuard' && (mutation === 'nested' || mutation === 'boundary')) { continue; }
        await t.test(`${action} refuses ${mutation} changes during ${phase}`, async () => {
          reset();
          if (action === 'revertFile') { documents = []; }
          const target = '/repo/src/a.ts';
          repository.state.workingTreeChanges = [change(target, mutation === 'deletedStatus' ? GitStatus.Deleted : GitStatus.Modified)];
          if (mutation !== 'deletedStatus') { put(target, 'synthetic source'); }
          const noted = new Set<string>();
          const excluded: vscode.Uri[] = [];
          const adapter = await git.workspaceRepository();
          assert.ok(adapter);
          let triggered = false;
          const mutate = () => {
            if (triggered) { return; }
            triggered = true;
            if (mutation === 'membership') {
              repository.state.workingTreeChanges = [];
              repository.state.indexChanges = [change(target)];
            }
            if (mutation === 'notes') { noted.add('src/a.ts'); }
            if (mutation === 'excluded') { excluded.push(file('/repo/src')); }
            if (mutation === 'folder') { workspace.workspaceFolders = [{ uri: Uri.file('/other') }]; }
            if (mutation === 'closed') { repositories = []; }
            if (mutation === 'nested') { repositories.push({ ...repository, rootUri: file('/repo/src') }); }
            if (mutation === 'boundary') { markers.set('/repo/src/.git', 1); }
            if (mutation === 'disposed') { git.dispose(); }
            if (mutation === 'deletedStatus') { repository.state.workingTreeChanges = [change(target, GitStatus.Modified)]; }
          };
          let fileStatted = false;
          onStat = async uri => {
            if ((phase === 'ownership' && uri.path.endsWith('/.git'))
              || (phase === 'fileStat' && uri.path === target)
              || (phase === 'finalOwnership' && fileStatted && uri.path.endsWith('/.git'))) { mutate(); }
            if (uri.path === target) { fileStatted = true; }
          };
          await assert.rejects(git[action](adapter, 'src/a.ts', noted, excluded, () => {
            if (phase === 'hostGuard') { mutate(); }
          }));
          assert.equal(triggered, true);
          assert.deepEqual(addCalls, []);
          assert.deepEqual(cleanCalls, []);
          assert.deepEqual(reads, []);
          assert.deepEqual(diffCalls, []);
        });
      }
    }
  }

  await t.test('Stage File propagates busy host guards, unavailable APIs and Git failures without retrying', async () => {
    reset();
    const target = '/repo/a.ts';
    put(target, 'synthetic source');
    repository.state.workingTreeChanges = [change(target)];
    const adapter = await git.workspaceRepository();
    assert.ok(adapter);
    const busy = new Error('Stage File is busy');
    await assert.rejects(git.stageFile(adapter, 'a.ts', new Set(), [], () => { throw busy; }), error => error === busy);
    assert.deepEqual(addCalls, []);
    const add = repository.add;
    repository = { ...repository, add: undefined };
    repositories = [repository];
    assert.equal(adapter.add, undefined);
    await assert.rejects(git.stageFile(adapter, 'a.ts', new Set(), [], () => {}), /does not support Stage File/);
    assert.deepEqual(addCalls, []);
    repository.add = add;
    const failure = new Error('synthetic Git add failure');
    onAdd = async () => { throw failure; };
    await assert.rejects(git.stageFile(adapter, 'a.ts', new Set(), [], () => {}), error => error === failure);
    assert.deepEqual(addCalls, [[target]]);
    assert.deepEqual(repository.state.workingTreeChanges, [change(target)]);
    onAdd = async () => {};
    await git.stageFile(adapter, 'a.ts', new Set(), [], () => {});
    assert.deepEqual(addCalls, [[target], [target]], 'a later explicit retry is allowed');
    assert.deepEqual(reads, []);
    assert.deepEqual(diffCalls, []);
  });
  for (const root of ['/repo', '/repo/packages/app']) {
    for (const kind of ['modified', 'partial', 'new', 'deleted', 'untracked', 'status7', 'binary', 'oversized']) {
      await t.test(`Revert File delegates only one absolute ${kind} path from ${root} without changing the index`, async () => {
        reset();
        documents = [];
        workspace.workspaceFolders = [{ uri: Uri.file(root) }];
        const target = `${root}/src/other file.md`;
        if (kind !== 'deleted') {
          put(target, kind === 'binary' ? new Uint8Array([0, 255]) : 'synthetic disk text', 1,
            kind === 'oversized' ? 6 * 1024 * 1024 : undefined);
        }
        let status = GitStatus.Modified;
        if (kind === 'deleted') {
          status = GitStatus.Deleted;
        } else if (kind === 'untracked' || kind === 'status7') {
          status = GitStatus.Untracked;
        }
        if (kind === 'untracked') { repository.state.untrackedChanges = [change(target, status)]; }
        else {
          repository.state.workingTreeChanges = [new class implements GitChange {
            get uri(): vscode.Uri { return file(target); }
            get status(): number { return status; }
          }()];
        }
        const index = [change(`${root}/already-staged.ts`, GitStatus.IndexModified)];
        if (kind === 'partial' || kind === 'deleted') { index.push(change(target, GitStatus.IndexModified)); }
        if (kind === 'new') { index.push(change(target, GitStatus.IndexAdded)); }
        repository.state.indexChanges = index;
        const snapshot = [...index];
        const adapter = await git.workspaceRepository();
        assert.ok(adapter);
        // There is no add or revert API on this replacement wrapper, only mocked clean.
        const { add: _add, ...replacement } = repository;
        repository = replacement;
        repository.diffWithHEAD = undefined;
        repositories = [repository];
        assert.equal(adapter.add, undefined);
        assert.equal('revert' in repository, false);
        let validations = 0;
        onClean = async () => { assert.equal(validations, 1, 'host validation must precede clean'); };
        await git.revertFile(adapter, 'src/other file.md', new Set(), [], () => {
          validations++;
          assert.ok(stats.includes(target));
          assert.deepEqual(cleanCalls, []);
        });
        assert.deepEqual(cleanCalls, [[target]]);
        assert.deepEqual(addCalls, []);
        assert.equal(repository.state.indexChanges, index);
        assert.deepEqual(index, snapshot);
        assert.equal((repository.state.workingTreeChanges?.length ?? 0) + (repository.state.untrackedChanges?.length ?? 0), 1,
          'no optimistic candidate removal');
        assert.deepEqual(reads, []);
        assert.deepEqual(diffCalls, []);
      });
    }
  }

  await t.test('Revert File rejects dirty open source documents before any await and allows a later clean retry', async () => {
    reset();
    const target = '/repo/src/a.ts';
    put(target, 'synthetic source');
    repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
    const adapter = await git.workspaceRepository();
    assert.ok(adapter);
    documents = [{ uri: file(target), isClosed: false, isDirty: true }];
    stats = [];
    const pending = git.revertFile(adapter, 'src/a.ts', new Set(), [], () => assert.fail('dirty file reached host guard'));
    documents[0].isDirty = false;
    await assert.rejects(pending, /unsaved changes/);
    assert.deepEqual(stats, [], 'dirty rejection precedes boundary and source stats');
    assert.deepEqual(cleanCalls, []);
    documents.push({ uri: file(target), isClosed: true, isDirty: true },
      { uri: file('/repo/other.ts'), isClosed: false, isDirty: true });
    await git.revertFile(adapter, 'src/a.ts', new Set(), [], () => {});
    assert.deepEqual(cleanCalls, [[target]]);
    assert.deepEqual(addCalls, []);
    assert.deepEqual(reads, []);
    assert.deepEqual(diffCalls, []);
  });

  await t.test('Revert File requires explicit supported status and rejects conflicts and intent-to-add in every group', async () => {
    for (const group of ['workingTreeChanges', 'untrackedChanges', 'indexChanges', 'mergeChanges'] as const) {
      for (const status of [undefined, -1, ...Object.values(GitStatus), 99]) {
        if (group === 'workingTreeChanges' && status !== undefined
          && [GitStatus.Modified, GitStatus.Deleted, GitStatus.Untracked].includes(status)) { continue; }
        if (group === 'untrackedChanges' && status === GitStatus.Untracked) { continue; }
        if (group === 'indexChanges' && status !== undefined
          && [GitStatus.IndexModified, GitStatus.IndexAdded, GitStatus.IndexDeleted,
            GitStatus.IndexRenamed, GitStatus.IndexCopied].includes(status)) { continue; }
        reset();
        documents = [];
        const target = '/repo/a.ts';
        put(target, 'synthetic source');
        repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
        repository.state[group] = [change(target, status)];
        const adapter = await git.workspaceRepository();
        assert.ok(adapter);
        stats = [];
        await assert.rejects(git.revertFile(adapter, 'a.ts', new Set(), [], () => assert.fail('invalid status reached host guard')),
          /Git status/, `${group}: ${status}`);
        assert.deepEqual(stats, []);
        assert.deepEqual(cleanCalls, []);
        assert.deepEqual(addCalls, []);
        assert.deepEqual(reads, []);
        assert.deepEqual(diffCalls, []);
      }
    }
  });

  for (const phase of ['ownership', 'fileStat', 'finalOwnership', 'hostGuard']) {
    for (const mutation of ['dirty', 'status', 'kind', 'intentToAdd', 'conflict', 'indexStatus']) {
      await t.test(`Revert File revalidates ${mutation} during ${phase}`, async () => {
        reset();
        const target = '/repo/src/a.ts';
        put(target, 'synthetic source');
        const document: SourceDocument = { uri: file(target), isClosed: false, isDirty: false };
        documents = [document];
        repository.state.workingTreeChanges = [change(target, mutation === 'kind' ? GitStatus.Untracked : GitStatus.Modified)];
        const adapter = await git.workspaceRepository();
        assert.ok(adapter);
        let triggered = false;
        const mutate = () => {
          if (triggered) { return; }
          triggered = true;
          if (mutation === 'dirty') { document.isDirty = true; }
          if (mutation === 'status') { repository.state.workingTreeChanges = [change(target, GitStatus.TypeChanged)]; }
          if (mutation === 'kind') {
            repository.state.workingTreeChanges = [];
            repository.state.untrackedChanges = [change(target, GitStatus.Untracked)];
          }
          if (mutation === 'intentToAdd') { repository.state.workingTreeChanges = [change(target, GitStatus.IntentToAdd)]; }
          if (mutation === 'conflict') { repository.state.mergeChanges = [change(target, GitStatus.BothAdded)]; }
          if (mutation === 'indexStatus') { repository.state.indexChanges = [change(target, GitStatus.IntentToRename)]; }
        };
        let fileStatted = false;
        onStat = async uri => {
          if ((phase === 'ownership' && uri.path.endsWith('/.git'))
            || (phase === 'fileStat' && uri.path === target)
            || (phase === 'finalOwnership' && fileStatted && uri.path.endsWith('/.git'))) { mutate(); }
          if (uri.path === target) { fileStatted = true; }
        };
        await assert.rejects(git.revertFile(adapter, 'src/a.ts', new Set(), [], () => {
          if (phase === 'hostGuard') { mutate(); }
        }), /unsaved changes|Git status|kind or status/);
        assert.equal(triggered, true);
        assert.deepEqual(cleanCalls, []);
        assert.deepEqual(addCalls, []);
        assert.deepEqual(reads, []);
        assert.deepEqual(diffCalls, []);
      });
    }
  }

  await t.test('Revert File propagates host guards, unavailable live clean APIs and failures without automatic retries', async () => {
    reset();
    documents = [];
    const target = '/repo/a.ts';
    put(target, 'synthetic source');
    repository.state.workingTreeChanges = [change(target, GitStatus.Modified)];
    const adapter = await git.workspaceRepository();
    assert.ok(adapter);
    const busy = new Error('Revert File is busy');
    await assert.rejects(git.revertFile(adapter, 'a.ts', new Set(), [], () => { throw busy; }), error => error === busy);
    assert.deepEqual(cleanCalls, []);
    const clean = repository.clean;
    repository = { ...repository, clean: undefined };
    repositories = [repository];
    assert.equal(adapter.clean, undefined);
    await assert.rejects(git.revertFile(adapter, 'a.ts', new Set(), [], () => {}), /does not support Revert File/);
    assert.deepEqual(cleanCalls, []);
    repository.clean = clean;
    const failure = new Error('synthetic Git clean failure');
    onClean = async () => { throw failure; };
    await assert.rejects(git.revertFile(adapter, 'a.ts', new Set(), [], () => {}), error => error === failure);
    assert.deepEqual(cleanCalls, [[target]]);
    assert.deepEqual(repository.state.workingTreeChanges, [change(target, GitStatus.Modified)]);
    onClean = async () => {};
    await git.revertFile(adapter, 'a.ts', new Set(), [], () => {});
    assert.deepEqual(cleanCalls, [[target], [target]], 'only a later explicit retry calls clean again');
    assert.deepEqual(addCalls, []);
    assert.deepEqual(reads, []);
    assert.deepEqual(diffCalls, []);
  });
  git.dispose();
});
