import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { captureContext } from '../../src/editorContext';
import { GitResources, Repository } from '../../src/git';

export async function testResourceEdges(
  git: GitResources,
  repo: Repository,
  working: vscode.Uri,
  head: vscode.Uri,
  staged: vscode.Uri,
): Promise<void> {
  const range = new vscode.Range(0, 0, 1, 0);
  for (const [original, modified] of [[head, staged], [staged, working]]) {
    const tabInput = new vscode.TabInputTextDiff(original, modified);
    for (const [side, uri] of [['left', original], ['right', modified]] as const) {
      const document = await vscode.workspace.openTextDocument(uri);
      const lines = document.getText().split('\n');
      const comparison = {
        left: await git.resource(original, repo), right: await git.resource(modified, repo),
      };
      for (const rangeSemantics of ['selection', 'thread'] as const) {
        const context = await captureContext(git, uri, range, { tabInput, rangeSemantics });
        assert.ok(context);
        assert.equal(context.comment.side, side);
        assert.deepEqual(context.comment.comparison, comparison);
        assert.equal(context.comment.startLine, 1);
        assert.equal(context.comment.endLine, rangeSemantics === 'thread' ? 2 : 1);
        assert.equal(context.comment.anchorText, lines.slice(0, rangeSemantics === 'thread' ? 2 : 1).join('\n'));
      }
    }
  }

  for (const [filePath, origin] of [['sample.ts', 'staged'], ['other.ts', 'head']] as const) {
    const file = git.uri({ path: filePath, origin: 'changed' }, repo);
    const baseline = git.uri({ path: filePath, origin: 'head' }, repo).with({
      query: JSON.stringify({ path: file.fsPath, ref: '~' }),
    });
    assert.equal(repo.state.indexChanges?.some(change => change.uri.toString() === file.toString()), origin === 'staged');
    assert.deepEqual(await git.resource(baseline, repo), { path: filePath, origin });
    assert.equal((await vscode.workspace.openTextDocument(baseline)).getText(),
      await git.content({ path: filePath, origin }, repo));
    const context = await captureContext(git, baseline, range, {
      tabInput: new vscode.TabInputTextDiff(baseline, file),
    });
    assert.ok(context);
    assert.equal(context.comment.origin, origin);
    assert.equal(context.comment.side, 'left');
    assert.deepEqual(context.comment.comparison, {
      left: { path: filePath, origin }, right: { path: filePath, origin: 'changed' },
    });
  }
}
