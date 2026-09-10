import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ReviewArchives } from '../../src/archive';
import type { ReviewArchive } from '../../src/archive';
import { captureContext } from '../../src/editorContext';
import { GitResources } from '../../src/git';
import { HANDOFF_INSTRUCTION } from '../../src/handoff';
import { ReviewComment } from '../../src/model';
import { parse } from '../../src/parser';
import { ReviewStore } from '../../src/store';
import { appendComment, deleteComment, editComment } from '../../src/writer';
import { testResourceEdges } from './resources';
import { testArchives } from './archives';
import { testWorkspaceScope } from './workspace';

// Activation must expose live snapshots; CommentController has no public threads property.
export interface ReviewTestAPI {
  refresh(): Promise<void>;
  getState(): { repo?: string; comments: number; threads: number; hasFeedback: boolean; archives: ReviewArchive[] };
  getDrafts(): readonly vscode.CommentThread[];
  getThreads(): readonly vscode.CommentThread[];
}

export async function within<T>(label: string, operation: () => PromiseLike<T>, milliseconds = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
    })]);
  } finally {
    if (timer !== undefined) { clearTimeout(timer); }
  }
}

export async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function openDocument(uri: vscode.Uri): Promise<vscode.TabInputText> {
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
  await waitFor('normal text tab', () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputText && input.uri.toString() === uri.toString();
  });
  const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input;
  assert.ok(input instanceof vscode.TabInputText);
  return input;
}

async function openDiff(original: vscode.Uri, modified: vscode.Uri): Promise<vscode.TabInputTextDiff> {
  await vscode.commands.executeCommand('vscode.diff', original, modified, 'Integration comparison', { preview: false });
  await waitFor('text diff tab', () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff
      && input.original.toString() === original.toString() && input.modified.toString() === modified.toString();
  });
  const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input;
  assert.ok(input instanceof vscode.TabInputTextDiff);
  return input;
}

export async function fixtureRoot(): Promise<string> {
  // Refuse manual launches against any workspace other than the runner's disposable fixture.
  const fixture = process.env.DEJAREVIEW_TEST_WORKSPACE;
  assert.ok(fixture, 'Launch this suite through test/runIntegration.ts');
  const repositoryRoot = await fs.realpath(fixture);
  assert.equal(path.dirname(path.dirname(repositoryRoot)), await fs.realpath(os.tmpdir()));
  assert.ok(path.basename(path.dirname(repositoryRoot)).startsWith('lr-'));
  assert.equal(path.basename(repositoryRoot), 'workspace');
  const root = process.env.DEJAREVIEW_TEST_SUBFOLDER === '1' ? path.join(repositoryRoot, 'project') : repositoryRoot;
  assert.equal(vscode.workspace.workspaceFolders?.length, 1);
  assert.equal(await fs.realpath(vscode.workspace.workspaceFolders![0].uri.fsPath), root);
  await vscode.workspace.getConfiguration('git').update('openRepositoryInParentFolders', 'always', vscode.ConfigurationTarget.Global);
  return root;
}

