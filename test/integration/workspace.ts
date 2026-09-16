import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ReviewArchives } from '../../src/archive';
import { GitResources } from '../../src/git';
import { parse } from '../../src/parser';
import { ReviewStore } from '../../src/store';
import { fixtureRoot, waitFor, within } from './index';
import type { ReviewTestAPI } from './index';

// The runner must open root before launching the host and discover its containing Git repo.
// Use a separate launch with sample.ts inside a Git subfolder to exercise ancestor scope.
export async function testWorkspaceScope(git: GitResources, root: vscode.Uri, api: ReviewTestAPI, store: ReviewStore): Promise<void> {
  assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.toString(), root.toString());
  assert.equal(api.getState().repo, root.fsPath);
  assert.equal(path.basename(store.uri.fsPath), 'REVIEW-NOTES.md');
  assert.equal(store.uri.toString(), vscode.Uri.joinPath(root, 'REVIEW-NOTES.md').toString());
  assert.ok(!(await vscode.commands.getCommands()).includes('dejareview.selectRepository'));
  const extension = vscode.extensions.getExtension('local-review.dejareview');
  assert.ok(extension);
  const commands: { command: string }[] = extension.packageJSON.contributes.commands;
  assert.ok(!commands.some(command => command.command === 'dejareview.selectRepository'));
  const repo = await git.workspaceRepository();
  assert.ok(repo, 'The runner must enable discovery of the containing Git repository');
  assert.equal(repo.rootUri.toString(), root.toString());
  assert.equal(await git.workspaceRepository(), repo);
  assert.equal(await git.repositoryFor(), repo);

  const actual = git.repositories.filter(candidate => {
    if (candidate.rootUri.scheme !== 'file' || candidate.rootUri.authority !== root.authority) { return false; }
    const value = path.relative(candidate.rootUri.fsPath, root.fsPath);
    return !path.isAbsolute(value) && value !== '..' && !value.startsWith(`..${path.sep}`);
  }).sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
  assert.ok(actual);
  assert.deepEqual(repo.state.HEAD, actual.state.HEAD);
  const commit = await actual.getCommit('HEAD');
  assert.deepEqual(await repo.getCommit('HEAD'), commit);

  const working = vscode.Uri.joinPath(root, 'sample.ts');
  for (const origin of ['changed', 'head', 'staged', `commit:${commit.hash}`] as const) {
    const resource = { path: 'sample.ts', origin };
    const uri = git.uri(resource, repo);
    assert.equal(await git.repositoryFor(uri), repo);
    assert.deepEqual(await git.resource(uri, repo), resource);
    if (origin === 'changed') {
      assert.equal(uri.toString(), working.toString());
    } else {
      const ref = origin === 'head' ? 'HEAD' : origin === 'staged' ? '' : commit.hash;
      assert.deepEqual(JSON.parse(uri.query), { path: working.fsPath, ref });
      assert.equal(await git.content(resource, repo), await actual.show(ref, working.fsPath));
    }
  }

  for (const outside of [vscode.Uri.joinPath(root, '..', 'outside.ts'), root.with({ path: `${root.path}-sibling/file.ts` })]) {
    const revision = vscode.Uri.from({ scheme: 'git', authority: outside.authority, path: outside.path,
      query: JSON.stringify({ path: outside.fsPath, ref: 'HEAD' }) });
    for (const uri of [outside, revision]) {
      assert.equal(await git.repositoryFor(uri), undefined);
      assert.equal(await git.resource(uri, repo), undefined);
    }
  }
  assert.throws(() => git.uri({ path: '../outside.ts', origin: 'changed' }, repo));

  // Exercise any real nested repositories supplied and discovered by the runner.
  for (const nested of git.repositories) {
    const value = path.relative(root.fsPath, nested.rootUri.fsPath);
    if (!value || path.isAbsolute(value) || value === '..' || value.startsWith(`..${path.sep}`)) { continue; }
    const file = vscode.Uri.joinPath(nested.rootUri, 'sample.ts');
    const resource = { path: path.relative(root.fsPath, file.fsPath).split(path.sep).join('/'), origin: 'changed' } as const;
    assert.equal(await git.repositoryFor(file), undefined);
    assert.equal(await git.resource(file, repo), undefined);
    assert.throws(() => git.uri(resource, repo), /nested repository/);
  }

  const routePath = 'pages/projects/[versionId]/opportunities/page.ts';
  const gitExtension = vscode.extensions.getExtension<{
    getAPI(version: 1): { repositories: readonly { rootUri: vscode.Uri; status(): Promise<void> }[] };
  }>('vscode.git');
  assert.ok(gitExtension);
  const gitApi = (await gitExtension.activate()).getAPI(1);
  const fixtureRepository = gitApi.repositories.find(candidate => candidate.rootUri.toString() === actual.rootUri.toString());
  assert.ok(fixtureRepository);
  const route = vscode.Uri.joinPath(root, routePath);
  const unrelated = vscode.Uri.joinPath(root, 'pages/projects/unrelated.ts');
  const indexBefore = await actual.show('', working.fsPath);
  await fs.mkdir(path.dirname(route.fsPath), { recursive: true });
  await fs.writeFile(route.fsPath, 'export const route = true;\n');
  await fs.writeFile(unrelated.fsPath, 'export const unrelated = true;\n');
  const isCandidate = (uri: vscode.Uri): boolean => [
    ...(repo.state.workingTreeChanges ?? []),
    ...(repo.state.untrackedChanges ?? []),
  ].some(change => change.uri.toString() === uri.toString());
  await fixtureRepository.status();
  await waitFor('bracket route discovered by bundled Git', () => isCandidate(route) && isCandidate(unrelated));

  await git.stageFile(repo, routePath, new Set(), [], () => {
    assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.toString(), root.toString());
  });

  assert.equal(await actual.show('', route.fsPath), 'export const route = true;\n');
  assert.equal(await actual.show('', working.fsPath), indexBefore, 'existing staged content is unchanged');
  assert.ok(!repo.state.indexChanges?.some(change => change.uri.toString() === unrelated.toString()));
  assert.equal(isCandidate(unrelated), true, 'another candidate remains unstaged');

  // Remove only the disposable route fixture and stage its deletion for the next host.
  await fs.unlink(route.fsPath);
  await fixtureRepository.status();
  await waitFor('bracket route deletion discovered by bundled Git', () =>
    repo.state.workingTreeChanges?.some(change => change.uri.toString() === route.toString() && change.status === 6) ?? false);
  await git.stageFile(repo, routePath, new Set(), [], () => {});
  assert.ok(!repo.state.indexChanges?.some(change => change.uri.toString() === route.toString()));
  await fs.unlink(unrelated.fsPath);
}

