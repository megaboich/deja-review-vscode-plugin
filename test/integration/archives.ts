import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { ReviewArchives } from '../../src/archive';
import type { ReviewArchive } from '../../src/archive';
import type { Repository } from '../../src/git';
import { HANDOFF_INSTRUCTION } from '../../src/handoff';
import type { ReviewComment } from '../../src/model';
import { parse } from '../../src/parser';
import { ReviewStore } from '../../src/store';
import { appendComment } from '../../src/writer';

export async function testArchives(
  repo: Repository,
  storageUri: vscode.Uri,
  comment: ReviewComment,
  test: (name: string, operation: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const archives = new ReviewArchives(storageUri, repo.rootUri);
  const store = new ReviewStore(repo, archives);
  const base = '0123456789ab';
  const valid = appendComment(appendComment('', { ...comment, body: 'First archived comment' }, base),
    { ...comment, body: 'Second archived comment' });
  const snapshot = `\uFEFF${valid.replace(/\n/g, '\r\n')}\r\n## \`broken\`:nope\r\n  Keep malformed feedback verbatim.\r\n`;
  const records: ReviewArchive[] = [];
  try {
    await test('durable archive metadata, exact BOM and malformed text, newest ten of twelve with older IDs retained', async () => {
      assert.deepEqual(await archives.list(), []);
      assert.ok(snapshot.startsWith('\uFEFF# Review'));
      assert.equal(parse(snapshot).base, base);
      assert.equal(parse(snapshot).comments.length, 2);
      assert.ok(parse(snapshot).diagnostics.length > 0);
      for (let index = 0; index < 12; index++) {
        const before = Date.now();
        const record = await archives.save(`${snapshot}${index}\r\n`);
        assert.deepEqual(Object.keys(record).sort(), ['commentCount', 'createdAt', 'id']);
        assert.equal(record.commentCount, 2);
        assert.equal(new Date(record.createdAt).toISOString(), record.createdAt);
        assert.ok(Date.parse(record.createdAt) >= before && Date.parse(record.createdAt) <= Date.now());
        records.push(record);
        // Distinct times make descending-date assertions independent of UUID tie-breaking.
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      assert.equal(new Set(records.map(record => record.id)).size, 12);
      const fresh = new ReviewArchives(storageUri, repo.rootUri);
      const listed = await fresh.list();
      assert.deepEqual(listed, records.slice(2).reverse());
      for (const [index, record] of records.entries()) {
        const text = await fresh.read(record.id);
        assert.deepEqual(new TextEncoder().encode(text), new TextEncoder().encode(`${snapshot}${index}\r\n`));
        assert.equal(parse(text).base, base);
        assert.deepEqual(parse(text).comments.map(item => item.anchorText), [comment.anchorText, comment.anchorText]);
      }
    });

    await test('archives isolate repository identities and reject unknown or unsafe IDs', async () => {
      const other = new ReviewArchives(storageUri, vscode.Uri.joinPath(repo.rootUri, 'other-repository'));
      assert.deepEqual(await other.list(), []);
      await assert.rejects(() => other.read(records[0].id));
      const separate = await other.save('Other repository feedback');
      await assert.rejects(() => archives.read(separate.id));
      assert.equal(await other.read(separate.id), 'Other repository feedback');
      await assert.rejects(() => archives.read(randomUUID()));
      for (const id of ['../REVIEW-NOTES.md', '%2e%2e%2fREVIEW-NOTES.md', '', `${records[0].id}\n`]) {
        await assert.rejects(() => archives.read(id), /Invalid review archive ID/);
      }
      await assert.rejects(() => archives.save(' \r\n\t'), /empty review feedback/);
      assert.deepEqual(await archives.list(), records.slice(2).reverse());
    });

    await test('restore preserves active feedback, allows whitespace, and rejects a real dirty buffer without prompting', async () => {
      const id = records[0].id;
      const expected = `${snapshot}0\r\n`;
      assert.equal(await store.read(), undefined);
      assert.equal(await store.restore(id), true, 'Older IDs outside the displayed ten remain recoverable');
      assert.equal(await store.read(), expected);
      assert.equal((await store.load()).parsed.base, base);
      await vscode.workspace.fs.writeFile(store.uri, new TextEncoder().encode('Saved active feedback\r\n'));
      assert.equal(await store.restore(id), false);
      assert.equal(await store.read(), 'Saved active feedback\r\n');
      const whitespace = ' \r\n\t\r\n';
      await vscode.workspace.fs.writeFile(store.uri, new TextEncoder().encode(whitespace));
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(store.uri), { preview: false });
      try {
        assert.ok(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'Unsaved feedback')));
        assert.equal(editor.document.isDirty, true);
        const dirty = editor.document.getText();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await assert.rejects(() => Promise.race([store.restore(id), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Restore waited for a prompt')), 5_000);
          })]), /unsaved changes.*before recovering an archive/);
        } finally {
          if (timer !== undefined) { clearTimeout(timer); }
        }
        assert.equal(editor.document.isDirty, true);
        assert.equal(editor.document.getText(), dirty);
        assert.equal(await store.read(), whitespace);
      } finally {
        await vscode.window.showTextDocument(editor.document);
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      assert.equal(editor.document.isDirty, false);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      assert.equal(await store.restore(id), true, 'A failed restore must not poison the operation queue');
      assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(store.uri)), Buffer.from(expected));
      assert.equal(await new ReviewArchives(storageUri, repo.rootUri).read(id), expected);
      await vscode.workspace.fs.delete(store.uri);
    });

    await test('real clipboard archive failure retains saved bytes and reports clipboardCopied; invalid UTF-8 is not copied', async () => {
      const failure = new Error('Injected archive storage failure');
      class FailingArchives extends ReviewArchives {
        override async save(text: string): Promise<ReviewArchive> {
          assert.equal(text, snapshot);
          throw failure;
        }
      }
      const failing = new ReviewStore(repo, new FailingArchives(storageUri, repo.rootUri));
      const previousClipboard = await vscode.env.clipboard.readText();
      const previousArchives = await archives.list();
      try {
        await vscode.workspace.fs.writeFile(store.uri, new TextEncoder().encode(snapshot));
        const result = await failing.handoff();
        assert.equal(result.status, 'archiveFailed');
        assert.equal(result.clipboardCopied, true);
        assert.ok('error' in result);
        assert.equal(result.error, failure);
        assert.equal(await vscode.env.clipboard.readText(), `${HANDOFF_INSTRUCTION}\n\n${snapshot}`);
        assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(store.uri)), Buffer.from(snapshot));
        assert.deepEqual(await archives.list(), previousArchives);
        const invalid = new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0x28]);
        await vscode.workspace.fs.writeFile(store.uri, invalid);
        const unreadable = await store.handoff();
        assert.equal(unreadable.status, 'readFailed');
        assert.equal(unreadable.clipboardCopied, false);
        assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(store.uri)), Buffer.from(invalid));
        assert.equal(await vscode.env.clipboard.readText(), `${HANDOFF_INSTRUCTION}\n\n${snapshot}`);
        assert.deepEqual(await archives.list(), previousArchives);
      } finally {
        failing.dispose();
        await vscode.env.clipboard.writeText(previousClipboard);
        await vscode.workspace.fs.delete(store.uri);
      }
    });

    await test('busy events release mutations after success, no-op, failure, and restore blocked by saved feedback', async () => {
      const fixture = vscode.Uri.joinPath(storageUri, `busy-${randomUUID()}`);
      await vscode.workspace.fs.createDirectory(fixture);
      const isolatedArchives = new ReviewArchives(fixture, fixture);
      const isolated = new ReviewStore({ ...repo, rootUri: fixture }, isolatedArchives);
      const events: boolean[] = [];
      const subscription = isolated.onDidChangeBusy(() => events.push(isolated.busy));
      try {
        assert.equal(isolated.busy, false);
        assert.deepEqual(events, []);
        const archived = await isolatedArchives.save('Archived feedback must not replace saved feedback');
        const failure = new Error('Injected mutation failure');
        const cases: [string, () => Promise<boolean>, boolean | Error][] = [
          ['success', () => isolated.mutate(() => snapshot), true],
          ['no-op', () => isolated.mutate(text => text), false],
          ['failure', () => isolated.mutate(() => { throw failure; }), failure],
          ['blocked restore', () => isolated.restore(archived.id), false],
        ];
        for (const [name, operation, expected] of cases) {
          events.length = 0;
          const pending = operation();
          assert.equal(isolated.busy, true, `${name} starts busy`);
          assert.deepEqual(events, [true], `${name} announces busy before returning`);
          if (expected instanceof Error) {
            await assert.rejects(pending, error => error === expected);
          } else {
            assert.equal(await pending, expected, name);
          }
          assert.equal(isolated.busy, false, `${name} releases busy`);
          assert.deepEqual(events, [true, false], `${name} announces completion`);
          assert.equal(await isolated.read(), snapshot, `${name} preserves saved feedback`);
        }
      } finally {
        subscription.dispose();
        isolated.dispose();
        await vscode.workspace.fs.delete(fixture, { recursive: true, useTrash: false });
      }
    });
  } finally {
    store.dispose();
  }
}
