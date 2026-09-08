import assert = require('node:assert/strict');
import { test } from 'node:test';
import { ReviewComment } from '../src/model';
import { parse } from '../src/parser';
import { appendComment, deleteComment, editComment, rewriteLines } from '../src/writer';
import { resolveAnchor } from '../src/anchor';

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return { path: 'src/example.ts', origin: 'changed', side: 'document', startLine: 2, endLine: 3,
    anchorText: '  first();\n  second();', body: 'First paragraph.\n\nSecond paragraph.', ...overrides };
}

test('append round-trips multiline comments and keeps duplicate identities', () => {
  const first = appendComment('', comment(), 'abcdef1');
  const text = appendComment(first, comment());
  assert.ok(text.startsWith(first));
  const parsed = parse(text);
  assert.equal(parsed.base, 'abcdef1');
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.comments.length, 2);
  assert.equal(parsed.comments[0].body, comment().body);
  assert.equal(parsed.comments[0].anchorText, comment().anchorText);
  assert.equal(parsed.comments[1].index, 1);
  assert.notEqual(parsed.comments[0].startOffset, parsed.comments[1].startOffset);
  const edited = editComment(text, parsed.comments[1], 'Only the second');
  assert.ok(edited.startsWith(first));
  assert.equal(parse(edited).comments[0].body, comment().body);
  assert.equal(parse(edited).comments[1].body, 'Only the second');
});

test('UTF-8 BOM preserves base recognition and exact comment splice offsets', () => {
  const withBase = '\uFEFF' + appendComment('', comment(), 'abcdef1');
  assert.equal(parse(withBase).base, 'abcdef1');
  assert.equal(parse(withBase).comments.length, 1);
  const text = '\uFEFF' + appendComment('', comment());
  const parsed = parse(text).comments[0];
  assert.equal(parsed.startOffset, 1);
  const edited = editComment(text, parsed, 'Updated feedback');
  assert.ok(edited.startsWith('\uFEFF## File:'));
  assert.equal(parse(edited).comments[0].body, 'Updated feedback');
  assert.equal(parse(edited).comments[0].anchorText, comment().anchorText);
  assert.equal(deleteComment(text, parsed), '\uFEFF');
});

test('longer fences safely contain markdown snippets and nested heading text', () => {
  const snippet = '````md\n## File: `fake`; Lines: 1; Origin: head; Side: document\n```\n~~~~\n````';
  const body = 'Explanation\n\n~~~~~md\n## not a comment\n~~~\n~~~~~\n\nMore prose.';
  const text = appendComment('', comment({ anchorText: snippet, body }));
  assert.ok(text.includes('\n`````\n'));
  assert.equal(parse(text).comments.length, 1);
  assert.equal(parse(text).comments[0].anchorText, snippet);
  assert.equal(parse(text).comments[0].body, body);
});

test('tilde anchor accepts a longer close and ignores shorter fences', () => {
  const text = '## File: `a`; Lines: 1; Origin: head; Side: document\n\n~~~~js\n~~~\n## inside\n~~~~~\n\nbody\n';
  assert.equal(parse(text).comments[0].anchorText, '~~~\n## inside');
  assert.equal(parse(text).comments[0].body, 'body');
});

test('CRLF metadata and unknown blocks survive targeted body edits and range rewriting', () => {
  const prefix = '# Notes\r\n\r\nKeep these bytes \u2603\r\n\r\n';
  const header = '## File : `src\\example.ts` ; Lines : 2 - 3 ; Origin : CHANGED ; Side : RIGHT\r\n';
  const metadata = '\r\n```ts\r\n  first();\r\n  second();\r\n```\r\n\r\nComparison : Left : `old.ts` (HEAD) ; Right : `src\\example.ts` (CHANGED)\r\n\r\n';
  const suffix = '\r\n\r\n## Unknown section\r\nOpaque text  \r\n';
  const text = prefix + header + metadata + 'old\r\nbody' + suffix;
  const parsed = parse(text).comments[0];
  assert.equal(parsed.path, 'src/example.ts');
  assert.equal(parsed.origin, 'changed');
  assert.equal(parsed.side, 'right');
  assert.equal(parsed.anchorText, '  first();\r\n  second();');
  assert.equal(editComment(text, parsed, 'new\n\nbody'), prefix + header + metadata + 'new\r\n\r\nbody' + suffix);
  assert.equal(rewriteLines(text, parsed, 8, 9), text.replace('2 - 3', '8-9'));
  const appended = appendComment(text, comment());
  assert.ok(appended.startsWith(text));
  assert.equal(appended.replace(/\r\n/g, '').includes('\n'), false);
});

