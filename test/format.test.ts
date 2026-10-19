import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Origin, ReviewComment } from '../src/model';
import { parse } from '../src/parser';
import { appendComment, deleteComment, editComment, rewriteLines, rewriteLinesBatch } from '../src/writer';

const origins: [Origin, string][] = [
  ['changed', 'Working tree'], ['staged', 'Staging area'], ['head', 'HEAD'],
  [`commit:${'a'.repeat(40)}`, `Commit ${'a'.repeat(40)}`],
  [`commit:${'b'.repeat(64)}`, `Commit ${'b'.repeat(64)}`],
];

function note(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: 'src/file.ts', startLine: 2, endLine: 3, origin: 'changed', side: 'document',
    anchorText: 'first\nsecond', body: 'Feedback', ...overrides,
  };
}

test('compact document headers and feedback markers have exact readable output', () => {
  for (const [origin, label] of origins) {
    const text = appendComment('', note({ origin }));
    assert.equal(text, `## \`src/file.ts\`:2-3 (${label})\n\n\`\`\`\nfirst\nsecond\n\`\`\`\n\n💬 Feedback\n`);
    const result = parse(text);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.comments[0].origin, origin);
    assert.equal(result.comments[0].side, 'document');
    assert.equal(result.comments[0].comparison, undefined);
    assert.equal(result.comments[0].body, 'Feedback');
  }
  assert.equal(appendComment('', note({ startLine: 1, endLine: 1, anchorText: undefined })),
    '## `src/file.ts`:1 (Working tree)\n\n💬 Feedback\n');
});

test('compact comparisons retain selected-side order for all origins, paths and identical endpoints', () => {
  for (const [leftOrigin, leftLabel] of origins) {
    for (const [rightOrigin, rightLabel] of origins) {
      for (const renamed of [false, true]) {
        const comparison = {
          left: { path: renamed ? 'old/file.ts' : 'src/file.ts', origin: leftOrigin },
          right: { path: 'src/file.ts', origin: rightOrigin },
        };
        for (const side of ['left', 'right'] as const) {
          const selectedLabel = side === 'left' ? leftLabel : rightLabel;
          const opposite = side === 'left' ? comparison.right : comparison.left;
          const oppositeLabel = side === 'left' ? rightLabel : leftLabel;
          const endpoint = renamed ? `\`${opposite.path}\` @ ${oppositeLabel}` : oppositeLabel;
          const input = note({ ...comparison[side], side, comparison });
          const text = appendComment('', input);
          assert.equal(text.split('\n')[0], `## \`${input.path}\`:2-3 (${side === 'left' ? 'Original' : 'Modified'}: ${selectedLabel} vs ${endpoint})`);
          const result = parse(text);
          assert.deepEqual(result.diagnostics, []);
          const item = result.comments[0];
          assert.deepEqual(item.comparison, comparison);
          assert.equal(item.path, input.path);
          assert.equal(item.origin, input.origin);
          assert.equal(item.side, side);
          assert.equal(item.anchorText, input.anchorText);
          assert.equal(item.body, input.body);
        }
      }
    }
  }
});

test('compact context tolerates case and whitespace and keeps punctuation inside paths', () => {
  for (const separator of ['\u2028', '\u2029']) {
    const comparison = { left: { path: `old${separator}name.ts`, origin: 'head' as const }, right: { path: 'src/file.ts', origin: 'changed' as const } };
    const result = parse(appendComment('', note({ side: 'right', comparison })));
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.comments[0].comparison, comparison);
  }
  const sha = 'A'.repeat(64);
  const text = `##   \`src\\file.ts\` : 2 - 3 ( oRiGiNaL : CoMmIt   ${sha} vs \`new (x) vs @.ts\` @ STAGING AREA )  \n\n~~~ts\nfirst\nsecond\n~~~~\n\n💬 Feedback\n`;
  const result = parse(text);
  assert.deepEqual(result.diagnostics, []);
  const item = result.comments[0];
  assert.equal(item.path, 'src/file.ts');
  assert.equal(item.origin, `commit:${sha.toLowerCase()}`);
  assert.equal(item.side, 'left');
  assert.deepEqual(item.comparison, {
    left: { path: 'src/file.ts', origin: `commit:${sha.toLowerCase()}` },
    right: { path: 'new (x) vs @.ts', origin: 'staged' },
  });
  assert.equal(editComment(text, item, 'New'), text.replace('Feedback', 'New'));
  assert.equal(rewriteLines(text, item, 8, 8), text.replace('2 - 3', '8'));
});

