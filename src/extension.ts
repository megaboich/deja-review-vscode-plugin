import * as vscode from 'vscode';
import { resolveAnchor } from './anchor';
import { ReviewArchives, type ReviewArchive } from './archive';
import { ReviewDashboard, type DashboardAction, type DashboardState } from './dashboard';
import { captureContext, type CapturedContext } from './editorContext';
import { GitResources, type Repository } from './git';
import { isGeneralNote, parsedNotes, type ParsedComment, type ParsedNote, type ResolvedAnchor, type ReviewComment } from './model';
import { parse } from './parser';
import { ReviewStore } from './store';
import { appendComment, appendGeneralNote, deleteComment, editComment, rewriteLinesBatch } from './writer';

interface SavedEntry {
  comment: ParsedNote;
  snapshot: string;
  repo: Repository;
  resolved?: ResolvedAnchor;
}

interface Entry extends SavedEntry {
  comment: ParsedComment;
}

type RefreshProjection = {
  text: string | undefined;
  parsed: ReturnType<typeof parse>;
  entries: Entry[];
  files: Awaited<ReturnType<GitResources['filesToReview']>>;
  filesError: string | undefined;
  archives: ReviewArchive[];
  historyError: string | undefined;
  staleBase: boolean;
  resources: Map<string, vscode.Uri[]>;
};

interface DashboardEditor {
  id: string;
  repo: Repository;
  store: ReviewStore;
  entry?: SavedEntry;
  snapshot: string;
  body: string;
  error?: string;
}

interface Note extends vscode.Comment {
  entry: Entry;
  parent: vscode.CommentThread;
}

function sideLabel(comment: ReviewComment): string {
  let side = 'Document';
  switch (comment.side) {
    case 'left':
      side = 'Left / Original';
      break;
    case 'right':
      side = 'Right / Modified';
      break;
  }
  return `${side} (${comment.origin})`;
}

function isNativeNote(note: vscode.Comment | undefined): note is Note {
  return !!note && 'entry' in note && 'parent' in note;
}

function label(comment: ReviewComment): string {
  const pair = comment.comparison;
  return `Captured: ${sideLabel(comment)} - ${comment.path}:${comment.startLine}-${comment.endLine}`
    + (pair ? ` | ${pair.left.path} (${pair.left.origin}) -> ${pair.right.path} (${pair.right.origin})` : '');
}

function markdown(entry: Entry): vscode.MarkdownString {
  const value = new vscode.MarkdownString();
  value.appendText(label(entry.comment));
  const pair = entry.comment.comparison;
  if (pair) {
    value.appendText(`\n\nComparison: ${pair.left.path} (${pair.left.origin}) -> ${pair.right.path} (${pair.right.origin})`);
  }
  value.appendMarkdown(`\n\n${entry.comment.body}`);
  // Review prose is user-editable. Never trust embedded commands or HTML.
  value.isTrusted = false;
  value.supportHtml = false;
  return value;
}

function range(anchor: ResolvedAnchor | ReviewComment): vscode.Range {
  return new vscode.Range(anchor.startLine - 1, 0, anchor.endLine - 1, 0);
}

class ReviewExtension implements vscode.Disposable {
  readonly git = new GitResources();
  private controller = vscode.comments.createCommentController('dejareview', 'DejaReview Notes');
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('dejareview');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private readonly output = vscode.window.createOutputChannel('DejaReview');
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: { contentText: ' [review]', margin: '0 0 0 1em', color: new vscode.ThemeColor('editorInfo.foreground') },
    overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly dashboard = new ReviewDashboard(action => this.dispatchDashboard(action));

  private async dispatchDashboard(action: DashboardAction): Promise<void> {
    try {
      if (action.repoKey !== this.repo?.rootUri.toString() || this.fileActionBusy || this.copyInProgress || this.store?.busy) {
        return;
      }
      switch (action.type) {
        case 'input':
        case 'saveEdit':
        case 'cancelEdit':
          await this.dashboardInput(action);
          return;
      }
      if (this.dashboardEditor || this.editorBusy) {
        return;
      }
      switch (action.type) {
        case 'addGeneral':
          await this.openDashboardEditor();
          return;
        case 'copy':
          await this.handoff(action.repoKey);
          return;
        case 'openFile':
          await this.openFile(action.fileId);
          return;
        case 'stageFile':
        case 'revertFile':
          await this.changeFile(action.fileId, action.type === 'revertFile');
          return;
        case 'restore':
          if (!this.hasFeedback && this.archives.some(archive => archive.id === action.archiveId)) {
            await this.restore(action.archiveId, action.repoKey);
          }
          return;
        case 'open':
        case 'edit':
        case 'delete':
          await this.dashboardNote(action);
      }
    } catch (error) {
      this.error(error);
    }
  }

