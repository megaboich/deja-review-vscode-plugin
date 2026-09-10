import assert = require('node:assert/strict');
import { test } from 'node:test';
import { normalizeResource } from '../src/model';
import type { ReviewComment } from '../src/model';
import { parse, scanMarkdown } from '../src/parser';
import { appendComment, deleteComment, editComment, rewriteLines, rewriteLinesBatch } from '../src/writer';
import { resolveAnchor } from '../src/anchor';

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: 'src/example.ts',
    origin: 'changed',
    side: 'document',
    startLine: 2,
    endLine: 3,
    anchorText: '  first();\n  second();',
    body: 'First paragraph.\n\nSecond paragraph.',
    ...overrides,
  };
}

test('resource origin normalization preserves the existing runtime string schema', () => {
  for (const [origin, expected] of [
    ['CHANGED', 'changed'], ['StAgEd', 'staged'], ['HEAD', 'head'],
    [`COMMIT:${'A'.repeat(40)}`, `commit:${'a'.repeat(40)}`],
    [`commit:${'B'.repeat(64)}`, `commit:${'b'.repeat(64)}`],
  ]) {
    // Exercise runtime strings without asserting that unvalidated input is already an Origin.
    const input = { path: 'src\\file.ts', origin, extra: 'ignored' };
    assert.deepEqual(Reflect.apply(normalizeResource, undefined, [input]), { path: 'src/file.ts', origin: expected });
  }
  for (const origin of ['', 'HEAD ', ' head', 'Working tree', 'commit:abc',
    `commit:${'a'.repeat(41)}`, `commit:${'g'.repeat(40)}`]) {
    assert.throws(() => Reflect.apply(normalizeResource, undefined, [{ path: 'src/file.ts', origin }]), /invalid Origin/);
  }
});

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
  assert.ok(edited.startsWith('\uFEFF## `'));
  assert.equal(parse(edited).comments[0].body, 'Updated feedback');
  assert.equal(parse(edited).comments[0].anchorText, comment().anchorText);
  assert.equal(deleteComment(text, parsed), '\uFEFF');
});

test('semantic base SHA is lowercase without rewriting the preamble', () => {
  const text = '\uFEFF' + appendComment('', comment(), 'ABCDEF1');
  assert.equal(parse(text).base, 'abcdef1');
  assert.ok(editComment(text, parse(text).comments[0], 'new').startsWith('\uFEFF# Review \u00b7 base ABCDEF1\n'));
});

test('range rewriting does not mistake Lines text inside a path for metadata', () => {
  const text = appendComment('', comment({ path: 'src/a; Lines: 999 - 1000.ts' }));
  const parsed = parse(text).comments[0];
  assert.equal(text.slice(parsed.rangeStartOffset, parsed.rangeEndOffset), '2-3');
  const rewritten = rewriteLines(text, parsed, 10, 12);
  assert.equal(rewritten, text.replace('`:2-3', '`:10-12'));
  assert.equal(parse(rewritten).comments[0].path, parsed.path);
});

test('batch rewriting preserves duplicate identities and rejects stale or repeated entries', () => {
  const text = '\uFEFF' + appendComment(appendComment('', comment()), comment()).replace(/\n/g, '\r\n');
  const comments = parse(text).comments;
  const updates = comments.map((item, index) => ({ comment: item, start: 100 + index, end: 200 + index }));
  const rewritten = rewriteLinesBatch(text, updates);
  assert.equal(rewritten, text.replace('`:2-3', '`:100-200').replace('`:2-3', '`:101-201'));
  assert.equal(rewriteLinesBatch(text, [...updates].reverse()), rewritten);
  assert.deepEqual(parse(rewritten).comments.map(item => [item.startLine, item.endLine]), [[100, 200], [101, 201]]);
  assert.throws(() => rewriteLinesBatch('prefix' + text, updates), /changed on disk/);
  assert.throws(() => rewriteLinesBatch(text, [updates[0], updates[0]]), /twice/);
  assert.throws(() => rewriteLinesBatch(text, [{ ...updates[1], start: 0 }]), /positive/);
  assert.equal(rewriteLinesBatch(text, []), text);
});

