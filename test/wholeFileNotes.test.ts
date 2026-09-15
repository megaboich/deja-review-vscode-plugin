import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAnchor } from '../src/anchor';
import { parse } from '../src/parser';
import { appendComment, appendGeneralNote, deleteComment, editComment, rewriteLines } from '../src/writer';

test('whole-file notes round-trip explicit scope and arbitrary bodies without anchors', () => {
  for (const body of ['File-wide feedback', '```ts\ncode\n```', '## Heading\nSelected: prose', '\n significant \n']) {
    const text = appendComment('', {
      wholeFile: true, path: 'src/a.ts', startLine: 1, endLine: 1, origin: 'changed', side: 'document', body,
    });
    assert.ok(text.startsWith('## `src/a.ts`:file\nSelected: Working tree\n'));
    const parsed = parse(text);
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.comments.length, 1);
    const note = parsed.comments[0];
    assert.equal(note.wholeFile, true);
    assert.equal(note.body, body);
    assert.equal(note.anchorText, undefined);
    assert.equal(resolveAnchor(note, 'arbitrary source'), undefined);
    assert.throws(() => rewriteLines(text, note, 2, 4), /no line numbers/);
  }
});

test('whole-file body edits and deletion preserve BOM, CRLF, siblings and scope', () => {
  const prefix = appendGeneralNote('\uFEFF# Preamble\r\n', 'Keep this');
  const text = appendComment(prefix, {
    wholeFile: true, path: 'image.png', startLine: 1, endLine: 1, origin: 'changed', side: 'document', body: 'Original',
  });
  const edited = editComment(text, parse(text).comments[0], '## New body\nline');
  assert.ok(edited.startsWith(prefix));
  assert.equal(parse(edited).comments[0].wholeFile, true);
  assert.equal(parse(edited).comments[0].body, '## New body\r\nline');
  assert.equal(deleteComment(edited, parse(edited).comments[0]), text.slice(0, parse(text).comments[0].startOffset));
});

test('whole-file notes reject anchors, elision and comparison metadata rather than guessing', () => {
  for (const block of [
    '## `a`:file; Snippet: elided\nSelected: Working tree\n\nBody\n',
    '## `a`:file\nSelected: Working tree\n\n```\nanchor\n```\nBody\n',
    '## `a`:file\nComparison: HEAD -> Working tree\nSelected: Modified (Working tree)\nBody\n',
  ]) {
    const parsed = parse(block);
    assert.equal(parsed.comments.length, 0);
    assert.equal(parsed.diagnostics.length, 1);
  }
});
