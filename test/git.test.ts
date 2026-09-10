import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import type { GitResources, Repository } from '../src/git';

// Only this small VS Code surface is emulated. All filesystem/Git data is in memory.
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

class TabInputText { constructor(readonly uri: Uri) {} }
class TabInputTextDiff { constructor(readonly original: Uri, readonly modified: Uri) {} }
class EventEmitter {
  readonly listeners = new Set<() => void>();
  event = (listener: () => void) => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(): void { this.listeners.forEach(listener => listener()); }
  dispose(): void { this.listeners.clear(); }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => assert.fail('promise executor has not run');
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const asUri = (uri: Uri): vscode.Uri => uri;
const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
const file = Uri.file('/repo/src/a.ts');
const revision = (ref: string, target = file) => Uri.from({ scheme: 'git', path: target.path,
  query: JSON.stringify({ path: target.fsPath, ref }) });
type CaptureRange = Pick<vscode.Range, 'isEmpty'> & {
  start: Pick<vscode.Position, 'line' | 'character'>;
  end: Pick<vscode.Position, 'line' | 'character'>;
};
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true } satisfies CaptureRange;

test('Git ownership and capture with an in-memory VS Code host', async t => {
  let git!: GitResources;
  let repository!: Repository;
  let repositories: Repository[] = [];
  let stat: (uri: Uri) => Promise<Pick<vscode.FileStat, 'type'>>;
  type Choice = Pick<vscode.QuickPickItem, 'label'> & { side: string };
  let picker: (choices: Choice[]) => Promise<Choice | undefined>;
  let markers = new Map<string, number>();
  let links = new Set<string>();
  const gitChanged = new EventEmitter();
  let blobs = new Map<string, string>();
  let reads: string[] = [];
  let shows: string[] = [];
  let stats: string[] = [];
  let warnings: string[] = [];
  const workspace = {
    workspaceFolders: [{ uri: Uri.file('/repo') }],
    textDocuments: [] as Pick<vscode.TextDocument, 'uri' | 'isClosed' | 'getText'>[],
    fs: {
      stat: (uri: Uri) => stat(uri),
      readFile: async (uri: Uri) => {
        reads.push(uri.path);
        const text = blobs.get(uri.path);
        assert.notEqual(text, undefined, `unexpected synthetic file read: ${uri.path}`);
        return new TextEncoder().encode(text);
      },
    },
  };
  const window = {
    tabGroups: {
      activeTabGroup: { activeTab: { input: new TabInputText(file) as TabInputText | TabInputTextDiff } },
      all: [] as { isActive: boolean; tabs: { input: TabInputText | TabInputTextDiff; label: string; isActive: boolean }[] }[],
    },
    showQuickPick: (choices: Choice[]) => picker(choices),
    showWarningMessage: async (message: string) => { warnings.push(message); },
    showInformationMessage: async () => {},
  };
  const api = { get repositories() { return repositories; }, state: 'initialized' };
  const mock = { Uri, EventEmitter, TabInputText, TabInputTextDiff, workspace, window,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => api }) }) } };
  const moduleLoader = require('node:module') as { _load(request: string, ...args: unknown[]): unknown };
  const load = moduleLoader._load;
  t.mock.method(moduleLoader, '_load', function (this: unknown, request: string, ...args: unknown[]) {
    return request === 'vscode' ? mock : load.call(this, request, ...args);
  });
  const { GitResources } = require('../src/git') as typeof import('../src/git');
  const { captureContext } = require('../src/editorContext') as typeof import('../src/editorContext');
  // Capture consumes only line/character coordinates, not Range's editor operations.
  const capture = (git: GitResources, uri: vscode.Uri, selected: CaptureRange,
    options?: Parameters<typeof captureContext>[3]): ReturnType<typeof captureContext> =>
    captureContext(git, uri, selected as vscode.Range, options);

  const reset = (): void => {
    git?.dispose();
    markers = new Map();
    blobs = new Map();
    reads = [];
    shows = [];
    stats = [];
    warnings = [];
    links = new Set();
    assert.equal(gitChanged.listeners.size, 0, 'capture must release interval listeners');
    workspace.workspaceFolders = [{ uri: Uri.file('/repo') }];
    workspace.textDocuments = [];
    window.tabGroups.activeTabGroup.activeTab.input = new TabInputText(file);
    window.tabGroups.all = [];
    stat = async uri => {
      stats.push(uri.path);
      if (links.has(uri.path)) { return { type: 66 }; }
      if (path.posix.basename(uri.path) !== '.git') {
        return { type: path.posix.extname(uri.path) ? 1 : 2 };
      }
      const type = markers.get(uri.path);
      if (type !== undefined) { return { type }; }
      throw Object.assign(new Error('missing synthetic marker'), { code: 'FileNotFound' });
    };
    picker = async () => assert.fail('unexpected picker');
    repository = {
      rootUri: asUri(Uri.file('/repo')),
      state: { HEAD: { commit: shaA }, indexChanges: [], submodules: [], onDidChange: gitChanged.event },
      getCommit: async () => ({ hash: shaA }),
      show: async (ref, target) => {
        const key = `${ref}:${target}`;
        shows.push(key);
        const text = blobs.get(key);
        assert.ok(text !== undefined, `unexpected synthetic revision read: ${key}`);
        return text;
      },
    };
    repositories = [repository];
    git = new GitResources();
  };
  const open = (uri: Uri, text: string) => workspace.textDocuments.push({ uri, isClosed: false, getText: () => text });
  const captureAt = (uri: Uri, forceSidePrompt = false) => capture(git, asUri(uri), range, { forceSidePrompt });

  await t.test('POSIX literal backslashes cannot alias a normalized source identity', async () => {
    if (path.sep !== '/') { return; }
    reset();
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    const literal = Uri.file('/repo/src\\a.ts');
    for (const uri of [literal, revision('HEAD', literal)]) {
      await assert.rejects(git.repositoryFor(asUri(uri)), /backslashes/);
      await assert.rejects(git.resource(asUri(uri), repo), /backslashes/);
    }
    assert.deepEqual(await git.resource(asUri(file), repo), { path: 'src/a.ts', origin: 'changed' });
    assert.deepEqual(reads, []);
    assert.deepEqual(shows, []);
  });

  await t.test('symlink leaves and ancestors reject reads, capture and subfolder ownership', async () => {
    for (const target of ['/repo/src', file.path]) {
      reset();
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      links.add(target);
      open(file, 'unsaved source');
      assert.equal(await git.repositoryFor(asUri(file)), undefined);
      assert.equal(await captureAt(file), undefined);
      for (const origin of ['changed', 'head', 'staged', `commit:${shaA}`] as const) {
        await assert.rejects(git.content({ path: 'src/a.ts', origin }, repo), /boundary/);
      }
      if (target === '/repo/src') {
        workspace.workspaceFolders = [{ uri: Uri.file('/repo/src/lib') }];
        assert.equal(await git.workspaceRepository(), undefined);
      }
      assert.deepEqual(reads, []);
      assert.deepEqual(shows, []);
    }
  });

  await t.test('native gutter infers a unique regular editor or diff side without a picker', async () => {
    for (const side of ['document', 'left', 'right'] as const) {
      reset();
      const head = revision('HEAD');
      open(file, 'working');
      open(head, 'original');
      blobs.set(`HEAD:${file.path}`, 'original');
      const input = side === 'document' ? new TabInputText(file) : new TabInputTextDiff(head, file);
      // Identical split views are one context, and unrelated active editors cannot retarget it.
      window.tabGroups.all = [false, false].map(isActive => ({ isActive,
        tabs: [{ input, label: 'a.ts', isActive: true }] }));
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputText(Uri.file('/repo/other.ts'));
      const captured = await capture(git, asUri(side === 'left' ? head : file), range,
        { inferFromOpenTabs: true, rangeSemantics: 'thread' });
      assert.equal(captured?.comment.side, side);
      assert.equal(captured?.comment.anchorText, side === 'left' ? 'original' : 'working');
      assert.equal(warnings.length, 0);
    }
  });

  await t.test('native gutter asks when regular and diff contexts coexist, regardless of active tab', async () => {
    reset();
    const head = revision('HEAD');
    open(file, 'working');
    open(head, 'original');
    blobs.set(`HEAD:${file.path}`, 'original');
    const diff = new TabInputTextDiff(head, file);
    window.tabGroups.activeTabGroup.activeTab.input = diff;
    window.tabGroups.all = [{ isActive: true, tabs: [
      { input: diff, label: 'a.ts diff', isActive: true },
      { input: new TabInputText(file), label: 'a.ts', isActive: false },
    ] }];
    let prompts = 0;
    picker = async choices => {
      prompts++;
      return choices.find(choice => choice.side === 'document');
    };
    const captured = await capture(git, asUri(file), range, { inferFromOpenTabs: true });
    assert.equal(prompts, 1);
    assert.equal(captured?.comment.side, 'document');
  });

  await t.test('native gutter does not guess same-URI comparison sides or missing tab context', async () => {
    for (const sameUri of [true, false]) {
      reset();
      open(file, 'working');
      if (sameUri) {
        const input = new TabInputTextDiff(file, file);
        window.tabGroups.all = [{ isActive: true, tabs: [{ input, label: 'same file', isActive: true }] }];
      }
      let prompts = 0;
      picker = async () => {
        prompts++;
        return undefined;
      };
      assert.equal(await capture(git, asUri(file), range, { inferFromOpenTabs: true }), undefined);
      assert.equal(prompts, 1);
    }
  });

  for (const type of [1, 2]) {
    await t.test(`undiscovered .git ${type === 1 ? 'file' : 'directory'} blocks capture, reads and navigation`, async () => {
      reset();
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      markers.set('/repo/src/.git', type);
      open(file, 'synthetic source');
      assert.equal(await git.repositoryFor(asUri(file)), undefined);
      assert.equal(await git.resource(asUri(file), repo), undefined);
      assert.equal(await captureAt(file), undefined);
      for (const origin of ['changed', 'head', 'staged', `commit:${shaA}`] as const) {
        const resource = { path: 'src/a.ts', origin };
        assert.throws(() => git.uri({ path: '../a.ts', origin }, repo));
        assert.ok(git.uri(resource, repo), 'construction remains synchronous');
        await assert.rejects(git.validatedUri(resource, repo), /boundary/);
        await assert.rejects(git.content(resource, repo), /boundary/);
      }
      assert.deepEqual(reads, []);
      assert.deepEqual(shows, []);
    });
  }

  await t.test('closed nested repository cannot fall back to its parent, including opened subfolders', async () => {
    reset();
    const nested = { ...repository, rootUri: asUri(Uri.file('/repo/src')) };
    repositories.push(nested);
    assert.equal(await git.repositoryFor(asUri(file)), undefined);
    markers.set('/repo/src/.git', 1);
    repositories = [repository];
    assert.equal(await git.repositoryFor(asUri(file)), undefined);
    workspace.workspaceFolders = [{ uri: Uri.file('/repo/src/lib') }];
    assert.equal(await git.workspaceRepository(), undefined);
    markers.clear();
    repository.state.submodules = [{ path: 'src' }];
    assert.equal(await git.workspaceRepository(), undefined);
    workspace.workspaceFolders = [{ uri: Uri.file('/repo') }];
    assert.equal(await git.repositoryFor(asUri(file)), undefined);
  });

  await t.test('subfolder adapter retains folder paths and delegates absolute Git paths', async () => {
    reset();
    workspace.workspaceFolders = [{ uri: Uri.file('/repo/src') }];
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    assert.equal(repo.rootUri.fsPath, '/repo/src');
    assert.deepEqual(await git.resource(asUri(file), repo), { path: 'a.ts', origin: 'changed' });
    blobs.set(`HEAD:${file.path}`, 'head content');
    assert.equal(await git.content({ path: 'a.ts', origin: 'head' }, repo), 'head content');
    assert.deepEqual(shows, [`HEAD:${file.path}`]);
    assert.equal(await git.repositoryFor(asUri(Uri.file('/repo/other.ts'))), undefined);
    assert.equal(stats.includes('/repo/.git'), false, 'the owning root marker is not an intervening boundary');
    repositories = [];
    await assert.rejects(git.validatedUri({ path: 'a.ts', origin: 'head' }, repo), /boundary/);
    assert.throws(() => repo.state, /no longer open/);
  });

  await t.test('boundary errors fail closed and repository/folder changes during stat are rejected', async () => {
    for (const change of ['permission', 'close', 'folder', 'nested'] as const) {
      reset();
      const started = deferred<void>();
      const resume = deferred<void>();
      stat = async () => {
        started.resolve();
        await resume.promise;
        throw Object.assign(new Error('synthetic stat'), { code: change === 'permission' ? 'NoPermissions' : 'FileNotFound' });
      };
      const pending = git.repositoryFor(asUri(file));
      await started.promise;
      if (change === 'close') { repositories = []; }
      if (change === 'folder') { workspace.workspaceFolders = [{ uri: Uri.file('/other') }]; }
      if (change === 'nested') { repositories.push({ ...repository, rootUri: asUri(Uri.file('/repo/src')) }); }
      resume.resolve();
      if (change === 'permission') { await assert.rejects(pending, /Cannot validate/); }
      else { assert.equal(await pending, undefined); }
    }
  });

  await t.test('displayed Git text must equal its resolved revision, not merely the selected lines', async () => {
    for (const [ref, resolvedRef] of [['branch', shaA], ['HEAD', 'HEAD'], ['', ''], ['~', 'HEAD']]) {
      reset();
      const uri = revision(ref);
      open(uri, 'same first line\nold tail');
      blobs.set(`${resolvedRef}:${file.path}`, 'same first line\nnew tail');
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputText(uri);
      assert.equal(await captureAt(uri), undefined);
      assert.match(warnings[0], /revision or review base changed/);
    }
  });

  await t.test('ownership is checked again after asynchronous commit resolution and content reads', async () => {
    for (const operation of ['commit', 'content'] as const) {
      reset();
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      const started = deferred<void>();
      const resume = deferred<void>();
      repository.getCommit = async () => {
        started.resolve();
        await resume.promise;
        return { hash: shaA };
      };
      repository.show = async () => {
        started.resolve();
        await resume.promise;
        return 'source';
      };
      const pending = operation === 'commit' ? git.resource(asUri(revision('branch')), repo)
        : git.content({ path: 'src/a.ts', origin: 'head' }, repo);
      await started.promise;
      markers.set('/repo/src/.git', 1);
      resume.resolve();
      if (operation === 'commit') { assert.equal(await pending, undefined); }
      else { await assert.rejects(pending, /boundary/); }
    }
  });

  await t.test('direct diff capture rejects an invalid opposite endpoint without a picker fallback', async () => {
    for (const opposite of [Uri.file('/outside/a.ts'), Uri.file('/repo/nested/a.ts'), revision('HEAD')]) {
      reset();
      open(file, 'source');
      markers.set('/repo/nested/.git', 2);
      if (opposite.scheme === 'git') {
        open(opposite, 'stale other side');
        blobs.set(`HEAD:${file.path}`, 'current other side');
      }
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(file, opposite);
      let picked = false;
      picker = async choices => {
        picked = true;
        return choices[0];
      };
      assert.equal(await captureAt(file), undefined);
      assert.equal(picked, false);
      assert.equal(warnings.length, 1);
    }
  });

  await t.test('added-file capture confirms displayed empty Original paths and skips undisplayed blobs', async () => {
    for (const buffered of [false, true]) {
      for (const forcePrompt of [false, true]) {
        reset();
        open(file, 'added source');
        const original = revision('HEAD');
        if (buffered) { open(original, ''); }
        let lookups = 0;
        repository.getObjectDetails = async (ref, target) => {
          assert.equal(ref, 'HEAD');
          assert.equal(target, file.path);
          lookups++;
          throw Object.assign(new Error('synthetic missing path'), { gitErrorCode: 'UnknownPath' });
        };
        window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(original, file);
        picker = async choices => choices.find(choice => choice.side === 'right');
        const captured = await captureAt(file, forcePrompt);
        assert.ok(captured, warnings.join('\n'));
        assert.equal(captured.comment.side, 'right');
        assert.equal(captured.comment.anchorText, 'added source');
        assert.deepEqual(captured.comment.comparison, {
          left: { path: 'src/a.ts', origin: 'head' }, right: { path: 'src/a.ts', origin: 'changed' },
        });
        await captured.validate();
        assert.equal(shows.length, buffered ? 3 : 0, 'displayed emptiness is checked initially and on each validation');
        assert.equal(lookups, buffered ? 3 : 0);
        assert.deepEqual(reads, []);
        repository.state.HEAD = { commit: shaB };
        await assert.rejects(captured.validate(), /revision or review base changed/);
      }
    }
  });

  await t.test('displayed empty staged Original rejects initially stale or later nonempty content', async () => {
    for (const when of ['initial', 'picker', 'draft'] as const) {
      reset();
      open(file, 'working source');
      const original = revision('');
      open(original, '');
      blobs.set(`:${file.path}`, when === 'initial' ? 'already nonempty' : '');
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(original, file);
      picker = async choices => {
        blobs.set(`:${file.path}`, 'changed during picker');
        return choices.find(choice => choice.side === 'right');
      };
      const captured = await captureAt(file, when === 'picker');
      if (when === 'draft') {
        assert.ok(captured, warnings.join('\n'));
        await captured.validate();
        blobs.set(`:${file.path}`, 'new staged content');
        await assert.rejects(captured.validate(), /revision or review base changed/);
      } else {
        assert.equal(captured, undefined);
        assert.match(warnings[0], /revision or review base changed/);
      }
    }
  });

  await t.test('confirmed missing displayed Original may remain missing or empty, but not become nonempty', async () => {
    reset();
    open(file, 'added source');
    const original = revision('');
    open(original, '');
    let details = 0;
    repository.getObjectDetails = async () => {
      details++;
      throw Object.assign(new Error('synthetic missing path'), { gitErrorCode: 'UnknownPath' });
    };
    window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(original, file);
    const captured = await captureAt(file);
    assert.ok(captured, warnings.join('\n'));
    await captured.validate();
    assert.equal(details, 3);
    blobs.set(`:${file.path}`, '');
    await captured.validate();
    assert.equal(details, 3, 'a successful empty read needs no missing-path lookup');
    blobs.set(`:${file.path}`, 'new staged source');
    await assert.rejects(captured.validate(), /revision or review base changed/);
  });

  await t.test('empty opposite read errors require structured UnknownPath from object details', async () => {
    for (const failure of ['permission', 'revision', 'message', 'exists', 'unsupported'] as const) {
      for (const when of ['initial', 'draft'] as const) {
        reset();
        open(file, 'source');
        const original = revision('HEAD');
        open(original, '');
        window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(original, file);
        blobs.set(`HEAD:${file.path}`, '');
        const captured = when === 'draft' ? await captureAt(file) : undefined;
        if (when === 'draft') { assert.ok(captured, warnings.join('\n')); }
        repository.show = async () => { throw new Error('synthetic show failure'); };
        if (failure !== 'unsupported') {
          repository.getObjectDetails = async () => {
            if (failure === 'exists') { return { mode: '100644', object: shaA, size: 0 }; }
            if (failure === 'message') { throw new Error('UnknownPath'); }
            throw Object.assign(new Error(`synthetic ${failure} failure`), {
              gitErrorCode: failure === 'permission' ? 'PermissionDenied' : 'BadRevision',
            });
          };
        }
        if (captured) { await assert.rejects(captured.validate(), /Cannot read/); }
        else {
          assert.equal(await captureAt(file), undefined);
          assert.match(warnings[0], /Cannot read/);
        }
      }
    }
  });

  await t.test('missing confirmation delegates absolute Git paths for opened subfolders', async () => {
    reset();
    workspace.workspaceFolders = [{ uri: Uri.file('/repo/src') }];
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    const lookups: string[] = [];
    repository.getObjectDetails = async (ref, target) => {
      lookups.push(`${ref}:${target}`);
      throw Object.assign(new Error('synthetic missing path'), { gitErrorCode: 'UnknownPath' });
    };
    assert.equal(await git.content({ path: 'a.ts', origin: 'head' }, repo, true), '');
    assert.deepEqual(lookups, [`HEAD:${file.path}`]);
    await assert.rejects(git.content({ path: 'a.ts', origin: 'head' }, repo), /Cannot read/);
    assert.equal(lookups.length, 1, 'selected reads never use missing-path fallback');
  });

  await t.test('explicit show permission and revision errors never use the missing-path fallback', async () => {
    for (const gitErrorCode of ['PermissionDenied', 'BadRevision']) {
      reset();
      const repo = await git.workspaceRepository();
      assert.ok(repo);
      repository.show = async () => { throw Object.assign(new Error('synthetic show error'), { gitErrorCode }); };
      let lookups = 0;
      repository.getObjectDetails = async () => {
        lookups++;
        throw Object.assign(new Error('synthetic missing path'), { gitErrorCode: 'UnknownPath' });
      };
      await assert.rejects(git.content({ path: 'src/a.ts', origin: 'head' }, repo, true), /synthetic show error/);
      assert.equal(lookups, 0);
    }
  });

  await t.test('deleted-file Original capture does not read a missing Modified working file', async () => {
    for (const buffered of [false, true]) {
      reset();
      const original = revision('HEAD');
      open(original, 'deleted source');
      blobs.set(`HEAD:${file.path}`, 'deleted source');
      if (buffered) { open(file, ''); }
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(original, file);
      const captured = await captureAt(original);
      assert.ok(captured, warnings.join('\n'));
      assert.equal(captured.comment.side, 'left');
      assert.equal(captured.comment.anchorText, 'deleted source');
      assert.deepEqual(captured.comment.comparison?.right, { path: 'src/a.ts', origin: 'changed' });
      await captured.validate();
      assert.deepEqual(reads, [], 'the deleted working file is never requested');
      blobs.set(`HEAD:${file.path}`, 'changed revision');
      await assert.rejects(captured.validate(), /revision or review base changed/);
    }
  });

  await t.test('unavailable selected text and unreadable nonempty opposite Git buffers still fail', async () => {
    for (const selected of [file, revision('HEAD')]) {
      reset();
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputText(selected);
      assert.equal(await captureAt(selected), undefined);
      assert.match(warnings[0], /Cannot read/);
    }
    for (const selected of [true, false]) {
      for (const text of selected ? ['', 'source'] : ['source', ' ']) {
        reset();
        const original = revision('HEAD');
        open(original, text);
        open(file, 'working source');
        repository.show = async () => { throw new Error('synthetic permission failure'); };
        window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(original, file);
        assert.equal(await captureAt(selected ? original : file), undefined);
        assert.match(warnings[0], /synthetic permission failure/);
      }
    }
  });

  await t.test('snapshot-free opposite endpoints still validate membership, ownership, and pinned origin', async () => {
    for (const change of ['membership', 'boundary', 'commit'] as const) {
      reset();
      open(file, 'source');
      const oppositeFile = Uri.file('/repo/other/a.ts');
      const opposite = revision(change === 'commit' ? 'branch' : '~', oppositeFile);
      let resolutions = 0;
      repository.getCommit = async () => {
        resolutions++;
        return { hash: shaA };
      };
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(opposite, file);
      picker = async choices => {
        if (change === 'commit') {
          assert.equal(resolutions, 1, 'opposite origin is pinned before the picker without reading text');
          repository.getCommit = async () => assert.fail('must not resolve the frozen branch again');
        }
        return choices.find(choice => choice.side === 'right');
      };
      const captured = await captureAt(file, true);
      assert.ok(captured, warnings.join('\n'));
      if (change === 'membership') {
        repository.state.indexChanges = [{ uri: asUri(oppositeFile) }];
        await assert.rejects(captured.validate(), /revision or review base changed/);
      } else if (change === 'boundary') {
        markers.set('/repo/other/.git', 2);
        await assert.rejects(captured.validate(), /boundary/);
      } else {
        assert.equal(captured.comment.comparison?.left.origin, `commit:${shaA}`);
        await captured.validate();
        assert.equal(resolutions, 1);
      }
      assert.deepEqual(shows, []);
      assert.deepEqual(reads, []);
    }
  });

  await t.test('a verified nonempty opposite snapshot remains validated after capture', async () => {
    reset();
    open(file, 'source');
    const original = revision('HEAD');
    open(original, 'original source');
    blobs.set(`HEAD:${file.path}`, 'original source');
    window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(original, file);
    const captured = await captureAt(file);
    assert.ok(captured, warnings.join('\n'));
    blobs.set(`HEAD:${file.path}`, 'different original');
    await assert.rejects(captured.validate(), /revision or review base changed/);
  });

  await t.test('unsupported candidate tabs do not block document capture or native confirmation', async () => {
    for (const mode of ['document', 'confirm', 'native', 'comparison'] as const) {
      reset();
      open(file, 'source');
      const other = Uri.file('/repo/src/b.ts');
      open(other, 'other source');
      const invalid = new TabInputTextDiff(file, Uri.file('/outside/a.ts'));
      const valid = new TabInputTextDiff(file, other);
      const stale = revision('HEAD');
      open(stale, 'stale source');
      blobs.set(`HEAD:${file.path}`, 'current source');
      window.tabGroups.all = [{ isActive: true, tabs: [
        { input: invalid, label: 'Outside scope', isActive: false },
        { input: new TabInputTextDiff(file, Uri.from({ scheme: 'untitled', path: '/unsupported' })), label: 'Unsupported', isActive: false },
        { input: new TabInputTextDiff(file, stale), label: 'Stale', isActive: false },
        { input: valid, label: 'Valid', isActive: false },
      ] }];
      if (mode === 'native') { window.tabGroups.activeTabGroup.activeTab.input = invalid; }
      let picked = false;
      picker = async choices => {
        picked = true;
        assert.deepEqual(choices.map(choice => choice.side), ['document', 'left']);
        return choices[mode === 'comparison' ? 1 : 0];
      };
      const captured = await captureAt(file, mode !== 'document');
      assert.ok(captured, warnings.join('\n'));
      assert.equal(captured.comment.side, mode === 'comparison' ? 'left' : 'document');
      assert.equal(captured.comment.anchorText, 'source');
      assert.equal(picked, mode !== 'document');
      assert.deepEqual(warnings, []);
      await captured.validate();
    }
  });

  await t.test('Git line-ending normalization is accepted while captured snippets retain displayed EOLs', async () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      reset();
      const uri = revision('HEAD');
      const text = ['first', 'second', ''].join(eol);
      open(uri, text);
      blobs.set(`HEAD:${file.path}`, 'first\r\nsecond\n');
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputText(uri);
      const selectedRange = { start: { line: 0, character: 0 }, end: { line: 1, character: 6 }, isEmpty: false } satisfies CaptureRange;
      const captured = await capture(git, asUri(uri), selectedRange);
      assert.ok(captured, warnings.join('\n'));
      assert.equal(captured.comment.anchorText, `first${eol}second`);
      blobs.set(`HEAD:${file.path}`, 'first\nsecond\n');
      await captured.validate();
      for (const changed of ['first\nsecond', 'first\nsecond \n', 'first\nsecond\n\n']) {
        blobs.set(`HEAD:${file.path}`, changed);
        await assert.rejects(captured.validate(), /revision or review base changed/);
      }
    }
  });

  await t.test('HEAD moves do not invalidate changed or pinned commit documents or unchosen base candidates', async () => {
    for (const kind of ['changed', 'commit'] as const) {
      reset();
      const uri = kind === 'changed' ? file : revision('branch');
      open(uri, 'source');
      blobs.set(`${shaA}:${file.path}`, 'source');
      const head = revision('HEAD');
      open(head, 'head source');
      blobs.set(`HEAD:${file.path}`, 'head source');
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputText(uri);
      window.tabGroups.all = [{ isActive: true, tabs: [
        { input: new TabInputTextDiff(uri, head), label: 'Unchosen HEAD comparison', isActive: false },
      ] }];
      picker = async choices => {
        repository.state.HEAD = { commit: shaB };
        return choices[0];
      };
      const captured = await captureAt(uri, true);
      assert.ok(captured, warnings.join('\n'));
      assert.equal(captured.baseCommit, shaA, 'retain capture provenance rather than updating the base');
      repository.state.HEAD = undefined;
      await captured.validate();
    }
  });

  await t.test('a chosen HEAD comparison still validates the base for a changed-side capture', async () => {
    reset();
    open(file, 'source');
    const head = revision('HEAD');
    open(head, 'head source');
    blobs.set(`HEAD:${file.path}`, 'head source');
    window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(head, file);
    const captured = await captureAt(file);
    assert.ok(captured, warnings.join('\n'));
    assert.equal(captured.comment.origin, 'changed');
    assert.equal(captured.comment.side, 'right');
    repository.state.HEAD = { commit: shaB };
    await assert.rejects(captured.validate(), /revision or review base changed/);
  });

  await t.test('both endpoints resolve before picker and named refs stay pinned across picker', async () => {
    reset();
    const left = revision('branch');
    const right = revision('other-branch');
    open(left, 'left source');
    open(right, 'right source');
    blobs.set(`${shaA}:${file.path}`, 'left source');
    blobs.set(`${shaB}:${file.path}`, 'right source');
    const started = deferred<void>();
    const resume = deferred<void>();
    const resolved: string[] = [];
    repository.getCommit = async ref => {
      resolved.push(ref);
      if (ref === 'other-branch') {
        started.resolve();
        await resume.promise;
      }
      return { hash: ref === 'branch' ? shaA : shaB };
    };
    window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(left, right);
    let picked = false;
    picker = async choices => {
      picked = true;
      assert.deepEqual(resolved, ['branch', 'other-branch']);
      assert.deepEqual(shows, [`${shaA}:${file.path}`, `${shaB}:${file.path}`]);
      repository.getCommit = async () => assert.fail('must not relabel frozen named revisions');
      return choices.find(choice => choice.side === 'left');
    };
    const pending = captureAt(left, true);
    await started.promise;
    assert.equal(picked, false);
    resume.resolve();
    const captured = await pending;
    assert.ok(captured, warnings.join('\n'));
    assert.equal(captured.comment.origin, `commit:${shaA}`);
    assert.equal(captured.comment.comparison?.right.origin, `commit:${shaB}`);
    assert.equal(captured.baseCommit, shaA);
  });

  await t.test('identical endpoint URIs reuse one resolution and preserve the chosen side', async () => {
    reset();
    const uri = revision('branch');
    open(uri, 'source');
    blobs.set(`${shaA}:${file.path}`, 'source');
    let calls = 0;
    repository.getCommit = async () => ({ hash: ++calls === 1 ? shaA : shaB });
    window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(uri, uri);
    picker = async choices => choices.find(choice => choice.side === 'right');
    const captured = await captureAt(uri);
    assert.ok(captured, warnings.join('\n'));
    assert.equal(calls, 1);
    assert.equal(captured.comment.side, 'right');
    assert.deepEqual(captured.comment.comparison?.left, captured.comment.comparison?.right);
  });

  await t.test('picker changes to HEAD, index content, or baseline mapping reject capture', async () => {
    for (const change of ['base', 'index', 'mapping'] as const) {
      reset();
      const uri = revision(change === 'mapping' ? '~' : '');
      const ref = change === 'mapping' ? 'HEAD' : '';
      open(uri, 'source');
      blobs.set(`${ref}:${file.path}`, 'source');
      picker = async choices => {
        if (change === 'base') { repository.state.HEAD = { commit: shaB }; }
        if (change === 'index') { blobs.set(`:${file.path}`, 'new source'); }
        if (change === 'mapping') { repository.state.indexChanges = [{ uri: asUri(file) }]; }
        return choices[0];
      };
      assert.equal(await captureAt(uri, true), undefined);
      assert.match(warnings[0], /revision or review base changed/);
    }
  });

  await t.test('draft validator rejects later base/index/boundary changes without changing captured text', async () => {
    for (const change of ['base', 'index', 'boundary'] as const) {
      reset();
      const uri = revision('');
      open(uri, 'source');
      blobs.set(`:${file.path}`, 'source');
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputText(uri);
      const captured = await captureAt(uri);
      assert.ok(captured, warnings.join('\n'));
      if (change === 'base') { repository.state.HEAD = { commit: shaB }; }
      if (change === 'index') { blobs.set(`:${file.path}`, 'new source'); }
      if (change === 'boundary') { markers.set('/repo/src/.git', 2); }
      await assert.rejects(captured.validate(), /changed|boundary/);
      assert.equal(captured.comment.anchorText, 'source');
      assert.equal(captured.baseCommit, shaA);
    }
  });

  await t.test('mutable initial resolution rejects a Git change even when returned text and HEAD look unchanged', async () => {
    for (const ref of ['', 'HEAD', 'branch']) {
      reset();
      const uri = revision(ref);
      open(uri, 'source');
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputText(uri);
      repository.show = async () => {
        repository.state.HEAD = { commit: shaB };
        gitChanged.fire();
        repository.state.HEAD = { commit: shaA };
        return 'source';
      };

      const captured = await captureAt(uri);

      if (ref === 'branch') {
        assert.ok(captured, 'pinned commits are not invalidated by unrelated mutable Git events');
      } else {
        assert.equal(captured, undefined);
        assert.match(warnings[0], /revision or review base changed/);
      }
      assert.equal(gitChanged.listeners.size, 0);
    }
  });

  await t.test('validation covers earlier mutable endpoints while a later endpoint awaits', async () => {
    for (const mutation of ['indexEvent', 'tildeMapping', 'headRoundTrip'] as const) {
      reset();
      const original = revision(mutation === 'tildeMapping' ? '~' : '');
      const other = Uri.file('/repo/other/b.ts');
      const modified = revision('branch', other);
      open(original, 'original');
      open(modified, 'modified');
      blobs.set(`${mutation === 'tildeMapping' ? 'HEAD' : ''}:${file.path}`, 'original');
      blobs.set(`${shaA}:${other.path}`, 'modified');
      window.tabGroups.activeTabGroup.activeTab.input = new TabInputTextDiff(original, modified);
      const captured = await captureAt(original);
      assert.ok(captured, warnings.join('\n'));
      const started = deferred<void>();
      const resume = deferred<void>();
      const show = repository.show;
      repository.show = async (ref, target) => {
        const text = await show(ref, target);
        if (target === other.path) {
          started.resolve();
          await resume.promise;
        }
        return text;
      };

      const validation = captured.validate();
      await started.promise;
      if (mutation === 'tildeMapping') {
        repository.state.indexChanges = [{ uri: asUri(file) }];
      } else {
        if (mutation === 'indexEvent') { blobs.set(`:${file.path}`, 'new index text'); }
        repository.state.HEAD = { commit: shaB };
        gitChanged.fire();
        repository.state.HEAD = { commit: shaA };
      }
      resume.resolve();

      await assert.rejects(validation, /revision or review base changed/);
      assert.equal(captured.comment.anchorText, 'original');
      assert.equal(gitChanged.listeners.size, 0);
    }
  });

  await t.test('tilde mapping is rechecked after its own content read without relying on an event', async () => {
    reset();
    const uri = revision('~');
    open(uri, 'source');
    blobs.set(`HEAD:${file.path}`, 'source');
    window.tabGroups.activeTabGroup.activeTab.input = new TabInputText(uri);
    const captured = await captureAt(uri);
    assert.ok(captured, warnings.join('\n'));
    repository.show = async () => {
      repository.state.indexChanges = [{ uri: asUri(file) }];
      return 'source';
    };

    await assert.rejects(captured.validate(), /revision or review base changed/);
    assert.equal(gitChanged.listeners.size, 0);
  });

  await t.test('capture covers picker round trips but permits changed-only capture and cancellation', async () => {
    for (const mode of ['mutable', 'changed', 'cancel'] as const) {
      reset();
      const uri = mode === 'changed' ? file : revision('HEAD');
      open(uri, 'source');
      blobs.set(`HEAD:${file.path}`, 'source');
      picker = async choices => {
        repository.state.HEAD = { commit: shaB };
        gitChanged.fire();
        repository.state.HEAD = { commit: shaA };
        return mode === 'cancel' ? undefined : choices[0];
      };

      const captured = await captureAt(uri, true);

      assert.equal(Boolean(captured), mode === 'changed');
      assert.equal(warnings.length, mode === 'mutable' ? 1 : 0);
      assert.equal(gitChanged.listeners.size, 0);
    }
  });

  await t.test('changed buffers stay frozen across picker without saving or reading disk', async () => {
    reset();
    open(file, 'unsaved source');
    picker = async choices => {
      workspace.textDocuments[0].getText = () => 'new source';
      return choices[0];
    };
    const captured = await captureAt(file, true);
    assert.equal(captured?.comment.anchorText, 'unsaved source');
    assert.deepEqual(reads, []);
    assert.deepEqual(shows, []);
  });

  await t.test('capture marks only shortened snippets as elided and preserves CRLF and full range', async () => {
    for (const count of [16, 20, 21]) {
      reset();
      const lines = Array.from({ length: count }, (_, index) => index === 10 ? '...' : `line ${index + 1}`);
      open(file, lines.join('\r\n'));
      const selectedRange = { start: { line: 0, character: 0 }, end: { line: count - 1, character: 1 }, isEmpty: false } satisfies CaptureRange;
      const captured = await capture(git, asUri(file), selectedRange);
      assert.ok(captured, warnings.join('\n'));
      assert.equal(captured.comment.elided, count > 20);
      assert.equal(captured.comment.startLine, 1);
      assert.equal(captured.comment.endLine, count);
      assert.equal(captured.comment.anchorText,
        (count > 20 ? [...lines.slice(0, 10), '...', ...lines.slice(-5)] : lines).join('\r\n'));
    }
  });
  git.dispose();
});