  private async dashboardNote(action: Extract<DashboardAction, { noteId: string }>): Promise<void> {
    if (!this.hasFeedback) {
      return;
    }
    const entry = this.cardEntries.get(action.noteId);
    if (!entry || !this.savedEntries.includes(entry)) {
      return;
    }
    switch (action.type) {
      case 'delete': {
        const choice = await vscode.window.showWarningMessage(
          isGeneralNote(entry.comment) ? 'Delete General Review Note?'
            : `Delete Review Note on ${entry.comment.path}:${entry.comment.startLine}?`,
          { modal: true }, 'Delete Review Note');
        const current = this.cardEntries.get(action.noteId);
        if (choice !== 'Delete Review Note' || !current || !this.savedEntries.includes(current)) {
          return;
        }
        if (current.repo.rootUri.toString() !== action.repoKey || current.snapshot !== entry.snapshot
          || current.comment.index !== entry.comment.index || current.comment.rawBlock !== entry.comment.rawBlock) {
          return;
        }
        if (this.dashboardEditor || this.editorBusy || this.fileActionBusy || this.copyInProgress || this.store?.busy) {
          return;
        }
        await this.remove(entry);
        return;
      }
      case 'edit':
        await this.openDashboardEditor(entry);
        return;
      case 'open':
        if (isGeneralNote(entry.comment)) {
          await this.openDashboardEditor(entry);
        } else {
          await this.goto({ ...entry, comment: entry.comment });
        }
    }
  }
  private archives: ReviewArchive[] = [];
  private hasFeedback = false;
  private historyError?: string;
  private readonly subscriptions: vscode.Disposable[] = [];
  private repoSubscriptions: vscode.Disposable[] = [];
  private store?: ReviewStore;
  private repo?: Repository;
  private entries: Entry[] = [];
  private savedEntries: SavedEntry[] = [];
  private cardEntries = new Map<string, SavedEntry>();
  private dashboardEditor?: DashboardEditor;
  private editorSequence = 0;
  private editorBusy = false;
  private cardSequence = 0;
  private noteError?: string;
  private files: DashboardState['files'] = [];
  private filesError?: string;
  private filesGeneration = 0;
  private fileActionBusy = false;
  private threads: vscode.CommentThread[] = [];
  private readonly drafts = new Map<vscode.CommentThread, CapturedContext>();
  private generation = 0;
  private refreshing?: Promise<void>;
  private publishedGeneration = 0;
  private copyInProgress = false;
  private submitting = new Set<vscode.CommentThread>();
  private readonly cancelledDrafts = new WeakSet<vscode.CommentThread>();
  private readonly saving = new Set<Note>();
  private readonly editSessions = new WeakMap<Note, object>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private warnedBase?: string;
  private lastEditor = vscode.window.activeTextEditor;
  private lastTab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configureController();
    this.status.command = 'dejareview.dashboard.focus';
    this.status.tooltip = 'Open review notes';
    this.registerCommand('addComment', (uri?: vscode.Uri, selection?: vscode.Range) => this.add(uri, selection));
    this.registerCommand('submitComment', (reply: vscode.CommentReply) => this.submit(reply));
    this.registerCommand('cancelDraft', (arg: vscode.CommentThread | vscode.CommentReply) => {
      const thread = 'thread' in arg ? arg.thread : arg;
      this.cancelDraft(thread);
    });
    this.registerCommand('editComment', (note: Note) => this.edit(note));
    this.registerCommand('saveComment', (note: Note) => this.save(note));
    this.registerCommand('cancelEdit', (note: Note) => this.cancelEdit(note));
    this.registerCommand('deleteComment', (arg: Entry | Note) => this.remove(this.entry(arg)));
    this.registerCommand('gotoCode', (entry: Entry) => this.goto(entry));
    this.registerCommand('openComparison', (arg: Entry | Note | vscode.CommentThread) => {
      if ('comments' in arg) {
        const note = arg.comments[0];
        return this.goto(this.entry(isNativeNote(note) ? note : undefined), true);
      }
      return this.goto(this.entry(arg), true);
    });
    this.registerCommand('copyForAgent', () => this.handoff());
    this.registerCommand('restoreArchive', (id?: string, repoKey?: string) => this.restore(id, repoKey));
    this.registerCommand('refresh', () => this.refresh());
    this.registerCommand('reanchorAll', () => this.reanchor());
    this.registerCommand('suggestGitignore', () => this.gitignore());
    this.subscriptions.push(
      vscode.window.registerWebviewViewProvider('dejareview.dashboard', this.dashboard),
      this.git.onDidChangeRepositories(() => this.schedule(true)),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
          this.lastEditor = editor;
          this.lastTab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        }
        this.schedule();
      }),
      vscode.window.onDidChangeTextEditorSelection(event => {
        this.lastEditor = event.textEditor;
        this.lastTab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidOpenTextDocument(() => this.schedule()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule(true)),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() !== this.store?.uri.toString()) {
          this.schedule();
        }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('dejareview')) {
          this.schedule();
        }
      }),
    );
  }

  private registerCommand<Args extends unknown[]>(name: string, run: (...args: Args) => unknown): void {
    this.subscriptions.push(vscode.commands.registerCommand(`dejareview.${name}`, async (...args: Args) => {
      try {
        return await run(...args);
      } catch (error) {
        this.error(error);
      }
    }));
  }

  private configureController(): void {
    this.controller.options = {
      prompt: 'Write review feedback. Use the shortcut to capture context before typing.',
      placeHolder: 'What should change, and why?',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: async (document, token) => {
        if (this.copyInProgress || !['file', 'git'].includes(document.uri.scheme)) {
          return [];
        }
        try {
          const repo = await this.git.repositoryFor(document.uri);
          if (!repo || token.isCancellationRequested || !await this.git.resource(document.uri, repo)) {
            return [];
          }
          return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
        } catch {
          return [];
        }
      },
    };
  }

  async initialize(): Promise<void> {
    await this.git.initialize();
    await this.refresh();
  }

  private error(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(error instanceof Error ? error.stack ?? message : message);
    console.error('DejaReview:', error);
    void vscode.window.showErrorMessage(`DejaReview: ${message}`);
  }

  private updateDashboard(): void {
    // Reuse handles only while the exact saved projection remains unchanged.
    const previous = new Map([...this.cardEntries].map(([id, entry]) => [entry.comment.startOffset, { id, entry }]));
    const cardEntries = new Map<string, SavedEntry>();
    for (const entry of this.savedEntries) {
      const old = previous.get(entry.comment.startOffset);
      let id: string;
      if (old && old.entry.repo.rootUri.toString() === entry.repo.rootUri.toString()
        && old.entry.snapshot === entry.snapshot && old.entry.comment.rawBlock === entry.comment.rawBlock) {
        id = old.id;
      } else {
        this.cardSequence++;
        id = String(this.cardSequence);
      }
      cardEntries.set(id, entry);
    }
    this.cardEntries = cardEntries;

    const notes: DashboardState['notes'] = [];
    for (const [id, entry] of this.cardEntries) {
      const preview = entry.comment.body.split(/\r\n|\r|\n/, 2).join('\n').slice(0, 320);
      if (isGeneralNote(entry.comment)) {
        notes.push({ id, general: true, preview });
        continue;
      }
      notes.push({
        id,
        path: entry.comment.path,
        startLine: entry.resolved?.startLine ?? entry.comment.startLine,
        endLine: entry.resolved?.endLine ?? entry.comment.endLine,
        preview,
        stale: !entry.resolved,
        comparison: !!entry.comment.comparison,
      });
    }

    let editor: DashboardState['editor'];
    const session = this.dashboardEditor;
    if (session) {
      editor = {
        id: session.id,
        repoKey: session.repo.rootUri.toString(),
        title: session.entry ? 'Edit Review Note' : 'Add General Review Note',
        body: session.body,
        error: session.error,
      };
    }

    this.dashboard.update({
      repoKey: this.repo?.rootUri.toString(),
      files: this.files,
      filesError: this.filesError,
      hasFeedback: this.hasFeedback,
      commentCount: this.savedEntries.length,
      notes,
      noteError: this.noteError,
      editor,
      busy: this.editorBusy || this.fileActionBusy || this.copyInProgress || !!this.store?.busy,
      archives: this.archives,
      error: this.historyError,
    });
  }

  private entry(arg: Entry | Note | undefined): Entry {
    const entry = arg && ('entry' in arg ? arg.entry : arg);
    if (!entry?.comment) {
      throw new Error('Choose a review note in the editor or review view.');
    }
    return entry;
  }

  private current(text: string, entry: Entry): ParsedComment;
  private current(text: string, entry: SavedEntry): ParsedNote;
  private current(text: string, entry: SavedEntry): ParsedNote {
    const parsed = parse(text);
    if (text === entry.snapshot) {
      const match = parsedNotes(parsed).find(note => note.startOffset === entry.comment.startOffset);
      if (match?.rawBlock === entry.comment.rawBlock) {
        return match;
      }
    }
    // Never apply an old action to a different duplicate or changed comment.
    const matches = parsedNotes(parsed).filter(comment => comment.rawBlock === entry.comment.rawBlock);
    const oldMatches = parsedNotes(parse(entry.snapshot)).filter(comment => comment.rawBlock === entry.comment.rawBlock);
    if (matches.length !== 1 || oldMatches.length !== 1) {
      throw new Error('This review note changed on disk. Refresh and select it again.');
    }
    return matches[0];
  }

  private requireFinishedDashboardEditor(): void {
    if (this.dashboardEditor || this.editorBusy) {
      throw new Error('Save or cancel the open dashboard Review Note before copying or recovering a review.');
    }
  }

  private async openDashboardEditor(entry?: SavedEntry): Promise<void> {
    if (this.dashboardEditor || this.editorBusy || this.copyInProgress || this.fileActionBusy || this.store?.busy) {
      return;
    }
    const repo = this.repo;
    const store = this.store;
    if (!repo || !store) {
      throw new Error('Open a local Git project folder to add Review Notes.');
    }

    this.editorBusy = true;
    this.updateDashboard();
    try {
      if (await this.git.workspaceRepository() !== repo) {
        throw new Error('The opened project folder changed. Refresh and retry.');
      }
      const snapshot = await store.read() ?? '';
      if (this.disposed || this.store !== store || this.repo !== repo || this.copyInProgress || this.fileActionBusy
        || store.busy || vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== repo.rootUri.toString()) {
        throw new Error('The opened project folder changed or is busy. Refresh and retry.');
      }
      const current = entry ? this.current(snapshot, entry) : undefined;
      this.dashboardEditor = {
        id: String(++this.editorSequence), repo, store, snapshot,
        entry: current ? { comment: current, repo, snapshot } : undefined,
        body: current?.body ?? '',
      };
    } finally {
      this.editorBusy = false;
      this.updateDashboard();
    }
  }

  private async dashboardInput(action: Extract<DashboardAction, { editorId: string }>): Promise<void> {
    const session = this.dashboardEditor;
    if (!session || action.editorId !== session.id || action.repoKey !== session.repo.rootUri.toString()
      || this.editorBusy || this.copyInProgress || this.fileActionBusy || session.store.busy) {
      return;
    }
    // Cancellation can release a stranded old-folder session, but never writes into another folder.
    if (action.type === 'cancelEdit') {
      this.dashboardEditor = undefined;
      this.updateDashboard();
      this.schedule();
      return;
    }
    if (typeof action.body !== 'string') {
      return;
    }
    if (action.type === 'input' && vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== session.repo.rootUri.toString()) {
      return;
    }
    if (action.type === 'saveEdit' || action.body !== session.body) {
      session.error = undefined;
    }
    session.body = action.body;
    if (action.type === 'input') {
      this.updateDashboard();
      return;
    }
    if (action.type !== 'saveEdit') {
      return;
    }

    const body = action.body;
    const validate = (): void => {
      if (this.disposed || this.dashboardEditor !== session || this.repo !== session.repo || this.store !== session.store
        || this.copyInProgress || this.fileActionBusy
        || vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== session.repo.rootUri.toString()) {
        throw new Error('The project folder changed. Cancel this Review Note and return to its original folder.');
      }
    };
    this.editorBusy = true;
    this.updateDashboard();
    try {
      validate();
      if (!body.trim()) {
        throw new Error('Enter a Review Note before saving.');
      }
      if (await this.git.workspaceRepository() !== session.repo) {
        throw new Error('No Git repository is available for this project folder.');
      }
      validate();
      let unchanged = false;
      const saved = await session.store.mutate(text => {
        validate();
        if (!session.entry && text !== session.snapshot) {
          throw new Error('Saved Review Notes changed. Cancel and reopen the general Review Note to retry.');
        }
        const next = session.entry
          ? editComment(text, this.current(text, session.entry), body)
          : appendGeneralNote(text, body, session.repo.state.HEAD?.commit?.slice(0, 12));
        unchanged = next === text;
        return next;
      }, async () => { validate(); }, validate);
      if (saved || unchanged) {
        this.dashboardEditor = undefined;
        await this.refresh();
        if (!session.entry) {
          void this.offerGitignore(session.repo, session.store).catch(error => this.error(error));
        }
      }
    } catch (error) {
      session.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.editorBusy = false;
      this.updateDashboard();
    }
  }

  private schedule(invalidateFiles = false): void {
    if (this.disposed) {
      return;
    }
    this.generation++;
    if (invalidateFiles) {
      this.filesGeneration++;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch(error => this.error(error));
    }, 300);
  }

  private async useRepository(repo: Repository): Promise<void> {
    if (this.disposed || vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== repo.rootUri.toString()) {
      throw new Error('The opened project folder changed. Refresh and retry.');
    }
    if (this.repo?.rootUri.toString() === repo.rootUri.toString()) {
      return;
    }
    if (this.fileActionBusy || this.copyInProgress || this.store?.busy) {
      throw new Error('Wait for the current review operation to finish.');
    }
    if (this.dashboardEditor || this.editorBusy || this.drafts.size || this.threads.some(thread => thread.comments.some(note => note.mode === vscode.CommentMode.Editing))) {
      throw new Error('Finish or cancel open review drafts before switching repositories.');
    }

    this.generation++;
    this.store?.dispose();
    this.repoSubscriptions.forEach(item => item.dispose());
    this.repo = repo;
    this.store = new ReviewStore(repo, new ReviewArchives(this.context.globalStorageUri, repo.rootUri));
    this.entries = [];
    this.savedEntries = [];
    this.files = [];
    this.filesError = undefined;
    this.archives = [];
    this.hasFeedback = false;
    this.historyError = undefined;
    this.noteError = undefined;
    this.updateDashboard();
    this.repoSubscriptions = [
      this.store.onDidChange(() => this.schedule(true)),
      this.store.onDidChangeBusy(() => {
        this.updateDashboard();
        if (!this.store?.busy) {
          this.schedule();
        }
      }),
      repo.state.onDidChange(() => this.schedule(true)),
    ];
    this.warnedBase = undefined;
  }

  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.generation++;
    this.filesGeneration++;
    if (!this.refreshing) {
      // All callers await the latest requested projection, not an obsolete pass
      // abandoned by a watcher or startup discovery notification.
      this.refreshing = this.drainRefresh();
    }
    await this.refreshing;
  }

  private async drainRefresh(): Promise<void> {
    try {
      let generation: number;
      do {
        generation = this.generation;
        await this.refreshProjection();
      } while (!this.disposed && generation !== this.generation);
    } finally {
      this.refreshing = undefined;
    }
  }

  private async refreshProjection(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = this.generation;
    const filesGeneration = this.filesGeneration;
    const folderKey = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    const currentRequest = (): boolean => !this.disposed && generation === this.generation
      && filesGeneration === this.filesGeneration
      && folderKey === vscode.workspace.workspaceFolders?.[0]?.uri.toString();

    const workspaceRepo = await this.git.workspaceRepository();
    if (!currentRequest()) {
      return;
    }
    if (workspaceRepo?.rootUri.toString() !== this.repo?.rootUri.toString()) {
      if (!await this.transitionRefreshScope(workspaceRepo)) {
        return;
      }
      if (!currentRequest()) {
        return;
      }
    }
    if (!this.store || !this.repo) {
      this.historyError = vscode.workspace.workspaceFolders?.length
        ? 'No Git repository is available for the opened project folder.' : undefined;
      this.updateDashboard();
      return;
    }

    const store = this.store;
    const repo = this.repo;
    const loaded = await store.load();
    if (!currentRequest() || store !== this.store || repo !== this.repo) {
      return;
    }
    const projection = await this.computeRefreshProjection(store, repo, loaded);

    // Publish only the request and scope that produced this complete projection.
    if (!currentRequest() || store !== this.store || repo !== this.repo) {
      return;
    }
    this.publishProjection(projection, store, repo, generation);
    await vscode.commands.executeCommand('setContext', 'dejareview.hasFeedback', !!projection.text?.trim());
    if (!currentRequest() || store !== this.store || repo !== this.repo) {
      return;
    }
    this.status.text = `$(comment) ${this.savedEntries.length}`;
    if (projection.text !== undefined) {
      this.status.show();
    } else {
      this.status.hide();
    }
  }

  /** A new repository restarts the drain; removing the scope continues this pass. */
  private async transitionRefreshScope(workspaceRepo: Repository | undefined): Promise<boolean> {
    if (this.dashboardEditor || this.editorBusy || this.fileActionBusy || this.copyInProgress || this.store?.busy || this.drafts.size
      || this.threads.some(thread => thread.comments.some(note => note.mode === vscode.CommentMode.Editing))) {
      this.historyError = 'The project folder changed. Finish open review edits before switching folders.';
      this.updateDashboard();
      return false;
    }
    if (workspaceRepo) {
      await this.useRepository(workspaceRepo);
      return false;
    }

    this.store?.dispose();
    this.store = undefined;
    this.repo = undefined;
    this.repoSubscriptions.forEach(item => item.dispose());
    this.repoSubscriptions = [];
    this.threads.forEach(thread => thread.dispose());
    this.threads = [];
    this.entries = [];
    this.savedEntries = [];
    this.files = [];
    this.filesError = undefined;
    this.archives = [];
    this.hasFeedback = false;
    this.diagnostics.clear();
    this.status.hide();
    this.noteError = undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decoration, []);
    }
    await vscode.commands.executeCommand('setContext', 'dejareview.hasFeedback', false);
    return true;
  }

  private async computeRefreshProjection(
    store: ReviewStore,
    repo: Repository,
    { text, parsed }: Awaited<ReturnType<ReviewStore['load']>>,
  ): Promise<RefreshProjection> {
    let archives: ReviewArchive[] = [];
    let historyError: string | undefined;
    if (!text?.trim()) {
      try {
        archives = await store.archives.list();
      } catch (error) {
        historyError = `Cannot load review archives: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const staleBase = !!parsed.base && !!repo.state.HEAD?.commit && !repo.state.HEAD.commit.startsWith(parsed.base);
    const contents = new Map<string, Promise<string>>();
    const entries = await Promise.all(parsed.comments.map(async comment => {
      const key = `${comment.origin}:${comment.path}`;
      let pendingContent = contents.get(key);
      if (!pendingContent) {
        pendingContent = this.git.content(comment, repo);
        contents.set(key, pendingContent);
      }
      let resolved: ResolvedAnchor | undefined;
      try {
        const content = await pendingContent;
        if (!(staleBase && ['head', 'staged'].includes(comment.origin))) {
          resolved = resolveAnchor(comment, content, vscode.workspace.getConfiguration('dejareview').get('searchRadius', 50));
        }
      } catch {
        // Missing revisions and deleted anchors remain as stale cards.
      }
      return { comment, resolved, repo, snapshot: text ?? '' };
    }));

    let files: Awaited<ReturnType<GitResources['filesToReview']>> = [];
    let filesError: string | undefined;
    try {
      files = await this.git.filesToReview(repo, new Set(parsed.comments.map(comment => comment.path)),
        [this.context.globalStorageUri]);
    } catch {
      filesError = 'Files to Review could not be refreshed. Refresh and retry.';
    }

    const resources = new Map<string, vscode.Uri[]>();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isClosed || !['file', 'git'].includes(doc.uri.scheme)) {
        continue;
      }
      try {
        const resource = await this.git.resource(doc.uri, repo);
        if (resource) {
          const key = `${resource.origin}:${resource.path}`;
          resources.set(key, [...(resources.get(key) ?? []), doc.uri]);
        }
      } catch {
        // Unrelated or unsupported virtual documents are not review targets.
      }
    }
    return { text, parsed, entries, files, filesError, archives, historyError, staleBase, resources };
  }

  private publishProjection(projection: RefreshProjection, store: ReviewStore, repo: Repository, generation: number): void {
    const { text, parsed, entries, files, filesError, archives, historyError, staleBase, resources } = projection;
    this.entries = entries;
    this.publishedGeneration = generation;
    this.savedEntries = [...entries, ...parsed.generalNotes.map(comment => ({ comment, repo, snapshot: text ?? '' }))]
      .sort((a, b) => a.comment.startOffset - b.comment.startOffset);
    this.files = files.map(file => ({ ...file, id: file.path }));
    this.filesError = filesError;
    this.archives = archives;
    this.hasFeedback = !!text?.trim();
    this.historyError = historyError;
    this.noteError = parsed.diagnostics.length
      ? `${parsed.diagnostics.length} malformed block(s). Open REVIEW-NOTES.md to fix; all raw feedback can still be copied.` : undefined;
    this.updateDashboard();

    this.diagnostics.clear();
    this.diagnostics.set(store.uri, parsed.diagnostics.map(item => {
      const range = new vscode.Range(item.line - 1, 0, item.line - 1, 1000);
      return new vscode.Diagnostic(range, item.message, vscode.DiagnosticSeverity.Warning);
    }));
    if (staleBase && this.warnedBase !== parsed.base) {
      this.warnedBase = parsed.base;
      void vscode.window.showWarningMessage('Review base changed. HEAD and index review notes are marked stale; their captured feedback is preserved.');
    }
    this.publishEditors(entries, resources, repo);
  }

  private publishEditors(entries: Entry[], resources: Map<string, vscode.Uri[]>, repo: Repository): void {
    // Preserve live editor input and collapse state while reconciling saved projections.
    const old = [...this.threads];
    const next: vscode.CommentThread[] = [];
    for (const entry of entries) {
      if (!entry.resolved) {
        continue;
      }
      const uris = resources.get(`${entry.comment.origin}:${entry.comment.path}`) ?? [this.git.uri(entry.comment, repo)];
      for (const uri of new Map(uris.map(uri => [uri.toString(), uri])).values()) {
        const index = old.findIndex(thread => {
          const note = thread.comments[0];
          return thread.uri.toString() === uri.toString() && isNativeNote(note) && note.entry.comment.index === entry.comment.index
            && note.entry.comment.rawBlock === entry.comment.rawBlock && note.entry.repo.rootUri.toString() === repo.rootUri.toString();
        });
        let thread: vscode.CommentThread;
        if (index >= 0) {
          thread = old.splice(index, 1)[0];
        } else {
          thread = this.controller.createCommentThread(uri, range(entry.resolved), []);
          thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        }
        if (!thread.comments.some(note => note.mode === vscode.CommentMode.Editing)) {
          thread.range = range(entry.resolved);
          thread.label = label(entry.comment);
          thread.canReply = false;
          thread.contextValue = entry.comment.comparison ? 'comparison' : 'saved';
          const body = new vscode.MarkdownString(entry.comment.body);
          body.isTrusted = false;
          const note: Note = {
            body,
            mode: vscode.CommentMode.Preview,
            author: { name: 'Review' },
            contextValue: 'saved',
            entry,
            parent: thread,
          };
          thread.comments = [note];
        }
        next.push(thread);
      }
    }
    for (const thread of old) {
      if (thread.comments.some(note => note.mode === vscode.CommentMode.Editing)) {
        next.push(thread);
      } else {
        thread.dispose();
      }
    }
    this.threads = next;
    for (const editor of vscode.window.visibleTextEditors) {
      const options: vscode.DecorationOptions[] = [];
      if (vscode.workspace.getConfiguration('dejareview').get<string>('decorationStyle', 'badge') !== 'none') {
        for (const entry of entries) {
          const matching = resources.get(`${entry.comment.origin}:${entry.comment.path}`)?.some(uri => uri.toString() === editor.document.uri.toString());
          if (entry.resolved && matching) {
            const line = Math.min(entry.resolved.startLine - 1, editor.document.lineCount - 1);
            options.push({ range: editor.document.lineAt(line).range, hoverMessage: markdown(entry) });
          }
        }
      }
      editor.setDecorations(this.decoration, options);
    }
  }

  private async add(uri?: vscode.Uri, selection?: vscode.Range): Promise<void> {
    if (this.copyInProgress) {
      throw new Error('Wait until copying finishes before adding review notes.');
    }
    const editor = uri ? vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString()) : this.lastEditor;
    const source = uri ?? editor?.document.uri;
    const selected = selection ?? editor?.selection;
    if (!source || !selected) {
      throw new Error('Focus a text editor and select a line to add a review note to.');
    }
    const input = uri ? vscode.window.tabGroups.activeTabGroup.activeTab?.input : this.lastTab;
    const captured = await captureContext(this.git, source, selected, {
      tabInput: input instanceof vscode.TabInputText || input instanceof vscode.TabInputTextDiff ? input : undefined,
    });
    if (!captured || this.copyInProgress) {
      return;
    }
    await this.useRepository(captured.repo);
    if (this.copyInProgress || !this.store) {
      return;
    }
    this.assertScope(captured.repo, this.store);
    const thread = this.controller.createCommentThread(source, range(captured.comment), []);
    thread.label = label(captured.comment);
    thread.contextValue = 'draft';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = true;
    this.drafts.set(thread, captured);
  }

  private async submit(reply: vscode.CommentReply): Promise<void> {
    if (!reply?.thread || !reply.text?.trim()) {
      return;
    }
    if (this.copyInProgress || this.submitting.has(reply.thread) || this.cancelledDrafts.has(reply.thread)) {
      return;
    }
    const thread = reply.thread;
    const body = reply.text;
    if (thread.comments.length) {
      throw new Error('Replies are not supported. Add a separate review note.');
    }

    this.submitting.add(thread);
    try {
      const captured = this.drafts.get(thread) ?? await captureContext(
        this.git, thread.uri, thread.range ?? new vscode.Range(0, 0, 0, 0),
        { inferFromOpenTabs: true, rangeSemantics: 'thread' },
      );
      if (!captured || this.cancelledDrafts.has(thread)) {
        return;
      }
      await this.useRepository(captured.repo);
      if (this.repo?.rootUri.toString() !== captured.repo.rootUri.toString() || !this.store) {
        throw new Error('Repository changed while capturing feedback. Retry the submission.');
      }
      const store = this.store;
      const repo = captured.repo;
      const usesBase = (captured.comment.comparison
        ? [captured.comment.comparison.left, captured.comment.comparison.right] : [captured.comment])
        .some(resource => resource.origin === 'head' || resource.origin === 'staged');
      let revisionChanged = false;
      const listener = repo.state.onDidChange(() => {
        revisionChanged = true;
      });
      const validateInput = (): void => {
        this.assertScope(repo, store);
        if (this.copyInProgress || this.cancelledDrafts.has(thread) || !this.submitting.has(thread)) {
          throw new Error('This Review Note submission was cancelled.');
        }
        if (revisionChanged || (usesBase && repo.state.HEAD?.commit !== captured.baseCommit)) {
          throw new Error('The Git revision changed during submission. Retry the Review Note.');
        }
      };
      let saved: boolean;
      try {
        const validate = async (): Promise<void> => {
          validateInput();
          await captured.validate();
          validateInput();
        };
        saved = await store.mutate(text => {
          validateInput();
          return appendComment(text, { ...captured.comment, body }, captured.baseCommit?.slice(0, 12));
        }, validate, validateInput);
      } finally {
        listener.dispose();
      }
      if (!saved) {
        return;
      }

      // Publication succeeded. A late Git event or scope change cannot make
      // this draft retryable: doing so would append the same note again.
      const cancelled = this.cancelledDrafts.has(thread);
      if (!cancelled) {
        this.cancelDraft(thread);
      }
      const currentScope = (): boolean => !this.disposed && this.repo === repo && this.store === store
        && vscode.workspace.workspaceFolders?.[0]?.uri.toString() === repo.rootUri.toString();
      if (cancelled || !currentScope()) {
        return;
      }

      try {
        await this.refresh();
      } catch (error) {
        if (currentScope()) {
          const message = error instanceof Error ? error.message : String(error);
          void vscode.window.showWarningMessage(`Review Note was saved, but its display could not be refreshed. Refresh to see it. ${message}`);
        }
        return;
      }
      if (!currentScope()) {
        return;
      }
      const latest = [...this.threads].reverse().find(thread => {
        const note = thread.comments[0];
        return isNativeNote(note) && note.entry.comment.body.trim() === body.trim();
      });
      if (latest) {
        latest.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      }
      void this.offerGitignore(repo, store).catch(error => this.error(error));
    } finally {
      this.submitting.delete(thread);
    }
  }

  private cancelDraft(thread: vscode.CommentThread): void {
    this.cancelledDrafts.add(thread);
    this.drafts.delete(thread);
    thread.dispose();
    this.schedule();
  }

  private edit(note: Note): void {
    if (this.copyInProgress || this.saving.has(note)) {
      return;
    }
    this.entry(note);
    this.editSessions.set(note, {});
    note.mode = vscode.CommentMode.Editing;
    note.contextValue = 'editing';
    note.parent.comments = [note];
  }

  private async save(note: Note): Promise<void> {
    const entry = this.entry(note);
    if (this.copyInProgress || this.saving.has(note) || note.mode !== vscode.CommentMode.Editing) {
      return;
    }
    const body = typeof note.body === 'string' ? note.body : note.body.value;
    const store = this.storeFor(entry);
    const session = this.editSessions.get(note);
    if (!session) {
      return;
    }
    const validateSession = (): void => {
      this.assertScope(entry.repo, store);
      if (this.copyInProgress || note.mode !== vscode.CommentMode.Editing
        || this.editSessions.get(note) !== session || !note.parent.comments.includes(note)) {
        throw new Error('This Review Note edit was cancelled or replaced.');
      }
    };
    const validate = (): void => {
      validateSession();
      if ((typeof note.body === 'string' ? note.body : note.body.value) !== body) {
        throw new Error('Review Note input changed while saving. Your newer input is retained; save again to retry.');
      }
    };
    this.saving.add(note);
    try {
      let unchanged = false;
      let savedEntry: Entry | undefined;
      const saved = await store.mutate(text => {
        validate();
        const current = this.current(text, entry);
        const next = editComment(text, current, body);
        const comment = parse(next).comments.find(comment => comment.startOffset === current.startOffset);
        if (!comment) {
          throw new Error('Cannot locate the edited Review Note. Refresh and retry.');
        }
        savedEntry = { ...entry, comment, snapshot: next };
        unchanged = next === text;
        return next;
      }, async () => { validate(); }, validate);
      validateSession();
      if (saved || unchanged) {
        // Rename may already have published while the reviewer typed more. Bind
        // retries to those exact bytes without replacing the live editor body.
        if (savedEntry) {
          note.entry = savedEntry;
        }
        if ((typeof note.body === 'string' ? note.body : note.body.value) !== body) {
          this.schedule();
          throw new Error('The earlier Review Note body was saved. Your newer input is retained; save again to apply it.');
        }
        note.mode = vscode.CommentMode.Preview;
        note.contextValue = 'saved';
        note.parent.comments = [note];
        this.editSessions.delete(note);
        await this.refresh();
      }
    } finally {
      this.saving.delete(note);
    }
  }

  private cancelEdit(note: Note): void {
    this.editSessions.delete(note);
    note.body = new vscode.MarkdownString(note.entry.comment.body);
    note.mode = vscode.CommentMode.Preview;
    note.contextValue = 'saved';
    note.parent.comments = [note];
    this.schedule();
  }

  private storeFor(entry: SavedEntry): ReviewStore {
    const store = this.store;
    if (!store) {
      throw new Error('The selected project folder changed. Select this review note again.');
    }
    this.assertScope(entry.repo, store);
    return store;
  }

  private assertScope(repo: Repository, store: ReviewStore): void {
    if (this.disposed || this.repo !== repo || this.store !== store
      || vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== repo.rootUri.toString()) {
      throw new Error('The selected project folder changed. Refresh and retry in its original folder.');
    }
  }

  private async remove(entry: SavedEntry): Promise<void> {
    if (this.copyInProgress) { return; }
    const store = this.storeFor(entry);
    const validate = (): void => {
      this.assertScope(entry.repo, store);
      if (this.copyInProgress) {
        throw new Error('Wait until copying finishes before deleting Review Notes.');
      }
    };
    await store.mutate(text => {
      validate();
      return deleteComment(text, this.current(text, entry));
    }, async () => { validate(); }, validate);
    await this.refresh();
  }

  private async openFile(id: string): Promise<void> {
    const repo = this.repo;
    const file = this.files.find(file => file.id === id);
    if (!repo || !file) { return; }
    if (vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== repo.rootUri.toString()) {
      throw new Error('The resource is outside the opened folder. Refresh and retry.');
    }
    const generation = this.filesGeneration;
    const target = vscode.Uri.joinPath(repo.rootUri, file.path).toString();
    const membership = (): string => {
      if (repo.state.untrackedChanges?.some(change => change.uri.toString() === target)) {
        return 'untracked';
      }
      const change = repo.state.workingTreeChanges?.find(change => change.uri.toString() === target);
      if (!change) {
        return '';
      }
      switch (change.status) {
        case 7:
          return 'untracked';
        case 6:
          return 'deleted';
        default:
          return 'tracked';
      }
    };
    const kind = membership();
    if (!kind) { return; }
    const valid = (): boolean => this.repo === repo && !this.copyInProgress && !this.store?.busy
      && generation === this.filesGeneration
      && vscode.workspace.workspaceFolders?.[0]?.uri.toString() === repo.rootUri.toString()
      && this.files.includes(file) && membership() === kind
      && !this.entries.some(entry => entry.comment.path === file.path);
    const uri = await this.git.validatedUri({ path: file.path, origin: 'changed' }, repo);
    if (!valid()) { return; }
    if (kind === 'untracked') {
      const document = await vscode.workspace.openTextDocument(uri);
      if (valid()) {
        await vscode.window.showTextDocument(document, { preview: true });
      }
      return;
    }
    const index = await this.git.validatedUri({ path: file.path, origin: 'staged' }, repo);
    if (!valid()) { return; }
    if (kind === 'deleted') {
      const document = await vscode.workspace.openTextDocument(index);
      if (valid()) {
        await vscode.window.showTextDocument(document, { preview: true });
      }
    } else {
      await vscode.commands.executeCommand('vscode.diff', index, uri, `${file.path} (Unstaged changes)`, { preview: true });
    }
  }

  private async changeFile(id: string, revert: boolean): Promise<void> {
    if (this.fileActionBusy || this.copyInProgress || this.store?.busy) {
      return;
    }
    const repo = this.repo;
    const file = this.files.find(file => file.id === id);
    if (!repo || !file) { return; }
    this.fileActionBusy = true;
    this.updateDashboard();
    const generation = this.filesGeneration;
    try {
      const validate = (): void => {
        if (this.disposed || this.repo !== repo || this.copyInProgress || this.store?.busy
          || this.filesGeneration !== generation || !this.files.includes(file)
          || this.entries.some(entry => entry.comment.path === file.path)) {
          throw new Error('Files to Review changed. Refresh and retry.');
        }
      };
      const notedPaths = new Set(this.entries.map(entry => entry.comment.path));
      if (revert) {
        await this.git.revertFile(repo, file.path, notedPaths, [this.context.globalStorageUri], validate, async untracked => {
          const warning = untracked
            ? `Revert ${file.path}? This untracked file will be removed and cannot be recovered by Git.`
            : `Revert ${file.path}? Its unstaged disk changes will be discarded. Staged changes will be kept.`;
          return await vscode.window.showWarningMessage(warning, { modal: true }, 'Revert File') === 'Revert File';
        });
      } else {
        await this.git.stageFile(repo, file.path, notedPaths, [this.context.globalStorageUri], validate);
      }
    } finally {
      this.fileActionBusy = false;
      this.updateDashboard();
      this.schedule(true);
    }
  }

  private async reveal(entry: Entry): Promise<void> {
    const store = this.storeFor(entry);
    const text = await store.read() ?? '';
    const comment = this.current(text, entry);
    const document = await vscode.workspace.openTextDocument(store.uri);
    this.storeFor(entry);
    if (document.isDirty || document.getText() !== text) {
      throw new Error('Review notes changed. Save and refresh before navigating.');
    }
    const position = document.positionAt(comment.startOffset);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
  }

  private async goto(entry: Entry, comparisonOnly = false): Promise<void> {
    const store = this.storeFor(entry);
    const validate = async (): Promise<void> => {
      this.current(await store.read() ?? '', entry);
      if (this.storeFor(entry) !== store || this.copyInProgress || store.busy) {
        throw new Error('Review notes changed or are busy. Refresh and retry.');
      }
    };
    await validate();
    if (!entry.resolved && !comparisonOnly) {
      await this.reveal(entry);
      return;
    }
    const pair = entry.comment.comparison;
    if (pair) {
      const [left, right] = await Promise.all([
        this.git.validatedUri(pair.left, entry.repo), this.git.validatedUri(pair.right, entry.repo),
      ]);
      await validate();
      await vscode.commands.executeCommand('vscode.diff', left, right, `${pair.left.path} <-> ${pair.right.path}`, {
        preview: true,
      } satisfies vscode.TextDocumentShowOptions);
      await validate();
      if (comparisonOnly && !vscode.workspace.getConfiguration('diffEditor').get<boolean>('renderSideBySide', true)) {
        await vscode.commands.executeCommand('toggle.diff.renderSideBySide');
        await validate();
      }
      const target = entry.comment.side === 'left' ? left : right;
      const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === target.toString());
      if (editor && entry.resolved) {
        editor.selection = new vscode.Selection(range(entry.resolved).start, range(entry.resolved).end);
        editor.revealRange(range(entry.resolved), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      } else if (entry.resolved) {
        const choice = await vscode.window.showInformationMessage('The selected comparison side is not exposed as a text editor. Open its revision separately?', 'Open Revision');
        if (choice === 'Open Revision') {
          await this.git.validatedUri(entry.comment, entry.repo);
          const document = await vscode.workspace.openTextDocument(target);
          await validate();
          await vscode.window.showTextDocument(document, { selection: range(entry.resolved), preview: false });
        }
      }
    } else {
      const document = await vscode.workspace.openTextDocument(await this.git.validatedUri(entry.comment, entry.repo));
      await validate();
      await vscode.window.showTextDocument(document, {
        selection: range(entry.resolved ?? entry.comment), preview: true,
      });
    }
  }

  private async handoff(expectedRepoKey?: string): Promise<void> {
    this.requireFinishedDashboardEditor();
    if (this.copyInProgress || this.fileActionBusy || this.store?.busy || this.submitting.size || this.saving.size) {
      return;
    }
    if (!await this.ensureWorkspaceStore()) {
      return;
    }
    const repo = this.repo;
    const store = this.store;
    if (!repo || !store || (expectedRepoKey && expectedRepoKey !== repo.rootUri.toString())) {
      return;
    }
    this.requireFinishedDashboardEditor();
    if (this.copyInProgress || this.fileActionBusy || store.busy || this.submitting.size || this.saving.size) {
      return;
    }

    const drafts = new Set(this.drafts.keys());
    const edits = new Map(this.nativeEdits().map(note => [note, typeof note.body === 'string' ? note.body : note.body.value]));
    const validate = (): void => {
      this.assertScope(repo, store);
      this.requireFinishedDashboardEditor();
      if (this.submitting.size || this.saving.size || this.fileActionBusy
        || [...this.drafts.keys()].some(thread => !drafts.has(thread))
        || this.nativeEdits().some(note => !edits.has(note)
          || edits.get(note) !== (typeof note.body === 'string' ? note.body : note.body.value))) {
        throw new Error('Review Note input changed. Finish or cancel it before copying.');
      }
    };
    this.copyInProgress = true;
    try {
      this.updateDashboard();
      await vscode.commands.executeCommand('setContext', 'dejareview.copyInProgress', true);
      validate();
      if (drafts.size || edits.size) {
        const choice = await vscode.window.showWarningMessage(
          'Unsubmitted review notes or open edits are not included. Finish them first, or explicitly discard them when copying.',
          { modal: true }, 'Copy and discard drafts', 'Finish review notes first');
        if (choice !== 'Copy and discard drafts') { return; }
      }
      validate();
      const result = await store.handoff(validate);
      if (result.status === 'copied') {
        validate();
        this.generation++;
        for (const thread of this.drafts.keys()) {
          thread.dispose();
        }
        this.drafts.clear();
        for (const thread of this.threads) {
          thread.dispose();
        }
        this.threads = [];
        // Native gutter templates are not enumerable. Keep the controller alive:
        // unsubmitted native input is not exported, but must never be destroyed.
        await this.refresh();
        void vscode.window.showInformationMessage('Review feedback copied and archived; REVIEW-NOTES.md cleared. Recover it from Recent Archives when needed.');
      } else if (result.status === 'empty') {
        void vscode.window.showInformationMessage('No review notes to copy.');
      } else if (result.status !== 'cancelled') {
        const prefix = result.clipboardCopied ? 'Feedback copied, but REVIEW-NOTES.md was not cleared.' : 'Feedback was not copied or cleared.';
        const detail = 'error' in result ? String(result.error) : 'The saved file or editor buffer changed. Save and retry.';
        void vscode.window.showWarningMessage(`${prefix} ${detail}`);
      }
    } finally {
      this.copyInProgress = false;
      this.updateDashboard();
      this.schedule();
      await vscode.commands.executeCommand('setContext', 'dejareview.copyInProgress', false);
    }
  }

  private async restore(id?: string, repoKey?: string): Promise<void> {
    this.requireFinishedDashboardEditor();
    if (this.copyInProgress || this.fileActionBusy || this.store?.busy || this.submitting.size || this.saving.size) {
      return;
    }
    if (!await this.ensureWorkspaceStore()) {
      return;
    }
    const store = this.store;
    const repo = this.repo;
    if (!store || !repo || this.copyInProgress || this.fileActionBusy || store.busy
      || (repoKey && repoKey !== repo.rootUri.toString())) {
      return;
    }
    const validate = (): void => {
      this.assertScope(repo, store);
      this.requireFinishedDashboardEditor();
      if (this.fileActionBusy || this.submitting.size || this.saving.size || this.drafts.size || this.nativeEdits().length) {
        throw new Error('Finish or cancel open drafts and edits before recovering a review.');
      }
    };
    validate();
    if (!id) {
      const archives = await store.archives.list();
      validate();
      if (this.copyInProgress || store.busy) { return; }
      const choice = await vscode.window.showQuickPick(archives.map(archive => ({
        label: new Date(archive.createdAt).toLocaleString(),
        description: `${archive.commentCount} review note${archive.commentCount === 1 ? '' : 's'}`,
        id: archive.id,
      })), { placeHolder: archives.length ? 'Recover a recent review batch' : 'No archived reviews for this repository' });
      id = choice?.id;
    }
    if (!id) { return; }
    validate();
    if (this.copyInProgress || store.busy) { return; }
    this.copyInProgress = true;
    try {
      this.updateDashboard();
      await vscode.commands.executeCommand('setContext', 'dejareview.copyInProgress', true);
      validate();
      if (!await store.restore(id, validate)) {
        throw new Error('Current feedback exists or changed. Copy and clear it before recovering a review.');
      }
      validate();
      await this.refresh();
      void vscode.window.showInformationMessage('Review recovered to REVIEW-NOTES.md. The archive is still available.');
    } finally {
      this.copyInProgress = false;
      this.updateDashboard();
      this.schedule();
      await vscode.commands.executeCommand('setContext', 'dejareview.copyInProgress', false);
    }
  }

  private async reanchor(): Promise<void> {
    const store = this.store;
    const repo = this.repo;
    if (!store || !repo || this.copyInProgress) { return; }
    const validate = (): void => {
      this.assertScope(repo, store);
      if (this.copyInProgress) {
        throw new Error('Wait until copying finishes before re-anchoring Review Notes.');
      }
    };
    validate();
    await this.refresh();
    validate();
    const entries = [...this.entries];
    const generation = this.generation;
    const validateProjection = (): void => {
      validate();
      if (generation !== this.generation || generation !== this.publishedGeneration || entries.some(entry => entry.repo !== repo)) {
        throw new Error('Review Note locations changed. Refresh and retry re-anchoring.');
      }
    };
    await store.mutate(text => {
      validateProjection();
      const updates = entries.flatMap(entry => {
        if (!entry.resolved) {
          return [];
        }
        return [{
          comment: this.current(text, entry),
          start: entry.resolved.startLine,
          end: entry.resolved.endLine,
        }];
      });
      return rewriteLinesBatch(text, updates);
    }, async () => { validateProjection(); }, validateProjection);
    await this.refresh();
  }

  private nativeEdits(): vscode.Comment[] {
    return this.threads.flatMap(thread => thread.comments.filter(note => note.mode === vscode.CommentMode.Editing));
  }

  private async ensureWorkspaceStore(): Promise<boolean> {
    const folderKey = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    const repo = await this.git.workspaceRepository();
    if (!repo) {
      throw new Error('Open a local Git project folder in VS Code to use review notes.');
    }
    if (folderKey !== repo.rootUri.toString() || folderKey !== vscode.workspace.workspaceFolders?.[0]?.uri.toString()) {
      throw new Error('The selected project folder changed. Refresh and retry.');
    }
    await this.useRepository(repo);
    if (!this.store) { return false; }
    this.assertScope(repo, this.store);
    return true;
  }

  private async offerGitignore(repo: Repository, store: ReviewStore): Promise<void> {
    this.assertScope(repo, store);
    const key = `gitignore:${repo.rootUri.toString()}:REVIEW-NOTES.md`;
    if (this.context.globalState.get(key)) { return; }
    await this.context.globalState.update(key, true);
    this.assertScope(repo, store);
    const choice = await vscode.window.showInformationMessage('REVIEW-NOTES.md is scratch review feedback. Add it to .gitignore?', 'Add', 'Not now');
    if (choice === 'Add') {
      this.assertScope(repo, store);
      await this.gitignore(repo, store);
    }
  }

  private async gitignore(repo = this.repo, store = this.store): Promise<void> {
    if (!repo || !store) { return; }
    const validate = (): void => this.assertScope(repo, store);
    validate();
    const uri = vscode.Uri.joinPath(repo.rootUri, '.gitignore');
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (error) {
      validate();
      let exists = true;
      try {
        await vscode.workspace.fs.stat(uri);
      } catch (statError) {
        validate();
        if (!(statError instanceof vscode.FileSystemError) || statError.code !== 'FileNotFound') {
          throw statError;
        }
        exists = false;
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      }
      validate();
      if (exists) {
        throw error;
      }
      document = await vscode.workspace.openTextDocument(uri);
    }
    validate();
    if (document.isDirty) {
      throw new Error('.gitignore has unsaved changes. Save it and retry.');
    }
    if (document.getText().split(/\r?\n/).some(line => ['REVIEW-NOTES.md', '/REVIEW-NOTES.md'].includes(line.trim()))) {
      return;
    }
    const text = document.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, document.positionAt(text.length), `${text && !text.endsWith('\n') ? '\n' : ''}/REVIEW-NOTES.md\n`);
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error('Could not update .gitignore. Retry the edit.');
    }
    validate();
    if (!await document.save()) {
      throw new Error('Could not save .gitignore. Its edit remains in the editor; save it and retry.');
    }
    validate();
  }

  getState(): { repo?: string; comments: number; threads: number; hasFeedback: boolean; archives: ReviewArchive[] } {
    return { repo: this.repo?.rootUri.fsPath, comments: this.savedEntries.length, threads: this.threads.length,
      hasFeedback: this.hasFeedback, archives: [...this.archives] };
  }
  getDrafts(): readonly vscode.CommentThread[] { return [...this.drafts.keys()]; }
  getThreads(): readonly vscode.CommentThread[] { return this.threads; }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); }
    this.store?.dispose();
    [...this.subscriptions, ...this.repoSubscriptions, this.controller, this.git,
      this.diagnostics, this.status, this.dashboard, this.decoration, this.output].forEach(item => item.dispose());
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const extension = new ReviewExtension(context);
  context.subscriptions.push(extension);
  await extension.initialize();
  return {
    refresh: () => extension.refresh(),
    getState: () => extension.getState(),
    getDrafts: () => extension.getDrafts(),
    getThreads: () => extension.getThreads(),
  };
}