test('delete removes precisely one separator blank line and leaves extra separators', () => {
  const block = appendComment('', comment());
  const suffix = '\n\n\n## Unknown\nuntouched\n';
  const text = 'preamble\n\n' + block + suffix;
  assert.equal(deleteComment(text, parse(text).comments[0]), 'preamble\n\n\n\n## Unknown\nuntouched\n');
});

test('invalid fields and comparison metadata remain opaque', () => {
  const good = '## File: `a`; Lines: 1; Origin: changed; Side: document';
  const invalid = [
    good.replace('Lines: 1', 'Lines: nope'), good.replace('Lines: 1', 'Lines: 0'),
    good.replace('Lines: 1', 'Lines: 4-2'), good.replace('Lines: 1', 'Lines: 9007199254740992'),
    good.replace('; Origin: changed', ''), good.replace('; Side: document', ''),
    good.replace('document', 'original'), good.replace('changed', 'commit:abc'),
    good.replace('`a`', '`../secret`'), good.replace('`a`', '`/absolute`'),
    good.replace('`a`', '`C:\\absolute`'), good.replace('`a`', '`a\\..\\secret`'),
    good.replace('`a`', '`a//b`'), good.replace('`a`', '`./a`'),
    good.replace('document', 'left'),
    good + '\nComparison: nonsense',
    good + '\nComparison: Left: `a` (head); Right: `a` (changed)',
    good.replace('document', 'left') + '\nComparison: Left: `b` (changed); Right: `a` (changed)',
    good.replace('document', 'right') + '\nComparison: Left: `../bad` (head); Right: `a` (changed)',
  ];
  for (const block of invalid) {
    const text = block + '\n\nKeep me\n\n';
    const parsed = parse(text);
    assert.equal(parsed.comments.length, 0, block);
    assert.equal(parsed.diagnostics.length, 1, block);
    assert.ok(parsed.diagnostics[0].line >= 1);
    assert.ok(appendComment(text, comment()).startsWith(text));
  }
});

test('both comparison sides and full SHA origins are distinct and validated', () => {
  const comparison = { left: { path: 'old.ts', origin: `commit:${'a'.repeat(40)}` as const },
    right: { path: 'new.ts', origin: `commit:${'b'.repeat(64)}` as const } };
  let text = '';
  for (const side of ['left', 'right'] as const) {
    text = appendComment(text, comment({ ...comparison[side], side, comparison }));
  }
  const parsed = parse(text);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.comments.map(item => item.side), ['left', 'right']);
  assert.deepEqual(parsed.comments[0].comparison, comparison);
  assert.throws(() => appendComment('', comment({ path: '../outside' })));
  assert.throws(() => appendComment('', comment({ side: 'left' })));
  assert.throws(() => appendComment('', comment({ comparison })));
});

test('only an immediately following fence or metadata line has special meaning', () => {
  const body = 'Prose first\n\n```md\n## inside\n```\n\nComparison: ordinary prose';
  const text = appendComment('', comment({ anchorText: undefined, body }));
  const parsed = parse(text);
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.comments[0].anchorText, undefined);
  assert.equal(parsed.comments[0].body, body);
  assert.equal(parsed.comments[0].comparison, undefined);
  const bare = '## File: `a`; Lines: 100; Origin: head; Side: document';
  assert.equal(parse(bare).comments.length, 1);
  assert.equal(parse(editComment(bare, parse(bare).comments[0], 'new')).comments[0].body, 'new');
});

test('writer rejects stale offsets, reserved body structure and unterminated fences', () => {
  const text = appendComment('', comment());
  const parsed = parse(text).comments[0];
  assert.throws(() => editComment('prefix' + text, parsed, 'new'));
  assert.throws(() => deleteComment('prefix' + text, parsed));
  assert.throws(() => rewriteLines(text, parsed, 0, 2));
  assert.throws(() => appendComment('```\nopaque', comment()));
  assert.throws(() => editComment(text, parsed, '```\nunclosed'));
  assert.throws(() => editComment(text, parsed, '## accidental block'));
  assert.throws(() => editComment(text, parsed, 'Comparison: invalid'));
  assert.throws(() => appendComment('', comment({ anchorText: undefined, body: '```\ncode\n```' })));
  const malformed = '## File: `a`; Lines: 1; Origin: head; Side: document\n\n```\nnot closed';
  assert.equal(parse(malformed).comments.length, 0);
  assert.match(parse(malformed).diagnostics[0].message, /unterminated/);
  const unclosedBody = text + '\nProse\n\n~~~\n## still fenced';
  assert.equal(parse(unclosedBody).comments.length, 0);
  assert.match(parse(unclosedBody).diagnostics[0].message, /unterminated/);
});