test('longer fences safely contain markdown snippets and nested heading text', () => {
  const snippet = '````md\n## `fake`:1\nSelected: HEAD\n```\n~~~~\n````';
  const body = 'Explanation\n\n~~~~~md\n## not a comment\n~~~\n~~~~~\n\nMore prose.';
  const text = appendComment('', comment({ anchorText: snippet, body }));
  assert.ok(text.includes('\n`````\n'));
  assert.equal(parse(text).comments.length, 1);
  assert.equal(parse(text).comments[0].anchorText, snippet);
  assert.equal(parse(text).comments[0].body, body);
});

test('tilde anchor accepts a longer close and ignores shorter fences', () => {
  const text = '## `a`:1\nSelected: HEAD\n\n~~~~js\n~~~\n## inside\n~~~~~\n\nbody\n';
  assert.equal(parse(text).comments[0].anchorText, '~~~\n## inside');
  assert.equal(parse(text).comments[0].body, 'body');
});

test('CRLF metadata and unknown blocks survive targeted body edits and range rewriting', () => {
  const prefix = '# Notes\r\n\r\nKeep these bytes \u2603\r\n\r\n';
  const header = '## `src\\example.ts` : 2 - 3\r\n';
  const metadata = '\r\nCOMPARISON : `old.ts` (HEAD) -> `src\\example.ts` (WORKING TREE)\r\n\r\nSELECTED : MODIFIED (WORKING TREE)\r\n\r\n```ts\r\n  first();\r\n  second();\r\n```\r\n\r\n';
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

test('bare CR lines preserve Markdown offsets and normalize source and anchor splits', () => {
  const text = '\uFEFF' + appendComment('', comment(), 'ABCDEF1').replace(/\n/g, '\r');
  const parsed = parse(text);
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.base, 'abcdef1');
  assert.equal(parsed.comments[0].anchorText, '  first();\r  second();');
  const edited = editComment(text, parsed.comments[0], 'new\r\nbody\nend');
  assert.equal(edited, text.replace('First paragraph.\r\rSecond paragraph.', 'new\rbody\rend'));
  assert.equal(rewriteLines(text, parsed.comments[0], 8, 9), text.replace('`:2-3', '`:8-9'));
  assert.equal(deleteComment(text, parsed.comments[0]), '\uFEFF# Review \u00b7 base ABCDEF1\r\r');
  const appended = appendComment(text, comment({ anchorText: 'one\rtwo' }));
  assert.equal(appended.includes('\n'), false);
  assert.equal(parse(appended).comments[1].anchorText, 'one\rtwo');
  for (const anchorText of ['  first();\r  second();', '  first();\n  second();', '  first();\r\n  second();']) {
    for (const eol of ['\r', '\n', '\r\n']) {
      assert.deepEqual(resolveAnchor(comment({ anchorText }), ['intro', '  first();', '  second();'].join(eol)),
        { startLine: 2, endLine: 3, confidence: 'high' });
    }
  }
  for (const eol of ['\r', '\n', '\r\n']) {
    const prefix = 'preamble' + eol;
    assert.ok(appendComment(prefix, comment()).startsWith(prefix + eol + '## `'));
    const appended = appendComment(prefix, comment({ body: 'prose\r## hidden heading' }));
    assert.deepEqual(parse(appended).diagnostics, []);
    assert.equal(parse(appended).comments[0].body, `prose${eol}## hidden heading`);
  }
});

test('delete removes precisely one separator blank line and leaves extra separators', () => {
  const block = appendComment('', comment());
  const suffix = '\n\n\n## Unknown\nuntouched\n';
  const text = 'preamble\n\n' + block + suffix;
  assert.equal(deleteComment(text, parse(text).comments[0]), 'preamble\n\n\n\n## Unknown\nuntouched\n');
});

test('the shared scanner treats bare second-level headings as boundaries only outside fences', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const text = '\uFEFF' + ['##', '## ', '##\t', '## Unknown', '###', '##literal',
      '```markdown', '##', '```', '~~~~', '##', '~~~~', '##'].join(eol);
    const scanned = scanMarkdown(text);
    assert.equal(scanned.openFence, false);
    assert.deepEqual(scanned.lines.filter(line => line.heading).map(line => line.text),
      ['##', '## ', '##\t', '## Unknown', '##']);
    for (const line of scanned.lines) {
      assert.equal(text.slice(line.start, line.end), line.text);
    }
  }
});

