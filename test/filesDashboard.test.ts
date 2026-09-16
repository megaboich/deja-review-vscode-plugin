import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import type { DashboardAction, DashboardHostMessage, DashboardState } from '../src/dashboard';
import type { CapturedContext } from '../src/editorContext';
import type { ReviewArchive } from '../src/archive';
import type { ReviewArchives as SavedArchives } from '../src/archive';
import type { ReviewStore as SavedStore } from '../src/store';
import type { Repository } from '../src/git';
import type { Origin, Resource, ReviewComment, Side } from '../src/model';
import { parse } from '../src/parser';
import { parsedNotes } from '../src/model';
import { appendComment, appendGeneralNote } from '../src/writer';
import { Uri, EventEmitter, Range, MarkdownString, deferred } from './filesHostPrimitives';
import { scriptFixture } from './dashboardClientFixture';
import { activationContext } from './filesHostContextFixture';

// Bundled vscode.git status values, intentionally independent of source helpers.
const GitStatus = {
  IndexModified: 0,
  IndexDeleted: 2,
  Modified: 5,
  Deleted: 6,
  Untracked: 7,
  IntentToAdd: 9,
  IntentToRename: 10,
  TypeChanged: 11,
  BothModified: 18,
} as const;

type GitChange = NonNullable<Repository['state']['workingTreeChanges']>[number];
type StatisticsMethod = import('../src/git').GitResources['fileStatistics'];

