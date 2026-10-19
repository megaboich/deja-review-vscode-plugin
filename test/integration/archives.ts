import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ReviewArchives, type ReviewArchive } from '../../src/archive';
import type { Repository } from '../../src/git';
import type { ReviewComment } from '../../src/model';
import type { StoredNote } from '../../src/reviewStorage';
import { ReviewStore } from '../../src/store';
import { appendComment } from '../../src/writer';

export async function testArchives(repo: Repository, storageUri: vscode.Uri, comment: ReviewComment,
  test: (name: string, operation: () => Promise<void>) => Promise<void>): Promise<void> {
  const isolated = vscode.Uri.joinPath(storageUri, 'integration-recovery-fixture');
  const archives = new ReviewArchives(isolated, repo.checkoutUri ?? repo.rootUri, repo.rootUri);
  const store = new ReviewStore(repo, archives);
  const snapshot = appendComment('', { ...comment, body: 'Recover this synthetic batch' });
  try {
    await test('last-copy recovery replaces history and isolates checkout disk paths', async () => {
      assert.deepEqual(await archives.list(), []);
      const old = await archives.save(snapshot);
      const latest = await archives.save(snapshot);
      assert.deepEqual(await archives.list(), [latest]);
      await assert.rejects(archives.read(old.id), /changed/);
      assert.equal(await archives.read(latest.id), snapshot);
      const other = new ReviewArchives(isolated, vscode.Uri.joinPath(repo.rootUri, 'separate-checkout'));
      assert.deepEqual(await other.list(), []);
      await assert.rejects(other.read(latest.id));
    });

    await test('recovery refuses active notes and dirty storage buffers without prompting', async () => {
      const [latest] = await archives.list();
      assert.equal(await store.restore(latest.id), true);
      assert.equal(await store.restore(latest.id), false);
      await store.mutate(() => '');
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(store.uri), { preview: false });
      try {
        assert.ok(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'unsaved')));
        await assert.rejects(store.restore(latest.id), /internal Review Notes storage/);
      } finally {
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
      assert.equal(await store.restore(latest.id), true);
      assert.equal(await store.read(), snapshot);
      await store.mutate(() => '');
    });

    await test('recovery-write failure never clears live notes after copying', async () => {
      class FailingArchives extends ReviewArchives {
        override async saveRecords(_notes: StoredNote[]): Promise<ReviewArchive> { throw new Error('injected recovery failure'); }
      }
      const failing = new ReviewStore(repo, new FailingArchives(isolated, repo.checkoutUri ?? repo.rootUri, repo.rootUri));
      const clipboard = await vscode.env.clipboard.readText();
      try {
        await failing.mutate(() => snapshot);
        const result = await failing.handoff();
        assert.equal(result.status, 'archiveFailed');
        assert.equal(result.clipboardCopied, true);
        assert.equal(result.archived, false);
        assert.equal(await failing.read(), snapshot);
      } finally {
        await failing.mutate(() => '');
        failing.dispose();
        await vscode.env.clipboard.writeText(clipboard);
      }
    });

    await test('busy state is released after successful, unchanged and failed writes', async () => {
      const events: boolean[] = [];
      const subscription = store.onDidChangeBusy(() => events.push(store.busy));
      try {
        assert.equal(await store.mutate(() => snapshot), true);
        assert.equal(await store.mutate(text => text), false);
        await assert.rejects(store.mutate(() => { throw new Error('injected failure'); }));
        assert.deepEqual(events, [true, false, true, false, true, false]);
        assert.equal(store.busy, false);
        assert.equal(await store.read(), snapshot);
      } finally { subscription.dispose(); }
    });
  } finally { store.dispose(); }
}