export async function run(): Promise<void> {
  const root = await fixtureRoot();
  const git = new GitResources();
  let store: ReviewStore | undefined;
  const test = async (name: string, operation: () => Promise<void>): Promise<void> => {
    await within(name, operation);
    console.log(`PASS ${name}`);
  };
  try {
    const extension = vscode.extensions.getExtension<ReviewTestAPI>('local-review.dejareview');
    assert.ok(extension, 'Development extension local-review.dejareview must be installed');
    const api = await within('extension activation', () => extension.activate());
    assert.ok(api, 'activate() must return the integration test API');
    for (const method of ['refresh', 'getState', 'getDrafts', 'getThreads'] as const) {
      assert.equal(typeof api[method], 'function', `activate() must export ${method}()`);
    }
    await within('Git repository discovery', async () => {
      await git.initialize();
      await waitFor('fixture repository', () => git.repositories.some(repo => repo.rootUri.fsPath === root));
    }, 10_000);
    const repo = await git.repositoryFor(vscode.Uri.file(path.join(root, 'sample.ts')));
    assert.ok(repo);
    assert.equal(repo.rootUri.fsPath, root);
    const storageUri = vscode.Uri.joinPath(repo.rootUri, '.test-archive-storage');
    store = new ReviewStore(repo, new ReviewArchives(storageUri, repo.rootUri));
    const reviewStore = store;
    const feedback = reviewStore.uri.fsPath;
    const range = new vscode.Range(0, 0, 1, 0);
    const head = git.uri({ path: 'sample.ts', origin: 'head' }, repo);
    const staged = git.uri({ path: 'sample.ts', origin: 'staged' }, repo);
    const working = git.uri({ path: 'sample.ts', origin: 'changed' }, repo);
    const other = git.uri({ path: 'other.ts', origin: 'changed' }, repo);
    const captured: { uri: vscode.Uri; comment: ReviewComment }[] = [];

    await test('review scope and notes belong to the first workspace folder', () =>
      testWorkspaceScope(git, repo.rootUri, api, reviewStore));

    await test('real HEAD, index, and working-tree resources and documents', async () => {
      for (const [origin, version] of [['head', 'head'], ['staged', 'staged'], ['changed', 'working']] as const) {
        const resource = { path: 'sample.ts', origin };
        const uri = git.uri(resource, repo);
        const expected = `export const version = '${version}';\nexport const stable = true;\n`;
        assert.equal(uri.scheme, origin === 'changed' ? 'file' : 'git');
        if (uri.scheme === 'git') {
          assert.deepEqual(JSON.parse(uri.query), { path: working.fsPath, ref: origin === 'head' ? 'HEAD' : '' });
        }
        assert.deepEqual(await git.resource(uri, repo), resource);
        assert.equal(await git.content(resource, repo), expected);
        assert.equal((await vscode.workspace.openTextDocument(uri)).getText(), expected);
      }
    });

    await test('capture normal editor and both sides of real Git and file/file diff tabs', async () => {
      const tabInput = await openDocument(working);
      const normal = await captureContext(git, working, range, { tabInput });
      assert.ok(normal);
      assert.deepEqual(normal.comment, {
        path: 'sample.ts', origin: 'changed', side: 'document', comparison: undefined,
        startLine: 1, endLine: 1, anchorText: "export const version = 'working';", elided: false, body: '',
      });
      captured.push(normal);
      for (const [left, right, comparison, anchors] of [
        [head, staged, { left: { path: 'sample.ts', origin: 'head' }, right: { path: 'sample.ts', origin: 'staged' } },
          ["export const version = 'head';", "export const version = 'staged';"]],
        [working, other, { left: { path: 'sample.ts', origin: 'changed' }, right: { path: 'other.ts', origin: 'changed' } },
          ["export const version = 'working';", 'export const alternate = true;']],
      ] as const) {
        const input = await openDiff(left, right);
        for (const [side, uri, anchorText] of [['left', left, anchors[0]], ['right', right, anchors[1]]] as const) {
          const context = await captureContext(git, uri, range, { tabInput: input });
          assert.ok(context);
          assert.deepEqual(context.comment, { ...comparison[side], side, comparison,
            startLine: 1, endLine: 1, anchorText, elided: false, body: '' });
          captured.push(context);
        }
      }
    });

    await test('native ranges and conditional Git baselines', () => testResourceEdges(git, repo, working, head, staged));

    await test('deny unsupported, outside-repository, and malformed resource URIs', async () => {
      const outside = vscode.Uri.file(path.join(path.dirname(root), 'outside.ts'));
      for (const uri of [
        vscode.Uri.parse('untitled:review.ts'),
        vscode.Uri.parse('https://example.invalid/sample.ts'),
        outside,
        head.with({ path: outside.path, query: JSON.stringify({ path: outside.fsPath, ref: 'HEAD' }) }),
      ]) {
        assert.equal(await git.repositoryFor(uri), undefined, uri.toString());
        assert.equal(await git.resource(uri, repo), undefined, uri.toString());
      }
      for (const [uri, error] of [
        [working.with({ query: 'unexpected=true' }), /query or fragment/],
        [working.with({ fragment: 'unexpected' }), /query or fragment/],
        [head.with({ query: '{' }), /Malformed Git URI/],
        [head.with({ query: JSON.stringify({ path: working.fsPath }) }), /path and ref must be strings/],
        [head.with({ query: JSON.stringify({ path: working.fsPath, ref: 1 }) }), /path and ref must be strings/],
        [head.with({ query: JSON.stringify({ path: 'sample.ts', ref: 'HEAD' }) }), /must be absolute/],
        [head.with({ authority: 'unexpected-host' }), /authority does not match/],
        [head.with({ query: JSON.stringify({ path: working.fsPath, ref: 'HEAD', submoduleOf: root }) }), /Submodule summary/],
      ] as const) {
        await assert.rejects(() => git.repositoryFor(uri), error);
        await assert.rejects(() => git.resource(uri, repo), error);
      }
      for (const ref of ['~1', ':1', '-HEAD', 'HEAD\n']) {
        const uri = head.with({ query: JSON.stringify({ path: working.fsPath, ref }) });
        await assert.rejects(() => git.resource(uri, repo), /Unsupported Git ref/);
      }
    });

    await testArchives(repo, storageUri, captured[0].comment, test);

    const savedThread = (uri: vscode.Uri, body: string): vscode.CommentThread => {
      const thread = api.getThreads().find(item => item.uri.toString() === uri.toString()
        && item.comments.some(comment => (typeof comment.body === 'string' ? comment.body : comment.body.value).includes(body)));
      assert.ok(thread, `Expected displayed thread for ${uri.toString()}: ${body}`);
      assert.ok(thread.range);
      assert.equal(thread.range.start.line, 0);
      assert.equal(thread.range.end.line, 0);
      return thread;
    };

    await test('add and submit comments through normal and diff editor commands', async () => {
      for (const [index, context] of captured.entries()) {
        if (context.comment.comparison) {
          await openDiff(git.uri(context.comment.comparison.left, repo), git.uri(context.comment.comparison.right, repo));
        } else {
          await openDocument(context.uri);
        }
        const previous = new Set(api.getDrafts());
        await vscode.commands.executeCommand('dejareview.addComment', context.uri, range);
        const draft = api.getDrafts().filter(thread => !previous.has(thread)).at(-1);
        assert.ok(draft, 'addComment(uri, range) must expose its new draft via getDrafts()');
        assert.equal(draft.uri.toString(), context.uri.toString());
        context.comment.body = `Integration feedback ${index}`;
        await vscode.commands.executeCommand('dejareview.submitComment', { thread: draft, text: context.comment.body });
        await api.refresh();
        assert.equal(api.getDrafts().length, 0);
        const parsed = parse(await fs.readFile(feedback, 'utf8'));
        assert.deepEqual(parsed.diagnostics, []);
        assert.equal(parsed.comments.length, index + 1);
        const saved = parsed.comments[index];
        for (const key of Object.keys(context.comment) as (keyof ReviewComment)[]) {
          assert.deepEqual(key === 'elided' ? !!saved[key] : saved[key], context.comment[key], `Saved ${key} for comment ${index}`);
        }
        assert.equal(api.getState().comments, index + 1);
        assert.ok(api.getState().threads > 0);
        savedThread(context.uri, context.comment.body);
      }
    });

    await test('restore persisted threads after closing and reopening editors', async () => {
      const before = await fs.readFile(feedback, 'utf8');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.refresh();
      for (const context of captured) {
        if (context.comment.comparison) {
          await openDiff(git.uri(context.comment.comparison.left, repo), git.uri(context.comment.comparison.right, repo));
        } else {
          await openDocument(context.uri);
        }
        await api.refresh();
        savedThread(context.uri, context.comment.body);
      }
      assert.equal(api.getState().comments, captured.length);
      assert.equal(await fs.readFile(feedback, 'utf8'), before, 'Display restoration must not rewrite feedback');
    });

    await test('open saved comparisons side by side through live thread commands', async () => {
      const configuration = vscode.workspace.getConfiguration('diffEditor');
      const previous = configuration.inspect<boolean>('renderSideBySide')?.workspaceValue;
      const before = await fs.readFile(feedback, 'utf8');
      const comparisons = parse(before).comments.filter(comment => comment.side === 'right' && comment.comparison);
      assert.equal(comparisons.length, 2, 'Exercise the saved Git and file/file comparisons');
      assert.ok((await vscode.commands.getCommands()).includes('toggle.diff.renderSideBySide'));
      try {
        for (const comment of comparisons) {
          const pair = comment.comparison!;
          const original = git.uri(pair.left, repo);
          const modified = git.uri(pair.right, repo);
          await configuration.update('renderSideBySide', false, vscode.ConfigurationTarget.Workspace);
          await openDiff(original, modified);
          await api.refresh();
          const thread = savedThread(modified, comment.body);
          assert.equal(thread.contextValue, 'comparison');
          assert.equal(vscode.workspace.getConfiguration('diffEditor').get('renderSideBySide'), false);
          await within('openComparison live thread command', () =>
            vscode.commands.executeCommand('dejareview.openComparison', thread), 5_000);
          await waitFor('side-by-side comparison setting', () =>
            vscode.workspace.getConfiguration('diffEditor').get('renderSideBySide') === true);
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          assert.ok(input instanceof vscode.TabInputTextDiff);
          assert.equal(input.original.toString(), original.toString());
          assert.equal(input.modified.toString(), modified.toString());
          assert.equal(vscode.workspace.getConfiguration('diffEditor').get('renderSideBySide'), true);
        }
        assert.equal(await fs.readFile(feedback, 'utf8'), before, 'Opening comparisons must not rewrite feedback');
      } finally {
        await configuration.update('renderSideBySide', previous, vscode.ConfigurationTarget.Workspace);
        assert.equal(vscode.workspace.getConfiguration('diffEditor').inspect<boolean>('renderSideBySide')?.workspaceValue, previous);
      }
    });

    await test('saving an unchanged editor comment returns to preview without rewriting feedback', async () => {
      await openDocument(working);
      await api.refresh();
      const before = await fs.readFile(feedback, 'utf8');
      const thread = savedThread(working, captured[0].comment.body);
      const comment = thread.comments[0];
      await vscode.commands.executeCommand('dejareview.editComment', comment);
      assert.equal(comment.mode, vscode.CommentMode.Editing);
      await vscode.commands.executeCommand('dejareview.saveComment', comment);
      assert.equal(comment.mode, vscode.CommentMode.Preview);
      assert.equal(comment.contextValue, 'saved');
      assert.equal(savedThread(working, captured[0].comment.body).comments[0].mode, vscode.CommentMode.Preview);
      assert.equal(await fs.readFile(feedback, 'utf8'), before);
    });

    await test('edit, save, and delete a displayed comment through commands', async () => {
      await openDocument(working);
      await api.refresh();
      const thread = savedThread(working, captured[0].comment.body);
      const comment = thread.comments.find(item => (typeof item.body === 'string' ? item.body : item.body.value)
        .includes(captured[0].comment.body))!;
      await vscode.commands.executeCommand('dejareview.editComment', comment);
      assert.equal(comment.mode, vscode.CommentMode.Editing);
      comment.body = 'Edited integration feedback';
      await vscode.commands.executeCommand('dejareview.saveComment', comment);
      await api.refresh();
      let parsed = parse(await fs.readFile(feedback, 'utf8'));
      assert.equal(parsed.comments[0].body, 'Edited integration feedback');
      assert.equal(parsed.comments[0].anchorText, captured[0].comment.anchorText);
      const updated = savedThread(working, 'Edited integration feedback').comments.find(item =>
        (typeof item.body === 'string' ? item.body : item.body.value).includes('Edited integration feedback'))!;
      await vscode.commands.executeCommand('dejareview.deleteComment', updated);
      await api.refresh();
      parsed = parse(await fs.readFile(feedback, 'utf8'));
      assert.deepEqual(parsed.diagnostics, []);
      assert.equal(parsed.comments.length, captured.length - 1);
      assert.ok(parsed.comments.every(item => item.body !== 'Edited integration feedback'));
      assert.equal(api.getState().comments, captured.length - 1);
    });

    await test('a stale duplicate editor action cannot change the surviving duplicate', async () => {
      await openDocument(working);
      const duplicate = { ...captured[0].comment, body: 'Identical duplicate feedback' };
      const text = appendComment(appendComment('', duplicate), duplicate);
      const parsed = parse(text);
      assert.deepEqual(parsed.diagnostics, []);
      assert.equal(parsed.comments.length, 2);
      assert.equal(parsed.comments[0].rawBlock, parsed.comments[1].rawBlock,
        'The regression requires byte-identical blocks, not just identical bodies');
      await fs.writeFile(feedback, text);
      await api.refresh();
      assert.equal(api.getState().comments, 2);
      const comment = savedThread(working, duplicate.body).comments[0];
      await vscode.commands.executeCommand('dejareview.editComment', comment);
      assert.equal(comment.mode, vscode.CommentMode.Editing);
      try {
        const survivor = deleteComment(text, parsed.comments[0]);
        assert.equal(parse(survivor).comments.length, 1);
        assert.equal(parse(survivor).comments[0].rawBlock, parsed.comments[1].rawBlock);
        await fs.writeFile(feedback, survivor);
        await api.refresh();
        assert.equal(api.getState().comments, 1);
        assert.ok(api.getThreads().some(thread => thread.comments.includes(comment)), 'Keep the stale editor input alive');
        comment.body = 'Should not apply';
        // The command catches the stale-action error and must not await its nonmodal notification.
        await within('stale save command', () => vscode.commands.executeCommand('dejareview.saveComment', comment), 5_000);
        assert.equal(await fs.readFile(feedback, 'utf8'), survivor);
        assert.equal(parse(await fs.readFile(feedback, 'utf8')).comments[0].body, duplicate.body);
        assert.equal(comment.body, 'Should not apply');
        assert.equal(comment.mode, vscode.CommentMode.Editing);
        assert.ok(api.getThreads().some(thread => thread.comments.includes(comment)));
      } finally {
        await vscode.commands.executeCommand('dejareview.cancelEdit', comment);
        await api.refresh();
      }
    });

    await test('filesystem watcher refreshes external create, edit, and delete without manual refresh', async () => {
      await openDocument(working);
      let changes = 0;
      const subscription = reviewStore.onDidChange(() => { changes++; });
      const displayed = (body: string): boolean => api.getThreads().some(thread => thread.uri.toString() === working.toString()
        && thread.comments.some(comment => (typeof comment.body === 'string' ? comment.body : comment.body.value) === body));
      try {
        await fs.unlink(feedback);
        await waitFor('initial deletion watcher event and cleared threads', () => changes > 0
          && api.getState().comments === 0 && api.getThreads().length === 0);
        const external = appendComment('', { ...captured[0].comment, body: 'External feedback' });
        let before = changes;
        await fs.writeFile(feedback, external);
        await waitFor('creation watcher event and displayed feedback', () => changes > before
          && api.getState().comments === 1 && displayed('External feedback'));
        savedThread(working, 'External feedback');
        const edited = editComment(external, parse(external).comments[0], 'Externally edited feedback');
        before = changes;
        await fs.writeFile(feedback, edited);
        await waitFor('edit watcher event and updated feedback', () => changes > before && displayed('Externally edited feedback'));
        savedThread(working, 'Externally edited feedback');
        assert.equal(await fs.readFile(feedback, 'utf8'), edited);
        before = changes;
        await fs.unlink(feedback);
        await waitFor('deletion watcher event and cleared threads', () => changes > before
          && api.getState().comments === 0 && api.getState().threads === 0 && api.getThreads().length === 0);
        assert.equal(await reviewStore.read(), undefined);
      } finally {
        subscription.dispose();
      }
    });

    await test('malformed feedback survives refresh and valid comment mutations', async () => {
      const malformed = '## `sample.ts`:nope\nSelected: Working tree\n\nKeep this malformed feedback.\n';
      await fs.writeFile(feedback, malformed);
      await api.refresh();
      assert.equal(api.getState().comments, 0);
      assert.equal(api.getState().threads, 0);
      const loaded = await reviewStore.load();
      assert.equal(loaded.text, malformed);
      assert.ok(loaded.parsed.diagnostics.length > 0);
      assert.equal(await reviewStore.mutate(text => appendComment(text, captured[0].comment)), true);
      await api.refresh();
      const text = await fs.readFile(feedback, 'utf8');
      assert.ok(text.startsWith(malformed));
      assert.equal(parse(text).comments.length, 1);
      assert.ok(parse(text).diagnostics.length > 0);
      savedThread(working, captured[0].comment.body);
    });

    // Handoff's modal save/discard choices remain covered by pure tests, not UI automation.
    await test('real clipboard handoff through ReviewStore and the copy command', async () => {
      const previousClipboard = await vscode.env.clipboard.readText();
      try {
        const snapshot = await fs.readFile(feedback, 'utf8');
        const result = await reviewStore.handoff();
        assert.equal(result.status, 'copied');
        assert.equal(result.clipboardCopied, true);
        assert.equal(await vscode.env.clipboard.readText(), `${HANDOFF_INSTRUCTION}\n\n${snapshot}`);
        assert.equal(await reviewStore.read(), undefined);
        const directArchive = (await reviewStore.archives.list())[0];
        assert.ok(directArchive);
        assert.equal(directArchive.commentCount, parse(snapshot).comments.length);
        assert.equal(await new ReviewArchives(storageUri, repo.rootUri).read(directArchive.id), snapshot);
        await api.refresh();
        assert.equal(api.getState().threads, 0);
        assert.equal(api.getState().hasFeedback, false);
        assert.deepEqual(api.getState().archives, [], 'Extension history must not use direct-store fixture storage');
        const base = repo.state.HEAD!.commit!.slice(0, 12);
        const valid = appendComment(appendComment('', captured[1].comment, base), captured[2].comment);
        const raw = `\uFEFFFree-form feedback\r\n\r\n${valid.replace(/\n/g, '\r\n')}\r\n## File: broken\r\n  Preserve every byte.\r\n`;
        const sources = await Promise.all([working, other].map(uri => vscode.workspace.fs.readFile(uri)));
        const indexBefore = await git.content({ path: 'sample.ts', origin: 'staged' }, repo);
        await fs.writeFile(feedback, raw);
        await api.refresh();
        assert.equal(api.getState().hasFeedback, true);
        // Success notifications must be fire-and-forget, not awaited by this command.
        await within('copyForAgent command (must not await a notification)', () =>
          vscode.commands.executeCommand('dejareview.copyForAgent'), 10_000);
        assert.equal(await vscode.env.clipboard.readText(), `${HANDOFF_INSTRUCTION}\n\n${raw}`);
        assert.equal(await reviewStore.read(), undefined);
        await api.refresh();
        assert.equal(api.getState().comments, 0);
        assert.equal(api.getState().threads, 0);
        assert.equal(api.getThreads().length, 0);
        assert.equal(api.getState().hasFeedback, false);
        const archive = api.getState().archives[0];
        assert.ok(archive, 'Command handoff must expose a recoverable archive after clearing');
        assert.equal(archive.commentCount, 2);
        assert.equal(new Date(archive.createdAt).toISOString(), archive.createdAt);
        const repoKey = repo.rootUri.toString();
        const staleKey = vscode.Uri.joinPath(repo.rootUri, 'other-repository').toString();
        await within('stale repository restore command', () =>
          vscode.commands.executeCommand('dejareview.restoreArchive', archive.id, staleKey), 5_000);
        assert.equal(await reviewStore.read(), undefined, 'A stale repoKey must not restore into the selected repository');
        await within('restore archive command', () =>
          vscode.commands.executeCommand('dejareview.restoreArchive', archive.id, repoKey), 5_000);
        assert.equal(await reviewStore.read(), raw);
        assert.deepEqual(await fs.readFile(feedback), Buffer.from(raw));
        await api.refresh();
        assert.equal(api.getState().hasFeedback, true);
        assert.equal(api.getState().comments, 2);
        assert.ok(api.getState().threads >= 2);
        for (const context of captured.slice(1, 3)) { savedThread(context.uri, context.comment.body); }
        const restored = parse(await reviewStore.read() ?? '');
        assert.equal(restored.base, base);
        assert.deepEqual(restored.comments.map(comment => comment.anchorText),
          captured.slice(1, 3).map(context => context.comment.anchorText));

        const active = appendComment('', { ...captured[0].comment, body: 'New active feedback must survive recovery' });
        await fs.writeFile(feedback, active);
        await api.refresh();
        // Rejections are reported as fire-and-forget notifications, not rejected command promises.
        await within('restore blocked by current feedback (must not await notification)', () =>
          vscode.commands.executeCommand('dejareview.restoreArchive', archive.id, repoKey), 5_000);
        assert.equal(await reviewStore.read(), active);
        await within('stale repository restore must not overwrite current feedback', () =>
          vscode.commands.executeCommand('dejareview.restoreArchive', archive.id, staleKey), 5_000);
        assert.equal(await reviewStore.read(), active);
        savedThread(working, 'New active feedback must survive recovery');

        await fs.unlink(feedback);
        await api.refresh();
        assert.deepEqual(api.getState().archives.find(item => item.id === archive.id), archive,
          'Recovery must retain the original archive metadata');
        await within('recover the retained archive again', () =>
          vscode.commands.executeCommand('dejareview.restoreArchive', archive.id, repoKey), 5_000);
        assert.equal(await reviewStore.read(), raw, 'The archived record must remain readable after recovery');
        assert.deepEqual(await Promise.all([working, other].map(uri => vscode.workspace.fs.readFile(uri))), sources);
        assert.equal(await git.content({ path: 'sample.ts', origin: 'staged' }, repo), indexBefore);
        await fs.unlink(feedback);
        await api.refresh();
      } finally {
        await vscode.env.clipboard.writeText(previousClipboard);
      }
    });

    await test('reanchor command rewrites line numbers from a moved unsaved working buffer', async () => {
      await openDocument(working);
      const editor = vscode.window.activeTextEditor!;
      assert.equal(editor.document.uri.toString(), working.toString());
      assert.equal(editor.document.isDirty, false);
      const original = editor.document.getText();
      const previousFeedback = await reviewStore.read();
      const comment = { ...captured[0].comment, body: 'Reanchor moved working buffer' };
      try {
        await fs.writeFile(feedback, appendComment('', comment));
        await api.refresh();
        savedThread(working, comment.body);
        assert.ok(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '// Inserted in unsaved buffer\n\n')));
        assert.equal(editor.document.isDirty, true);
        assert.equal(await fs.readFile(working.fsPath, 'utf8'), original, 'The anchor must move only in the live buffer');
        await vscode.commands.executeCommand('dejareview.reanchorAll');
        const parsed = parse(await fs.readFile(feedback, 'utf8'));
        assert.deepEqual(parsed.diagnostics, []);
        assert.equal(parsed.comments.length, 1);
        assert.equal(parsed.comments[0].startLine, 3);
        assert.equal(parsed.comments[0].endLine, 3);
        assert.equal(parsed.comments[0].anchorText, comment.anchorText);
        assert.equal(parsed.comments[0].body, comment.body);
        assert.equal(editor.document.isDirty, true);
        const thread = api.getThreads().find(thread => thread.uri.toString() === working.toString());
        assert.ok(thread?.range);
        assert.equal(thread.range.start.line, 2);
        assert.equal(thread.range.end.line, 2);
      } finally {
        assert.ok(await editor.edit(edit => edit.replace(new vscode.Range(
          editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)), original)));
        assert.ok(await editor.document.save());
        assert.equal(await fs.readFile(working.fsPath, 'utf8'), original);
        if (previousFeedback === undefined) { await fs.unlink(feedback); }
        else { await fs.writeFile(feedback, previousFeedback); }
        await api.refresh();
      }
    });
  } finally {
    store?.dispose();
    git.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