export async function run(): Promise<void> {
  assert.equal(process.env.DEJAREVIEW_TEST_SUBFOLDER, '1');
  const root = vscode.Uri.file(await fixtureRoot());
  const repositoryRoot = path.dirname(root.fsPath);
  const parentNotes = path.join(repositoryRoot, 'REVIEW-NOTES.md');
  const readParentNotes = () => fs.readFile(parentNotes).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') { return undefined; }
    throw error;
  });
  const parentBefore = await readParentNotes();
  const git = new GitResources();
  let store: ReviewStore | undefined;
  try {
    assert.equal(vscode.window.activeTextEditor, undefined, 'Subfolder host must start without an active editor');
    const extension = vscode.extensions.getExtension<ReviewTestAPI>('local-review.dejareview');
    assert.ok(extension);
    const api = await within('subfolder extension activation', () => extension.activate());
    await within('parent Git repository discovery', async () => {
      await git.initialize();
      await waitFor('parent fixture repository', () => git.repositories.some(repo => repo.rootUri.fsPath === repositoryRoot));
    }, 10_000);
    assert.equal(vscode.window.activeTextEditor, undefined);
    assert.equal(api.getState().repo, root.fsPath, 'Startup must select the opened folder without an editor or manual refresh');
    assert.equal(api.getState().hasFeedback, false);
    const repo = await git.workspaceRepository();
    assert.ok(repo);
    store = new ReviewStore(repo, new ReviewArchives(vscode.Uri.joinPath(root, '.test-archive-storage'), root));
    await within('subfolder workspace scope', () => testWorkspaceScope(git, root, api, store!));
    console.log('PASS subfolder startup without an editor and parent Git adapter');

    await within('outside editor cannot change workspace scope', async () => {
      const outside = vscode.Uri.file(path.join(repositoryRoot, 'sample.ts'));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(outside), { preview: false });
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), outside.toString());
      assert.equal(await git.repositoryFor(outside), undefined);
      assert.equal(await git.resource(outside, repo), undefined);
      assert.equal(await git.repositoryFor(), repo);
      await api.refresh();
      assert.equal(api.getState().repo, root.fsPath);
      assert.equal(api.getState().hasFeedback, false);
    });
    console.log('PASS outside parent editor leaves subfolder scope unchanged');

    await within('persist current-document feedback in subfolder REVIEW-NOTES.md', async () => {
      const working = vscode.Uri.joinPath(root, 'sample.ts');
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(working), { preview: false });
      editor.selection = new vscode.Selection(0, 0, 1, 0);
      assert.equal(api.getDrafts().length, 0);
      await vscode.commands.executeCommand('dejareview.addComment');
      assert.equal(api.getDrafts().length, 1);
      const draft = api.getDrafts()[0];
      assert.equal(draft.uri.toString(), working.toString());
      const body = 'Feedback scoped to the opened project folder';
      await vscode.commands.executeCommand('dejareview.submitComment', { thread: draft, text: body });
      await api.refresh();
      const parsed = parse(await fs.readFile(path.join(root.fsPath, 'REVIEW-NOTES.md'), 'utf8'));
      assert.deepEqual(parsed.diagnostics, []);
      assert.equal(parsed.comments.length, 1);
      assert.equal(parsed.comments[0].path, 'sample.ts');
      assert.equal(parsed.comments[0].origin, 'changed');
      assert.equal(parsed.comments[0].side, 'document');
      assert.equal(parsed.comments[0].body, body);
      assert.equal(api.getState().repo, root.fsPath);
      assert.equal(api.getState().comments, 1);
      assert.equal(api.getDrafts().length, 0);
      assert.ok(api.getThreads().some(thread => thread.uri.toString() === working.toString()));
      assert.deepEqual(await readParentNotes(), parentBefore, 'Subfolder feedback must not change parent-root notes');
    });
    console.log('PASS current-document command persists project-relative notes only in the subfolder');
  } finally {
    store?.dispose();
    git.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