test('writer rejects lone surrogates in new bodies, paths, anchors and edited bodies', () => {
  const text = appendComment('', comment());
  const parsed = parse(text).comments[0];
  for (const invalid of ['\uD800', '\uDBFF', '\uDC00', '\uDFFF', '\uD800x', 'x\uDC00',
    '\uD800\uD800', '\uDC00\uD800', '\uD800\uDC00\uD800']) {
    assert.throws(() => appendComment('', comment({ body: invalid })), /unpaired UTF-16 surrogate/);
    assert.throws(() => appendComment('', comment({ path: `src/${invalid}.ts` })), /unpaired UTF-16 surrogate/);
    assert.throws(() => appendComment('', comment({ anchorText: invalid })), /unpaired UTF-16 surrogate/);
    assert.throws(() => editComment(text, parsed, invalid), /unpaired UTF-16 surrogate/);
  }
});

test('invalid fields and comparison metadata remain opaque', () => {
  const good = '## `a`:1\nSelected: Working tree';
  const invalid = [
    good.replace(':1', ':nope'), good.replace(':1', ':0'),
    good.replace(':1', ':4-2'), good.replace(':1', ':9007199254740992'),
    good.replace('\nSelected: Working tree', ''), good.replace('Working tree', 'Original'),
    good.replace('Working tree', 'Commit abc'),
    good.replace('`a`', '`../secret`'), good.replace('`a`', '`/absolute`'),
    good.replace('`a`', '`C:\\absolute`'), good.replace('`a`', '`a\\..\\secret`'),
    good.replace('`a`', '`a//b`'), good.replace('`a`', '`./a`'),
    good + '; Original',
    good + '; nonsense',
    good.replace('Selected: Working tree', 'Working tree'),
    good.replace('Selected: Working tree', 'Working tree; HEAD -> Working tree'),
    good.replace('Selected: Working tree', 'Comparison: HEAD -> Staging area'),
    good.replace('Selected: Working tree', 'Comparison: HEAD -> Staging area\nSelected: Original'),
    good.replace('Selected: Working tree', 'Comparison: HEAD -> Staging area\nSelected: HEAD'),
    good.replace('Selected: Working tree', 'Comparison: HEAD -> Staging area\nSelected: Modified (HEAD)'),
    good.replace('Selected: Working tree', 'Comparison: `b` (Working tree) -> `a` (Working tree)\nSelected: Original (Working tree)'),
    good.replace('Selected: Working tree', 'Comparison: `../bad` (HEAD) -> `a` (Working tree)\nSelected: Modified (Working tree)'),
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

test('only a fence immediately after context has anchor meaning', () => {
  const body = 'Prose first\n\n```md\n## inside\n```\n\nComparison: ordinary prose\nSelected: ordinary prose';
  const text = `## \`src/example.ts\`:2-3\nSelected: Working tree\n\n${body}\n`;
  const parsed = parse(text);
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.comments[0].anchorText, undefined);
  assert.equal(parsed.comments[0].body, body);
  assert.equal(parsed.comments[0].comparison, undefined);
  const bare = '## `a`:100\nSelected: HEAD';
  assert.equal(parse(bare).comments.length, 1);
  assert.equal(parse(editComment(bare, parse(bare).comments[0], 'new')).comments[0].body, 'new');
});

test('writer rejects stale offsets and preexisting unterminated fences, not composer fences', () => {
  const text = appendComment('', comment());
  const parsed = parse(text).comments[0];
  assert.throws(() => editComment('prefix' + text, parsed, 'new'));
  assert.throws(() => deleteComment('prefix' + text, parsed));
  assert.throws(() => rewriteLines(text, parsed, 0, 2));
  for (const fence of ['```', '~~~~', '`````']) {
    assert.throws(() => appendComment(`${fence}\nopaque`, comment()), /unterminated fence/);
  }
  for (const body of ['```\nunclosed', '## accidental block', '```\ncode\n```']) {
    for (const updated of [editComment(text, parsed, body),
      appendComment('', comment({ anchorText: undefined, body }))]) {
      const result = parse(updated);
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.comments.length, 1);
      assert.equal(result.comments[0].body, body);
    }
  }
  const malformed = '## `a`:1\nSelected: HEAD\n\n```\nnot closed';
  assert.equal(parse(malformed).comments.length, 0);
  assert.match(parse(malformed).diagnostics[0].message, /unterminated/);
  const unclosedBody = text + '\nProse\n\n~~~\n## still fenced';
  assert.equal(parse(unclosedBody).comments.length, 0);
  assert.match(parse(unclosedBody).diagnostics[0].message, /unterminated/);
});

test('writer round-trips unfenced reserved body lines and fenced metadata examples', () => {
  for (const anchorText of [undefined, 'code']) {
    const text = appendComment('', comment({ anchorText }));
    const parsed = parse(text).comments[0];
    for (const line of ['Comparison: ordinary prose', 'Selected: ordinary prose',
      'Body: fenced', 'Body: ordinary prose', '  bOdY \t: fenced',
      '  cOmPaRiSoN \t: HEAD -> Staging area', '\tsElEcTeD : Original (HEAD)']) {
      for (const eol of ['\n', '\r\n', '\r']) {
        for (const prefix of ['', `Prose${eol}${eol}`, `Prose${eol}~~~${eol}example${eol}~~~${eol}`]) {
          const body = prefix + line;
          for (const updated of [appendComment('', comment({ anchorText, body })), editComment(text, parsed, body)]) {
            const result = parse(updated);
            assert.deepEqual(result.diagnostics, []);
            assert.equal(result.comments.length, 1);
            assert.equal(result.comments[0].body, body.replace(/\r\n|\r|\n/g, '\n'));
            assert.equal(result.comments[0].anchorText, anchorText);
            assert.equal(result.comments[0].comparison, undefined);
          }
        }
      }
      for (const fence of ['```', '~~~', '````', '~~~~']) {
        const body = `Prose\n\n${fence}md\n${line}\n${fence}\n\nMore prose`;
        for (const updated of [appendComment('', comment({ anchorText, body })), editComment(text, parsed, body)]) {
          const result = parse(updated);
          assert.deepEqual(result.diagnostics, []);
          assert.equal(result.comments[0].body, body);
          assert.equal(result.comments[0].anchorText, anchorText);
        }
      }
    }
  }
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

test('arbitrary bodies survive append, targeted edit/delete and range rewrites without changing siblings', () => {
  const bodies = [
    '', 'Plain prose  ', '### Body heading', '## Heading', 'prose\r## Heading',
    'Comparison: HEAD -> Staging area\nSelected: Original (HEAD)', 'Selected: HEAD', 'Body: fenced',
    '```', '~~~\nunclosed', 'Prose\n````markdown\n```\n## still inside',
    '```md\ncode\n```', '~~~md\ncode\n~~~',
    '\n', '\r\n\r\n', ' \t', '\n\nleading', 'trailing\n\n', '\n \t\nbody\n \t\n',
    'first\rsecond\r\nthird\nfourth',
    '## `src/example.ts`:2-3\nSelected: Working tree\n\nFake sibling\n\n## Unknown\nKeep me',
    'Body: fenced\n````markdown\nBody: fenced\n```markdown\nnested\n```\n````',
    '\uFEFF', '\uFEFF## Heading\nSelected: HEAD', '\uFEFF```\ncode\n```',
    '\uFEFF\u96ea \ud83d\ude80 e\u0301\u2028literal\u2029text\u0000\tend  ',
  ];
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const bom of ['', '\uFEFF']) {
      for (const anchorText of [undefined, 'code\nsecond']) {
        for (const body of bodies) {
          const label = JSON.stringify({ eol, bom, anchorText, body });
          const prefix = bom + `# Review \u00b7 base ABCDEF1${eol}${eol}`;
          const first = appendComment(prefix, comment({ anchorText, body }));
          const second = appendComment(first, comment({ anchorText, body }));
          assert.ok(second.startsWith(first), label);
          const suffix = `${eol}${eol}## Unknown${eol}Opaque bytes  ${eol}`;
          const text = appendComment(second, comment({ anchorText, body })) + suffix;
          const parsed = parse(text);
          assert.deepEqual(parsed.diagnostics, [], label);
          assert.equal(parsed.base, 'abcdef1', label);
          assert.equal(parsed.comments.length, 3, label);
          const expectedBody = body.replace(/\r\n|\r|\n/g, eol);
          const expectedAnchor = anchorText?.replace(/\n/g, eol);
          for (const item of parsed.comments) {
            assert.equal(item.body, expectedBody, label);
            assert.equal(item.anchorText, expectedAnchor, label);
            assert.equal(text.slice(item.startOffset, item.endOffset), item.rawBlock, label);
            const replacement = `\n## Replacement\r\nSelected: literal\r\n\n`;
            const edited = editComment(text, item, replacement);
            const updated = parse(edited);
            assert.deepEqual(updated.diagnostics, [], label);
            assert.equal(updated.comments.length, 3, label);
            assert.ok(edited.startsWith(text.slice(0, item.bodyStartOffset)), label);
            assert.ok(edited.endsWith(text.slice(item.bodyEndOffset)), label);
            for (const sibling of updated.comments) {
              assert.equal(sibling.body, sibling.index === item.index
                ? replacement.replace(/\r\n|\r|\n/g, eol) : expectedBody, label);
              assert.equal(sibling.anchorText, expectedAnchor, label);
              if (sibling.index !== item.index) {
                assert.equal(sibling.rawBlock, parsed.comments[sibling.index].rawBlock, label);
              }
            }
            const deleted = deleteComment(text, item);
            assert.equal(deleted, text.slice(0, item.startOffset) + text.slice(item.deleteEndOffset), label);
            assert.deepEqual(parse(deleted).diagnostics, [], label);
            assert.deepEqual(parse(deleted).comments.map(sibling => sibling.rawBlock),
              parsed.comments.filter(sibling => sibling.index !== item.index).map(sibling => sibling.rawBlock), label);
            const rewritten = rewriteLines(text, item, 10, 12);
            assert.equal(rewritten, text.slice(0, item.rangeStartOffset) + '10-12' + text.slice(item.rangeEndOffset), label);
            assert.deepEqual(parse(rewritten).comments.map(sibling => sibling.body), Array(3).fill(expectedBody), label);
          }
          const updates = parsed.comments.map((item, index) => ({ comment: item, start: 20 + index, end: 30 + index }));
          const rewritten = rewriteLinesBatch(text, updates);
          assert.equal(rewriteLinesBatch(text, [...updates].reverse()), rewritten, label);
          let expected = text;
          for (const { comment: item, start, end } of [...updates].reverse()) {
            expected = expected.slice(0, item.rangeStartOffset) + `${start}-${end}` + expected.slice(item.rangeEndOffset);
          }
          assert.equal(rewritten, expected, label);
          assert.deepEqual(parse(rewritten).diagnostics, [], label);
          assert.deepEqual(parse(rewritten).comments.map(item => [item.startLine, item.endLine, item.body]),
            updates.map(update => [update.start, update.end, expectedBody]), label);
        }
      }
    }
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
  const anchor = comment({ startLine: 1, endLine: 30, anchorText, elided: true });
  assert.deepEqual(resolveAnchor(anchor, selected.join('\n')), { startLine: 1, endLine: 30, confidence: 'high' });
  const changed = ['intro', ...selected.slice(0, 12), 'new middle', ...selected.slice(12)];
  assert.deepEqual(resolveAnchor(anchor, changed.join('\n')), { startLine: 2, endLine: 32, confidence: 'high' });
  assert.deepEqual(resolveAnchor(anchor, changed.map(line => `    ${line}`).join('\n')),
    { startLine: 2, endLine: 32, confidence: 'high' });
  assert.equal(resolveAnchor(anchor, selected.slice(0, 25).join('\n')), undefined);
  const duplicate = ['intro', ...selected, 'between', ...selected].join('\n');
  assert.equal(resolveAnchor(anchor, duplicate)?.confidence, 'low');
});

test('explicit elisions round-trip shortened ranges and subsequent growth', () => {
  const selected = Array.from({ length: 30 }, (_, index) => `line${index + 1}`);
  const anchorText = [...selected.slice(0, 10), '...', ...selected.slice(-5)].join('\r');
  const text = appendComment('', comment({ startLine: 1, endLine: 30, anchorText, elided: true }));
  const parsed = parse(text).comments[0];
  assert.equal(parsed.elided, true);
  assert.equal(text.includes('; Snippet: elided'), true);
  for (const length of [15, 16, 20, 21, 25, 40]) {
    const source = ['intro', ...selected.slice(0, 10), ...Array<string>(length - 15).fill('middle'), ...selected.slice(-5)].join('\r');
    assert.deepEqual(resolveAnchor(parsed, source), { startLine: 2, endLine: length + 1, confidence: 'high' });
    const rewritten = rewriteLinesBatch(text, [{ comment: parsed, start: 2, end: length + 1 }]);
    const expected = text.replace('`:1-30', `\`:2-${length + 1}`);
    assert.equal(rewritten, expected);
    const updated = parse(rewritten);
    assert.deepEqual(updated.diagnostics, []);
    assert.equal(updated.comments[0].elided, true);
    assert.equal(updated.comments[0].anchorText, parsed.anchorText);
    assert.deepEqual(resolveAnchor(updated.comments[0], source),
      { startLine: 2, endLine: length + 1, confidence: 'high' });
    assert.equal(rewriteLines(rewritten, updated.comments[0], 2, length + 1), rewritten);
    const grown = rewriteLines(rewritten, updated.comments[0], 1, 30);
    assert.deepEqual(resolveAnchor(parse(grown).comments[0], selected.join('\n')),
      { startLine: 1, endLine: 30, confidence: 'high' });
  }
});

test('Snippet metadata is case-insensitive, shape-validated and only accepted at the header suffix', () => {
  const anchorText = [...Array<string>(10).fill('first'), '...', ...Array<string>(5).fill('last')].join('\n');
  const text = appendComment('', comment({ startLine: 1, endLine: 15, anchorText, elided: true }));
  const mixedCase = text.replace('; Snippet: elided', '; sNiPpEt: ELIDED');
  assert.deepEqual(parse(mixedCase).diagnostics, []);
  assert.equal(parse(mixedCase).comments[0].elided, true);
  assert.equal(editComment(mixedCase, parse(mixedCase).comments[0], 'new'), mixedCase.replace(comment().body, 'new'));
  assert.equal(rewriteLines(mixedCase, parse(mixedCase).comments[0], 2, 16), mixedCase.replace('`:1-15', '`:2-16'));
  for (const invalid of [
    text.replace('Snippet: elided', 'Snippet: literal'),
    text.replace('Snippet: elided', 'Snippet: elided; Snippet: elided'),
    text.replace('; Snippet: elided\nSelected: Working tree', '\nSelected: Working tree; Snippet: elided'),
    text.replace('\n...\n', '\n ...\n'),
    text.replace('first\n', ''),
    text.replace(anchorText, 'first\n...\nlast'),
    text.replace('\n\n```\n' + anchorText + '\n```', ''),
  ]) {
    assert.equal(parse(invalid).comments.length, 0);
    assert.equal(parse(invalid).diagnostics.length, 1);
  }
  for (const invalid of [undefined, 'first\n...\nlast', anchorText.replace('...', ' ...'), anchorText + '\n']) {
    assert.throws(() => appendComment('', comment({ anchorText: invalid, elided: true })), /Snippet: elided requires/);
  }
});

test('explicit elision batch preserves metadata, BOM, CRLF, path and sibling bytes', () => {
  const anchorText = [...Array<string>(10).fill('  first();'), '...', ...Array<string>(5).fill('  last();')].join('\r\n');
  const header = '## `src\\a; Lines: 999; Snippet: elided.ts` : 1 - 30 ; Snippet : ELIDED  \t';
  const metadata = '\r\n\r\nComparison: `old.ts` (HEAD) -> `src\\a; Lines: 999; Snippet: elided.ts` (Working tree)\r\n\r\nSelected: Modified (Working tree)';
  const block = header + metadata + '\r\n\r\n```ts\r\n' + anchorText + '\r\n```\r\n\r\nbody  \r\n';
  const suffix = '\r\n## Unknown\r\nKeep these bytes\r\n';
  for (const prefix of ['\uFEFF', '\uFEFF# Review \u00b7 base ABCDEF1\r\n\r\n']) {
    const text = prefix + block + '\r\n' + block + suffix;
    const parsed = parse(text);
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.comments[0].elided, true);
    const updates = parsed.comments.map((item, index) => ({ comment: item, start: 100 + index, end: 114 + index }));
    const rewritten = rewriteLinesBatch(text, updates);
    const updatedBlock = (start: number, end: number): string => block.replace(header,
      header.replace(': 1 - 30', `: ${start}-${end}`));
    assert.equal(rewritten, prefix + updatedBlock(100, 114) + '\r\n' + updatedBlock(101, 115) + suffix);
    assert.equal(rewriteLinesBatch(text, [...updates].reverse()), rewritten);
    const updated = parse(rewritten);
    assert.deepEqual(updated.diagnostics, []);
    assert.deepEqual(updated.comments.map(item => [item.startLine, item.endLine, item.elided]), [[100, 114, true], [101, 115, true]]);
    for (const item of updated.comments) {
      assert.equal(item.anchorText, anchorText);
      assert.equal(item.path, parsed.comments[0].path);
      assert.deepEqual(item.comparison, parsed.comments[0].comparison);
      assert.deepEqual(resolveAnchor(item, [...Array<string>(10).fill('  first();'), ...Array<string>(5).fill('  last();')].join('\r\n')),
        { startLine: 1, endLine: 15, confidence: 'high' });
    }
  }
});

test('repetitive elided endpoints stay bounded and rank ranges beyond EOF', () => {
  const length = 20000;
  const source = Array<string>(length).fill('hit').join('\n');
  const anchorText = [...Array<string>(10).fill('hit'), '...', ...Array<string>(5).fill('hit')].join('\n');
  assert.deepEqual(resolveAnchor(comment({ anchorText, elided: true, startLine: length + 30, endLine: length + 59 }), source, 0),
    { startLine: length - 14, endLine: length, confidence: 'low' });
  assert.deepEqual(resolveAnchor(comment({ anchorText, elided: true, startLine: 1, endLine: length + 30 }), source, 0),
    { startLine: 1, endLine: length, confidence: 'low' });
  assert.deepEqual(resolveAnchor(comment({ anchorText, elided: true, startLine: 1, endLine: 30 }), source),
    { startLine: 1, endLine: 30, confidence: 'high' });
  assert.deepEqual(resolveAnchor(comment({ anchorText, elided: true, startLine: length + 30, endLine: length + 59 }),
    Array<string>(length).fill('  hit  ').join('\r'), 0),
    { startLine: length - 14, endLine: length, confidence: 'low' });
});

test('elided endpoint ranking preserves ambiguity, local priority and relative indentation', () => {
  const prefix = Array<string>(10).fill('  prefix');
  const suffix = Array<string>(5).fill('    suffix');
  const anchorText = [...prefix, '...', ...suffix].join('\n');
  const anchor = comment({ anchorText, elided: true, startLine: 2, endLine: 31 });
  const source = ['intro', ...prefix, ...Array<string>(12).fill('middle'), ...suffix, 'gap', ...suffix].join('\n');
  // Ends 28 and 34 are equally far from the recorded end; the earlier wins.
  assert.deepEqual(resolveAnchor(anchor, source, 0), { startLine: 2, endLine: 28, confidence: 'low' });
  assert.deepEqual(resolveAnchor(anchor, source.split('\n').map(line => '\t' + line).join('\n'), 0),
    { startLine: 2, endLine: 28, confidence: 'low' });
  assert.equal(resolveAnchor(anchor, source.replace(/    suffix/g, '  suffix')), undefined);
  const selected = [...prefix, ...Array<string>(15).fill('middle'), ...suffix];
  const duplicate = ['intro', ...selected, 'gap', ...selected].join('\n');
  const shifted = { ...anchor, startLine: 3, endLine: 32 };
  assert.deepEqual(resolveAnchor(shifted, duplicate, 1), { startLine: 2, endLine: 31, confidence: 'low' });
  assert.deepEqual(resolveAnchor({ ...shifted, startLine: 17, endLine: 46 }, duplicate, 0),
    { startLine: 2, endLine: 31, confidence: 'low' });
});

test('elided indentation matching permits blank endpoints without losing joint indentation', () => {
  for (const [prefix, suffix] of [
    [Array<string>(10).fill(''), Array<string>(5).fill('  suffix')],
    [Array<string>(10).fill('  prefix'), Array<string>(5).fill('')],
    [Array<string>(10).fill(''), Array<string>(5).fill('')],
    [Array<string>(10).fill('\t  prefix'), Array<string>(5).fill('\t\tsuffix')],
  ]) {
    const anchorText = [...prefix, '...', ...suffix].join('\n');
    const source = ['intro', ...prefix, ...Array<string>(6).fill('middle'), ...suffix]
      .map(line => ' \t' + line + '  ').join('\n');
    assert.deepEqual(resolveAnchor(comment({ anchorText, elided: true, startLine: 1, endLine: 30 }), source),
      { startLine: 2, endLine: 22, confidence: 'high' });
  }
});

test('literal ellipsis is not elision without an explicit flag regardless of range or snippet shape', () => {
  const anchor = comment({ startLine: 1, endLine: 3, anchorText: 'first\n...\nlast' });
  assert.equal(resolveAnchor(anchor, 'first\nanything\nlast'), undefined);
  assert.deepEqual(resolveAnchor(anchor, 'first\n...\nlast'), { startLine: 1, endLine: 3, confidence: 'high' });
  assert.equal(resolveAnchor({ ...anchor, endLine: 30 }, 'first\nanything\nlast'), undefined);
  const anchorText = [...Array<string>(10).fill('first'), '...', ...Array<string>(5).fill('last')].join('\n');
  for (const endLine of [16, 30]) {
    for (const elided of [undefined, false]) {
      const text = appendComment('', comment({ startLine: 1, endLine, anchorText, elided }));
      assert.equal(text.includes('; Snippet:'), false);
      const parsed = parse(text).comments[0];
      assert.equal(parsed.elided, undefined);
      assert.deepEqual(resolveAnchor(parsed, anchorText), { startLine: 1, endLine: 16, confidence: 'high' });
      assert.equal(resolveAnchor(parsed, anchorText.replace('...\n', '')), undefined);
      assert.equal(resolveAnchor(parsed, anchorText.replace('...\n', 'middle\n'.repeat(15))), undefined);
      const rewritten = rewriteLines(text, parsed, 2, 17);
      assert.equal(rewritten, text.replace(`\`:1-${endLine}`, '`:2-17'));
      assert.equal(parse(rewritten).comments[0].elided, undefined);
    }
  }
});