const disposable = () => ({ dispose() {} });
const file = (value: string): vscode.Uri => Uri.file(value);
const change = (value: string, status: number = GitStatus.Modified): GitChange => ({ uri: file(value), status });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('Files to Review through activation in a synthetic VS Code host', { timeout: 10_000 }, async t => {
  // Only module code is loaded from disk. Persistence and all VS Code I/O are in memory.
  const gitChanged = new EventEmitter();
  const foldersChanged = new EventEmitter();
  const documentsChanged = new EventEmitter<{ document: { uri: vscode.Uri } }>();
  const documentOpened = new EventEmitter();
  const receive = new EventEmitter<unknown>();
  const viewDisposed = new EventEmitter();
  const visibilityChanged = new EventEmitter();
  const visibleEditorsChanged = new EventEmitter();
  const activeEditorChanged = new EventEmitter<vscode.TextEditor | undefined>();
  const commands = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  function registeredCommand(id: string): (...args: unknown[]) => Promise<unknown> {
    const callback = commands.get(id);
    assert.ok(callback, `Expected registered command ${id}`);
    return callback;
  }
  const executed: Array<{ command: string; args: unknown[] }> = [];
  const opened: vscode.Uri[] = [];
  const shown: Array<{ document: { uri: vscode.Uri }; options: unknown }> = [];
  const messages: DashboardState[] = [];
  const stateListeners = new Set<(state: DashboardState) => void>();
  const statisticsJobs: ReturnType<StatisticsMethod>[] = [];
  const errors: string[] = [];
  const sources = new Map<string, string>();
  const index = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const indexObjects = new Map<string, string>();
  const fileDiffs = new Map<string, string>();
  const diffPaths: string[] = [];
  const missing = new Set<string>();
  const adds: string[][] = [];
  const cleans: string[][] = [];
  const warnings: Array<{ message: string; options: unknown; items: string[] }> = [];
  const stores = new Map<string, ReviewStore>();
  let provider: vscode.WebviewViewProvider | undefined;
  let repository!: Repository;
  let scopedRepository: Repository | undefined;
  let repositories: Repository[] = [];
  let subscriptions: vscode.Disposable[] = [];
  let onOpen = async (_uri: vscode.Uri) => {};
  let onValidate = async (_origin: Origin) => {};
  let onDiff = async () => {};
  let onCandidates = async () => {};
  let onStatistics: (...args: Parameters<StatisticsMethod>) => Promise<Awaited<ReturnType<StatisticsMethod>> | undefined> = async () => undefined;
  let activeStatistics = 0;
  let maxActiveStatistics = 0;
  let onStat = async (_uri: vscode.Uri) => {};
  let onAdd = async () => {};
  let onClean = async () => {};
  let onWarning = async (): Promise<string | undefined> => 'Revert File';
  let diffText = '';
  let validations: Origin[] = [];
  let diffCalls = 0;
  let view!: { visible: boolean; webview: { html: string } };
  let onRead = async () => {};
  let onMutate = async () => {};
  let onPublish = async () => {};
  let onHandoff = async () => {};
  let onRestore = async () => {};
  let onList = async () => {};
  let onPick = async () => {};
  let onWorkspaceRepository = async () => {};
  let onFinalGuard = async () => {};
  let onPublished = async () => {};
  let onCommand = async (_command: string, _args: unknown[]) => {};
  let onCapture = async (): Promise<CapturedContext | undefined> => undefined;
  let onApplyEdit = async () => true;
  let onSaveDocument = async () => true;
  let onInformation = async (): Promise<string | undefined> => undefined;
  let ignoreSuggested = true;
  let sideBySide = true;
  const status = { ...disposable(), text: '', visible: false,
    show() { this.visible = true; }, hide() { this.visible = false; } };
  const edits: unknown[] = [];
  let documentSaves = 0;
  let mutationCancelled = false;
  let mutations = 0;
  let publications = 0;
  let handoffs = 0;
  let restores = 0;
  let inputChecks = 0;
  const batches = new Map<string, ReviewArchive & { text: string }>();
  const clipboard: string[] = [];

  class ReviewArchives implements Pick<SavedArchives, 'list'> {
    async list(): Promise<ReviewArchive[]> {
      await onList();
      return [...batches.values()];
    }
  }
  class ReviewStore implements Pick<SavedStore, 'uri' | 'onDidChange' | 'onDidChangeBusy' | 'busy' | 'read' | 'load' | 'mutate' | 'handoff' | 'restore' | 'dispose'> {
    readonly uri: vscode.Uri;
    readonly changed = new EventEmitter();
    readonly busyChanged = new EventEmitter();
    readonly onDidChange = this.changed.event;
    readonly onDidChangeBusy = this.busyChanged.event;
    busy = false;
    text: string | undefined;
    get savedText(): string {
      assert.ok(this.text !== undefined, 'Expected saved synthetic Review Notes');
      return this.text;
    }
    constructor(repo: Repository, readonly archives: ReviewArchives) {
      this.uri = file(`${repo.rootUri.fsPath}/REVIEW-NOTES.md`);
      stores.set(repo.rootUri.toString(), this);
    }
    async read(): ReturnType<SavedStore['read']> {
      await onRead();
      return this.text;
    }

    async load(): ReturnType<SavedStore['load']> {
      const text = await this.read();
      return { text, parsed: parse(text ?? '') };
    }

    async mutate(change: (text: string) => string, validate?: () => Promise<void>, validateInput?: () => void): ReturnType<SavedStore['mutate']> {
      assert.equal(this.busy, false, 'Concurrent saves must be rejected before the store');
      mutations++;
      this.busy = true;
      this.busyChanged.fire();
      try {
        await onMutate();
        if (mutationCancelled) { return false; }
        const snapshot = this.text;
        const next = change(snapshot ?? '');
        if (next === (snapshot ?? '')) { return false; }
        await onPublish();
        assert.ok(validate, 'Writes must supply an async publication guard');
        await validate();
        await onFinalGuard();
        assert.ok(validateInput, 'Writes must supply a final synchronous publication guard');
        validateInput();
        if (this.text !== snapshot) { throw new Error('Synthetic saved snapshot changed before publication'); }
        publications++;
        this.save(next);
        await onPublished();
        return true;
      } finally {
        this.busy = false;
        this.busyChanged.fire();
      }
    }
    async handoff(validateInput?: () => void): ReturnType<SavedStore['handoff']> {
      // Exercise the extension's callback contract, not filesystem/clipboard implementation details.
      handoffs++;
      assert.ok(validateInput, 'Handoff must supply an input guard');
      const check = () => { inputChecks++; validateInput(); };
      check();
      const snapshot = this.text;
      await onHandoff();
      check();
      if (!snapshot?.trim()) { return { status: 'empty' as const }; }
      assert.equal(this.text, snapshot);
      clipboard.push(snapshot);
      batches.set('copied', { id: 'copied', createdAt: '2026-01-01T00:00:00.000Z',
        commentCount: parsedNotes(parse(snapshot)).length, text: snapshot });
      check();
      this.save(undefined);
      return { status: 'copied' as const };
    }
    async restore(id: string, validateInput?: () => void): ReturnType<SavedStore['restore']> {
      restores++;
      assert.ok(validateInput, 'Recovery must supply an input guard');
      const check = () => { inputChecks++; validateInput(); };
      check();
      const snapshot = this.text;
      await onRestore();
      check();
      if (snapshot?.trim() || this.text !== snapshot) { return false; }
      const batch = batches.get(id);
      assert.ok(batch, 'Only synthetic archive membership may be recovered');
      this.save(batch.text);
      return true;
    }
    save(text: string | undefined): void {
      this.text = text;
      this.changed.fire();
    }

    dispose(): void {
      this.changed.dispose();
      this.busyChanged.dispose();
    }
  }

  function sourceText(target: string): string {
    const text = sources.get(target);
    assert.ok(text !== undefined, `Unexpected synthetic source read: ${target}`);
    return text;
  }

  const workspace = {
    workspaceFolders: [{ uri: file('/synthetic/repo') }],
    textDocuments: [] as Array<Pick<vscode.TextDocument, 'uri' | 'isDirty' | 'isClosed' | 'getText'>>,
    onDidChangeWorkspaceFolders: foldersChanged.event,
    onDidChangeTextDocument: documentsChanged.event,
    onDidOpenTextDocument: documentOpened.event,
    onDidChangeConfiguration: disposable,
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'renderSideBySide' ? sideBySide : fallback }),
    async applyEdit(edit: unknown) { edits.push(edit); return onApplyEdit(); },
    fs: {
      async stat(uri: vscode.Uri) {
        if (path.posix.basename(uri.path) === '.git') {
          throw Object.assign(new Error('No synthetic nested repository'), { code: 'FileNotFound' });
        }
        await onStat(uri);
        if (missing.has(uri.path)) {
          throw Object.assign(new Error('Synthetic deleted file'), { code: 'FileNotFound' });
        }
        if ([...sources.keys()].some(target => target.startsWith(`${uri.path}/`))) {
          return { type: 2, size: 0 };
        }
        return { type: 1, size: Buffer.byteLength(sourceText(uri.path)), mtime: mtimes.get(uri.path) };
      },
      async readFile(uri: vscode.Uri) {
        return Buffer.from(sourceText(uri.path));
      },
    },
    async openTextDocument(uri: vscode.Uri) {
      assert.ok(sources.has(uri.path), `Unexpected document open: ${uri.path}`);
      opened.push(uri);
      await onOpen(uri);
      return { uri, isDirty: false, getText: () => sources.get(uri.path) ?? '',
        positionAt: (offset: number) => ({ line: 0, character: offset }),
        async save() { documentSaves++; return onSaveDocument(); } };
    },
  };
  const mock = {
    Uri, EventEmitter, ThemeColor: class {},
    Range, MarkdownString,
    Selection: class { constructor(readonly start: unknown, readonly end: unknown) {} },
    WorkspaceEdit: class { insert(_uri: vscode.Uri, _position: unknown, _text: string) {} },
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 0 },
    Diagnostic: class { constructor(..._args: unknown[]) {} },
    DiagnosticSeverity: { Warning: 1 }, FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    StatusBarAlignment: { Left: 1 }, OverviewRulerLane: { Right: 4 },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    workspace,
    extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => ({
      state: 'initialized', get repositories() { return repositories; },
    }) }) }) },
    comments: { createCommentController: () => ({ ...disposable(),
      createCommentThread: (uri: vscode.Uri, range: vscode.Range, comments: vscode.Comment[]) => ({
        uri, range, comments, dispose() {},
      }),
    }) },
    languages: { createDiagnosticCollection: () => ({ ...disposable(), clear() {}, set() {} }) },
    window: {
      visibleTextEditors: [] as Array<{
        document: Pick<vscode.TextDocument, 'uri' | 'isDirty' | 'isClosed' | 'getText'>;
        setDecorations: vscode.TextEditor['setDecorations'];
      }>, tabGroups: { activeTabGroup: {} },
      createStatusBarItem: () => status,
      createOutputChannel: () => ({ ...disposable(), appendLine() {} }),
      createTextEditorDecorationType: disposable,
      registerWebviewViewProvider(id: string, value: vscode.WebviewViewProvider) {
        assert.equal(id, 'dejareview.dashboard'); provider = value; return disposable();
      },
      onDidChangeActiveTextEditor: activeEditorChanged.event,
      onDidChangeTextEditorSelection: disposable,
      onDidChangeVisibleTextEditors: visibleEditorsChanged.event,
      async showTextDocument(document: { uri: vscode.Uri }, options: unknown) { shown.push({ document, options }); },
      async showErrorMessage(message: string) { errors.push(message); },
      async showInformationMessage() { return onInformation(); },
      async showQuickPick(items: Array<{ id: string }>) { await onPick(); return items[0]; },
      async showWarningMessage(message: string, options: unknown, ...items: string[]) {
        warnings.push({ message, options, items });
        if (options !== undefined) {
          assert.deepEqual(options, { modal: true });
        }
        return onWarning();
      },
    },
    commands: {
      registerCommand(id: string, callback: (...args: unknown[]) => Promise<unknown>) {
        commands.set(id, callback); return { dispose: () => { commands.delete(id); } };
      },
      async executeCommand(command: string, ...args: unknown[]) {
        executed.push({ command, args });
        await onCommand(command, args);
      },
    },
  };
  const loader = require('node:module') as { _load(request: string, ...args: unknown[]): unknown };
  const load = loader._load;
  t.mock.method(loader, '_load', function (this: unknown, request: string, ...args: unknown[]) {
    if (request === 'vscode') { return mock; }
    const parent = args[0];
    const filename = parent && typeof parent === 'object' && 'filename' in parent ? parent.filename : undefined;
    if (filename === require.resolve('../src/extension')) {
      if (request === './store') { return { ReviewStore }; }
      if (request === './archive') { return { ReviewArchives }; }
      if (request === './editorContext') { return { captureContext: () => onCapture() }; }
    }
    if (filename === require.resolve('../src/git') && request === 'node:fs/promises') {
      return {
        async open(target: string) {
          const bytes = Buffer.from(sourceText(target));
          return {
            async stat() { return { size: bytes.length, isFile: () => true }; },
            async read(buffer: Buffer, offset: number, length: number, position: number) {
              const bytesRead = bytes.copy(buffer, offset, position, position + length);
              return { bytesRead, buffer };
            },
            async close() {},
          };
        },
      };
    }
    return load.call(this, request, ...args);
  });
  const { GitResources } = require('../src/git') as typeof import('../src/git');
  const filesToReview = GitResources.prototype.filesToReview;
  t.mock.method(GitResources.prototype, 'filesToReview', async function (
    this: InstanceType<typeof GitResources>, ...args: Parameters<typeof filesToReview>
  ) {
    await onCandidates();
    return filesToReview.apply(this, args);
  });
  const fileStatistics = GitResources.prototype.fileStatistics;
  t.mock.method(GitResources.prototype, 'fileStatistics', function (
    this: InstanceType<typeof GitResources>, ...args: Parameters<StatisticsMethod>
  ): ReturnType<StatisticsMethod> {
    const job = (async () => {
      activeStatistics++;
      maxActiveStatistics = Math.max(maxActiveStatistics, activeStatistics);
      try {
        const result = await onStatistics(...args);
        return result ?? await fileStatistics.apply(this, args);
      } finally {
        activeStatistics--;
      }
    })();
    statisticsJobs.push(job);
    return job;
  });
  const workspaceRepository = GitResources.prototype.workspaceRepository;
  t.mock.method(GitResources.prototype, 'workspaceRepository', async function (this: InstanceType<typeof GitResources>) {
    await onWorkspaceRepository();
    const repo = await workspaceRepository.call(this);
    scopedRepository = repo;
    return repo;
  });
  const validate = GitResources.prototype.validatedUri;
  t.mock.method(GitResources.prototype, 'validatedUri', async function (this: InstanceType<typeof GitResources>, resource: Resource, repo: Repository) {
    const uri = await validate.call(this, resource, repo);
    validations.push(resource.origin);
    await onValidate(resource.origin);
    return uri;
  });
  const { activate } = require('../src/extension') as typeof import('../src/extension');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { subscriptions.forEach(item => item.dispose()); });

  const state = (): DashboardState => {
    const current = messages.at(-1);
    assert.ok(current, 'Expected a published dashboard state');
    return current;
  };
  const repoKey = (): string => {
    const key = state().repoKey;
    assert.ok(key, 'The action requires a supported project folder');
    return key;
  };
  const paths = () => state().files.map(row => row.path);
  function waitForState(predicate: (value: DashboardState) => boolean): Promise<void> {
    if (messages.length && predicate(state())) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const listener = (value: DashboardState): void => {
        if (predicate(value)) {
          stateListeners.delete(listener);
          resolve();
        }
      };
      stateListeners.add(listener);
    });
  }
  async function statisticsPublished(): Promise<void> {
    // Settled display rows remain non-pending during revalidation. Drain the
    // background work rather than mistaking retained counts for completion.
    await settle();
    await statisticsFinished();
    await waitForState(value => value.files.every(row => row.statisticsPending === false));
  }
  async function statisticsFinished(): Promise<void> {
    // The host registered its continuation before these waits. This also drains
    // rejected/obsolete jobs that deliberately produce no dashboard publication.
    let completed = 0;
    do {
      const jobs = statisticsJobs.slice(completed);
      completed = statisticsJobs.length;
      await Promise.allSettled(jobs);
    } while (completed < statisticsJobs.length);
  }
  function currentEditor(): NonNullable<DashboardState['editor']> {
    const editor = state().editor;
    assert.ok(editor, 'Expected an active host-held editor');
    return editor;
  }
  const store = (): ReviewStore => {
    const current = stores.get(workspace.workspaceFolders[0].uri.toString());
    assert.ok(current, 'Expected a store for the opened folder');
    return current;
  };
  const navigation = () => executed.filter(call => call.command !== 'setContext');
  const action = (target = 'src/a.ts') => {
    const row = state().files.find(row => row.path === target);
    assert.ok(row, `Missing candidate ${target}`);
    return { type: 'openFile' as const, repoKey: repoKey(), fileId: row.id };
  };
  const stageAction = () => ({ ...action(), type: 'stageFile' as const });
  const revertAction = (target?: string) => ({ ...action(target), type: 'revertFile' as const });
  // Bypass webview serialization to exercise the host's independent busy/membership guards.
  const incoming = async (value: DashboardAction): Promise<void> => {
    assert.ok(provider, 'Expected a registered dashboard provider');
    assert.ok('onAction' in provider && typeof provider.onAction === 'function', 'Expected the registered host action callback');
    await provider.onAction(value);
  };
  const automaticRefresh = async () => {
    // Advance the debounce, then drain asynchronous work without invoking refresh ourselves.
    t.mock.timers.tick(1000);
    await settle();
    assert.deepEqual(errors, []);
  };
  const mountView = async () => {
    const next = {
      visible: true, onDidDispose: viewDisposed.event, onDidChangeVisibility: visibilityChanged.event,
      viewType: 'dejareview.dashboard', show() {},
      webview: { html: '', options: {}, onDidReceiveMessage: receive.event,
        cspSource: 'test-webview:',
        asWebviewUri() { return assert.fail('Dashboard must not load external resources'); },
        async postMessage(message: DashboardHostMessage) {
          if (message.type === 'state') {
            messages.push(message.state);
            for (const listener of stateListeners) {
              listener(message.state);
            }
          }
          return true;
        },
      },
    } satisfies vscode.WebviewView;
    view = next;
    assert.ok(provider, 'Activation must register the dashboard provider before mounting');
    await provider.resolveWebviewView(next, { state: undefined }, {
      isCancellationRequested: false, onCancellationRequested: disposable,
    });
    receive.fire({ type: 'ready' });
  };
  const reset = async (status: number = GitStatus.Modified, group: 'workingTreeChanges' | 'untrackedChanges' = 'workingTreeChanges') => {
    subscriptions.forEach(item => item.dispose());
    await statisticsFinished();
    statisticsJobs.length = 0;
    stateListeners.clear();
    subscriptions = [];
    sources.clear();
    missing.clear();
    index.clear();
    mtimes.clear();
    indexObjects.clear();
    fileDiffs.clear();
    diffPaths.length = 0;
    stores.clear();
    batches.clear();
    clipboard.length = 0;

    adds.length = 0;
    cleans.length = 0;
    messages.length = 0;
    executed.length = 0;
    warnings.length = 0;
    opened.length = 0;
    shown.length = 0;
    errors.length = 0;
    validations = [];
    edits.length = 0;

    onOpen = async () => {};
    onValidate = async () => {};
    onDiff = async () => {};
    onCandidates = async () => {};
    onStatistics = async () => undefined;
    activeStatistics = 0;
    maxActiveStatistics = 0;
    onStat = async () => {};
    onAdd = async () => {};
    onClean = async () => {};
    onWarning = async () => 'Revert File';
    onRead = async () => {};
    onMutate = async () => {};
    onPublish = async () => {};
    onHandoff = async () => {};
    onRestore = async () => {};
    onList = async () => {};
    onPick = async () => {};
    onWorkspaceRepository = async () => {};
    onFinalGuard = async () => {};
    onCommand = async () => {};
    onCapture = async () => undefined;
    onPublished = async () => {};
    onApplyEdit = async () => true;
    onSaveDocument = async () => true;
    onInformation = async () => undefined;

    ignoreSuggested = true;
    sideBySide = true;
    mutationCancelled = false;
    diffCalls = 0;
    documentSaves = 0;
    mutations = 0;
    publications = 0;
    handoffs = 0;
    restores = 0;
    inputChecks = 0;

    diffText = '@@ -1 +1,2 @@\n-index content\n+disk content\n+extra\n';
    workspace.workspaceFolders = [{ uri: file('/synthetic/repo') }];
    workspace.textDocuments = [];
    mock.window.visibleTextEditors = [];
    sources.set('/synthetic/repo/src/a.ts', 'disk content\n');
    sources.set('/synthetic/repo/src/other.ts', 'other disk content\n');
    index.set('/synthetic/repo/src/a.ts', 'index content\n');
    index.set('/synthetic/repo/src/other.ts', 'other index content\n');
    repository = {
      rootUri: workspace.workspaceFolders[0].uri,
      state: { HEAD: { commit: 'a'.repeat(40) }, onDidChange: gitChanged.event,
        workingTreeChanges: [], untrackedChanges: [], indexChanges: [],
        [group]: [change('/synthetic/repo/src/a.ts', status)],
      },
      async show(_ref, target) {
        return sourceText(target);
      },
      async getCommit() { return { hash: 'b'.repeat(40) }; },
      async getObjectDetails(ref, target) {
        assert.equal(ref, '', 'Statistics signatures must use the index, not HEAD');
        const object = indexObjects.get(target);
        assert.ok(object, `No synthetic index signature: ${target}`);
        return { mode: '100644', object, size: Buffer.byteLength(index.get(target) ?? '') };
      },
      async add(paths) {
        assert.equal(paths.length, 1, 'Only one literal file may reach the synthetic Git boundary');
        assert.ok(path.isAbsolute(paths[0]));
        adds.push([...paths]);
        await onAdd();
      },
      async clean(paths) {
        assert.equal(paths.length, 1, 'Only one literal file may reach the synthetic clean boundary');
        const target = paths[0];
        assert.ok(path.isAbsolute(target));
        assert.ok(sources.has(target) || missing.has(target), `Unexpected clean: ${target}`);
        cleans.push([...paths]);
        await onClean();
        // Model only Git.clean's disk effect; Git state publication remains independently controlled.
        const stagedText = index.get(target);
        if (stagedText !== undefined) {
          sources.set(target, stagedText);
          missing.delete(target);
        } else {
          sources.delete(target);
          missing.add(target);
        }
      },
      async diffWithHEAD(target) {
        assert.ok(sources.has(target), `Unexpected diff: ${target}`);
        diffCalls++;
        diffPaths.push(target);
        await onDiff();
        return fileDiffs.get(target) ?? diffText;
      },
    };
    repositories = [repository];
    const api = await activate(activationContext(subscriptions, () => ignoreSuggested));
    await mountView();
    await statisticsPublished();
    assert.deepEqual(paths(), ['src/a.ts']);
    assert.deepEqual(errors, []);
    return api;
  };

  const send = async (message: unknown) => { receive.fire(message); await settle(); };
  const generalAction = (): DashboardAction => ({ type: 'addGeneral', repoKey: repoKey() });
  const noteAction = (index: number, type: 'edit' | 'open' = 'edit'): Extract<DashboardAction, { noteId: string }> => ({
    type, repoKey: repoKey(), noteId: state().notes[index].id,
  });
  let editorRequestSequence = 0;
  function editorAction(type: 'input' | 'saveEdit', body?: string): Extract<DashboardAction, { body: string }> & { requestId: string };
  function editorAction(type: 'cancelEdit', body?: string): Extract<DashboardAction, { type: 'cancelEdit' }> & { requestId: string };
  function editorAction(type: 'input' | 'saveEdit' | 'cancelEdit', body?: string): Extract<DashboardAction, { editorId: string }> & { requestId: string };
  function editorAction(type: 'input' | 'saveEdit' | 'cancelEdit', body = ''): Extract<DashboardAction, { editorId: string }> & { requestId: string } {
    const editor = state().editor;
    assert.ok(editor, 'An explicit host-held editor must exist');
    const requestId = String(++editorRequestSequence);
    if (type === 'cancelEdit') { return { type, repoKey: editor.repoKey, editorId: editor.id, requestId }; }
    return { type, repoKey: editor.repoKey, editorId: editor.id, body, requestId };
  }
  const staleNote = (body = 'File preview\nSecond line\nPRIVATE_FILE_BODY') => ({
    path: 'src/a.ts', origin: 'head' as const, side: 'left' as const, startLine: 2, endLine: 3,
    comparison: { left: { path: 'src/a.ts', origin: 'head' as const },
      right: { path: 'src/other.ts', origin: 'changed' as const } },
    anchorText: 'PRIVATE_MISSING_ANCHOR\nnot present on disk', body,
  });
  const mixedText = () => appendGeneralNote(appendComment(appendGeneralNote('',
    'General preview\nSecond line\nPRIVATE_GENERAL_BODY'), staleNote()), 'Last general note');
  const seedArchive = () => {
    const batch = { id: '12345678-1234-4123-8123-123456789abc', createdAt: '2026-01-01T00:00:00.000Z',
      commentCount: 7, text: appendGeneralNote('', 'Synthetic recovered body\nline two\nPRIVATE_ARCHIVE_BODY') };
    batches.set(batch.id, batch);
    return batch;
  };
  const switchFolder = () => {
    workspace.workspaceFolders = [{ uri: file('/synthetic/other') }];
    repository = { ...repository, rootUri: workspace.workspaceFolders[0].uri,
      state: { ...repository.state, workingTreeChanges: [change('/synthetic/other/src/a.ts')] } };
    repositories = [repository];
    sources.set('/synthetic/other/src/a.ts', 'other folder\n');
    foldersChanged.fire();
  };

  const nativeNote = async (api: Awaited<ReturnType<typeof activate>>, comparison = false) => {
    store().save(appendComment('', {
      path: 'src/a.ts', origin: 'changed', side: comparison ? 'right' : 'document',
      startLine: 2, endLine: 2, anchorText: 'disk content', body: 'Original native body',
      comparison: comparison ? {
        left: { path: 'src/a.ts', origin: 'head' }, right: { path: 'src/a.ts', origin: 'changed' },
      } : undefined,
    }));
    await registeredCommand('dejareview.refresh')();
    const thread = api.getThreads()[0];
    assert.ok(thread);
    const note = thread.comments[0];
    assert.ok(note);
    return { thread, note };
  };

  for (const operation of ['copy', 'restore'] as const) {
    for (const wait of ['discovery', 'initial context', 'final callback'] as const) {
      await t.test(`${operation} rejects a folder switch during ${wait} without touching either store`, async child => {
        child.mock.method(console, 'error', () => {});
        await reset();
        const batch = seedArchive();
        if (operation === 'copy') { store().save(mixedText()); }
        await registeredCommand('dejareview.refresh')();
        const original = store();
        const snapshot = original.text;
        const started = deferred();
        const release = deferred();
        const pause = async () => { started.resolve(); await release.promise; };
        if (wait === 'discovery') { onWorkspaceRepository = pause; }
        if (wait === 'initial context') {
          onCommand = async (command, args) => {
            if (command === 'setContext' && args[0] === 'dejareview.copyInProgress' && args[1] === true) { await pause(); }
          };
        }
        if (wait === 'final callback') {
          if (operation === 'copy') { onHandoff = pause; } else { onRestore = pause; }
        }
        const pending = registeredCommand(operation === 'copy' ? 'dejareview.copyForAgent' : 'dejareview.restoreArchive')(batch.id);
        await started.promise;
        switchFolder();
        release.resolve();
        await pending;

        assert.equal(original.text, snapshot);
        assert.equal(stores.size, 1);
        assert.deepEqual(clipboard, []);
        assert.equal(state().busy, false);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /project folder changed/);
      });
    }

    await t.test(`${operation} releases busy after initial setContext rejects and permits retry`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      const batch = seedArchive();
      if (operation === 'copy') { store().save(mixedText()); }
      await registeredCommand('dejareview.refresh')();
      onCommand = async (command, args) => {
        if (command === 'setContext' && args[0] === 'dejareview.copyInProgress' && args[1] === true) {
          throw new Error('Synthetic context failure');
        }
      };
      const command = registeredCommand(operation === 'copy' ? 'dejareview.copyForAgent' : 'dejareview.restoreArchive');
      await command(batch.id);
      assert.equal(state().busy, false);
      assert.equal(handoffs + restores, 0);
      assert.match(errors[0], /Synthetic context failure/);
      onCommand = async () => {};
      await command(batch.id);
      assert.equal(handoffs + restores, 1);
      assert.equal(state().busy, false);
    });
  }

  for (const wait of ['archive listing', 'archive picker'] as const) {
    await t.test(`recovery binds its folder across ${wait}`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      seedArchive();
      const started = deferred();
      const release = deferred();
      const pause = async () => { started.resolve(); await release.promise; };
      if (wait === 'archive listing') { onList = pause; } else { onPick = pause; }
      const pending = registeredCommand('dejareview.restoreArchive')();
      await started.promise;
      switchFolder();
      release.resolve();
      await pending;
      assert.equal(restores, 0);
      assert.match(errors[0], /project folder changed/);
    });
  }

  for (const operation of ['save', 'delete', 'reanchor'] as const) {
    await t.test(`native ${operation} rejects a folder switch after async validation and before final publication`, async child => {
      child.mock.method(console, 'error', () => {});
      const api = await reset();
      const { note } = await nativeNote(api);
      const original = store();
      const snapshot = original.text;
      if (operation === 'save') {
        await registeredCommand('dejareview.editComment')(note);
        note.body = 'Changed native body';
      }
      const started = deferred();
      const release = deferred();
      onFinalGuard = async () => { started.resolve(); await release.promise; };
      const command = {
        save: 'dejareview.saveComment',
        delete: 'dejareview.deleteComment',
        reanchor: 'dejareview.reanchorAll',
      }[operation];
      const pending = registeredCommand(command)(note);
      await started.promise;
      switchFolder();
      release.resolve();
      await pending;
      assert.equal(publications, 0);
      assert.equal(original.text, snapshot);
      assert.match(errors[0], /project folder changed/);
      if (operation === 'save') { assert.equal(note.body, 'Changed native body'); }
    });
  }

  await t.test('native cancel revokes a pending save, repeat saves are rejected and a fresh edit can retry', async child => {
    child.mock.method(console, 'error', () => {});
    const api = await reset();
    const { note } = await nativeNote(api);
    await registeredCommand('dejareview.editComment')(note);
    note.body = 'First submitted body';
    const started = deferred();
    const release = deferred();
    onFinalGuard = async () => { started.resolve(); await release.promise; };
    const pending = registeredCommand('dejareview.saveComment')(note);
    await started.promise;
    await registeredCommand('dejareview.saveComment')(note);
    assert.equal(mutations, 1);
    await registeredCommand('dejareview.cancelEdit')(note);
    release.resolve();
    await pending;
    assert.equal(publications, 0);
    assert.equal(parse(store().savedText).comments[0].body, 'Original native body');
    assert.match(errors[0], /cancelled or replaced/);
    onFinalGuard = async () => {};
    await registeredCommand('dejareview.editComment')(note);
    note.body = 'Retry body';
    await registeredCommand('dejareview.saveComment')(note);
    assert.equal(publications, 1);
    assert.equal(parse(store().savedText).comments[0].body, 'Retry body');
  });

  for (const wait of ['mutation', 'temporary publication', 'final guard'] as const) {
    await t.test(`native save retains newer typing during ${wait} and permits retry without reopening`, async child => {
      child.mock.method(console, 'error', () => {});
      const api = await reset();
      const { note, thread } = await nativeNote(api);
      const snapshot = store().text;
      await registeredCommand('dejareview.editComment')(note);
      note.body = 'Frozen submitted body';
      const started = deferred();
      const release = deferred();
      const pause = async () => { started.resolve(); await release.promise; };
      switch (wait) {
        case 'mutation': onMutate = pause; break;
        case 'temporary publication': onPublish = pause; break;
        case 'final guard': onFinalGuard = pause; break;
      }
      const pending = registeredCommand('dejareview.saveComment')(note);
      await started.promise;
      const newerBody = new MarkdownString('Newer input typed while saving');
      note.body = newerBody;
      release.resolve();
      await pending;

      assert.equal(publications, 0);
      assert.equal(store().text, snapshot);
      assert.equal(note.body, newerBody);
      assert.equal(note.mode, mock.CommentMode.Editing);
      assert.equal(note.contextValue, 'editing');
      assert.equal(thread.comments[0], note);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /input changed.*newer input is retained; save again/i);
      await registeredCommand('dejareview.refresh')();
      assert.equal(thread.comments[0], note);
      assert.equal(note.body, newerBody);

      onMutate = async () => {};
      onPublish = async () => {};
      onFinalGuard = async () => {};
      await registeredCommand('dejareview.saveComment')(note);
      assert.equal(publications, 1);
      assert.equal(parse(store().savedText).comments[0].body, newerBody.value);
      assert.equal(note.mode, mock.CommentMode.Preview);
      assert.equal(errors.length, 1, 'Retry must not fail against the original saved target');
    });
  }

  for (const changedTarget of [false, true]) {
    await t.test(`native save retains postpublication typing and ${changedTarget ? 'rejects an externally changed retry target' : 'retries the exact published duplicate'}`, async child => {
      child.mock.method(console, 'error', () => {});
      const api = await reset();
      await nativeNote(api);
      const original = parse(store().savedText).comments[0];
      store().save(appendComment(store().savedText, original));
      await registeredCommand('dejareview.refresh')();
      const thread = api.getThreads()[1];
      assert.ok(thread);
      const note = thread.comments[0];
      assert.ok(note);
      const firstBlock = parse(store().savedText).comments[0].rawBlock;
      await registeredCommand('dejareview.editComment')(note);
      note.body = 'Published earlier body';
      const started = deferred();
      const release = deferred();
      onPublished = async () => { started.resolve(); await release.promise; };
      const pending = registeredCommand('dejareview.saveComment')(note);
      await started.promise;
      assert.equal(publications, 1);
      assert.deepEqual(parse(store().savedText).comments.map(comment => comment.body),
        ['Original native body', 'Published earlier body']);
      note.body = 'Newer input after the final publication guard';
      release.resolve();
      await pending;

      assert.equal(note.body, 'Newer input after the final publication guard');
      assert.equal(note.mode, mock.CommentMode.Editing);
      assert.equal(note.contextValue, 'editing');
      assert.equal(thread.comments[0], note);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /earlier Review Note body was saved.*newer input is retained; save again/);
      await registeredCommand('dejareview.refresh')();
      assert.equal(thread.comments[0], note);
      assert.equal(note.body, 'Newer input after the final publication guard');

      if (changedTarget) {
        store().text = store().savedText.replace('Published earlier body', 'External replacement');
      }
      onPublished = async () => {};
      await registeredCommand('dejareview.saveComment')(note);
      const parsed = parse(store().savedText);
      assert.equal(parsed.comments[0].rawBlock, firstBlock);
      if (changedTarget) {
        assert.equal(publications, 1);
        assert.equal(parsed.comments[1].body, 'External replacement');
        assert.equal(note.body, 'Newer input after the final publication guard');
        assert.equal(note.mode, mock.CommentMode.Editing);
        assert.match(errors[1], /changed on disk/);
      } else {
        assert.equal(publications, 2);
        assert.equal(parsed.comments[1].body, 'Newer input after the final publication guard');
        assert.equal(note.mode, mock.CommentMode.Preview);
        assert.equal(errors.length, 1);
      }
    });
  }

  for (const mutation of ['cancel', 'folder', 'Git event', 'late body'] as const) {
    await t.test(`native submit handles ${mutation} at the final synchronous guard`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      const original = store();
      onCapture = async () => {
        assert.ok(scopedRepository);
        return {
          repo: scopedRepository, uri: file('/synthetic/repo/src/a.ts'), baseCommit: repository.state.HEAD?.commit,
          comment: { path: 'src/a.ts', origin: 'changed', side: 'document', startLine: 1, endLine: 1,
            anchorText: 'disk content', body: '' },
          async validate() {},
        };
      };
      const thread = { uri: file('/synthetic/repo/src/a.ts'), comments: [], dispose() {} } satisfies
        Pick<vscode.CommentThread, 'uri' | 'comments' | 'dispose'>;
      const reply = { thread, text: 'Frozen submitted body' };
      const started = deferred();
      const release = deferred();
      onFinalGuard = async () => { started.resolve(); await release.promise; };
      const pending = registeredCommand('dejareview.submitComment')(reply);
      await started.promise;
      await registeredCommand('dejareview.submitComment')(reply);
      assert.equal(mutations, 1);
      switch (mutation) {
        case 'cancel': await registeredCommand('dejareview.cancelDraft')(thread); break;
        case 'folder': switchFolder(); break;
        case 'Git event': gitChanged.fire(); break;
        case 'late body': reply.text = 'Late body must not replace submitted text'; break;
      }
      release.resolve();
      await pending;
      assert.equal(publications, mutation === 'late body' ? 1 : 0);
      if (mutation === 'late body') {
        assert.equal(parse(original.savedText).comments[0].body, 'Frozen submitted body');
        assert.deepEqual(errors, []);
      } else {
        assert.equal(original.text, undefined);
        assert.equal(errors.length, 1);
      }
    });
  }

  for (const event of ['Git event', 'cancel', 'folder', 'dispose', 'refresh failure', 'folder during refresh'] as const) {
    await t.test(`native submit consumes its published draft after ${event} during the rename await`, async child => {
      child.mock.method(console, 'error', () => {});
      const api = await reset();
      const original = store();
      onCapture = async () => {
        assert.ok(scopedRepository);
        return {
          repo: scopedRepository,
          uri: file('/synthetic/repo/src/a.ts'),
          baseCommit: repository.state.HEAD?.commit,
          comment: {
            path: 'src/a.ts', origin: 'changed', side: 'document',
            startLine: 1, endLine: 1, anchorText: 'disk content', body: '',
          },
          async validate() {},
        };
      };
      let disposed = false;
      const thread = {
        uri: file('/synthetic/repo/src/a.ts'),
        comments: [],
        dispose() { disposed = true; },
      } satisfies Pick<vscode.CommentThread, 'uri' | 'comments' | 'dispose'>;
      const reply = { thread, text: 'Published submission' };
      const renamed = deferred();
      const release = deferred();
      onPublished = async () => {
        renamed.resolve();
        await release.promise;
      };

      const submit = registeredCommand('dejareview.submitComment');
      const pending = submit(reply);
      await renamed.promise;
      assert.equal(publications, 1);
      assert.deepEqual(parse(original.savedText).comments.map(note => note.body), ['Published submission']);
      switch (event) {
        case 'Git event':
          gitChanged.fire();
          break;
        case 'cancel':
          await registeredCommand('dejareview.cancelDraft')(thread);
          break;
        case 'folder':
          switchFolder();
          break;
        case 'dispose':
          subscriptions.forEach(item => item.dispose());
          break;
        case 'refresh failure':
          onWorkspaceRepository = async () => {
            throw new Error('Synthetic refresh failure');
          };
          break;
        case 'folder during refresh':
          onWorkspaceRepository = async () => {
            onWorkspaceRepository = async () => {};
            switchFolder();
          };
          break;
      }
      const commandsBeforeCompletion = executed.length;
      release.resolve();
      await pending;

      assert.equal(disposed, true);
      assert.deepEqual(errors, []);
      if (event === 'Git event') {
        assert.equal(api.getState().comments, 1);
        assert.equal(api.getThreads().length, 1);
      } else if (event === 'cancel' || event === 'folder' || event === 'dispose') {
        assert.equal(executed.length, commandsBeforeCompletion, 'Obsolete completion must not refresh or retarget UI');
        assert.equal(api.getThreads().length, 0);
      } else if (event === 'refresh failure') {
        assert.match(warnings.at(-1)?.message ?? '', /Review Note was saved, but its display could not be refreshed/);
      } else {
        assert.equal(api.getState().repo, '/synthetic/other');
        assert.equal(api.getThreads().length, 0, 'Do not reveal the old submission in the new folder');
      }

      onPublished = async () => {};
      await submit(reply);
      assert.equal(mutations, 1, 'Retrying the consumed submission must not enter the store');
      assert.equal(publications, 1);
      assert.deepEqual(parse(original.savedText).comments.map(note => note.body), ['Published submission']);
      assert.deepEqual(errors, []);
    });
  }

  await t.test('cancel during native capture prevents a later submission and never enters the store', async () => {
    await reset();
    const started = deferred();
    const release = deferred();
    onCapture = async () => {
      started.resolve();
      await release.promise;
      return { repo: repository, uri: file('/synthetic/repo/src/a.ts'),
        comment: { path: 'src/a.ts', origin: 'changed', side: 'document', startLine: 1, endLine: 1, body: '' },
        async validate() {} };
    };
    const thread = { uri: file('/synthetic/repo/src/a.ts'), comments: [], dispose() {} };
    const pending = registeredCommand('dejareview.submitComment')({ thread, text: 'Cancelled input' });
    await started.promise;
    await registeredCommand('dejareview.cancelDraft')(thread);
    release.resolve();
    await pending;
    assert.equal(mutations, 0);
    assert.equal(store().text, undefined);
  });

  for (const changeFolder of [false, true]) {
    await t.test(`activation awaits rediscovery after ${changeFolder ? 'a folder switch' : 'a startup notification'} invalidates subfolder discovery`, async () => {
      await reset();
      subscriptions.forEach(item => item.dispose());
      subscriptions = [];
      stores.clear();
      workspace.workspaceFolders = [{ uri: file('/synthetic/repo/src') }];
      const started = deferred();
      const release = deferred();
      let calls = 0;
      onWorkspaceRepository = async () => {
        if (++calls === 1) { started.resolve(); await release.promise; }
      };
      const activation = activate(activationContext(subscriptions, () => true));
      await started.promise;
      if (changeFolder) { workspace.workspaceFolders = [{ uri: file('/synthetic/repo') }]; }
      foldersChanged.fire();
      release.resolve();
      const api = await activation;

      assert.equal(api.getState().repo, changeFolder ? '/synthetic/repo' : '/synthetic/repo/src');
      assert.equal(api.getState().hasFeedback, false);
      assert.equal(stores.size, 1, 'Obsolete startup discovery must not create an old-folder store');
      assert.ok(calls >= 2, 'Activation must retry invalidated discovery without advancing the debounce timer');
      assert.deepEqual(errors, []);
    });
  }

  await t.test('an awaited refresh drains watcher invalidation rather than returning an old projection', async () => {
    const api = await reset();
    store().text = appendGeneralNote('', 'Old projection');
    await api.refresh();
    const started = deferred();
    const release = deferred();
    let reads = 0;
    onRead = async () => {
      if (++reads === 1) { started.resolve(); await release.promise; }
    };
    const pending = api.refresh();
    await started.promise;
    store().save(appendGeneralNote(appendGeneralNote('', 'First new note'), 'Second new note'));
    release.resolve();
    await pending;

    assert.equal(api.getState().comments, 2);
    assert.deepEqual(state().notes.map(note => note.preview), ['First new note', 'Second new note']);
    assert.ok(reads >= 2);
    assert.deepEqual(errors, []);
  });

  await t.test('overlapping refresh callers await the newer projection after paused discovery', async () => {
    await reset();
    const started = deferred();
    const release = deferred();
    let calls = 0;
    onWorkspaceRepository = async () => {
      if (++calls === 1) { started.resolve(); await release.promise; }
    };
    const older = registeredCommand('dejareview.refresh')();
    await started.promise;
    store().text = appendGeneralNote('', 'Newer projection');
    repository.state.workingTreeChanges = [];
    const newer = registeredCommand('dejareview.refresh')();
    release.resolve();
    await Promise.all([older, newer]);
    assert.equal(state().notes[0].preview, 'Newer projection');
    assert.deepEqual(paths(), []);
    assert.deepEqual(errors, []);
  });

  await t.test('old refresh cannot publish status after its final setContext wait', async () => {
    await reset();
    store().text = appendGeneralNote('', 'Old projection');
    const started = deferred();
    const release = deferred();
    let paused = false;
    onCommand = async (command, args) => {
      if (!paused && command === 'setContext' && args[0] === 'dejareview.hasFeedback' && args[1] === true) {
        paused = true;
        started.resolve();
        await release.promise;
      }
    };
    const older = registeredCommand('dejareview.refresh')();
    await started.promise;
    store().text = undefined;
    const newer = registeredCommand('dejareview.refresh')();
    release.resolve();
    await Promise.all([older, newer]);
    assert.equal(status.visible, false);
    assert.equal(state().hasFeedback, false);
  });

  await t.test('comparison layout toggle revalidates saved feedback before selecting or offering navigation', async child => {
    child.mock.method(console, 'error', () => {});
    const api = await reset();
    const { thread } = await nativeNote(api, true);
    sideBySide = false;
    const started = deferred();
    const release = deferred();
    onCommand = async command => {
      if (command === 'toggle.diff.renderSideBySide') { started.resolve(); await release.promise; }
    };
    let prompts = 0;
    onInformation = async () => { prompts++; return 'Open Revision'; };
    const pending = registeredCommand('dejareview.openComparison')(thread);
    await started.promise;
    store().text = store().savedText.replace('Original native body', 'Externally changed body');
    release.resolve();
    await pending;
    assert.equal(prompts, 0);
    assert.deepEqual(opened, []);
    assert.match(errors[0], /changed on disk/);
  });

  for (const wait of ['document open', 'edit application'] as const) {
    await t.test(`gitignore refuses a folder switch during ${wait}`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      sources.set('/synthetic/repo/.gitignore', 'out/\n');
      const started = deferred();
      const release = deferred();
      if (wait === 'document open') {
        onOpen = async () => { started.resolve(); await release.promise; };
      } else {
        onApplyEdit = async () => { started.resolve(); await release.promise; return true; };
      }
      const pending = registeredCommand('dejareview.suggestGitignore')();
      await started.promise;
      switchFolder();
      release.resolve();
      await pending;
      assert.equal(edits.length, wait === 'document open' ? 0 : 1);
      assert.equal(documentSaves, 0);
      assert.match(errors[0], /project folder changed/);
    });
  }

  for (const failure of ['edit', 'save'] as const) {
    await t.test(`gitignore reports failed ${failure} instead of claiming success`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      sources.set('/synthetic/repo/.gitignore', 'out/\n');
      if (failure === 'edit') { onApplyEdit = async () => false; }
      else { onSaveDocument = async () => false; }
      await registeredCommand('dejareview.suggestGitignore')();
      assert.equal(errors.length, 1);
      assert.match(errors[0], failure === 'edit' ? /Could not update .gitignore/ : /Could not save .gitignore/);
      assert.equal(documentSaves, failure === 'edit' ? 0 : 1);
    });
  }

  await t.test('gitignore approval remains bound to the folder that saved the note', async child => {
    child.mock.method(console, 'error', () => {});
    await reset();
    ignoreSuggested = false;
    await send(generalAction());
    const started = deferred();
    const release = deferred();
    onInformation = async () => { started.resolve(); await release.promise; return 'Add'; };
    receive.fire(editorAction('saveEdit', 'Saved general body'));
    await started.promise;
    switchFolder();
    release.resolve();
    await settle();
    assert.deepEqual(edits, []);
    assert.deepEqual(opened, []);
    assert.equal(documentSaves, 0);
    assert.match(errors[0], /project folder changed/);
  });

  await t.test('general creation without an active editor saves a body-only note and never suppresses files or creates threads', async () => {
    const api = await reset();
    assert.equal('activeTextEditor' in mock.window, false);
    assert.equal(store().text, undefined, 'Activation must not create notes');
    await send(generalAction());
    assert.equal(state().editor?.title, 'Add General Review Note');
    assert.equal(state().editor?.body, '');
    assert.equal(store().text, undefined, 'Opening the composer must not create notes');
    const body = '  ## Literal heading\nSelected: HEAD\n```markdown\n<script>literal input</script>\n  ';
    await send(editorAction('input', body));
    await registeredCommand('dejareview.refresh')();
    assert.equal(state().editor?.body, body);
    assert.deepEqual(paths(), ['src/a.ts']);
    await send(editorAction('saveEdit', body));
    assert.equal(state().editor, undefined);
    const parsed = parse(store().savedText);
    assert.deepEqual(parsed.comments, []);
    assert.equal(parsed.generalNotes.length, 1);
    assert.equal(parsed.generalNotes[0].body, body);
    assert.equal(parsed.base, 'a'.repeat(12));
    assert.equal(state().commentCount, 1);
    assert.equal(state().notes[0].general, true);
    assert.equal(api.getState().comments, 1);
    assert.equal(api.getState().threads, 0);
    assert.deepEqual(paths(), ['src/a.ts']);
    assert.deepEqual(validations, []);
    assert.deepEqual(navigation(), []);
    assert.deepEqual(opened, []);
    assert.deepEqual(adds, []);
    assert.deepEqual(cleans, []);
    assert.equal(publications, 1);
    assert.deepEqual(errors, []);
  });

  await t.test('mixed cards preserve document order, combined count and preview-only payloads; general cards open editing', async () => {
    const api = await reset();
    repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
    store().save(mixedText());
    await automaticRefresh();
    assert.equal(state().commentCount, 3);
    assert.equal(api.getState().comments, 3);
    assert.equal(api.getState().threads, 0);
    assert.deepEqual(state().notes.map(note => !!note.general), [true, false, true]);
    assert.deepEqual(state().notes.map(note => note.preview), ['General preview\nSecond line', 'File preview\nSecond line', 'Last general note']);
    assert.deepEqual(paths(), ['src/other.ts']);
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_|rawBlock|snapshot|anchorText/);
    await send(noteAction(0, 'open'));
    assert.equal(state().editor?.title, 'Edit Review Note');
    assert.equal(state().editor?.body, 'General preview\nSecond line\nPRIVATE_GENERAL_BODY');
    const { editor, ...projection } = state();
    assert.ok(editor);
    assert.doesNotMatch(JSON.stringify(projection), /PRIVATE_|rawBlock|snapshot|anchorText/);
    assert.doesNotMatch(JSON.stringify(state()), /PRIVATE_FILE_BODY|PRIVATE_MISSING_ANCHOR/);
    assert.deepEqual(navigation(), []);
    assert.deepEqual(opened, []);
    await send(editorAction('cancelEdit'));
    store().save(appendGeneralNote('', `${'x'.repeat(400)}\nsecond\nPRIVATE_TAIL`));
    await automaticRefresh();
    assert.equal(state().notes[0].preview.length, 320);
    assert.deepEqual(paths(), ['src/a.ts', 'src/other.ts'], 'General notes cannot acquire a file identity');
  });

  for (const target of [0, 1]) {
    await t.test(`editing ${target === 0 ? 'general' : 'stale comparison file'} changes only body bytes and preserves BOM/CRLF, siblings and metadata`, async () => {
      const api = await reset();
      const original = '\uFEFF' + mixedText().replace(/\n/g, '\r\n');
      store().save(original);
      await automaticRefresh();
      if (target === 1) {
        const card = state().notes[target];
        assert.ok(!card.general);
        assert.equal(card.stale, true);
      }
      const before = parsedNotes(parse(original));
      await send(noteAction(target));
      assert.equal(state().editor?.body, before[target].body);
      const body = '  ## New literal heading\nSelected: Modified (HEAD)\n```\nunfinished fence\n ';
      await send(editorAction('saveEdit', body));
      assert.equal(state().editor, undefined);
      const saved = store().savedText;
      const after = parsedNotes(parse(saved));
      assert.equal(after[target].body, body.replace(/\n/g, '\r\n'));
      assert.equal(saved.slice(0, after[target].bodyStartOffset), original.slice(0, before[target].bodyStartOffset));
      assert.equal(saved.slice(after[target].bodyEndOffset), original.slice(before[target].bodyEndOffset));
      for (const index of [0, 1, 2].filter(index => index !== target)) {
        assert.equal(after[index].rawBlock, before[index].rawBlock);
      }
      assert.equal(parse(saved).comments[0].anchorText, parse(original).comments[0].anchorText);
      assert.deepEqual(parse(saved).comments[0].comparison, parse(original).comments[0].comparison);
      assert.equal(api.getState().threads, 0);
      assert.deepEqual(opened, []);
      assert.deepEqual(navigation(), []);
      assert.deepEqual(errors, []);
    });
  }

  for (const mode of ['create', 'edit'] as const) {
    await t.test(`${mode} session input survives late refresh, hide/show and webview disposal/recreation without retargeting`, async () => {
      await reset();
      store().save(mixedText());
      await automaticRefresh();
      await send(mode === 'create' ? generalAction() : noteAction(1));
      const session = currentEditor();
      const started = deferred(), release = deferred();
      onRead = async () => { started.resolve(); await release.promise; };
      const refreshing = registeredCommand('dejareview.refresh')();
      await started.promise;
      await send(editorAction('input', 'Host-held input\nline two\nPRIVATE_TYPED_BODY'));
      store().text = appendGeneralNote(store().savedText, 'An independently saved sibling');
      release.resolve();
      await refreshing;
      onRead = async () => {};
      const expected = { ...session, body: 'Host-held input\nline two\nPRIVATE_TYPED_BODY' };
      assert.deepEqual(state().editor, expected);
      await send(generalAction());
      await incoming(noteAction(0));
      assert.deepEqual(state().editor, expected, 'An active editor cannot be replaced');
      view.visible = false; visibilityChanged.fire();
      await registeredCommand('dejareview.refresh')();
      view.visible = true; visibilityChanged.fire();
      assert.deepEqual(state().editor, expected);
      viewDisposed.fire();
      const count = messages.length;
      await registeredCommand('dejareview.refresh')();
      assert.equal(messages.length, count, 'Disposed webviews receive no updates');
      await mountView();
      assert.deepEqual(state().editor, expected);
      if (mode === 'edit') {
        await send(editorAction('saveEdit', expected.body));
        assert.equal(parse(store().savedText).comments[0].body, expected.body);
        assert.equal(parse(store().savedText).generalNotes.length, 3);
      } else {
        await send(editorAction('saveEdit', expected.body));
        assert.equal(state().editor?.id, session.id);
        assert.equal(state().editor?.body, expected.body);
        assert.match(state().editor?.error ?? '', /Saved Review Notes changed/);
        assert.equal(publications, 0);
      }
      assert.deepEqual(errors, []);
    });
  }

  for (const failure of ['throw', 'cancel', 'empty'] as const) {
    await t.test(`${failure} save retains session and body, exposes validation errors and permits retry or cancel`, async () => {
      await reset();
      await send(generalAction());
      const id = currentEditor().id;
      const body = failure === 'empty' ? ' \n\t' : 'Retain this exact unsaved body';
      if (failure === 'throw') { onPublish = async () => { throw new Error('Synthetic publication failed'); }; }
      if (failure === 'cancel') { mutationCancelled = true; }
      if (failure === 'empty') {
        await send(editorAction('saveEdit', body));
        assert.equal(mutations, 0, 'Client rejects whitespace-only saves');
        await incoming(editorAction('saveEdit', body));
      } else { await send(editorAction('saveEdit', body)); }
      assert.equal(state().editor?.id, id);
      assert.equal(state().editor?.body, body);
      assert.equal(state().busy, false);
      assert.equal(store().text, undefined);
      assert.equal(publications, 0);
      if (failure !== 'cancel') {
        assert.match(state().editor?.error ?? '', failure === 'throw' ? /Synthetic publication failed/ : /Enter a Review Note/);
      }
      await registeredCommand('dejareview.refresh')();
      viewDisposed.fire(); await mountView();
      assert.equal(state().editor?.body, body);
      if (failure !== 'cancel') { assert.ok(state().editor?.error); }
      const saveError = state().editor?.error;
      await send(editorAction('input', body));
      assert.equal(state().editor?.id, id);
      assert.equal(state().editor?.body, body);
      assert.equal(state().editor?.error, saveError, 'Unchanged-body transport resync preserves the save error');
      onPublish = async () => {}; mutationCancelled = false;
      await send(editorAction('input', 'Retry body'));
      assert.equal(state().editor?.error, undefined, 'Actual changed input clears the save error');
      await registeredCommand('dejareview.refresh')();
      assert.equal(state().editor?.error, undefined);
      await send(editorAction(failure === 'cancel' ? 'cancelEdit' : 'saveEdit', 'Retry body'));
      assert.equal(state().editor, undefined);
      assert.equal(publications, failure === 'cancel' ? 0 : 1);
      assert.deepEqual(errors, []);
    });
  }

  for (const lifecycle of ['hide/show', 'recreation'] as const) {
    await t.test(`input is restored on immediate webview ${lifecycle} without an intervening saved-projection refresh`, async () => {
      await reset();
      store().save(mixedText()); await automaticRefresh();
      await send(noteAction(1));
      const session = currentEditor();
      await send(editorAction('input', 'Latest keystrokes without a refresh'));
      if (lifecycle === 'hide/show') {
        view.visible = false; visibilityChanged.fire();
        view.visible = true; visibilityChanged.fire();
      } else { viewDisposed.fire(); await mountView(); }
      assert.equal(state().editor?.id, session.id);
      assert.equal(state().editor?.body, 'Latest keystrokes without a refresh');
      assert.equal(mutations, 0);
    });
  }

  await t.test('old-folder input messages are rejected while the original editor awaits cancellation', async () => {
    await reset();
    await send(generalAction());
    await send(editorAction('input', 'Original folder input'));
    await registeredCommand('dejareview.refresh')();
    const oldInput = editorAction('input', 'Late input after folder switch');
    switchFolder();
    await registeredCommand('dejareview.refresh')();
    await send(oldInput); await incoming(oldInput);
    await registeredCommand('dejareview.refresh')();
    assert.equal(state().editor?.body, 'Original folder input');
    assert.equal(mutations, 0);
  });

  await t.test('saving an unchanged general body closes the session without publishing a replacement', async () => {
    await reset();
    store().save(mixedText()); await automaticRefresh();
    const snapshot = store().text;
    await send(noteAction(0));
    await send(editorAction('saveEdit', currentEditor().body));
    assert.equal(state().editor, undefined);
    assert.equal(mutations, 1);
    assert.equal(publications, 0);
    assert.equal(store().text, snapshot);
    assert.deepEqual(errors, []);
  });

  for (const kind of ['general', 'file'] as const) {
    await t.test(`opening a ${kind} edit revalidates a changed saved block after its asynchronous read`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      store().save(mixedText()); await automaticRefresh();
      const started = deferred(), release = deferred();
      onRead = async () => { started.resolve(); await release.promise; };
      receive.fire(noteAction(kind === 'general' ? 0 : 1)); await started.promise;
      store().text = store().savedText.replace(kind === 'general' ? 'General preview' : 'File preview', 'Changed externally');
      const snapshot = store().text;
      release.resolve(); await settle();
      assert.equal(state().editor, undefined);
      assert.equal(state().busy, false);
      assert.equal(store().text, snapshot);
      assert.equal(mutations, 0);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /changed on disk.*Refresh/);
    });
  }

  for (const kind of ['general', 'file'] as const) {
    for (const mutation of ['changed block', 'new duplicate', 'old duplicate', 'unique moved', 'unchanged duplicate'] as const) {
      await t.test(`${kind} edit ${mutation} uses exact raw-block identity rather than a reassigned card index`, async () => {
        await reset();
        const single = kind === 'general' ? appendGeneralNote('', 'Target body') : appendComment('', staleNote('Target body'));
        const duplicate = kind === 'general' ? appendGeneralNote(single, 'Target body') : appendComment(single, staleNote('Target body'));
        const original = mutation === 'old duplicate' || mutation === 'unchanged duplicate' ? duplicate : single;
        store().save(original);
        await automaticRefresh();
        await send(noteAction(0));
        const id = currentEditor().id;
        if (mutation === 'changed block') { store().text = original.replace('Target body', 'External replacement'); }
        if (mutation === 'new duplicate') { store().text = duplicate; }
        if (mutation === 'old duplicate') { store().text = single; }
        if (mutation === 'unique moved') { store().text = appendGeneralNote('', 'Inserted sibling') + original; }
        const current = store().text;
        await registeredCommand('dejareview.refresh')();
        await send(editorAction('saveEdit', 'Edited target body'));
        const success = mutation === 'unique moved' || mutation === 'unchanged duplicate';
        assert.equal(publications, success ? 1 : 0);
        if (success) {
          assert.equal(state().editor, undefined);
          const bodies = parsedNotes(parse(store().savedText)).map(note => note.body);
          assert.deepEqual(bodies, mutation === 'unique moved'
            ? ['Inserted sibling', 'Edited target body'] : ['Edited target body', 'Target body']);
        } else {
          assert.equal(store().text, current);
          assert.equal(state().editor?.id, id);
          assert.equal(state().editor?.body, 'Edited target body');
          assert.match(state().editor?.error ?? '', /changed on disk.*Refresh/);
        }
        assert.deepEqual(errors, []);
      });
    }
  }

  await t.test('stale card handles and malformed or closed/replaced session messages cannot open or mutate another note', async () => {
    await reset();
    store().save(mixedText()); await automaticRefresh();
    const old = noteAction(0);
    store().save(appendGeneralNote('', 'Different saved target')); await automaticRefresh();
    await send(old); await incoming(old);
    assert.equal(state().editor, undefined);
    await send(noteAction(0));
    const closed = editorAction('saveEdit', 'Late body');
    await send(editorAction('cancelEdit'));
    await send(closed); await incoming(closed);
    await send(generalAction());
    const id = currentEditor().id;
    assert.notEqual(id, closed.editorId);
    for (const invalid of [closed, { type: 'cancelEdit' as const, repoKey: closed.repoKey, editorId: closed.editorId },
      { ...editorAction('input', 'Wrong folder'), repoKey: file('/synthetic/other').toString() },
      { ...editorAction('input', 'Wrong id'), editorId: 'missing' }]) {
      await send(invalid); await incoming(invalid);
    }
    for (const invalid of [
      { ...editorAction('input', 'Injected'), path: 'src/a.ts' },
      { ...editorAction('saveEdit', 'Injected'), noteId: state().notes[0].id },
      { ...editorAction('input'), body: 12 },
      { ...editorAction('cancelEdit'), body: 'Not permitted' },
      { ...editorAction('input'), editorId: 1 },
    ]) { await send(invalid); }
    await registeredCommand('dejareview.refresh')();
    assert.equal(state().editor?.id, id);
    assert.equal(state().editor?.body, '');
    assert.equal(mutations, 0);
    assert.equal(parse(store().savedText).generalNotes[0].body, 'Different saved target');
    assert.deepEqual(errors, []);
  });

  for (const wait of ['before save', 'mutation', 'publication'] as const) {
    await t.test(`folder changes ${wait} preserve the old session but never publish into either folder`, async () => {
      await reset();
      const originalStore = store();
      await send(generalAction());
      const session = currentEditor();
      const save = editorAction('saveEdit', 'Old-folder input');
      if (wait === 'before save') {
        switchFolder();
        await registeredCommand('dejareview.refresh')();
        await send(save);
      } else {
        const started = deferred(), release = deferred();
        const pause = async () => { started.resolve(); await release.promise; };
        if (wait === 'mutation') { onMutate = pause; } else { onPublish = pause; }
        receive.fire(save); await started.promise;
        switchFolder();
        release.resolve(); await settle();
      }
      assert.equal(state().editor?.id, session.id);
      assert.equal(state().editor?.body, save.body);
      assert.match(state().editor?.error ?? '', /project folder changed/i);
      assert.equal(originalStore.text, undefined);
      assert.equal(publications, 0);
      assert.equal(stores.size, 1);
      await send({ ...save, repoKey: workspace.workspaceFolders[0].uri.toString() });
      assert.equal(publications, 0);
      await send(editorAction('cancelEdit'));
      await registeredCommand('dejareview.refresh')();
      assert.notEqual(state().repoKey, session.repoKey);
      assert.equal(state().editor, undefined);
      await send(save); await incoming(save);
      assert.equal(store().text, undefined);
      assert.equal(originalStore.text, undefined);
      assert.equal(publications, 0);
      assert.deepEqual(errors, []);
    });
  }

  await t.test('folder change during editor opening rejects before creating a session', async child => {
    child.mock.method(console, 'error', () => {});
    await reset();
    const started = deferred(), release = deferred();
    onRead = async () => { started.resolve(); await release.promise; };
    receive.fire(generalAction()); await started.promise;
    switchFolder(); release.resolve(); await settle();
    assert.equal(state().editor, undefined);
    assert.equal(mutations, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /project folder changed/);
  });

  await t.test('general creation rejects an unsupported folder without fabricating an editor or store', async () => {
    await reset();
    const old = generalAction();
    workspace.workspaceFolders = [{ uri: file('/synthetic/not-a-repository') }];
    repositories = [];
    await registeredCommand('dejareview.refresh')();
    assert.equal(state().repoKey, undefined);
    await send(old); await incoming(old); await send({ type: 'addGeneral', repoKey: undefined });
    assert.equal(state().editor, undefined);
    assert.equal(mutations, 0);
    assert.equal(stores.size, 1, 'No replacement store may be fabricated');
    assert.deepEqual(errors, []);
  });

  for (const mode of ['create', 'edit'] as const) {
    await t.test(`${mode} repeated/concurrent save and late input/cancel are rejected while one publication is pending`, async () => {
      await reset();
      if (mode === 'edit') { store().save(mixedText()); await automaticRefresh(); }
      await send(mode === 'create' ? generalAction() : noteAction(1));
      const started = deferred(), release = deferred();
      onPublish = async () => { started.resolve(); await release.promise; };
      const save = editorAction('saveEdit', 'First submitted body');
      const cancel = editorAction('cancelEdit');
      receive.fire(save); await started.promise;
      assert.equal(state().busy, true);
      for (const request of [save, { ...save, body: 'Second submitted body' },
        { ...save, type: 'input' as const, body: 'Late input' }, cancel]) {
        receive.fire(request); await incoming(request);
      }
      assert.equal(mutations, 1);
      assert.equal(state().editor?.body, 'First submitted body');
      assert.equal(publications, 0);
      release.resolve(); await settle();
      assert.equal(publications, 1);
      assert.equal(state().busy, false);
      assert.equal(state().editor, undefined);
      await send(save); await incoming(save);
      assert.equal(mutations, 1);
      const parsed = parse(store().savedText);
      assert.equal(mode === 'create' ? parsed.generalNotes[0].body : parsed.comments[0].body, 'First submitted body');
      assert.deepEqual(errors, []);
    });
  }

  await t.test('history restore requires explicit openHistory, closeHistory revokes it and successful recovery hides history', async () => {
    await reset();
    const batch = seedArchive(); await registeredCommand('dejareview.refresh')();
    const restore: DashboardAction = { type: 'restore', repoKey: repoKey(), archiveId: batch.id };
    assert.equal(state().historyVisible, false);
    assert.deepEqual(state().archives, [{ id: batch.id, createdAt: batch.createdAt, commentCount: 7 }]);
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_ARCHIVE_BODY/);
    await send(restore); assert.equal(restores, 0);
    await send({ type: 'openHistory', repoKey: state().repoKey });
    assert.equal(state().historyVisible, true);
    await send({ type: 'closeHistory', repoKey: state().repoKey });
    assert.equal(state().historyVisible, false);
    await send(restore); assert.equal(restores, 0);
    await send({ type: 'openHistory', repoKey: state().repoKey });
    await send(restore);
    assert.equal(restores, 1);
    assert.equal(inputChecks, 2);
    assert.equal(store().text, batch.text);
    assert.equal(batches.get(batch.id), batch, 'Recovery never removes the archive');
    assert.equal(state().historyVisible, false);
    assert.equal(state().commentCount, 1);
    assert.deepEqual(errors, []);
  });

  for (const mode of ['create', 'edit'] as const) {
    await t.test(`hidden active ${mode} editor blocks command/UI copy and recovery without discard or persistence calls`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      const batch = seedArchive();
      if (mode === 'edit') { store().save(mixedText()); }
      await registeredCommand('dejareview.refresh')();
      await send(mode === 'create' ? generalAction() : noteAction(0));
      await send(editorAction('input', 'Do not discard this input'));
      await registeredCommand('dejareview.refresh')();
      const expected = state().editor;
      const snapshot = store().text;
      view.visible = false; visibilityChanged.fire(); viewDisposed.fire();
      await registeredCommand('dejareview.copyForAgent')();
      assert.ok(expected, 'Expected the captured editor before hiding the view');
      await registeredCommand('dejareview.restoreArchive')(batch.id, expected.repoKey);
      await registeredCommand('dejareview.restoreArchive')();
      assert.equal(errors.length, 3);
      errors.forEach(error => assert.match(error, /Save or cancel the open dashboard Review Note/));
      await mountView();
      await send({ type: 'openHistory', repoKey: state().repoKey });
      assert.equal(state().historyVisible, false);
      for (const request of [{ type: 'copy' as const, repoKey: repoKey() },
        { type: 'restore' as const, repoKey: repoKey(), archiveId: batch.id }]) {
        await send(request); await incoming(request);
      }
      assert.deepEqual(state().editor, expected);
      assert.equal(store().text, snapshot);
      assert.equal(handoffs, 0); assert.equal(restores, 0);
      assert.deepEqual(clipboard, []); assert.deepEqual(warnings, []);
      assert.equal(batches.size, 1);
    });
  }

  for (const operation of ['copy', 'restore'] as const) {
    await t.test(`${operation} is blocked while editor opening is awaiting a saved snapshot`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      const batch = seedArchive();
      const started = deferred(), release = deferred();
      onRead = async () => { started.resolve(); await release.promise; };
      receive.fire(generalAction()); await started.promise;
      assert.equal(state().editor, undefined);
      assert.equal(state().busy, true);
      await registeredCommand(operation === 'copy' ? 'dejareview.copyForAgent' : 'dejareview.restoreArchive')(batch.id);
      assert.equal(handoffs, 0); assert.equal(restores, 0);
      assert.deepEqual(clipboard, []);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /Save or cancel the open dashboard Review Note/);
      release.resolve(); await settle();
      assert.equal(state().editor?.title, 'Add General Review Note');
      assert.equal(state().busy, false);
      assert.equal(store().text, undefined);
    });
  }

  for (const operation of ['copy', 'restore'] as const) {
    await t.test(`${operation} rechecks active input after awaited workspace discovery`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      const batch = seedArchive();
      if (operation === 'copy') { store().save(mixedText()); }
      await registeredCommand('dejareview.refresh')();
      const snapshot = store().text;
      const started = deferred(), release = deferred();
      let calls = 0;
      onWorkspaceRepository = async () => { if (++calls === 1) { started.resolve(); await release.promise; } };
      const pending = registeredCommand(operation === 'copy' ? 'dejareview.copyForAgent' : 'dejareview.restoreArchive')(batch.id);
      await started.promise;
      await send(generalAction());
      await send(editorAction('input', 'Input opened during discovery'));
      release.resolve(); await pending;
      await registeredCommand('dejareview.refresh')();
      assert.equal(state().editor?.body, 'Input opened during discovery');
      assert.equal(handoffs, 0); assert.equal(restores, 0);
      assert.equal(store().text, snapshot);
      assert.deepEqual(clipboard, []);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /Save or cancel the open dashboard Review Note/);
    });
  }

  for (const wait of ['archive listing', 'archive picker'] as const) {
    await t.test(`command recovery rechecks active input after ${wait}`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset(); seedArchive();
      const started = deferred(), release = deferred();
      const pause = async () => { started.resolve(); await release.promise; };
      if (wait === 'archive listing') { onList = pause; } else { onPick = pause; }
      const pending = registeredCommand('dejareview.restoreArchive')();
      await started.promise;
      await send(generalAction());
      await send(editorAction('input', 'Input while choosing recovery'));
      release.resolve(); await pending;
      await registeredCommand('dejareview.refresh')();
      assert.equal(restores, 0);
      assert.equal(store().text, undefined);
      assert.equal(state().editor?.body, 'Input while choosing recovery');
      assert.equal(errors.length, 1);
      assert.match(errors[0], /Save or cancel the open dashboard Review Note/);
    });
  }

  for (const operation of ['copy', 'restore'] as const) {
    await t.test(`pending ${operation} prevents a dashboard editor from opening and passes guarded store callbacks`, async () => {
      await reset();
      const batch = seedArchive();
      if (operation === 'copy') { store().save(mixedText()); }
      await registeredCommand('dejareview.refresh')();
      const started = deferred(), release = deferred();
      const pause = async () => { started.resolve(); await release.promise; };
      if (operation === 'copy') { onHandoff = pause; } else { onRestore = pause; }
      const pending = registeredCommand(operation === 'copy' ? 'dejareview.copyForAgent' : 'dejareview.restoreArchive')(batch.id);
      await started.promise;
      assert.equal(state().busy, true);
      await send(generalAction()); await incoming(generalAction());
      assert.equal(state().editor, undefined);
      release.resolve(); await pending;
      assert.equal(state().busy, false);
      assert.equal(state().historyVisible, false);
      assert.equal(inputChecks, operation === 'copy' ? 3 : 2);
      if (operation === 'copy') {
        assert.equal(handoffs, 1);
        assert.deepEqual(clipboard, [mixedText()]);
        assert.equal(batches.get('copied')?.commentCount, 3);
        assert.equal(store().text, undefined);
        assert.equal(state().commentCount, 0);
        assert.deepEqual(paths(), ['src/a.ts']);
      } else {
        assert.equal(restores, 1);
        assert.equal(store().text, batch.text);
      }
      assert.deepEqual(errors, []);
    });
  }

  function visibleEditor(uri: vscode.Uri): typeof mock.window.visibleTextEditors[number] {
    return {
      document: { uri, isClosed: false, isDirty: false, getText: () => '' },
      setDecorations() {},
    };
  }
  const visiblePaths = (): string[] => state().files.filter(row => row.visible).map(row => row.path);

  await t.test('editor-only refreshes reuse blocked statistics and retain completed counts without restarting work', async () => {
    const api = await reset();
    const started = deferred();
    const release = deferred();
    let jobs = 0;
    let currentAtCompletion: boolean | undefined;
    onStatistics = async (_repo, _candidates, isCurrent) => {
      jobs++;
      started.resolve();
      await release.promise;
      currentAtCompletion = isCurrent();
      return new Map([['src/a.ts', { insertions: 7, deletions: 3 }]]);
    };
    try {
      await api.refresh();
      await started.promise;
      const first = visibleEditor(file('/synthetic/repo/src/a.ts'));
      const other = visibleEditor(file('/synthetic/repo/src/other.ts'));
      const pending = [{ id: 'src/a.ts', path: 'src/a.ts', visible: false,
        statisticsPending: false, insertions: 2, deletions: 1 }];
      const completed = [{
        id: 'src/a.ts', path: 'src/a.ts', visible: false,
        statisticsPending: false, insertions: 7, deletions: 3,
      }];
      assert.deepEqual(state().files, pending);

      for (const phase of ['pending', 'completed'] as const) {
        const expected = phase === 'pending' ? pending : completed;
        for (const editor of [first, other, first]) {
          mock.window.visibleTextEditors = [editor];
          const beforeVisibility = messages.length;
          visibleEditorsChanged.fire();
          await waitForState(() => messages.length > beforeVisibility);
          assert.ok(messages.slice(beforeVisibility).every(message =>
            message.files[0].statisticsPending === false));
          assert.deepEqual(state().files, expected.map(row => ({ ...row, visible: editor === first })));

          const beforeDocument = messages.length;
          documentsChanged.fire({ document: editor.document });
          t.mock.timers.tick(1000);
          await waitForState(() => messages.length > beforeDocument);
          assert.ok(messages.slice(beforeDocument).every(message =>
            message.files[0].statisticsPending === false));
          assert.deepEqual(state().files, expected.map(row => ({ ...row, visible: editor === first })));
          assert.equal(jobs, 1, 'Editor refreshes must reuse the original statistics job');
        }
        if (phase === 'pending') {
          assert.equal(activeStatistics, 1);
          release.resolve();
          await statisticsPublished();
          assert.equal(currentAtCompletion, true, 'Editor-only generations must not invalidate the statistics snapshot');
          assert.deepEqual(state().files, completed.map(row => ({ ...row, visible: true })));
        }
      }
      await statisticsFinished();
      assert.equal(jobs, 1, 'No replacement statistics job may run after the original completes');
      assert.equal(maxActiveStatistics, 1);
      assert.deepEqual(errors, []);
    } finally {
      release.resolve();
      await statisticsFinished();
    }
  });

  await t.test('discovery failure clears pending stats while independent visibility updates retain rows', async () => {
    const api = await reset();
    repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
    mock.window.visibleTextEditors = [visibleEditor(file('/synthetic/repo/src/a.ts'))];
    const started = deferred();
    const release = deferred();
    let jobs = 0;
    let currentAtCompletion: boolean | undefined;
    onStatistics = async (_repo, _candidates, isCurrent) => {
      jobs++;
      started.resolve();
      await release.promise;
      currentAtCompletion = isCurrent();
      return new Map([['src/a.ts', { insertions: 999, deletions: 999 }]]);
    };
    try {
      await api.refresh();
      await started.promise;
      assert.deepEqual(visiblePaths(), ['src/a.ts']);
      assert.deepEqual(state().files.map(row => row.statisticsPending), [false, true]);
      const client = scriptFixture();
      client.update(state());
      const rows = [...client.element('files').children];
      onCandidates = async () => {
        throw new Error('Synthetic editor-refresh candidate failure');
      };
      await api.refresh();

      for (const visible of [true, false]) {
        mock.window.visibleTextEditors = visible ? [visibleEditor(file('/synthetic/repo/src/other.ts'))] : [];
        const before = messages.length;
        visibleEditorsChanged.fire();
        await waitForState(() => messages.length > before);

        assert.deepEqual(state().files, [
          { id: 'src/a.ts', path: 'src/a.ts', visible: false, statisticsPending: false, insertions: 2, deletions: 1 },
          { id: 'src/other.ts', path: 'src/other.ts', visible, statisticsPending: false },
        ]);
        assert.match(state().filesError ?? '', /could not be refreshed/);
        assert.equal(state().busy, false);
        assert.equal(jobs, 1);
        client.update(state());
        assert.equal(client.element('files-title').textContent, 'Files to Review (2)');
        assert.equal(client.element('files-error').hidden, false);
        assert.deepEqual(client.element('files').children, rows);
        assert.ok(rows.every(row => row.animations.length === 0 && !row.inert));
      }

      const beforeCompletion = messages.length;
      release.resolve();
      await statisticsFinished();
      assert.equal(currentAtCompletion, false, 'Candidate failure must revoke the old statistics snapshot');
      assert.equal(messages.length, beforeCompletion, 'Late statistics must not publish or clear the candidate error');
      assert.match(state().filesError ?? '', /could not be refreshed/);
      assert.deepEqual(state().files.map(row => [row.statisticsPending, row.insertions]), [[false, 2], [false, undefined]]);

      onCandidates = async () => {};
      onStatistics = async () => {
        jobs++;
        return undefined;
      };
      const beforeRetry = messages.length;
      await api.refresh();
      await waitForState(() => messages.length > beforeRetry);
      await statisticsPublished();
      assert.equal(jobs, 2, 'An explicit retry must create a new snapshot after discovery failure');
      assert.equal(state().filesError, undefined);
      assert.deepEqual(paths(), ['src/a.ts', 'src/other.ts']);
      assert.ok(state().files.every(row => row.insertions === 2 && row.deletions === 1));
      assert.deepEqual(errors, []);
    } finally {
      release.resolve();
      await statisticsFinished();
    }
  });

  await t.test('visibility follows visible split panes, moves and closes, not hidden documents or focus alone', async () => {
    await reset();
    repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
    const first = visibleEditor(file('/synthetic/repo/src/a.ts'));
    const second = visibleEditor(file('/synthetic/repo/src/other.ts'));
    await registeredCommand('dejareview.refresh')();
    workspace.textDocuments = [first.document, second.document];
    for (const [editors, expected] of [
      [[first], ['src/a.ts']],
      [[second], ['src/other.ts']],
      [[first, second, first], ['src/a.ts', 'src/other.ts']],
      [[], []],
    ] as const) {
      mock.window.visibleTextEditors = [...editors];
      visibleEditorsChanged.fire();
      await settle();
      assert.deepEqual(visiblePaths(), expected, 'Visible changes publish without advancing the debounce');
    }
    const before = diffCalls;
    activeEditorChanged.fire(undefined);
    await automaticRefresh();
    assert.equal(diffCalls, before, 'Focus-only changes do not recompute candidates');
    assert.deepEqual(visiblePaths(), []);
  });

  await t.test('visible Git revisions match validated source paths, including different-file diff panes', async () => {
    await reset();
    repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
    await registeredCommand('dejareview.refresh')();
    for (const ref of ['', 'HEAD', '~', 'b'.repeat(40)]) {
      mock.window.visibleTextEditors = [visibleEditor(Uri.from({
        scheme: 'git', path: '/synthetic/repo/src/a.ts',
        query: JSON.stringify({ path: '/synthetic/repo/src/a.ts', ref }),
      })), visibleEditor(file('/synthetic/repo/src/other.ts'))];
      visibleEditorsChanged.fire();
      await settle();
      assert.deepEqual(visiblePaths(), ['src/a.ts', 'src/other.ts']);
    }
    mock.window.visibleTextEditors = [mock.window.visibleTextEditors[0]];
    visibleEditorsChanged.fire();
    await settle();
    assert.deepEqual(visiblePaths(), ['src/a.ts'], 'The Original revision alone marks the file visible');
  });

  await t.test('outside-folder, malformed, unsupported and nested-repository editors never mark a candidate visible', async () => {
    await reset();
    const invalid = [
      file('/synthetic/other/src/a.ts'),
      Uri.from({ scheme: 'git', path: '/synthetic/repo/src/a.ts', query: '{malformed' }),
      Uri.from({ scheme: 'git', path: '/synthetic/repo/src/a.ts',
        query: JSON.stringify({ path: '/synthetic/other/src/a.ts', ref: 'HEAD' }) }),
      Uri.from({ scheme: 'git', path: '/synthetic/repo/src/a.ts',
        query: JSON.stringify({ path: '/synthetic/repo/src/a.ts', ref: ':1' }) }),
      Uri.from({ scheme: 'untitled', path: '/synthetic/repo/src/a.ts' }),
    ];
    mock.window.visibleTextEditors = invalid.map(visibleEditor);
    visibleEditorsChanged.fire();
    await settle();
    assert.deepEqual(paths(), ['src/a.ts']);
    assert.deepEqual(visiblePaths(), []);

    workspace.workspaceFolders = [{ uri: file('/synthetic/repo/src') }];
    mock.window.visibleTextEditors = [visibleEditor(file('/synthetic/repo/src/a.ts')),
      visibleEditor(file('/synthetic/repo/outside.ts'))];
    foldersChanged.fire();
    await registeredCommand('dejareview.refresh')();
    assert.deepEqual(visiblePaths(), ['a.ts']);
    repositories.push({ ...repository, rootUri: file('/synthetic/repo/src') });
    workspace.workspaceFolders = [{ uri: file('/synthetic/repo') }];
    foldersChanged.fire();
    await registeredCommand('dejareview.refresh')();
    assert.deepEqual(visiblePaths(), []);
    assert.deepEqual(errors, []);
  });

  for (const mutation of ['move', 'close', 'folder'] as const) {
    await t.test(`visibility validation cannot publish stale eyes after ${mutation}`, async child => {
      await reset();
      repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
      await registeredCommand('dejareview.refresh')();
      const started = deferred();
      const release = deferred();
      const resource = GitResources.prototype.resource;
      child.mock.method(GitResources.prototype, 'resource', async function (
        this: InstanceType<typeof GitResources>, uri: vscode.Uri, repo: Repository,
      ) {
        const resolved = await resource.call(this, uri, repo);
        if (uri.scheme === 'git') {
          started.resolve();
          await release.promise;
        }
        return resolved;
      });
      mock.window.visibleTextEditors = [visibleEditor(Uri.from({
        scheme: 'git', path: '/synthetic/repo/src/a.ts',
        query: JSON.stringify({ path: '/synthetic/repo/src/a.ts', ref: 'HEAD' }),
      }))];
      visibleEditorsChanged.fire();
      await started.promise;
      const before = messages.length;
      mock.window.visibleTextEditors = mutation === 'move'
        ? [visibleEditor(file('/synthetic/repo/src/other.ts'))] : [];
      if (mutation === 'folder') {
        switchFolder();
        t.mock.timers.tick(1000);
      } else {
        repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
        visibleEditorsChanged.fire();
      }
      release.resolve();
      await settle();
      assert.ok(messages.slice(before).every(message => !message.files.some(row => row.path === 'src/a.ts' && row.visible)));
      assert.deepEqual(visiblePaths(), mutation === 'move' ? ['src/other.ts'] : []);
      if (mutation === 'folder') {
        assert.equal(state().repoKey, file('/synthetic/other').toString());
      }
      assert.deepEqual(errors, []);
    });
  }

  for (const operation of ['stage', 'revert'] as const) {
    for (const outcome of ['success', 'failure', 'cancel'] as const) {
      if (operation === 'stage' && outcome === 'cancel') {
        continue;
      }
      await t.test(`${operation} ${outcome} holds captured row progress through immediate refresh settlement`, async child => {
        child.mock.method(console, 'error', () => {});
        await reset();
        repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
        await registeredCommand('dejareview.refresh')();
        await statisticsPublished();
        const started = deferred();
        const release = deferred();
        const refreshing = deferred();
        const finishRefresh = deferred();
        const checkPending = (): void => {
          assert.deepEqual(state().files.map(row => row.pending), [operation, undefined]);
          assert.equal(state().busy, true);
        };
        onWarning = async () => {
          checkPending();
          if (outcome === 'cancel') {
            started.resolve();
            await release.promise;
            return undefined;
          }
          return 'Revert File';
        };
        const mutate = async (): Promise<void> => {
          checkPending();
          started.resolve();
          await release.promise;
          if (outcome === 'failure') {
            throw new Error('Synthetic operation failure');
          }
          repository.state.workingTreeChanges = [change('/synthetic/repo/src/other.ts')];
          gitChanged.fire();
        };
        onAdd = mutate;
        onClean = mutate;
        let settled = false;
        const pending = incoming(operation === 'stage' ? stageAction() : revertAction()).then(() => { settled = true; });
        checkPending();
        await started.promise;
        onCandidates = async () => {
          refreshing.resolve();
          await finishRefresh.promise;
        };
        release.resolve();
        await refreshing.promise;
        checkPending();
        assert.equal(settled, false);
        assert.deepEqual(paths(), ['src/a.ts', 'src/other.ts'], 'Even updated Git state requires a completed projection');
        await incoming(stageAction());
        await incoming(revertAction());
        finishRefresh.resolve();
        await pending;
        assert.equal(state().busy, false);
        assert.ok(state().files.every(row => row.pending === undefined));
        assert.deepEqual(paths(), outcome === 'success' ? ['src/other.ts'] : ['src/a.ts', 'src/other.ts']);
        assert.equal(errors.length, outcome === 'failure' ? 1 : 0);
        await statisticsPublished();
        const before = diffCalls;
        t.mock.timers.tick(1000);
        await settle();
        assert.equal(diffCalls, before, 'No leftover post-operation debounce refresh');
      });
    }
  }

  for (const operationFails of [false, true]) {
    await t.test(`refresh rejection releases pending and ${operationFails ? 'preserves the original operation error' : 'reports the refresh error'}`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      onAdd = async () => {
        onWorkspaceRepository = async () => { throw new Error('Synthetic refresh failure'); };
        if (operationFails) {
          throw new Error('Synthetic original add failure');
        }
      };
      await incoming(stageAction());
      assert.equal(state().busy, false);
      assert.equal(state().files[0].pending, undefined);
      assert.deepEqual(paths(), ['src/a.ts']);
      assert.equal(errors.length, 1);
      assert.match(errors[0], operationFails ? /Synthetic original add failure/ : /Synthetic refresh failure/);
      onWorkspaceRepository = async () => {};
      onAdd = async () => {};
      await incoming(stageAction());
      assert.equal(adds.length, 2, 'The refresh drain and file lock both permit retry');
      assert.equal(state().busy, false);
    });
  }

  await t.test('captured pending identity survives row reprojection and never follows the same path into another folder', async () => {
    const api = await reset();
    const started = deferred();
    const release = deferred();
    onAdd = async () => {
      started.resolve();
      await release.promise;
    };
    const pending = incoming(stageAction());
    await started.promise;
    mock.window.visibleTextEditors = [visibleEditor(file('/synthetic/repo/src/a.ts'))];
    visibleEditorsChanged.fire();
    await api.refresh();
    assert.equal(state().files[0].pending, 'stage');
    assert.equal(state().files[0].visible, true);
    switchFolder();
    release.resolve();
    await pending;
    assert.equal(state().repoKey, file('/synthetic/other').toString());
    assert.deepEqual(paths(), ['src/a.ts']);
    assert.equal(state().files[0].pending, undefined);
    assert.equal(state().files[0].visible, false);
    assert.equal(state().busy, false);
    assert.deepEqual(errors, []);
  });

  await t.test('candidate refresh failure retains rows and returns row progress to normal', async child => {
    await reset();
    onAdd = async () => {
      child.mock.method(GitResources.prototype, 'filesToReview', async () => {
        throw new Error('Synthetic candidate refresh failure');
      });
    };
    await incoming(stageAction());
    assert.deepEqual(paths(), ['src/a.ts']);
    assert.equal(state().files[0].pending, undefined);
    assert.equal(state().busy, false);
    assert.match(state().filesError ?? '', /could not be refreshed/);
  });

  for (const phase of ['workspace discovery', 'resource ownership', 'post-stat ownership', 'final batch ownership'] as const) {
    await t.test(`${phase} stat rejection retains actual dashboard rows and count without removal animation`, async () => {
      const api = await reset();
      workspace.workspaceFolders = [{ uri: file('/synthetic/repo/src') }];
      repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
      await api.refresh();
      await statisticsPublished();
      const previous = state().files;
      const client = scriptFixture();
      client.update(state());
      const rows = [...client.element('files').children];
      assert.equal(client.element('files-title').textContent, 'Files to Review (2)');
      let armed = phase === 'resource ownership';
      let failures = 0;
      let armedStats = 0;
      const backgroundFailure = phase === 'post-stat ownership' || phase === 'final batch ownership';
      onRead = async () => {
        // Arm after the extension's outer discovery, before filesToReview's own discovery.
        if (phase === 'workspace discovery') {
          armed = true;
        }
      };
      onDiff = async () => {
        if (backgroundFailure) {
          armed = true;
        }
      };
      onStat = async uri => {
        const target = phase === 'workspace discovery' ? '/synthetic/repo/src' : '/synthetic/repo/src/a.ts';
        if (armed && failures === 0 && uri.path === target) {
          armedStats++;
          // A validation stats the leaf during the ownership walk and once more
          // afterward. The third call is the final statistics batch validation.
          if (phase === 'final batch ownership' && armedStats < 3) {
            return;
          }
          failures++;
          throw Object.assign(new Error('Synthetic boundary access failure'), { code: 'Unavailable' });
        }
      };

      await api.refresh();
      if (backgroundFailure) {
        await statisticsPublished();
      }

      assert.equal(failures, 1, 'The real Git ownership walk must encounter the lower-level rejection');
      if (backgroundFailure) {
        assert.deepEqual(state().files, previous.map(({ id, path, visible }) => ({
          id, path, visible, statisticsPending: false,
        })));
        assert.match(state().filesError ?? '', /statistics could not be loaded/);
      } else {
        assert.deepEqual(state().files, previous);
        assert.match(state().filesError ?? '', /could not be refreshed/);
      }
      client.update(state());
      assert.equal(client.element('files-title').textContent, 'Files to Review (2)');
      assert.equal(client.element('files-error').hidden, false);
      assert.deepEqual(client.element('files').children, rows);
      assert.ok(rows.every(row => row.animations.length === 0 && !row.inert));

      onRead = async () => {};
      onDiff = async () => {};
      onStat = async () => {};
      repository.state.workingTreeChanges = [change('/synthetic/repo/src/other.ts')];
      await api.refresh();
      assert.deepEqual(paths(), ['other.ts'], 'A successful refresh still publishes confirmed removal');
      assert.equal(state().filesError, undefined);
      client.update(state());
      assert.equal(client.element('files-title').textContent, 'Files to Review (1)');
      assert.deepEqual(errors, []);
    });
  }

  await t.test('retained rows still require independent live ownership authorization for every action', async child => {
    child.mock.method(console, 'error', () => {});
    const api = await reset();
    onStat = async uri => {
      if (uri.path === '/synthetic/repo/src/a.ts') {
        throw Object.assign(new Error('Synthetic boundary access failure'), { code: 'NoPermissions' });
      }
    };
    await api.refresh();
    assert.deepEqual(paths(), ['src/a.ts']);
    assert.match(state().filesError ?? '', /could not be refreshed/);

    await incoming(action());
    await incoming(stageAction());
    await incoming(revertAction());

    assert.equal(errors.length, 3);
    assert.ok(errors.every(error => /Cannot validate Git repository boundaries/.test(error)));
    assert.deepEqual(navigation(), []);
    assert.deepEqual(adds, []);
    assert.deepEqual(cleans, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(paths(), ['src/a.ts']);
    assert.equal(state().files[0].pending, undefined);
    assert.equal(state().busy, false);
  });

  for (const kind of ['tracked', 'binary', 'deleted', 'untracked'] as const) {
    await t.test(`whole-file ${kind} creation retains input across refresh and saves only file-wide feedback`, async () => {
      await reset(kind === 'deleted' ? GitStatus.Deleted : GitStatus.Modified,
        kind === 'untracked' ? 'untrackedChanges' : 'workingTreeChanges');
      if (kind === 'binary') {
        sources.set('/synthetic/repo/src/a.ts', '\0binary');
      }
      await incoming({ ...action(), type: 'addFileNote' });
      const editor = currentEditor();
      assert.equal(editor.title, 'Add File Review Note: src/a.ts');
      const body = '## File-wide feedback\n```\nunbalanced';
      await incoming({ type: 'input', repoKey: repoKey(), editorId: editor.id, body });
      await registeredCommand('dejareview.refresh')();
      await mountView();
      assert.equal(currentEditor().id, editor.id);
      assert.equal(currentEditor().body, body);
      assert.deepEqual(paths(), ['src/a.ts'], 'Drafts do not suppress candidates');
      await incoming({ type: 'saveEdit', repoKey: repoKey(), editorId: editor.id, body });
      assert.equal(state().editor, undefined);
      const note = parse(store().savedText).comments[0];
      assert.equal(note.wholeFile, true);
      assert.equal(note.path, 'src/a.ts');
      assert.equal(note.body, body);
      assert.equal(note.anchorText, undefined);
      assert.deepEqual(paths(), []);
      assert.equal(state().commentCount, 1);
      assert.deepEqual(adds, []);
      assert.deepEqual(cleans, []);
      assert.deepEqual(opened, []);
      assert.deepEqual(navigation(), []);
    });
  }

  for (const when of ['before save', 'publication'] as const) {
    await t.test(`whole-file creation retains input when membership changes ${when}`, async () => {
      await reset();
      await incoming({ ...action(), type: 'addFileNote' });
      const editor = currentEditor();
      const remove = (): void => { repository.state.workingTreeChanges = []; };
      if (when === 'publication') {
        onFinalGuard = async () => remove();
      } else {
        remove();
      }
      await incoming({ type: 'saveEdit', repoKey: repoKey(), editorId: editor.id, body: 'Keep my input' });
      assert.equal(store().text, undefined);
      assert.equal(currentEditor().body, 'Keep my input');
      assert.match(currentEditor().error ?? '', /Files to Review changed/);
      await incoming({ type: 'cancelEdit', repoKey: repoKey(), editorId: editor.id });
      assert.equal(state().editor, undefined);
    });
  }

  await t.test('whole-file cards open deleted files from the index and never rewrite their scope', async () => {
    await reset(GitStatus.Deleted);
    await incoming({ ...action(), type: 'addFileNote' });
    await incoming({ type: 'saveEdit', repoKey: repoKey(), editorId: currentEditor().id, body: 'Restore this file' });
    const snapshot = store().savedText;
    const note = state().notes[0];
    assert.ok(!note.general && note.wholeFile);
    assert.equal(note.stale, false);
    const client = scriptFixture();
    client.update(state());
    assert.equal(client.element('notes').children[0].children[0].children[0].textContent, 'a.ts');
    await incoming({ type: 'open', repoKey: repoKey(), noteId: note.id });
    assert.equal(navigation()[0].command, 'vscode.open');
    const target = navigation()[0].args[0];
    assert.ok(target instanceof Uri);
    assert.equal(target.scheme, 'git');
    await registeredCommand('dejareview.reanchorAll')();
    assert.equal(store().savedText, snapshot);
  });

  for (const cancellation of ['saved note filtering', 'history action'] as const) {
    await t.test(`${cancellation} cannot cause a delayed staging advance`, async () => {
      await reset();
      repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
      await registeredCommand('dejareview.refresh')();
      await incoming(stageAction());
      if (cancellation === 'saved note filtering') {
        store().text = appendComment('', {
          path: 'src/a.ts', wholeFile: true, startLine: 1, endLine: 1, origin: 'changed', side: 'document', body: 'Still needs changes',
        });
        store().changed.fire();
      } else {
        receive.fire({ type: 'openHistory', repoKey: repoKey() });
        repository.state.workingTreeChanges = [change('/synthetic/repo/src/other.ts')];
        gitChanged.fire();
      }
      await automaticRefresh();
      assert.deepEqual(paths(), ['src/other.ts']);
      assert.deepEqual(navigation(), []);
    });
  }

  for (const timing of ['immediate', 'later Git event'] as const) {
    await t.test(`staging the first row opens the next only after ${timing} confirms removal`, async () => {
      await reset();
      repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
      await registeredCommand('dejareview.refresh')();
      const remove = (): void => {
        repository.state.workingTreeChanges = [change('/synthetic/repo/src/other.ts')];
      };
      if (timing === 'immediate') {
        onAdd = async () => remove();
      }
      await incoming(stageAction());
      if (timing === 'later Git event') {
        assert.deepEqual(navigation(), []);
        remove();
        gitChanged.fire();
        await automaticRefresh();
      }
      assert.deepEqual(paths(), ['src/other.ts']);
      assert.equal(navigation().length, 1);
      assert.equal(navigation()[0].command, 'vscode.diff');
      assert.equal(navigation()[0].args[2], 'src/other.ts (Unstaged changes)');
      await registeredCommand('dejareview.refresh')();
      assert.equal(navigation().length, 1, 'Advance is consumed exactly once');
    });
  }

  await t.test('400-file staging unlocks the next visible row without another scan when its diff opens', async () => {
    const api = await reset();
    const changes = Array.from({ length: 400 }, (_, index) => {
      const target = `/synthetic/repo/src/file-${String(index).padStart(3, '0')}.ts`;
      sources.set(target, 'disk content\n');
      return change(target);
    });
    repository.state.workingTreeChanges = changes;
    await api.refresh();
    await statisticsPublished();
    const release = deferred();
    let scans = 0;
    let reads = 0;
    let diffOpened = false;
    onCandidates = async () => {
      scans++;
      if (diffOpened) {
        await release.promise;
      }
    };
    onRead = async () => { reads++; };
    onAdd = async () => {
      repository.state.workingTreeChanges = repository.state.workingTreeChanges?.slice(1);
      gitChanged.fire();
    };
    onCommand = async (command, args) => {
      if (command !== 'vscode.diff') {
        return;
      }
      diffOpened = true;
      const original = args[0];
      const modified = args[1];
      assert.ok(original instanceof Uri && modified instanceof Uri);
      mock.window.visibleTextEditors = [visibleEditor(original), visibleEditor(modified)];
      workspace.textDocuments = mock.window.visibleTextEditors.map(editor => editor.document);
      documentOpened.fire();
      visibleEditorsChanged.fire();
    };
    try {
      receive.fire({ ...action('src/file-000.ts'), type: 'stageFile' });
      await settle();
      assert.equal(diffOpened, true);
      assert.equal(state().busy, false, 'The webview action lock must finish after navigation, without another full scan');
      assert.deepEqual(visiblePaths(), ['src/file-001.ts']);
      assert.equal(scans, 1, 'Only the Git-confirming post-stage scan is required');
      assert.equal(reads, 1, 'Opening the next diff must not reload saved notes');
      const client = scriptFixture();
      client.update(state());
      const row = client.element('files').children[0];
      const stage = row.children.find(child => child.title === 'Stage File');
      assert.ok(stage);
      assert.equal(stage.disabled, false);

      receive.fire({ ...action('src/file-001.ts'), type: 'stageFile' });
      await settle();
      assert.deepEqual(adds, [['/synthetic/repo/src/file-000.ts'], ['/synthetic/repo/src/file-001.ts']],
        'The next activation must reach live host validation and Git immediately');
    } finally {
      release.resolve();
      await settle();
      await statisticsFinished();
    }
    assert.deepEqual(errors, []);
  });

  await t.test('visibility updates bypass blocked full discovery and editor refreshes reuse candidate membership', async () => {
    const api = await reset();
    let scans = 0;
    const started = deferred();
    const release = deferred();
    onCandidates = async () => {
      scans++;
      started.resolve();
      await release.promise;
    };
    const refresh = api.refresh();
    try {
      await started.promise;
      mock.window.visibleTextEditors = [visibleEditor(file('/synthetic/repo/src/a.ts'))];
      visibleEditorsChanged.fire();
      await settle();
      assert.deepEqual(visiblePaths(), ['src/a.ts'], 'Highlights must not queue behind whole-list discovery');
      assert.equal(scans, 1);
    } finally {
      release.resolve();
      await refresh;
    }
    documentsChanged.fire({ document: mock.window.visibleTextEditors[0].document });
    await automaticRefresh();
    assert.equal(scans, 1, 'Source-buffer changes do not invalidate Git candidate membership');
    gitChanged.fire();
    await automaticRefresh();
    assert.equal(scans, 2, 'Git changes must still revalidate candidates');
    store().changed.fire();
    await automaticRefresh();
    assert.equal(scans, 3, 'Saved-note changes must still revalidate candidates');
  });

  for (const operation of ['lower row', 'revert', 'failure', 'manual navigation'] as const) {
    await t.test(`${operation} does not trigger automatic staging navigation`, async () => {
      await reset();
      repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
      await registeredCommand('dejareview.refresh')();
      if (operation === 'failure') {
        onAdd = async () => { throw new Error('Synthetic staging failure'); };
        await incoming(stageAction());
      } else if (operation === 'revert') {
        await incoming(revertAction());
      } else if (operation === 'lower row') {
        await incoming({ ...action('src/other.ts'), type: 'stageFile' });
      } else {
        await incoming(stageAction());
        await incoming(action('src/other.ts'));
      }
      executed.length = 0;
      errors.length = 0;
      repository.state.workingTreeChanges = operation === 'lower row'
        ? [change('/synthetic/repo/src/a.ts')] : [change('/synthetic/repo/src/other.ts')];
      gitChanged.fire();
      await automaticRefresh();
      assert.deepEqual(navigation(), []);
    });
  }

  for (const kind of ['tracked', 'binary', 'unknown stats', 'new', 'new binary', 'partial', 'deleted'] as const) {
    await t.test(`stageFile sends one absolute ${kind} path and waits for refreshed Git state`, async () => {
      await reset(kind === 'deleted' ? GitStatus.Deleted : GitStatus.Modified,
        kind.startsWith('new') ? 'untrackedChanges' : 'workingTreeChanges');
      if (kind === 'binary') { diffText = 'Binary files a/src/a.ts and b/src/a.ts differ\n'; }
      if (kind === 'new binary') { sources.set('/synthetic/repo/src/a.ts', '\0binary'); }
      if (kind === 'unknown stats') { onDiff = async () => { throw new Error('Synthetic stats unavailable'); }; }
      if (kind === 'partial') { repository.state.indexChanges = [change('/synthetic/repo/src/a.ts')]; }
      if (kind === 'deleted') { missing.add('/synthetic/repo/src/a.ts'); }
      await registeredCommand('dejareview.refresh')();
      assert.deepEqual(paths(), ['src/a.ts']);
      await statisticsPublished();
      if (kind.includes('binary') || kind === 'unknown stats') {
        assert.equal(state().files[0].insertions, undefined);
        assert.equal(state().files[0].deletions, undefined);
      }
      const started = deferred(), release = deferred();
      onAdd = async () => { started.resolve(); await release.promise; };
      const request = stageAction();
      receive.fire(request);
      await started.promise;
      assert.equal(state().busy, true);
      assert.deepEqual(paths(), ['src/a.ts'], 'No optimistic removal while add is pending');
      receive.fire(request);
      await incoming(request);
      assert.deepEqual(adds, [['/synthetic/repo/src/a.ts']], 'Both webview and host reject repeated activation');
      release.resolve();
      await settle();
      assert.equal(state().busy, false);
      assert.deepEqual(paths(), ['src/a.ts'], 'Add success alone must not remove a row');
      await automaticRefresh();
      assert.deepEqual(paths(), ['src/a.ts'], 'Residual unstaged/untracked state retains the row');
      repository.state.indexChanges = [change('/synthetic/repo/src/a.ts')];
      repository.state.workingTreeChanges = [];
      repository.state.untrackedChanges = [];
      gitChanged.fire();
      assert.deepEqual(paths(), ['src/a.ts'], 'Only the refreshed projection removes the row');
      await automaticRefresh();
      assert.deepEqual(paths(), []);
      assert.deepEqual(adds, [['/synthetic/repo/src/a.ts']]);
      assert.deepEqual(navigation(), []);
      assert.deepEqual(opened, []);
      assert.equal(store().text, undefined);
    });
  }

  for (const kind of ['tracked', 'partial', 'deleted', 'binary', 'unknown stats', 'untracked', 'untracked binary'] as const) {
    await t.test(`revertFile confirms ${kind}, changes only target disk content and waits for Git refresh`, async () => {
      const untracked = kind.startsWith('untracked');
      let status: number = GitStatus.Modified;
      if (untracked) {
        status = GitStatus.Untracked;
      } else if (kind === 'deleted') {
        status = GitStatus.Deleted;
      }
      await reset(status, untracked ? 'untrackedChanges' : 'workingTreeChanges');
      if (untracked) { index.delete('/synthetic/repo/src/a.ts'); }
      if (kind === 'partial') {
        repository.state.indexChanges = [change('/synthetic/repo/src/a.ts', GitStatus.IndexModified)];
        index.set('/synthetic/repo/src/a.ts', 'staged content distinct from HEAD and disk\n');
      }
      if (kind === 'deleted') {
        sources.delete('/synthetic/repo/src/a.ts');
        missing.add('/synthetic/repo/src/a.ts');
      }
      if (kind === 'binary') {
        sources.set('/synthetic/repo/src/a.ts', '\0disk binary');
        index.set('/synthetic/repo/src/a.ts', '\0index binary');
        diffText = 'Binary files a/src/a.ts and b/src/a.ts differ\n';
      }
      if (kind === 'untracked binary') { sources.set('/synthetic/repo/src/a.ts', '\0new binary'); }
      if (kind === 'unknown stats') { onDiff = async () => { throw new Error('Synthetic stats unavailable'); }; }
      if (untracked) {
        index.delete('/synthetic/repo/src/other.ts');
        assert.ok(repository.state.untrackedChanges);
        repository.state.untrackedChanges = [...repository.state.untrackedChanges, change('/synthetic/repo/src/other.ts', GitStatus.Untracked)];
      } else {
        assert.ok(repository.state.workingTreeChanges);
        repository.state.workingTreeChanges = [...repository.state.workingTreeChanges, change('/synthetic/repo/src/other.ts')];
      }
      await registeredCommand('dejareview.refresh')();
      await statisticsPublished();
      if (kind.includes('binary') || kind === 'unknown stats') {
        assert.equal(state().files[0].insertions, undefined);
        assert.equal(state().files[0].deletions, undefined);
      }
      const savedIndex = new Map(index);
      assert.ok(repository.state.indexChanges);
      const indexChanges = [...repository.state.indexChanges];
      const otherDisk = sources.get('/synthetic/repo/src/other.ts');
      const started = deferred(), release = deferred();
      onClean = async () => { started.resolve(); await release.promise; };
      receive.fire(revertAction());
      await started.promise;
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].message, untracked
        ? 'Revert src/a.ts? This untracked file will be removed and cannot be recovered by Git.'
        : 'Revert src/a.ts? Its unstaged disk changes will be discarded. Staged changes will be kept.');
      assert.equal(state().busy, true);
      assert.deepEqual(paths(), ['src/a.ts', 'src/other.ts']);
      assert.deepEqual(cleans, [['/synthetic/repo/src/a.ts']]);
      release.resolve();
      await settle();
      assert.equal(state().busy, false);
      assert.deepEqual(index, savedIndex);
      assert.deepEqual(repository.state.indexChanges, indexChanges);
      assert.equal(sources.get('/synthetic/repo/src/a.ts'), untracked ? undefined : savedIndex.get('/synthetic/repo/src/a.ts'));
      assert.equal(missing.has('/synthetic/repo/src/a.ts'), untracked);
      assert.equal(sources.get('/synthetic/repo/src/other.ts'), otherDisk);
      assert.deepEqual(paths(), ['src/a.ts', 'src/other.ts'], 'Clean success alone must not remove a row');
      await automaticRefresh();
      assert.deepEqual(paths(), ['src/a.ts', 'src/other.ts'], 'Unchanged Git state retains the candidate');
      repository.state.workingTreeChanges = untracked ? [] : [change('/synthetic/repo/src/other.ts')];
      repository.state.untrackedChanges = untracked ? [change('/synthetic/repo/src/other.ts', GitStatus.Untracked)] : [];
      gitChanged.fire();
      assert.deepEqual(paths(), ['src/a.ts', 'src/other.ts'], 'No optimistic removal before Git refresh');
      await automaticRefresh();
      assert.deepEqual(paths(), ['src/other.ts']);
      assert.deepEqual(cleans, [['/synthetic/repo/src/a.ts']]);
      assert.deepEqual(adds, []);
      assert.deepEqual(navigation(), []);
      assert.deepEqual(opened, []);
      assert.equal(store().text, undefined);
    });
  }

  await t.test('revert cancellation makes zero clean calls, preserves disk/index and releases the guard', async () => {
    await reset();
    const disk = new Map(sources), savedIndex = new Map(index);
    onWarning = async () => undefined;
    receive.fire(revertAction());
    await settle();
    assert.equal(warnings.length, 1);
    assert.deepEqual(cleans, []);
    assert.deepEqual(adds, []);
    assert.deepEqual(sources, disk);
    assert.deepEqual(index, savedIndex);
    assert.equal(state().busy, false);
    assert.deepEqual(paths(), ['src/a.ts']);
    assert.deepEqual(errors, []);
    onWarning = async () => 'Revert File';
    receive.fire(revertAction());
    await settle();
    assert.deepEqual(cleans, [['/synthetic/repo/src/a.ts']]);
  });

  await t.test('index-only staged deletions are absent and stale revert handles never restore them', async () => {
    await reset();
    const request = revertAction();
    sources.delete('/synthetic/repo/src/a.ts');
    index.delete('/synthetic/repo/src/a.ts');
    missing.add('/synthetic/repo/src/a.ts');
    repository.state.workingTreeChanges = [];
    repository.state.indexChanges = [change('/synthetic/repo/src/a.ts', GitStatus.IndexDeleted)];
    gitChanged.fire();
    await automaticRefresh();
    assert.deepEqual(paths(), []);
    receive.fire(request);
    await incoming(request);
    assert.deepEqual(warnings, []);
    assert.deepEqual(cleans, []);
    assert.deepEqual(adds, []);
    assert.equal(sources.has('/synthetic/repo/src/a.ts'), false);
    assert.equal(index.has('/synthetic/repo/src/a.ts'), false);
    assert.deepEqual(repository.state.indexChanges, [change('/synthetic/repo/src/a.ts', GitStatus.IndexDeleted)]);
  });

  for (const pending of ['confirmation', 'clean', 'add'] as const) {
    await t.test(`pending ${pending} disables all file actions and rejects repeat/concurrent stage and revert`, async () => {
      await reset();
      repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
      await registeredCommand('dejareview.refresh')();
      const client = scriptFixture();
      client.update(state());
      const row = client.element('files').children[0];
      const buttons = row.children.filter(child => child.tagName === 'button');
      assert.deepEqual(buttons.slice(1).map(button => ({
        title: button.title, label: button.attributes.get('aria-label'), disabled: button.disabled,
      })), [
        { title: 'Revert File', label: 'Revert File', disabled: false },
        { title: 'Add File Review Note', label: 'Add File Review Note', disabled: false },
        { title: 'Stage File', label: 'Stage File', disabled: false },
      ]);
      const started = deferred(), release = deferred();
      const pause = async () => { started.resolve(); await release.promise; };
      if (pending === 'confirmation') { onWarning = async () => { await pause(); return 'Revert File'; }; }
      else if (pending === 'clean') { onClean = pause; }
      else { onAdd = pause; }
      receive.fire(pending === 'add' ? stageAction() : revertAction());
      await started.promise;
      assert.equal(state().busy, true);
      client.update(state());
      assert.ok(buttons.every(button => button.disabled), 'Published busy state disables actual client controls');
      const cleanCount = cleans.length, addCount = adds.length, warningCount = warnings.length;
      for (const target of ['src/a.ts', 'src/other.ts']) {
        for (const type of ['stageFile', 'revertFile', 'addFileNote'] as const) {
          const request = { ...action(target), type };
          receive.fire(request);
          await incoming(request);
        }
      }
      assert.equal(cleans.length, cleanCount);
      assert.equal(adds.length, addCount);
      assert.equal(warnings.length, warningCount);
      assert.deepEqual(paths(), ['src/a.ts', 'src/other.ts']);
      release.resolve();
      await settle();
      assert.equal(state().busy, false);
      assert.deepEqual(errors, []);
      assert.deepEqual(cleans, pending === 'add' ? [] : [['/synthetic/repo/src/a.ts']]);
      assert.deepEqual(adds, pending === 'add' ? [['/synthetic/repo/src/a.ts']] : []);
    });
  }

  for (const when of ['before', 'confirmation', 'final validation'] as const) {
    await t.test(`dirty target ${when} refuses revert without touching disk, index or buffer`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      const disk = new Map(sources), savedIndex = new Map(index);
      const document = { uri: file('/synthetic/repo/src/a.ts'), isDirty: true, isClosed: false,
        getText: () => 'unsaved source content',
        save: () => assert.fail('Revert must not save a dirty buffer'),
      } satisfies Pick<vscode.TextDocument, 'uri' | 'isDirty' | 'isClosed' | 'getText' | 'save'>;
      if (when === 'before') { workspace.textDocuments = [document]; }
      else if (when === 'confirmation') {
        onWarning = async () => { workspace.textDocuments = [document]; return 'Revert File'; };
      } else {
        let calls = 0;
        onValidate = async () => { if (++calls === 2) { workspace.textDocuments = [document]; } };
      }
      receive.fire(revertAction());
      await settle();
      assert.equal(warnings.length, when === 'before' ? 0 : 1);
      assert.deepEqual(cleans, []);
      assert.deepEqual(adds, []);
      assert.deepEqual(sources, disk);
      assert.deepEqual(index, savedIndex);
      assert.equal(document.isDirty, true);
      assert.equal(document.getText(), 'unsaved source content');
      assert.deepEqual(navigation(), []);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /unsaved changes/);
      assert.equal(state().busy, false);
      assert.deepEqual(paths(), ['src/a.ts']);
    });
  }

  const unsupportedRevertCases: Array<{
    kind: string;
    group: 'workingTreeChanges' | 'indexChanges' | 'mergeChanges';
    status: GitChange['status'];
  }> = [
    { kind: 'conflict', group: 'workingTreeChanges', status: GitStatus.BothModified },
    { kind: 'merge conflict', group: 'mergeChanges', status: GitStatus.BothModified },
    { kind: 'intent-to-add', group: 'workingTreeChanges', status: GitStatus.IntentToAdd },
    { kind: 'intent-to-rename', group: 'workingTreeChanges', status: GitStatus.IntentToRename },
    { kind: 'index conflict', group: 'indexChanges', status: GitStatus.BothModified },
    { kind: 'unknown status', group: 'workingTreeChanges', status: undefined },
    { kind: 'type change', group: 'workingTreeChanges', status: GitStatus.TypeChanged },
    { kind: 'unknown index status', group: 'indexChanges', status: undefined },
  ];
  for (const { kind, group, status } of unsupportedRevertCases) {
    await t.test(`${kind} refuses revert before confirmation and clean`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      repository.state[group] = [{ uri: file('/synthetic/repo/src/a.ts'), status }];
      const disk = new Map(sources), savedIndex = new Map(index);
      receive.fire(revertAction());
      await settle();
      assert.deepEqual(warnings, []);
      assert.deepEqual(cleans, []);
      assert.deepEqual(adds, []);
      assert.deepEqual(sources, disk);
      assert.deepEqual(index, savedIndex);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /does not support this Git status/);
      assert.equal(state().busy, false);
    });
  }

  for (const mutation of ['folder', 'Git event', 'saved note', 'membership', 'status', 'nested repository'] as const) {
    await t.test(`${mutation} during revert confirmation refuses the captured action`, async child => {
      child.mock.method(console, 'error', () => {});
      await reset();
      const disk = new Map(sources), savedIndex = new Map(index);
      const started = deferred(), release = deferred();
      onWarning = async () => { started.resolve(); await release.promise; return 'Revert File'; };
      receive.fire(revertAction());
      await started.promise;
      assert.equal(state().busy, true);
      if (mutation === 'folder') { workspace.workspaceFolders = [{ uri: file('/synthetic/other') }]; }
      else if (mutation === 'Git event') { gitChanged.fire(); }
      else if (mutation === 'saved note') {
        store().save(appendComment('', { path: 'src/a.ts', origin: 'head', side: 'document',
          startLine: 1, endLine: 1, anchorText: 'missing old anchor', body: 'Synthetic saved note',
        }));
      } else if (mutation === 'nested repository') {
        repositories.push({ ...repository, rootUri: file('/synthetic/repo/src') });
      } else {
        // Without an event, the helper must independently revalidate live Git state.
        repository.state.workingTreeChanges = mutation === 'membership' ? [] : [change('/synthetic/repo/src/a.ts', GitStatus.TypeChanged)];
      }
      release.resolve();
      await settle();
      assert.equal(warnings.length, 1);
      assert.deepEqual(cleans, []);
      assert.deepEqual(adds, []);
      assert.deepEqual(sources, disk);
      assert.deepEqual(index, savedIndex);
      assert.equal(state().busy, false);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /opened folder|Files to Review changed|no longer has unstaged|Git status|status has changed|nested repository/);
    });
  }

  await t.test('clean rejection retains disk and candidate, releases the guard and allows retry', async child => {
    child.mock.method(console, 'error', () => {});
    await reset();
    const disk = new Map(sources), savedIndex = new Map(index);
    onClean = async () => { throw new Error('Synthetic clean rejected'); };
    receive.fire(revertAction());
    await settle();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Synthetic clean rejected/);
    assert.equal(state().busy, false);
    assert.deepEqual(paths(), ['src/a.ts']);
    assert.deepEqual(sources, disk);
    assert.deepEqual(index, savedIndex);
    errors.length = 0;
    await automaticRefresh();
    onClean = async () => {};
    receive.fire(revertAction());
    await settle();
    assert.deepEqual(cleans, [['/synthetic/repo/src/a.ts'], ['/synthetic/repo/src/a.ts']]);
    assert.equal(warnings.length, 2, 'Retry requires a fresh confirmation');
    assert.equal(sources.get('/synthetic/repo/src/a.ts'), index.get('/synthetic/repo/src/a.ts'));
    assert.deepEqual(index, savedIndex);
    assert.deepEqual(errors, []);
    assert.deepEqual(adds, []);
    assert.equal(state().busy, false);
    assert.deepEqual(paths(), ['src/a.ts']);
  });

  await t.test('revertFile rejects malformed, outside, cross-folder and stale handles before confirmation', async () => {
    await reset();
    const request = revertAction();
    for (const invalid of [
      { ...request, path: '/synthetic/outside.ts' },
      { ...request, fileId: '/synthetic/outside.ts' },
      { ...request, fileId: '../outside.ts' },
      { ...request, fileId: 1 },
      { ...request, repoKey: file('/synthetic/other').toString() },
    ]) { receive.fire(invalid); }
    await incoming({ ...request, fileId: '../outside.ts' });
    await incoming({ ...request, repoKey: file('/synthetic/other').toString() });
    repository.state.workingTreeChanges = [];
    gitChanged.fire();
    await automaticRefresh();
    receive.fire(request);
    await incoming(request);
    assert.deepEqual(validations, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(cleans, []);
    assert.deepEqual(adds, []);
    assert.deepEqual(errors, []);
  });

  await t.test('add rejection is shown, retains the row and clears the host guard for retry', async child => {
    child.mock.method(console, 'error', () => {});
    await reset();
    onAdd = async () => { throw new Error('Synthetic add rejected'); };
    receive.fire(stageAction());
    await settle();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Synthetic add rejected/);
    assert.equal(state().busy, false);
    assert.deepEqual(paths(), ['src/a.ts']);
    errors.length = 0;
    await automaticRefresh();
    onAdd = async () => {};
    receive.fire(stageAction());
    await settle();
    assert.deepEqual(adds, [['/synthetic/repo/src/a.ts'], ['/synthetic/repo/src/a.ts']]);
    assert.deepEqual(errors, []);
    assert.equal(state().busy, false);
  });

  await t.test('stageFile rejects malformed, outside, cross-folder and stale handles before add', async () => {
    await reset();
    const request = stageAction();
    for (const invalid of [
      { ...request, path: '/synthetic/outside.ts' },
      { ...request, fileId: '/synthetic/outside.ts' },
      { ...request, fileId: '../outside.ts' },
      { ...request, fileId: 1 },
      { ...request, repoKey: file('/synthetic/other').toString() },
    ]) { receive.fire(invalid); }
    await incoming({ ...request, fileId: '../outside.ts' });
    await incoming({ ...request, repoKey: file('/synthetic/other').toString() });
    assert.deepEqual(validations, []);
    assert.deepEqual(adds, []);
    repository.state.workingTreeChanges = [];
    gitChanged.fire();
    await automaticRefresh();
    receive.fire(request);
    await incoming(request);
    assert.deepEqual(validations, []);
    assert.deepEqual(adds, []);
    assert.deepEqual(errors, []);
  });

  for (const wait of ['first validation', 'file stat', 'final validation'] as const) {
    for (const mutation of ['scope', 'Git event', 'saved note', 'membership'] as const) {
      await t.test(`${mutation} during stageFile ${wait} rejects before add`, async child => {
        child.mock.method(console, 'error', () => {});
        await reset();
        const started = deferred(), release = deferred();
        const pause = async () => { started.resolve(); await release.promise; };
        if (wait === 'file stat') { onStat = pause; }
        else {
          let calls = 0;
          onValidate = async () => { if (++calls === (wait === 'first validation' ? 1 : 2)) { await pause(); } };
        }
        receive.fire(stageAction());
        await started.promise;
        assert.equal(state().busy, true);
        if (mutation === 'scope') {
          workspace.workspaceFolders = [{ uri: file('/synthetic/other') }];
        } else if (mutation === 'Git event') {
          // Identical membership still invalidates the captured host generation.
          gitChanged.fire();
        } else if (mutation === 'saved note') {
          store().save(appendComment('', { path: 'src/a.ts', origin: 'head', side: 'document',
            startLine: 1, endLine: 1, anchorText: 'missing old anchor', body: 'Synthetic saved note',
          }));
        } else {
          // No event: the real helper must recheck live membership itself.
          repository.state.workingTreeChanges = [];
        }
        release.resolve();
        await settle();
        assert.deepEqual(adds, []);
        assert.equal(state().busy, false);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /opened folder|Files to Review changed|no longer has unstaged/);
      });
    }
  }

  await t.test('saved notes and review data are excluded before dashboard or direct helper staging and reverting', async () => {
    await reset();
    const request = stageAction();
    const revert = revertAction();
    store().save(appendComment('', { path: 'src/a.ts', origin: 'head', side: 'document',
      startLine: 1, endLine: 1, anchorText: 'missing old anchor', body: 'Synthetic saved note',
    }));
    const excluded = ['REVIEW-NOTES.md', '.REVIEW-NOTES.md.test.tmp', 'archives/batch.json'];
    sources.set('/synthetic/repo/guide.md', 'Ordinary project documentation\n');
    repository.state.workingTreeChanges = ['src/a.ts', 'guide.md', ...excluded.slice(0, 2)]
      .map(name => change(`/synthetic/repo/${name}`));
    await automaticRefresh();
    assert.deepEqual(paths(), ['guide.md']);
    receive.fire(request);
    await incoming(request);
    receive.fire(revert);
    await incoming(revert);
    const git = new GitResources();
    try {
      const repo = await git.workspaceRepository();
      assert.ok(repo, 'Expected synthetic repository discovery');
      for (const target of ['src/a.ts', ...excluded, '../outside.ts']) {
        await assert.rejects(git.stageFile(repo, target, new Set(['src\\a.ts']),
          [file('/synthetic/repo/archives')], () => assert.fail('Excluded paths must fail before the final guard')),
        /saved Review Notes|cannot be staged|traversal/);
        await assert.rejects(git.revertFile(repo, target, new Set(['src\\a.ts']),
          [file('/synthetic/repo/archives')], () => assert.fail('Excluded paths must fail before the final guard'),
          async () => assert.fail('Excluded paths must fail before confirmation')),
        /saved Review Notes|cannot be reverted|traversal/);
      }
      assert.deepEqual(adds, []);
      assert.deepEqual(cleans, []);
      assert.deepEqual(warnings, []);
      assert.deepEqual(errors, []);
    } finally { git.dispose(); }
  });

  await t.test('real stageFile helper delegates a subfolder-relative file as one containing-repository absolute path', async () => {
    await reset();
    workspace.workspaceFolders = [{ uri: file('/synthetic/repo/src') }];
    const git = new GitResources();
    try {
      const repo = await git.workspaceRepository();
      assert.ok(repo, 'Expected synthetic subfolder repository discovery');
      let guarded = false;
      onAdd = async () => { assert.equal(guarded, true); };
      await git.stageFile(repo, 'a.ts', new Set(), [], () => { guarded = true; });
      assert.deepEqual(adds, [['/synthetic/repo/src/a.ts']]);
    } finally { git.dispose(); }
  });

  await t.test('Git state events refresh automatically; partial staging stays visible and index-only disappears', async () => {
    await reset();
    repository.state.indexChanges = [change('/synthetic/repo/src/a.ts')];
    const before = diffCalls;
    gitChanged.fire();
    await automaticRefresh();
    await statisticsPublished();
    assert.ok(diffCalls > before, 'Git event must request fresh statistics');
    assert.deepEqual(state().files, [{ id: 'src/a.ts', path: 'src/a.ts', insertions: 2, deletions: 1,
      visible: false, statisticsPending: false }]);
    repository.state.workingTreeChanges = [];
    gitChanged.fire();
    await automaticRefresh();
    assert.deepEqual(paths(), []);
    repository.state.indexChanges = [];
    repository.state.workingTreeChanges = [change('/synthetic/repo/src/a.ts')];
    gitChanged.fire();
    await automaticRefresh();
    assert.deepEqual(paths(), ['src/a.ts']);
  });

  await t.test('saved stale notes hide their header path for every origin and side; clearing restores candidates', async () => {
    const api = await reset();
    repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
    for (const origin of ['changed', 'staged', 'head', `commit:${'b'.repeat(40)}`] as Origin[]) {
      for (const side of ['document', 'left', 'right'] as Side[]) {
        const selected = { path: 'src/a.ts', origin };
        const opposite = { path: 'src/other.ts', origin: 'changed' as const };
        const note: ReviewComment = { ...selected, side, startLine: 1, endLine: 1,
          anchorText: 'synthetic old content that no longer exists', body: 'Synthetic feedback',
        };
        switch (side) {
          case 'document':
            break;
          case 'left':
            note.comparison = { left: selected, right: opposite };
            break;
          case 'right':
            note.comparison = { left: opposite, right: selected };
            break;
        }
        store().save(appendComment('', note));
        await automaticRefresh();
        assert.equal(state().commentCount, 1, `${origin}/${side}`);
        const card = state().notes[0];
        assert.ok(!card.general);
        assert.equal(card.stale, true);
        assert.equal(api.getState().threads, 0);
        assert.deepEqual(paths(), ['src/other.ts'], 'The opposite endpoint is not another noted header');
        store().save(undefined);
        await automaticRefresh();
        assert.equal(state().hasFeedback, false);
        assert.equal(state().commentCount, 0);
        assert.deepEqual(paths(), ['src/a.ts', 'src/other.ts']);
      }
    }
  });

  await t.test('unsaved review document events do not hide candidates; refresh command uses only saved projection', async () => {
    await reset();
    const unsaved = { uri: store().uri, isDirty: true, isClosed: false,
      getText: () => appendComment('', { path: 'src/a.ts', origin: 'changed', side: 'document',
        startLine: 1, endLine: 1, body: 'Synthetic unsaved feedback',
      }),
    };
    workspace.textDocuments = [unsaved];
    const before = diffCalls;
    documentsChanged.fire({ document: unsaved });
    await automaticRefresh();
    assert.equal(diffCalls, before);
    assert.deepEqual(paths(), ['src/a.ts']);
    await registeredCommand('dejareview.refresh')();
    assert.equal(state().hasFeedback, false);
    assert.equal(state().commentCount, 0);
    assert.deepEqual(paths(), ['src/a.ts'], 'Unsaved note text must not suppress candidates on explicit refresh either');
    store().text = '## `src/a.ts`:1\nMalformed synthetic metadata\n';
    await registeredCommand('dejareview.refresh')();
    assert.equal(state().hasFeedback, true);
    assert.equal(state().commentCount, 0);
    assert.ok(state().noteError);
    assert.deepEqual(paths(), ['src/a.ts'], 'Malformed headers must not be guessed into saved note paths');
    const snapshot = store().text;
    await send({ type: 'openHistory', repoKey: state().repoKey });
    assert.equal(state().historyVisible, false, 'Meaningful malformed feedback still blocks history in the host');
    assert.equal(store().text, snapshot);
    assert.equal(mutations, 0);
    assert.equal(handoffs, 0);
    assert.equal(restores, 0);
    assert.deepEqual(clipboard, []);
  });

  await t.test('pending file navigation stays non-busy across refresh, rejects repeats and mutations, and permits retry after failure', async child => {
    child.mock.method(console, 'error', () => {});
    await reset(GitStatus.Untracked, 'untrackedChanges');
    const started = deferred(), release = deferred();
    onOpen = async () => {
      started.resolve();
      await release.promise;
      throw new Error('Synthetic navigation failed');
    };
    const before = messages.length;
    const request = action();
    receive.fire(request);
    await started.promise;
    assert.equal(state().busy, false);
    await registeredCommand('dejareview.refresh')();
    view.visible = false; visibilityChanged.fire();
    view.visible = true; visibilityChanged.fire();
    for (const next of [request, stageAction(), revertAction(), generalAction()]) receive.fire(next);
    await settle();
    assert.equal(opened.length, 1);
    assert.deepEqual(adds, []);
    assert.deepEqual(cleans, []);
    assert.deepEqual(warnings, []);
    assert.equal(state().editor, undefined);
    assert.ok(messages.slice(before).every(message => !message.busy), 'No transient busy state from navigation or refresh');
    release.resolve();
    await settle();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Synthetic navigation failed/);
    assert.deepEqual(shown, []);
    assert.deepEqual(paths(), ['src/a.ts']);
    onOpen = async () => {};
    await send(action());
    assert.equal(opened.length, 2, 'The failed navigation releases provider serialization');
    assert.equal(shown.length, 1);
    assert.ok(messages.slice(before).every(message => !message.busy));
    assert.equal(store().text, undefined);
    assert.equal(mutations, 0);
  });

  await t.test('file change labels describe only changes relative to the staged snapshot', async () => {
    await reset();
    for (const [workingStatus, indexStatus, expected] of [
      [GitStatus.Untracked, undefined, 'added'],
      [GitStatus.IntentToAdd, undefined, 'added'],
      [GitStatus.Deleted, undefined, 'removed'],
      [GitStatus.IntentToRename, undefined, 'renamed'],
      [GitStatus.Modified, 3, undefined],
      [GitStatus.Modified, 1, undefined],
      [GitStatus.Deleted, 1, 'removed'],
      [GitStatus.Deleted, 3, 'removed'],
      [GitStatus.Modified, undefined, undefined],
    ] as const) {
      repository.state.workingTreeChanges = [change('/synthetic/repo/src/a.ts', workingStatus)];
      repository.state.indexChanges = indexStatus === undefined ? [] : [change('/synthetic/repo/src/a.ts', indexStatus)];
      gitChanged.fire();
      await automaticRefresh();
      assert.equal(state().files[0].changeKind, expected);
      await statisticsPublished();
      const client = scriptFixture();
      client.update(state());
      const open = client.element('files').children[0].children[0];
      if (workingStatus === GitStatus.Modified) {
        assert.equal(open.children[4].hidden, true, 'Staged history must not label residual edits Added or Renamed');
        assert.equal(open.children[1].textContent, '+2');
        assert.equal(open.children[2].textContent, '-1');
      }
    }
    repository.state.workingTreeChanges = [];
    repository.state.untrackedChanges = [change('/synthetic/repo/src/a.ts', GitStatus.Untracked)];
    const started = deferred();
    const release = deferred();
    onStatistics = async () => {
      started.resolve();
      await release.promise;
      return new Map();
    };
    await registeredCommand('dejareview.refresh')();
    await started.promise;
    assert.equal(state().files[0].changeKind, 'added', 'Label is published before counts settle');
    release.resolve();
    await statisticsPublished();
    assert.equal(state().files[0].changeKind, 'added');
    assert.equal(state().files[0].insertions, undefined, 'Unavailable statistics do not remove the label');
    repository.state.untrackedChanges = [];
    repository.state.workingTreeChanges = [];
    repository.state.indexChanges = [change('/synthetic/repo/src/a.ts', 3)];
    gitChanged.fire();
    await automaticRefresh();
    assert.deepEqual(paths(), [], 'Status metadata must not introduce index-only candidates');
  });

  const navigationCases = [
    { kind: 'tracked', status: GitStatus.Modified, group: 'workingTreeChanges' },
    { kind: 'partially staged', status: GitStatus.Modified, group: 'workingTreeChanges' },
    { kind: 'untracked', status: GitStatus.Modified, group: 'untrackedChanges' },
    { kind: 'status7', status: GitStatus.Untracked, group: 'workingTreeChanges' },
    { kind: 'deleted', status: GitStatus.Deleted, group: 'workingTreeChanges' },
  ] as const;
  for (const { kind, status, group } of navigationCases) {
    await t.test(`openFile navigates ${kind} using the correct resource`, async () => {
      await reset(status, group);
      if (kind === 'partially staged') { repository.state.indexChanges = [change('/synthetic/repo/src/a.ts')]; }
      receive.fire(action());
      await settle();
      assert.equal(state().busy, false);
      assert.deepEqual(errors, []);
      const index = (uri: vscode.Uri) => {
        assert.equal(uri.scheme, 'git');
        assert.deepEqual(JSON.parse(uri.query), { path: '/synthetic/repo/src/a.ts', ref: '' });
      };
      if (kind === 'tracked' || kind === 'partially staged') {
        assert.equal(navigation().length, 1);
        const call = navigation()[0];
        assert.equal(call.command, 'vscode.diff');
        assert.ok(call.args[0] instanceof Uri);
        assert.ok(call.args[1] instanceof Uri);
        assert.equal(call.args[0].scheme, 'git');
        assert.equal(call.args[0].query, JSON.stringify({ path: '/synthetic/repo/src/a.ts', ref: '~' }),
          'Native Git hunk staging menus require the working-tree ref, with ref last in the query');
        assert.equal(call.args[1].toString(), file('/synthetic/repo/src/a.ts').toString());
        assert.equal(call.args[2], 'src/a.ts (Unstaged changes)');
        assert.deepEqual(call.args[3], { preview: true });
        assert.deepEqual(opened, []); assert.deepEqual(shown, []);
        assert.deepEqual(adds, [], 'Opening a staging-enabled diff does not stage anything');
        assert.deepEqual(cleans, []);
      } else {
        assert.deepEqual(navigation(), []);
        assert.equal(opened.length, 1); assert.equal(shown.length, 1);
        assert.equal(shown[0].document.uri, opened[0]);
        assert.deepEqual(shown[0].options, { preview: true });
        if (kind === 'deleted') { index(opened[0]); }
        else { assert.equal(opened[0].toString(), file('/synthetic/repo/src/a.ts').toString()); }
      }
      const usesIndex = kind === 'tracked' || kind === 'partially staged' || kind === 'deleted';
      assert.deepEqual(validations, usesIndex ? ['changed', 'staged'] : ['changed']);
    });
  }

  await t.test('old folder actions fail before and after refresh, even when the new folder has the same path ID', async child => {
    const logged: unknown[][] = [];
    child.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
    await reset();
    const old = action();
    workspace.workspaceFolders = [{ uri: file('/synthetic/other') }];
    repository = { ...repository, rootUri: workspace.workspaceFolders[0].uri,
      state: { ...repository.state, workingTreeChanges: [change('/synthetic/other/src/a.ts')] },
    };
    repositories = [repository];
    sources.set('/synthetic/other/src/a.ts', 'other folder\n');
    // The dashboard still shows the previous folder; host scope validation must reject it.
    receive.fire(old);
    await settle();
    assert.deepEqual(navigation(), []); assert.deepEqual(shown, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /outside the opened folder/);
    assert.equal(logged.length, 1);
    errors.length = 0;
    foldersChanged.fire();
    await automaticRefresh();
    assert.notEqual(state().repoKey, old.repoKey);
    assert.equal(action().fileId, old.fileId);
    receive.fire(old);
    await settle();
    assert.deepEqual(navigation(), []); assert.deepEqual(shown, []);
    receive.fire(action());
    await settle();
    assert.equal(navigation().length, 1);
    const target = navigation()[0].args[1];
    assert.ok(target instanceof Uri);
    assert.equal(target.path, '/synthetic/other/src/a.ts');
  });

  for (const wait of ['changed URI', 'index URI', 'untracked document', 'deleted document'] as const) {
    for (const mutation of ['remove', 'stage', 'save note'] as const) {
      await t.test(`${mutation} during awaited ${wait} cancels navigation before the debounced refresh`, async () => {
        await reset(wait === 'deleted document' ? GitStatus.Deleted : GitStatus.Modified,
          wait === 'untracked document' ? 'untrackedChanges' : 'workingTreeChanges');
        const started = deferred();
        const release = deferred();
        const pause = async () => { started.resolve(); await release.promise; };
        if (wait.endsWith('document')) { onOpen = pause; }
        else { onValidate = async origin => { if (origin === (wait === 'index URI' ? 'staged' : 'changed')) { await pause(); } }; }
        const old = action();
        receive.fire(old);
        await started.promise;
        assert.equal(state().busy, false, 'Pending navigation must not make the dashboard visually busy');
        if (mutation === 'save note') {
          store().save(appendComment('', { path: 'src/a.ts', origin: 'head', side: 'document',
            startLine: 1, endLine: 1, anchorText: 'missing old anchor', body: 'Synthetic saved note',
          }));
        } else {
          repository.state.workingTreeChanges = [];
          repository.state.untrackedChanges = [];
          repository.state.indexChanges = mutation === 'stage' ? [change('/synthetic/repo/src/a.ts')] : [];
          gitChanged.fire();
        }
        release.resolve();
        await settle();
        assert.deepEqual(navigation(), []);
        assert.deepEqual(shown, []);
        assert.equal(state().busy, false);
        await automaticRefresh();
        assert.deepEqual(paths(), []);
        const before = validations.length;
        receive.fire(old);
        await settle();
        assert.equal(validations.length, before, 'Removed candidate IDs must not reach navigation');
      });
    }
  }

  const staleStatisticsCases = (['Git state', 'saved notes', 'folder', 'disposal'] as const).flatMap(mutation =>
    (['before replacement', 'after replacement'] as const).map(completion => ({ mutation, completion })));
  for (const { mutation, completion } of staleStatisticsCases) {
    await t.test(`${mutation} rejects background statistics ${completion}`, async () => {
      const api = await reset();
      const started = deferred();
      const release = deferred();
      onStatistics = async () => {
        onStatistics = async () => undefined;
        started.resolve();
        await release.promise;
        // Deliberately ignore the helper's cancellation callback to exercise the
        // extension's independent post-await publication guard.
        return new Map([['src/a.ts', { insertions: 999, deletions: 999 }]]);
      };
      try {
        await api.refresh();
        await started.promise;
        assert.equal(state().files[0].statisticsPending, false);
        assert.equal(state().files[0].insertions, 2);
        switch (mutation) {
          case 'Git state':
            repository.state.workingTreeChanges = [];
            repository.state.indexChanges = [change('/synthetic/repo/src/a.ts')];
            gitChanged.fire();
            break;
          case 'saved notes':
            store().save(appendComment('', { path: 'src/a.ts', origin: 'staged', side: 'document',
              startLine: 1, endLine: 1, anchorText: 'missing old anchor', body: 'Synthetic feedback',
            }));
            break;
          case 'folder':
            switchFolder();
            break;
          case 'disposal':
            subscriptions.forEach(item => item.dispose());
            break;
        }
        // Invalidation itself must revoke publication, even before the debounce
        // can replace the row array. A Git helper may still return old results.
        if (completion === 'before replacement') {
          const invalidated = messages.length;
          release.resolve();
          await statisticsFinished();
          assert.equal(messages.length, invalidated, 'Invalidation must reject stats before replacement publication');
        }
        await api.refresh();
        const before = messages.length;
        if (mutation !== 'folder' && mutation !== 'disposal') {
          assert.deepEqual(paths(), []);
          assert.equal(state().commentCount, mutation === 'saved notes' ? 1 : 0);
        }
        release.resolve();
        await statisticsFinished();
        if (mutation === 'folder') {
          await statisticsPublished();
          assert.equal(state().repoKey, file('/synthetic/other').toString());
          assert.deepEqual(paths(), ['src/a.ts']);
          assert.equal(state().files[0].insertions, 2);
        } else {
          assert.equal(messages.length, before, 'Obsolete completion must not publish at all');
        }
        assert.ok(messages.slice(before).every(message =>
          message.files.every(row => row.insertions !== 999 && row.deletions !== 999)));
        assert.deepEqual(errors, []);
      } finally {
        release.resolve();
        await statisticsFinished();
      }
    });
  }

  await t.test('65 settled files retain counts through staging and delayed Git events, while disk changes and forced refresh recompute stats', async () => {
    const api = await reset();
    const targets = ['src/a.ts', ...Array.from({ length: 64 }, (_, i) => `src/file-${i}.ts`)];
    for (const target of targets) {
      const absolute = `/synthetic/repo/${target}`;
      sources.set(absolute, 'disk content\n');
      index.set(absolute, 'index content\n');
      mtimes.set(absolute, 1000);
      indexObjects.set(absolute, 'b'.repeat(40));
    }
    repository.state.workingTreeChanges = targets.map(target => change(`/synthetic/repo/${target}`));
    await api.refresh();
    await statisticsPublished();
    assert.equal(state().files.length, 65);
    assert.ok(state().files.every(row => row.statisticsPending === false && row.insertions === 2 && row.deletions === 1));
    const before = messages.length;
    const beforeDiffs = diffCalls;
    const beforeJobs = statisticsJobs.length;
    onAdd = async () => {
      repository.state.workingTreeChanges = targets.slice(1).map(target => change(`/synthetic/repo/${target}`));
      repository.state.indexChanges = [change('/synthetic/repo/src/a.ts', GitStatus.IndexModified)];
      gitChanged.fire();
    };

    await incoming(stageAction());
    await statisticsPublished();
    for (let notification = 0; notification < 2; notification++) {
      t.mock.timers.tick(2000);
      gitChanged.fire();
      await automaticRefresh();
      await statisticsPublished();
    }

    assert.deepEqual(adds, [['/synthetic/repo/src/a.ts']]);
    assert.deepEqual(cleans, []);
    assert.deepEqual(paths(), targets.slice(1).sort());
    assert.ok(statisticsJobs.length >= beforeJobs + 3, 'Post-action and both delayed events must revalidate signatures');
    assert.equal(diffCalls, beforeDiffs, 'All 64 unchanged disk/index signatures must reuse cached diffs');
    assert.ok(messages.length > before);
    for (const publication of messages.slice(before)) {
      const unaffected = publication.files.filter(row => row.path !== 'src/a.ts');
      assert.equal(unaffected.length, 64);
      assert.ok(unaffected.every(row => row.statisticsPending === false && row.insertions === 2 && row.deletions === 1),
        'No publication may replace settled counts with loading or unavailable');
    }

    const changed = '/synthetic/repo/src/file-0.ts';
    mtimes.set(changed, 2000);
    sources.set(changed, 'new content!\n');
    fileDiffs.set(changed, '@@ -1 +1,3 @@\n-index content\n+new content!\n+second\n+third\n');
    const beforeChange = diffPaths.length;
    gitChanged.fire();
    await automaticRefresh();
    await statisticsPublished();
    assert.deepEqual(diffPaths.slice(beforeChange), [changed], 'Only the changed disk signature needs a new diff');
    assert.equal(state().files.find(row => row.path === 'src/file-0.ts')?.insertions, 3);
    assert.ok(messages.slice(before).every(publication => publication.files.every(row => row.statisticsPending === false)));

    const beforeForce = diffPaths.length;
    fileDiffs.set(changed, '@@ -1 +1 @@\n-index content\n+forced content\n');
    await registeredCommand('dejareview.refresh')();
    await statisticsPublished();
    assert.deepEqual(diffPaths.slice(beforeForce).sort(), targets.slice(1).map(target => `/synthetic/repo/${target}`).sort(),
      'Explicit refresh bypasses every otherwise matching signature');
    assert.equal(state().files.find(row => row.path === 'src/file-0.ts')?.insertions, 1);
    assert.ok(messages.slice(before).every(publication => publication.files.every(row => row.statisticsPending === false)));
    assert.deepEqual(errors, []);
  });

  await t.test('a residual staged target refreshes its changed index identity without blinking or rediffing its neighbor', async () => {
    const api = await reset();
    const target = '/synthetic/repo/src/a.ts';
    const other = '/synthetic/repo/src/other.ts';
    for (const absolute of [target, other]) {
      mtimes.set(absolute, 1000);
      indexObjects.set(absolute, 'b'.repeat(40));
    }
    repository.state.workingTreeChanges = [change(target), change(other)];
    await api.refresh();
    await statisticsPublished();
    const before = messages.length;
    const beforeDiffs = diffPaths.length;
    onAdd = async () => {
      indexObjects.set(target, 'c'.repeat(40));
      index.set(target, 'new index baseline\n');
      fileDiffs.set(target, '@@ -1 +1 @@\n-new index baseline\n+residual disk content\n');
      repository.state.indexChanges = [change(target, GitStatus.IndexModified)];
      gitChanged.fire();
    };

    await incoming(stageAction());
    await statisticsPublished();

    assert.deepEqual(adds, [[target]]);
    assert.deepEqual(diffPaths.slice(beforeDiffs), [target]);
    assert.deepEqual(state().files.map(row => [row.path, row.insertions, row.deletions]),
      [['src/a.ts', 1, 1], ['src/other.ts', 2, 1]]);
    assert.ok(messages.slice(before).every(publication => publication.files.length === 2
      && publication.files.every(row => row.statisticsPending === false)));
    assert.equal(state().busy, false);
    assert.deepEqual(errors, []);
  });

  await t.test('existing unavailable statistics stay unavailable during blocked Git revalidation and failure', async () => {
    const api = await reset();
    diffText = 'Binary files a/src/a.ts and b/src/a.ts differ\n';
    await api.refresh();
    await statisticsPublished();
    assert.equal(state().files[0].insertions, undefined);
    assert.equal(state().files[0].statisticsPending, false);
    const before = messages.length;
    const started = deferred();
    const release = deferred();
    onStatistics = async () => {
      started.resolve();
      await release.promise;
      throw new Error('Synthetic unavailable statistics retry failed');
    };
    try {
      gitChanged.fire();
      await automaticRefresh();
      await started.promise;
      assert.equal(activeStatistics, 1);
      assert.equal(state().files[0].statisticsPending, false);
      release.resolve();
      await statisticsPublished();
      assert.match(state().filesError ?? '', /statistics could not be loaded/);
      for (const publication of messages.slice(before)) {
        assert.equal(publication.files.length, 1);
        assert.equal(publication.files[0].statisticsPending, false);
        assert.equal(publication.files[0].insertions, undefined);
        assert.equal(publication.files[0].deletions, undefined);
      }
      assert.deepEqual(errors, []);
    } finally {
      release.resolve();
      await statisticsFinished();
    }
  });

  for (const operation of ['stage', 'revert'] as const) {
    await t.test(`${operation} confirms candidates for 65 files without waiting for blocked statistics`, async () => {
      const api = await reset();
      const targets = ['src/a.ts', ...Array.from({ length: 64 }, (_, i) => `src/file-${i}.ts`)];
      for (const target of targets) {
        sources.set(`/synthetic/repo/${target}`, 'disk content\n');
        index.set(`/synthetic/repo/${target}`, 'index content\n');
      }
      repository.state.workingTreeChanges = targets.map(target => change(`/synthetic/repo/${target}`));
      const started = deferred();
      const release = deferred();
      onDiff = async () => {
        started.resolve();
        await release.promise;
      };
      try {
        const before = messages.length;
        await api.refresh();
        await started.promise;
        assert.deepEqual(paths(), [...targets].sort());
        assert.equal(state().files[0].statisticsPending, false);
        assert.equal(state().files[0].insertions, 2);
        assert.ok(state().files.slice(1).every(row => row.statisticsPending === true));
        const client = scriptFixture();
        client.update(state());
        assert.equal(client.element('files-title').textContent, 'Files to Review (65)');
        assert.ok(messages.slice(before).every(message => message.files.every(row =>
          !('uri' in row) && !('untracked' in row))));

        const mutate = async (): Promise<void> => {
          repository.state.workingTreeChanges = targets.slice(1).map(target => change(`/synthetic/repo/${target}`));
          gitChanged.fire();
        };
        onAdd = mutate;
        onClean = mutate;
        await incoming(operation === 'stage' ? stageAction() : revertAction());

        assert.deepEqual(adds, operation === 'stage' ? [['/synthetic/repo/src/a.ts']] : []);
        assert.deepEqual(cleans, operation === 'revert' ? [['/synthetic/repo/src/a.ts']] : []);
        assert.equal(warnings.length, operation === 'revert' ? 1 : 0);
        assert.deepEqual(paths(), targets.slice(1).sort());
        assert.equal(state().busy, false);
        assert.ok(state().files.every(row => row.pending === undefined && row.statisticsPending === true));
        client.update(state());
        assert.equal(client.element('files-title').textContent, 'Files to Review (64)');
        assert.equal(activeStatistics, 1, 'The obsolete job is still blocked, not awaited by the action');
        assert.equal(maxActiveStatistics, 1);

        onDiff = async () => {};
        release.resolve();
        await statisticsPublished();
        assert.ok(state().files.every(row => row.insertions === 2 && row.deletions === 1));
        assert.deepEqual(paths(), targets.slice(1).sort());
        assert.equal(maxActiveStatistics, 1);
        assert.ok(messages.slice(before).every(message => message.files.every(row =>
          !('uri' in row) && !('untracked' in row))));
        assert.deepEqual(errors, []);
      } finally {
        release.resolve();
        await statisticsFinished();
      }
    });
  }

  await t.test('automatic Git refresh preserves a queued explicit force request until current statistics publish', async () => {
    const api = await reset();
    const target = '/synthetic/repo/src/a.ts';
    mtimes.set(target, 1000);
    indexObjects.set(target, 'b'.repeat(40));
    await api.refresh();
    await statisticsPublished();
    const primedDiffs = diffPaths.length;
    gitChanged.fire();
    await automaticRefresh();
    await statisticsPublished();
    assert.equal(diffPaths.length, primedDiffs, 'Prove the unchanged disk/index signature is cached');

    const started = deferred();
    const release = deferred();
    const forceFlags: Array<boolean | undefined> = [];
    onStatistics = async (_repo, _candidates, isCurrent, force) => {
      forceFlags.push(force);
      if (forceFlags.length === 1) {
        started.resolve();
        await release.promise;
        assert.equal(isCurrent(), false, 'The blocked pass must be obsolete before it completes');
        return new Map([['src/a.ts', { insertions: 999, deletions: 999 }]]);
      }
      return undefined;
    };
    const before = messages.length;
    try {
      gitChanged.fire();
      await automaticRefresh();
      await started.promise;
      assert.deepEqual(forceFlags, [false]);

      await registeredCommand('dejareview.refresh')();
      const queuedPublication = messages.length;
      gitChanged.fire();
      await automaticRefresh();
      assert.ok(messages.length > queuedPublication, 'An automatic projection must supersede the queued explicit refresh');
      assert.deepEqual(forceFlags, [false], 'Both replacements wait behind the blocked statistics job');
      assert.equal(diffPaths.length, primedDiffs);

      // Leave the signature unchanged so only the surviving explicit force
      // request can discover this new synthetic diff result.
      fileDiffs.set(target, '@@ -1 +1 @@\n-index content\n+fresh content\n');
      release.resolve();
      await statisticsPublished();

      assert.deepEqual(forceFlags, [false, true], 'The automatic replacement inherits the unconsumed force request');
      assert.deepEqual(diffPaths.slice(primedDiffs), [target]);
      assert.equal(state().files[0].insertions, 1);
      assert.equal(state().files[0].deletions, 1);
      assert.ok(messages.slice(before).every(publication => publication.files.every(row =>
        row.statisticsPending === false && row.insertions !== 999)));

      gitChanged.fire();
      await automaticRefresh();
      await statisticsPublished();
      assert.deepEqual(forceFlags, [false, true, false], 'Publication consumes force so later automatic refreshes can reuse the cache');
      assert.deepEqual(diffPaths.slice(primedDiffs), [target]);
      assert.equal(maxActiveStatistics, 1);
      assert.deepEqual(errors, []);
      assert.deepEqual(adds, []);
      assert.deepEqual(cleans, []);
    } finally {
      release.resolve();
      await statisticsFinished();
    }
  });

  await t.test('background statistics jobs serialize, skip obsolete queued generations and enrich only the newest rows', async () => {
    const api = await reset();
    const started = deferred();
    const release = deferred();
    let jobs = 0;
    onStatistics = async () => {
      jobs++;
      if (jobs === 1) {
        started.resolve();
        await release.promise;
        return new Map([['src/a.ts', { insertions: 999, deletions: 999 }]]);
      }
      return new Map([['src/a.ts', { insertions: 7, deletions: 3 }]]);
    };
    try {
      await api.refresh();
      await started.promise;
      await api.refresh();
      await api.refresh();
      assert.equal(jobs, 1, 'Queued refreshes must not start overlapping statistics I/O');
      assert.equal(state().files[0].statisticsPending, false);
      assert.equal(state().files[0].insertions, 2);
      const before = messages.length;
      release.resolve();
      await statisticsPublished();

      assert.equal(jobs, 2, 'The obsolete queued generation must skip statistics I/O');
      assert.equal(maxActiveStatistics, 1);
      assert.deepEqual(state().files, [{
        id: 'src/a.ts', path: 'src/a.ts', visible: false,
        insertions: 7, deletions: 3, statisticsPending: false,
      }]);
      assert.ok(messages.slice(before).every(message => message.files.every(row => row.insertions !== 999)));
    } finally {
      release.resolve();
      await statisticsFinished();
    }
  });

  await t.test('statistics completion during pending stage preserves the authorized target and pending state', async () => {
    const api = await reset();
    const statsStarted = deferred();
    const releaseStats = deferred();
    const validationStarted = deferred();
    const releaseValidation = deferred();
    onStatistics = async () => {
      statsStarted.resolve();
      await releaseStats.promise;
      return new Map([['src/a.ts', { insertions: 4, deletions: 2 }]]);
    };
    try {
      await api.refresh();
      await statsStarted.promise;
      const request = stageAction();
      onValidate = async () => {
        validationStarted.resolve();
        await releaseValidation.promise;
      };
      const pending = incoming(request);
      await validationStarted.promise;
      assert.equal(state().files[0].pending, 'stage');
      assert.deepEqual(adds, []);

      releaseStats.resolve();
      await statisticsPublished();
      assert.equal(state().busy, true);
      assert.equal(state().files[0].pending, 'stage');
      assert.equal(state().files[0].insertions, 4);
      assert.equal(state().files[0].id, request.fileId);
      releaseValidation.resolve();
      await pending;
      await statisticsPublished();

      assert.deepEqual(adds, [['/synthetic/repo/src/a.ts']]);
      assert.equal(state().busy, false);
      assert.equal(state().files[0].pending, undefined);
      assert.deepEqual(errors, [], 'Stats enrichment must not invalidate host-held row identity');
    } finally {
      releaseStats.resolve();
      releaseValidation.resolve();
      await statisticsFinished();
    }
  });

  await t.test('statistics failure retains newly published candidates and permits a successful retry', async () => {
    const api = await reset();
    repository.state.workingTreeChanges = ['a', 'other'].map(name => change(`/synthetic/repo/src/${name}.ts`));
    const started = deferred();
    const release = deferred();
    onStatistics = async () => {
      started.resolve();
      await release.promise;
      throw new Error('Synthetic background statistics failure');
    };
    try {
      await api.refresh();
      await started.promise;
      const candidates = state().files;
      assert.deepEqual(paths(), ['src/a.ts', 'src/other.ts']);
      assert.deepEqual(candidates.map(row => row.statisticsPending), [false, true]);
      assert.equal(candidates[0].insertions, 2);
      release.resolve();
      await statisticsPublished();
      assert.deepEqual(state().files, candidates.map(({ id, path, visible }) => ({ id, path, visible, statisticsPending: false })));
      assert.match(state().filesError ?? '', /statistics could not be loaded/);
      assert.equal(state().busy, false);

      onStatistics = async () => undefined;
      await api.refresh();
      await statisticsPublished();
      assert.equal(state().filesError, undefined);
      assert.deepEqual(paths(), ['src/a.ts', 'src/other.ts']);
      assert.ok(state().files.every(row => row.insertions === 2 && row.deletions === 1));
      assert.deepEqual(errors, []);
    } finally {
      release.resolve();
      await statisticsFinished();
    }
  });
});
