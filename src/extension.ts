import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveAnchor } from './anchor';
import { ReviewArchive, ReviewArchives } from './archive';
import { ReviewDashboard } from './dashboard';
import { CapturedContext, captureContext } from './editorContext';
import { GitResources, Repository } from './git';
import { ParsedComment, ResolvedAnchor, ReviewComment } from './model';
import { parse } from './parser';
import { ReviewStore } from './store';
import { appendComment, deleteComment, editComment, rewriteLines } from './writer';

interface Entry {
  comment: ParsedComment;
  snapshot: string;
  repo: Repository;
  resolved?: ResolvedAnchor;
}

interface Note extends vscode.Comment {
  entry: Entry;
  parent: vscode.CommentThread;
}

type TreeNode = { label: string; children: TreeNode[] } | Entry;

function sideLabel(comment: ReviewComment): string {
  return `${comment.side === 'left' ? 'Left / Original' : comment.side === 'right' ? 'Right / Modified' : 'Document'} (${comment.origin})`;
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

class ReviewExtension implements vscode.Disposable, vscode.TreeDataProvider<TreeNode> {
  readonly git = new GitResources();
  private controller = vscode.comments.createCommentController('dejareview', 'DejaReview Notes');
  private readonly changes = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changes.event;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('dejareview');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private readonly output = vscode.window.createOutputChannel('DejaReview');
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: { contentText: ' [review]', margin: '0 0 0 1em', color: new vscode.ThemeColor('editorInfo.foreground') },
    overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly tree = vscode.window.createTreeView('dejareview.tree', { treeDataProvider: this, showCollapseAll: true });
  private readonly dashboard = new ReviewDashboard(async action => {
    try {
      if (action.repoKey !== this.repo?.rootUri.toString()) { return; }
      if (action.type === 'copy') { await this.handoff(action.repoKey); }
      else if (action.type === 'restore' && action.archiveId) { await this.restore(action.archiveId, action.repoKey); }
    } catch (error) { this.error(error); }
  });
  private archives: ReviewArchive[] = [];
  private hasFeedback = false;
  private historyError?: string;
  private readonly subscriptions: vscode.Disposable[] = [];
  private repoSubscriptions: vscode.Disposable[] = [];
  private store?: ReviewStore;
  private repo?: Repository;
  private entries: Entry[] = [];
  private threads: vscode.CommentThread[] = [];
  private readonly drafts = new Map<vscode.CommentThread, CapturedContext>();
  private generation = 0;
  private copyInProgress = false;
  private submitting = new Set<vscode.CommentThread>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private warnedBase?: string;
  private lastEditor = vscode.window.activeTextEditor;
  private lastTab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configureController();
    this.status.command = 'dejareview.dashboard.focus';
    this.status.tooltip = 'Open review notes';
    const commands: Record<string, (...args: any[]) => unknown> = {
      addComment: (uri?: vscode.Uri, selection?: vscode.Range) => this.add(uri, selection),
      submitComment: (reply: vscode.CommentReply) => this.submit(reply),
      cancelDraft: (arg: vscode.CommentThread | vscode.CommentReply) => this.cancelDraft('thread' in arg ? arg.thread : arg),
      editComment: (note: Note) => this.edit(note),
      saveComment: (note: Note) => this.save(note),
      cancelEdit: (note: Note) => this.cancelEdit(note),
      deleteComment: (arg: Entry | Note) => this.remove(this.entry(arg)),
      reveal: (arg: Entry | Note) => this.reveal(this.entry(arg)),
      gotoCode: (entry: Entry) => this.goto(entry),
      openComparison: (arg: Entry | Note | vscode.CommentThread) => this.goto(this.entry('comments' in arg ? arg.comments[0] as Note : arg), true),
      copyForAgent: () => this.handoff(),
      restoreArchive: (id?: string, repoKey?: string) => this.restore(id, repoKey),
      refresh: () => this.refresh(),
      reanchorAll: () => this.reanchor(),
      suggestGitignore: () => this.gitignore(),
    };
    for (const [name, run] of Object.entries(commands)) {
      this.subscriptions.push(vscode.commands.registerCommand(`dejareview.${name}`, async (...args: any[]) => {
        try { return await run(...args); }
        catch (error) { this.error(error); }
      }));
    }
    this.subscriptions.push(
      vscode.window.registerWebviewViewProvider('dejareview.dashboard', this.dashboard),
      this.git.onDidChangeRepositories(() => this.schedule()),
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
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() !== this.store?.uri.toString()) { this.schedule(); }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('dejareview')) { this.schedule(); }
      }),
    );
  }

  private configureController(): void {
    this.controller.options = { prompt: 'Write review feedback. Use the shortcut to capture context before typing.', placeHolder: 'What should change, and why?' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: async (document, token) => {
        if (this.copyInProgress || !['file', 'git'].includes(document.uri.scheme)) { return []; }
        try {
          const repo = await this.git.repositoryFor(document.uri);
          if (!repo || token.isCancellationRequested || !await this.git.resource(document.uri, repo)) { return []; }
          return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
        } catch { return []; }
      },
    };
  }

  async initialize(): Promise<void> {
    await this.git.initialize();
    const repo = await this.git.workspaceRepository();
    if (repo) { await this.useRepository(repo); }
  }

  private error(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(error instanceof Error ? error.stack ?? message : message);
    console.error('DejaReview:', error);
    void vscode.window.showErrorMessage(`DejaReview: ${message}`);
  }

  private updateDashboard(): void {
    this.dashboard.update({ repoKey: this.repo?.rootUri.toString(),
      repoName: this.repo ? path.basename(this.repo.rootUri.fsPath) : undefined,
      hasFeedback: this.hasFeedback, commentCount: this.entries.length,
      busy: this.copyInProgress || !!this.store?.busy, archives: this.archives, error: this.historyError });
  }

  private entry(arg: Entry | Note): Entry {
    const entry = arg && ('entry' in arg ? arg.entry : arg);
    if (!entry?.comment) { throw new Error('Choose a review note in the editor or review view.'); }
    return entry;
  }

  private current(text: string, entry: Entry): ParsedComment {
    const parsed = parse(text);
    if (text === entry.snapshot) {
      const match = parsed.comments[entry.comment.index];
      if (match?.rawBlock === entry.comment.rawBlock) { return match; }
    }
    // Never apply an old action to a different duplicate or changed comment.
    const matches = parsed.comments.filter(comment => comment.rawBlock === entry.comment.rawBlock);
    const oldMatches = parse(entry.snapshot).comments.filter(comment => comment.rawBlock === entry.comment.rawBlock);
    if (matches.length !== 1 || oldMatches.length !== 1) { throw new Error('This review note changed on disk. Refresh and select it again.'); }
    return matches[0];
  }

  private schedule(): void {
    if (this.disposed) { return; }
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh().catch(error => this.error(error)); }, 300);
  }

  private async useRepository(repo: Repository): Promise<void> {
    if (this.repo?.rootUri.toString() === repo.rootUri.toString()) { return; }
    if (this.copyInProgress || this.store?.busy) { throw new Error('Wait for the current review operation to finish.'); }
    if (this.drafts.size || this.threads.some(thread => thread.comments.some(note => note.mode === vscode.CommentMode.Editing))) {
      throw new Error('Finish or cancel open review drafts before switching repositories.');
    }
    this.generation++;
    this.store?.dispose();
    this.repoSubscriptions.forEach(item => item.dispose());
    this.repo = repo;
    this.store = new ReviewStore(repo, new ReviewArchives(this.context.globalStorageUri, repo.rootUri));
    this.entries = [];
    this.archives = [];
    this.hasFeedback = false;
    this.historyError = undefined;
    this.updateDashboard();
    this.repoSubscriptions = [this.store.onDidChange(() => this.schedule()),
      this.store.onDidChangeBusy(() => { this.updateDashboard(); if (!this.store?.busy) { this.schedule(); } }),
      repo.state.onDidChange(() => this.schedule())];
    this.tree.description = path.basename(repo.rootUri.fsPath);
    this.warnedBase = undefined;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.disposed) { return; }
    const workspaceRepo = await this.git.workspaceRepository();
    if (this.disposed) { return; }
    if (workspaceRepo?.rootUri.toString() !== this.repo?.rootUri.toString()) {
      if (this.copyInProgress || this.store?.busy || this.drafts.size
        || this.threads.some(thread => thread.comments.some(note => note.mode === vscode.CommentMode.Editing))) {
        this.historyError = 'The project folder changed. Finish open review edits before switching folders.';
        this.updateDashboard();
        return;
      }
      if (workspaceRepo) { await this.useRepository(workspaceRepo); return; }
      this.generation++;
      this.store?.dispose();
      this.store = undefined;
      this.repo = undefined;
      this.repoSubscriptions.forEach(item => item.dispose());
      this.repoSubscriptions = [];
      this.threads.forEach(thread => thread.dispose());
      this.threads = [];
      this.entries = [];
      this.archives = [];
      this.hasFeedback = false;
      this.diagnostics.clear();
      this.status.hide();
      this.tree.description = undefined;
      this.tree.message = undefined;
      this.changes.fire(undefined);
      for (const editor of vscode.window.visibleTextEditors) { editor.setDecorations(this.decoration, []); }
      await vscode.commands.executeCommand('setContext', 'dejareview.hasFeedback', false);
    }
    if (!this.store || !this.repo) {
      this.historyError = vscode.workspace.workspaceFolders?.length
        ? 'No Git repository is available for the opened project folder.' : undefined;
      this.updateDashboard();
      return;
    }
    const generation = ++this.generation;
    const store = this.store;
    const repo = this.repo;
    const { text, parsed } = await store.load();
    let archives: ReviewArchive[] = [];
    let historyError: string | undefined;
    if (!text?.trim()) {
      try { archives = await store.archives.list(); }
      catch (error) { historyError = `Cannot load review archives: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const staleBase = !!parsed.base && !!repo.state.HEAD?.commit && !repo.state.HEAD.commit.startsWith(parsed.base);
    const contents = new Map<string, Promise<string>>();
    const entries = await Promise.all(parsed.comments.map(async comment => {
      const key = `${comment.origin}:${comment.path}`;
      if (!contents.has(key)) { contents.set(key, this.git.content(comment, repo)); }
      let resolved: ResolvedAnchor | undefined;
      try {
        const content = await contents.get(key)!;
        if (!(staleBase && ['head', 'staged'].includes(comment.origin))) {
          resolved = resolveAnchor(comment, content, vscode.workspace.getConfiguration('dejareview').get('searchRadius', 50));
        }
      } catch { /* Missing revisions and deleted anchors stay exportable in the Stale group. */ }
      return { comment, resolved, repo, snapshot: text ?? '' };
    }));
    const resources = new Map<string, vscode.Uri[]>();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isClosed || !['file', 'git'].includes(doc.uri.scheme)) { continue; }
      try {
        const resource = await this.git.resource(doc.uri, repo);
        if (resource) {
          const key = `${resource.origin}:${resource.path}`;
          resources.set(key, [...(resources.get(key) ?? []), doc.uri]);
        }
      } catch { /* Unrelated or unsupported virtual documents are not review targets. */ }
    }
    if (generation !== this.generation || this.disposed || store !== this.store) { return; }
    this.entries = entries;
    this.archives = archives;
    this.hasFeedback = !!text?.trim();
    this.historyError = historyError;
    this.updateDashboard();
    this.diagnostics.clear();
    this.diagnostics.set(store.uri, parsed.diagnostics.map(item => new vscode.Diagnostic(
      new vscode.Range(item.line - 1, 0, item.line - 1, 1000), item.message, vscode.DiagnosticSeverity.Warning)));
    if (staleBase && this.warnedBase !== parsed.base) {
      this.warnedBase = parsed.base;
      void vscode.window.showWarningMessage('Review base changed. HEAD and index review notes are marked stale; their captured feedback is preserved.');
    }
    // Preserve live editor input and collapse state while reconciling saved projections.
    const old = [...this.threads];
    const next: vscode.CommentThread[] = [];
    for (const entry of entries) {
      if (!entry.resolved) { continue; }
      const uris = resources.get(`${entry.comment.origin}:${entry.comment.path}`) ?? [this.git.uri(entry.comment, repo)];
      for (const uri of new Map(uris.map(uri => [uri.toString(), uri])).values()) {
        const index = old.findIndex(thread => {
          const note = thread.comments[0] as Note | undefined;
          return thread.uri.toString() === uri.toString() && note?.entry.comment.index === entry.comment.index
            && note.entry.comment.rawBlock === entry.comment.rawBlock && note.entry.repo.rootUri.toString() === repo.rootUri.toString();
        });
        let thread: vscode.CommentThread;
        if (index >= 0) { thread = old.splice(index, 1)[0]; }
        else {
          thread = this.controller.createCommentThread(uri, range(entry.resolved), []);
          thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        }
        if (!thread.comments.some(note => note.mode === vscode.CommentMode.Editing)) {
          thread.range = range(entry.resolved);
          thread.label = label(entry.comment);
          thread.canReply = false;
          thread.contextValue = entry.comment.comparison ? 'comparison' : 'saved';
          const note: Note = { body: new vscode.MarkdownString(entry.comment.body), mode: vscode.CommentMode.Preview,
            author: { name: 'Review' }, contextValue: 'saved', entry, parent: thread };
          if (note.body instanceof vscode.MarkdownString) { note.body.isTrusted = false; }
          thread.comments = [note];
        }
        next.push(thread);
      }
    }
    for (const thread of old) {
      if (thread.comments.some(note => note.mode === vscode.CommentMode.Editing)) { next.push(thread); }
      else { thread.dispose(); }
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
    await vscode.commands.executeCommand('setContext', 'dejareview.hasFeedback', !!text?.trim());
    this.status.text = `$(comment) ${entries.length}`;
    if (text !== undefined) { this.status.show(); } else { this.status.hide(); }
    this.tree.message = parsed.diagnostics.length ? `${parsed.diagnostics.length} malformed block(s). Open REVIEW-NOTES.md to fix; all raw feedback can still be copied.` : undefined;
    this.changes.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if ('children' in node) { return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded); }
    const item = new vscode.TreeItem(node.comment.body.split(/\r?\n/)[0] || '(empty review note)');
    item.description = `${sideLabel(node.comment)} :${node.resolved?.startLine ?? node.comment.startLine}`;
    item.tooltip = markdown(node);
    item.contextValue = 'reviewComment';
    item.iconPath = new vscode.ThemeIcon(node.resolved ? 'comment' : 'warning');
    item.command = { command: 'dejareview.gotoCode', title: 'Go to Code', arguments: [node] };
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) { return 'children' in node ? node.children : []; }
    const groups: TreeNode[] = [];
    for (const stale of [false, true]) {
      const files = new Map<string, Entry[]>();
      for (const entry of this.entries.filter(entry => !entry.resolved === stale)) {
        files.set(entry.comment.path, [...(files.get(entry.comment.path) ?? []), entry]);
      }
      if (files.size) { groups.push({ label: stale ? 'Stale' : 'Review Notes', children: [...files].map(([label, children]) => ({ label, children })) }); }
    }
    return groups;
  }

  private async add(uri?: vscode.Uri, selection?: vscode.Range): Promise<void> {
    if (this.copyInProgress) { throw new Error('Wait until copying finishes before adding review notes.'); }
    const editor = uri ? vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString()) : this.lastEditor;
    const source = uri ?? editor?.document.uri;
    const selected = selection ?? editor?.selection;
    if (!source || !selected) { throw new Error('Focus a text editor and select a line to add a review note to.'); }
    const input = uri ? vscode.window.tabGroups.activeTabGroup.activeTab?.input : this.lastTab;
    const captured = await captureContext(this.git, source, selected, {
      tabInput: input instanceof vscode.TabInputText || input instanceof vscode.TabInputTextDiff ? input : undefined,
    });
    if (!captured || this.copyInProgress) { return; }
    await this.useRepository(captured.repo);
    if (this.copyInProgress || this.repo?.rootUri.toString() !== captured.repo.rootUri.toString()) { return; }
    const thread = this.controller.createCommentThread(source, range(captured.comment), []);
    thread.label = label(captured.comment);
    thread.contextValue = 'draft';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = true;
    this.drafts.set(thread, captured);
  }

  private async submit(reply: vscode.CommentReply): Promise<void> {
    if (!reply?.thread || !reply.text?.trim()) { return; }
    if (this.copyInProgress || this.submitting.has(reply.thread)) { return; }
    const thread = reply.thread;
    if (thread.comments.length) { throw new Error('Replies are not supported. Add a separate review note.'); }
    this.submitting.add(thread);
    try {
      const captured = this.drafts.get(thread) ?? await captureContext(this.git, thread.uri, thread.range ?? new vscode.Range(0, 0, 0, 0), { forceSidePrompt: true, rangeSemantics: 'thread' });
      if (!captured) { return; }
      await this.useRepository(captured.repo);
      if (this.repo?.rootUri.toString() !== captured.repo.rootUri.toString() || !this.store) { throw new Error('Repository changed while capturing feedback. Retry the submission.'); }
      const store = this.store;
      if (await store.mutate(text => appendComment(text, { ...captured.comment, body: reply.text }, captured.repo.state.HEAD?.commit?.slice(0, 12)))) {
        this.cancelDraft(thread);
        await this.refresh();
        const latest = [...this.threads].reverse().find(thread => (thread.comments[0] as Note | undefined)?.entry.comment.body.trim() === reply.text.trim());
        if (latest) { latest.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded; }
        void this.offerGitignore().catch(error => this.error(error));
      }
    } finally { this.submitting.delete(thread); }
  }

  private cancelDraft(thread: vscode.CommentThread): void { this.drafts.delete(thread); thread.dispose(); this.schedule(); }

  private edit(note: Note): void {
    if (this.copyInProgress) { return; }
    this.entry(note);
    note.mode = vscode.CommentMode.Editing;
    note.contextValue = 'editing';
    note.parent.comments = [note];
  }

  private async save(note: Note): Promise<void> {
    const entry = this.entry(note);
    if (this.copyInProgress) { return; }
    const body = typeof note.body === 'string' ? note.body : note.body.value;
    const store = this.storeFor(entry);
    let unchanged = false;
    if (await store.mutate(text => {
      const next = editComment(text, this.current(text, entry), body);
      unchanged = next === text;
      return next;
    }) || unchanged) {
      note.mode = vscode.CommentMode.Preview;
      note.contextValue = 'saved';
      note.parent.comments = [note];
      await this.refresh();
    }
  }

  private cancelEdit(note: Note): void {
    note.body = new vscode.MarkdownString(note.entry.comment.body);
    note.mode = vscode.CommentMode.Preview;
    note.contextValue = 'saved';
    note.parent.comments = [note];
    this.schedule();
  }

  private storeFor(entry: Entry): ReviewStore {
    if (!this.store || this.repo?.rootUri.toString() !== entry.repo.rootUri.toString()) { throw new Error('The selected repository changed. Select this review note again.'); }
    return this.store;
  }

  private async remove(entry: Entry): Promise<void> {
    if (this.copyInProgress) { return; }
    await this.storeFor(entry).mutate(text => deleteComment(text, this.current(text, entry)));
    await this.refresh();
  }

  private async reveal(entry: Entry): Promise<void> {
    const store = this.storeFor(entry);
    const text = await store.read() ?? '';
    const comment = this.current(text, entry);
    const document = await vscode.workspace.openTextDocument(store.uri);
    const position = document.positionAt(comment.startOffset);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
  }

  private async goto(entry: Entry, comparisonOnly = false): Promise<void> {
    if (!entry.resolved && !comparisonOnly) { await this.reveal(entry); return; }
    const pair = entry.comment.comparison;
    if (pair) {
      const left = this.git.uri(pair.left, entry.repo);
      const right = this.git.uri(pair.right, entry.repo);
      await vscode.commands.executeCommand('vscode.diff', left, right, `${pair.left.path} <-> ${pair.right.path}`, {
        preview: true,
      } satisfies vscode.TextDocumentShowOptions);
      if (comparisonOnly && !vscode.workspace.getConfiguration('diffEditor').get<boolean>('renderSideBySide', true)) {
        await vscode.commands.executeCommand('toggle.diff.renderSideBySide');
      }
      const target = entry.comment.side === 'left' ? left : right;
      const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === target.toString());
      if (editor && entry.resolved) {
        editor.selection = new vscode.Selection(range(entry.resolved).start, range(entry.resolved).end);
        editor.revealRange(range(entry.resolved), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      } else if (entry.resolved) {
        const choice = await vscode.window.showInformationMessage('The selected comparison side is not exposed as a text editor. Open its revision separately?', 'Open Revision');
        if (choice === 'Open Revision') {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { selection: range(entry.resolved), preview: false });
        }
      }
    } else {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(this.git.uri(entry.comment, entry.repo)), {
        selection: range(entry.resolved ?? entry.comment), preview: true,
      });
    }
  }

  private async handoff(expectedRepoKey?: string): Promise<void> {
    if (this.copyInProgress || this.submitting.size) { return; }
    if (!await this.ensureWorkspaceStore()) { return; }
    if (expectedRepoKey && expectedRepoKey !== this.repo?.rootUri.toString()) { return; }
    if (this.copyInProgress || this.submitting.size) { return; }
    this.copyInProgress = true;
    this.updateDashboard();
    await vscode.commands.executeCommand('setContext', 'dejareview.copyInProgress', true);
    try {
      if (this.drafts.size || this.threads.some(thread => thread.comments.some(note => note.mode === vscode.CommentMode.Editing))) {
        const choice = await vscode.window.showWarningMessage(
          'Unsubmitted review notes or open edits are not included. Finish them first, or explicitly discard them when copying.',
          { modal: true }, 'Copy and discard drafts', 'Finish review notes first');
        if (choice !== 'Copy and discard drafts') { return; }
      }
      const result = await this.store!.handoff();
      if (result.status === 'copied') {
        this.generation++;
        for (const thread of this.drafts.keys()) { thread.dispose(); }
        this.drafts.clear();
        for (const thread of this.threads) { thread.dispose(); }
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
    if (this.copyInProgress || this.submitting.size) { return; }
    if (!await this.ensureWorkspaceStore()) { return; }
    const store = this.store;
    const selectedKey = this.repo?.rootUri.toString();
    if (!store || this.copyInProgress || this.submitting.size || (repoKey && repoKey !== selectedKey)) { return; }
    if (this.drafts.size || this.threads.some(thread => thread.comments.some(note => note.mode === vscode.CommentMode.Editing))) {
      throw new Error('Finish or cancel open drafts and edits before recovering a review.');
    }
    if (!id) {
      const archives = await store.archives.list();
      const choice = await vscode.window.showQuickPick(archives.map(archive => ({
        label: new Date(archive.createdAt).toLocaleString(),
        description: `${archive.commentCount} review note${archive.commentCount === 1 ? '' : 's'}`, id: archive.id,
      })), { placeHolder: archives.length ? 'Recover a recent review batch' : 'No archived reviews for this repository' });
      id = choice?.id;
    }
    if (!id || this.store !== store || this.copyInProgress) { return; }
    if (this.submitting.size || this.drafts.size || this.threads.some(thread => thread.comments.some(note => note.mode === vscode.CommentMode.Editing))) {
      throw new Error('Finish or cancel open drafts and edits before recovering a review.');
    }
    this.copyInProgress = true;
    this.updateDashboard();
    await vscode.commands.executeCommand('setContext', 'dejareview.copyInProgress', true);
    try {
      if (!await store.restore(id)) { throw new Error('Current feedback exists or changed. Copy and clear it before recovering a review.'); }
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
    if (!this.store || this.copyInProgress) { return; }
    await this.refresh();
    const entries = [...this.entries].reverse();
    await this.store.mutate(text => {
      for (const entry of entries) {
        if (entry.resolved) { text = rewriteLines(text, this.current(text, entry), entry.resolved.startLine, entry.resolved.endLine); }
      }
      return text;
    });
    await this.refresh();
  }

  private async ensureWorkspaceStore(): Promise<boolean> {
    const repo = await this.git.workspaceRepository();
    if (!repo) { throw new Error('Open a local Git project folder in VS Code to use review notes.'); }
    await this.useRepository(repo);
    return !!this.store && this.repo?.rootUri.toString() === repo.rootUri.toString();
  }

  private async offerGitignore(): Promise<void> {
    if (!this.repo) { return; }
    const repoUri = this.repo.rootUri.toString();
    const key = `gitignore:${this.repo.rootUri.toString()}:REVIEW-NOTES.md`;
    if (this.context.globalState.get(key)) { return; }
    await this.context.globalState.update(key, true);
    const choice = await vscode.window.showInformationMessage('REVIEW-NOTES.md is scratch review feedback. Add it to .gitignore?', 'Add', 'Not now');
    if (choice === 'Add') {
      if (this.repo?.rootUri.toString() !== repoUri) {
        void vscode.window.showInformationMessage('Repository selection changed. Run Add REVIEW-NOTES.md to .gitignore in the intended repository.');
      } else { await this.gitignore(); }
    }
  }

  private async gitignore(): Promise<void> {
    const repo = this.repo;
    if (!repo) { return; }
    const uri = vscode.Uri.joinPath(repo.rootUri, '.gitignore');
    let document: vscode.TextDocument;
    try { document = await vscode.workspace.openTextDocument(uri); }
    catch (error) {
      try { await vscode.workspace.fs.stat(uri); } catch (statError) {
        if (!(statError instanceof vscode.FileSystemError) || statError.code !== 'FileNotFound') { throw statError; }
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      }
      document = await vscode.workspace.openTextDocument(uri);
    }
    if (document.isDirty) { throw new Error('.gitignore has unsaved changes. Save it and retry.'); }
    if (document.getText().split(/\r?\n/).some(line => ['REVIEW-NOTES.md', '/REVIEW-NOTES.md'].includes(line.trim()))) { return; }
    const text = document.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, document.positionAt(text.length), `${text && !text.endsWith('\n') ? '\n' : ''}/REVIEW-NOTES.md\n`);
    if (await vscode.workspace.applyEdit(edit)) { await document.save(); }
  }

  getState(): { repo?: string; comments: number; threads: number; hasFeedback: boolean; archives: ReviewArchive[] } {
    return { repo: this.repo?.rootUri.fsPath, comments: this.entries.length, threads: this.threads.length,
      hasFeedback: this.hasFeedback, archives: [...this.archives] };
  }
  getDrafts(): readonly vscode.CommentThread[] { return [...this.drafts.keys()]; }
  getThreads(): readonly vscode.CommentThread[] { return this.threads; }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); }
    this.store?.dispose();
    [...this.subscriptions, ...this.repoSubscriptions, this.controller, this.git, this.changes,
      this.diagnostics, this.status, this.tree, this.dashboard, this.decoration, this.output].forEach(item => item.dispose());
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