test('empty body edits preserve metadata and repeated edits remain parseable', () => {
  for (const anchorText of [undefined, 'code']) {
    let text = appendComment('', comment({ anchorText, body: '' }));
    text = editComment(text, parse(text).comments[0], 'new\n\nparagraph');
    assert.equal(parse(text).comments[0].body, 'new\n\nparagraph');
    assert.equal(parse(text).comments[0].anchorText, anchorText);
    text = editComment(text, parse(text).comments[0], '');
    assert.equal(parse(text).comments[0].body, '');
    assert.equal(parse(text).comments[0].anchorText, anchorText);
    text = editComment(text, parse(text).comments[0], 'restored');
    assert.equal(parse(text).comments[0].body, 'restored');
  }
});

test('empty and newline-terminated anchors retain exact captured content', () => {
  for (const anchorText of ['', 'line\n', 'line\n\n', '\n']) {
    const text = appendComment('', comment({ anchorText }));
    assert.equal(parse(text).comments[0].anchorText, anchorText);
  }
});

test('anchor resolution handles exact, local, whole-file, trailing whitespace and deletion', () => {
  const anchor = comment();
  assert.deepEqual(resolveAnchor(anchor, 'before\n  first();\n  second();\nafter'),
    { startLine: 2, endLine: 3, confidence: 'high' });
  assert.deepEqual(resolveAnchor(anchor, 'inserted\n'.repeat(10) + 'before\n  first(); \r\n  second();\t\n'),
    { startLine: 12, endLine: 13, confidence: 'high' });
  assert.deepEqual(resolveAnchor(anchor, 'inserted\n'.repeat(100) + '  first();\n  second();'),
    { startLine: 101, endLine: 102, confidence: 'high' });
  assert.equal(resolveAnchor(anchor, 'deleted'), undefined);
  assert.deepEqual(resolveAnchor(comment({ anchorText: undefined, startLine: 100, endLine: 101 }), ''),
    { startLine: 100, endLine: 101, confidence: 'low' });
});

test('indentation fallback strips common indentation, not relative indentation', () => {
  const anchor = comment({ anchorText: '  if (ok) {\n    go();\n  }', startLine: 1, endLine: 3 });
  assert.deepEqual(resolveAnchor(anchor, 'intro\n      if (ok) {\n        go();\n      }'),
    { startLine: 2, endLine: 4, confidence: 'high' });
  assert.equal(resolveAnchor(anchor, 'if (ok) {\ngo();\n}'), undefined);
});

test('ambiguous anchors choose nearest with low confidence, exact position takes priority', () => {
  const anchor = comment({ anchorText: 'hit', startLine: 5, endLine: 5 });
  const content = 'hit\nx\nx\nx\nx\nhit\nx\nx\nhit';
  assert.deepEqual(resolveAnchor(anchor, content), { startLine: 6, endLine: 6, confidence: 'low' });
  assert.deepEqual(resolveAnchor(anchor, content, 1), { startLine: 6, endLine: 6, confidence: 'high' });
  assert.deepEqual(resolveAnchor({ ...anchor, startLine: 1, endLine: 1 }, content),
    { startLine: 1, endLine: 1, confidence: 'high' });
});

test('elided anchors resolve both endpoints including changes to omitted length', () => {
  const selected = Array.from({ length: 30 }, (_, index) => `  line${index + 1}`);
  const anchorText = [...selected.slice(0, 10), '...', ...selected.slice(-5)].join('\n');
  const anchor = comment({ startLine: 1, endLine: 30, anchorText });
  assert.deepEqual(resolveAnchor(anchor, selected.join('\n')), { startLine: 1, endLine: 30, confidence: 'high' });
  const changed = ['intro', ...selected.slice(0, 12), 'new middle', ...selected.slice(12)];
  assert.deepEqual(resolveAnchor(anchor, changed.join('\n')), { startLine: 2, endLine: 32, confidence: 'high' });
  assert.deepEqual(resolveAnchor(anchor, changed.map(line => `    ${line}`).join('\n')),
    { startLine: 2, endLine: 32, confidence: 'high' });
  assert.equal(resolveAnchor(anchor, selected.slice(0, 25).join('\n')), undefined);
  const duplicate = ['intro', ...selected, 'between', ...selected].join('\n');
  assert.equal(resolveAnchor(anchor, duplicate)?.confidence, 'low');
});

test('literal ellipsis is not elision for a short selection or another snippet shape', () => {
  const anchor = comment({ startLine: 1, endLine: 3, anchorText: 'first\n...\nlast' });
  assert.equal(resolveAnchor(anchor, 'first\nanything\nlast'), undefined);
  assert.deepEqual(resolveAnchor(anchor, 'first\n...\nlast'), { startLine: 1, endLine: 3, confidence: 'high' });
  assert.equal(resolveAnchor({ ...anchor, endLine: 30 }, 'first\nanything\nlast'), undefined);
});