test('invalid compact headers and missing body markers diagnose without dropping raw bytes', () => {
  const invalid = [
    '## `a`:nope (HEAD)', '## `a`:0 (HEAD)', '## `a`:3-2 (HEAD)',
    '## `a`:9007199254740992 (HEAD)', '## ``:1 (HEAD)', '## `a:1 (HEAD)',
    '## `../a`:1 (HEAD)', '## `/a`:1 (HEAD)', '## `a`:1',
    '## `a`:1 (HEAD); Snippet: literal', '## `a`:1 (HEAD); Snippet: elided',
    ...['', 'Index', 'changed', 'Commit abc', `Commit ${'a'.repeat(41)}`, `Commit ${'g'.repeat(40)}`,
      'Working tree vs HEAD', 'Modified: Working tree', 'Left: HEAD vs Working tree',
      'Modified: Working tree vs HEAD vs HEAD', 'Modified: Working tree vs Commit abc',
      'Original: HEAD vs `` @ Working tree', 'Original: HEAD vs `../bad.ts` @ Working tree',
      'Modified: Working tree vs `a` (HEAD)', 'HEAD extra',
    ].map(context => `## \`a\`:1 (${context})`),
  ];
  for (const header of invalid) {
    const text = `${header}\n\n💬 Keep raw feedback  \n`;
    const result = parse(text);
    assert.equal(result.comments.length, 0, header);
    assert.equal(result.diagnostics.length, 1, header);
    assert.equal(result.diagnostics[0].line, 1, header);
    const appended = appendComment(text, note());
    assert.ok(appended.startsWith(text));
    assert.equal(parse(appended).comments.length, 1);
    assert.equal(parse(appended).diagnostics.length, 1);
  }
  for (const eol of ['\n', '\r\n', '\r']) {
    const text = '\uFEFF' + ['# Preamble', '', '## `a`:1 (HEAD)', '', 'Unmarked feedback'].join(eol);
    assert.equal(parse(text).diagnostics[0].line, 5);
  }
  // Unrecognized formats remain opaque; they are not converted or interpreted.
  const opaque = '## Unknown section\n\nUnrecognized text\n';
  assert.deepEqual(parse(opaque), { comments: [], generalNotes: [], diagnostics: [] });
  assert.ok(appendComment(opaque, note()).startsWith(opaque));
});

test('duplicate compact notes preserve BOM, newline styles, range offsets and sibling bytes', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const bom of ['', '\uFEFF']) {
      const header = '## `src/a:1; Snippet: elided.ts` : 2 - 3 (Modified: Working tree vs `old.ts` @ HEAD)';
      const block = [header, '', '~~~ts', 'first', 'second', '~~~', '', '💬 Feedback  ', ''].join(eol);
      const suffix = `${eol}## Unknown${eol}Untouched${eol}`;
      const text = bom + block + eol + block + suffix;
      const result = parse(text);
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.comments.length, 2);
      assert.deepEqual(result.comments.map(item => item.startOffset), [bom.length, bom.length + block.length + eol.length]);
      for (const item of result.comments) {
        assert.equal(text.slice(item.startOffset, item.endOffset), item.rawBlock);
        assert.equal(text.slice(item.bodyStartOffset, item.bodyEndOffset), '💬 Feedback  ');
        assert.equal(text.slice(item.rangeStartOffset, item.rangeEndOffset), '2 - 3');
        assert.equal(editComment(text, item, 'New\nbody'),
          text.slice(0, item.bodyStartOffset) + `💬 New${eol}body` + text.slice(item.bodyEndOffset));
        assert.equal(deleteComment(text, item), text.slice(0, item.startOffset) + text.slice(item.deleteEndOffset));
      }
      const rewritten = rewriteLinesBatch(text, result.comments.map((comment, index) => ({ comment, start: 10 + index, end: 10 + index })));
      assert.deepEqual(parse(rewritten).comments.map(item => item.startLine), [10, 11]);
      assert.ok(rewritten.endsWith(suffix));
    }
  }
});

test('body markers decode once, stay out of editable feedback and preserve literal emoji', () => {
  // An empty body keeps a bare marker rather than saving trailing whitespace.
  assert.equal(appendComment('', note({ anchorText: undefined, body: '' })),
    '## `src/file.ts`:2-3 (Working tree)\n\n💬\n');
  for (const anchorText of [undefined, 'code']) {
    for (const body of ['', 'Plain prose  ', '💬 Literal feedback', '💼 Literal header', '💬 Body: fenced',
      'First\n💬 another paragraph', '## General Review Note', '```ts\ncode\n```',
      '~~~\nunclosed', '\n significant \n', 'Body: fenced', '\uFEFFtext']) {
      let text = appendComment('', note({ anchorText, body }));
      assert.deepEqual(parse(text).diagnostics, []);
      assert.equal(parse(text).comments[0].body, body);
      for (const replacement of ['New', '', body]) {
        text = editComment(text, parse(text).comments[0], replacement);
        assert.deepEqual(parse(text).diagnostics, []);
        assert.equal(parse(text).comments[0].body, replacement);
        assert.equal(parse(text).comments[0].anchorText, anchorText);
      }
    }
  }
});

test('fenced bodies protect arbitrary headings, leading fences and significant boundary whitespace', () => {
  const prefix = '## `src/file.ts`:2-3 (Working tree)\n\n';
  for (const body of ['Plain prose', '### Heading\nMore prose', '💬 Body: fenced',
    'Selected: HEAD\nComparison: ordinary prose', 'Prose\nBody: fenced']) {
    assert.equal(appendComment('', note({ anchorText: undefined, body })), `${prefix}💬 ${body}\n`);
  }
  for (const length of [3, 4, 16, 64]) {
    const run = '`'.repeat(length);
    const body = `## Heading\n${run}collision\n~~~\nunclosed\n`;
    const fence = '`'.repeat(length + 1);
    const text = appendComment('', note({ anchorText: undefined, body }));
    assert.equal(text, `${prefix}💬 Body: fenced\n${fence}markdown\n${body}\n${fence}\n`);
    assert.equal(parse(text).comments[0].body, body);
  }
});

test('malformed body wrappers preserve trailing feedback and report the body line', () => {
  for (const wrapper of ['Body: fenced', 'Body: fenced\nnot a fence',
    'Body: fenced\n~~~markdown\nbody\n~~~', 'Body: fenced\n```text\nbody\n```',
    'Body: fenced\n\n```markdown\nbody\n```', 'Body: fenced\n```markdown\nbody\n```\nKeep this']) {
    const text = `## \`a\`:1 (HEAD)\n\n💬 ${wrapper}\n`;
    const result = parse(text);
    assert.equal(result.comments.length, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].line, 3);
    assert.ok(appendComment(text, note()).startsWith(text));
  }
});
