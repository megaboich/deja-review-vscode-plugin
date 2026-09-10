import assert = require('node:assert/strict');
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
    path: 'src/file.ts',
    startLine: 2,
    endLine: 3,
    origin: 'changed',
    side: 'document',
    anchorText: 'first\nsecond',
    body: 'Feedback',
    ...overrides,
  };
}

function roundTrip(input: ReviewComment, context: string): string {
  const text = appendComment('', input);
  assert.equal(text, `## \`${input.path}\`:2-3\n${context}\n\n\`\`\`\nfirst\nsecond\n\`\`\`\n\nFeedback\n`);
  const parsed = parse(text);
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.comments.length, 1);
  const { path, startLine, endLine, origin, side, comparison, anchorText, body } = parsed.comments[0];
  assert.deepEqual({ path, startLine, endLine, origin, side, comparison, anchorText, body },
    { comparison: undefined, ...input });
  return text;
}

test('explicit output selects every document origin and leaves base H1 unchanged', () => {
  for (const [origin, label] of origins) { roundTrip(note({ origin }), `Selected: ${label}`); }
  assert.equal(appendComment('', note({ startLine: 1, endLine: 1, anchorText: undefined }), 'ABCDEF1'),
    '# Review \u00b7 base ABCDEF1\n\n## `src/file.ts`:1\nSelected: Working tree\n\nFeedback\n');
});

test('explicit comparison round-trips all origin pairs, ordered sides, renamed paths and identical resources', () => {
  for (const [leftOrigin, leftLabel] of origins) {
    for (const [rightOrigin, rightLabel] of origins) {
      for (const renamed of [false, true]) {
        const comparison = {
          left: { path: renamed ? 'old/file.ts' : 'src/file.ts', origin: leftOrigin },
          right: { path: 'src/file.ts', origin: rightOrigin },
        };
        for (const side of ['left', 'right'] as const) {
          const selectedLabel = side === 'left' ? leftLabel : rightLabel;
          const pair = renamed ? `\`old/file.ts\` (${leftLabel}) -> \`src/file.ts\` (${rightLabel})`
            : `${leftLabel} -> ${rightLabel}`;
          roundTrip(note({ ...comparison[side], side, comparison }),
            `Comparison: ${pair}\nSelected: ${side === 'left' ? 'Original' : 'Modified'} (${selectedLabel})`);
        }
      }
    }
  }
});

test('context accepts whitespace, case, normalized paths and consistent explicit side labels', () => {
  const sha = 'A'.repeat(64);
  const text = `##   \`src\\file.ts\` : 2 - 3  \n \t\n  cOmPaRiSoN : \`src/file.ts\` (CoMmIt   ${sha}) -> \`new.ts\` (STAGING AREA)  \n\n \t\n  sElEcTeD : oRiGiNaL ( CoMmIt   ${sha} )  \n\n~~~ts\nfirst\nsecond\n~~~~\nFeedback\n`;
  const parsed = parse(text);
  assert.deepEqual(parsed.diagnostics, []);
  const item = parsed.comments[0];
  assert.equal(item.origin, `commit:${sha.toLowerCase()}`);
  assert.equal(item.side, 'left');
  assert.equal(item.path, 'src/file.ts');
  assert.deepEqual(item.comparison, {
    left: { path: 'src/file.ts', origin: `commit:${sha.toLowerCase()}` },
    right: { path: 'new.ts', origin: 'staged' },
  });
  assert.equal(editComment(text, item, 'new'), text.replace('Feedback', 'new'));
  assert.equal(rewriteLines(text, item, 8, 8), text.replace('2 - 3', '8'));
  for (const [context, side] of [
    ['Comparison: HEAD -> Working tree\nSelected: Modified (Working tree)', 'right'],
    ['Comparison: HEAD -> Staging area\nSelected: Original (HEAD)', 'left'],
    ['Comparison: `src/file.ts` (HEAD) -> `src\\file.ts` (Staging area)\nSelected: Modified (Staging area)', 'right'],
    ['Comparison: `src\\file.ts` (HEAD) -> `src/file.ts` (HEAD)\nSelected: Original (HEAD)', 'left'],
    ['  comparison : HEAD \t->\t Working   tree \n\t\n selected : Modified\t( working\t tree )\t ', 'right'],
    [' Comparison: `old.ts` (HEAD)\t ->  `src/file.ts` (Staging area)  \n Selected: Modified (Staging area)', 'right'],
    ['Comparison: HEAD\u2028-> Working\u2029tree\nSelected: Modified (Working\u2029tree)', 'right'],
  ]) {
    const result = parse(`## \`src/file.ts\`:1\n${context}\nFeedback`);
    assert.deepEqual(result.diagnostics, [], context);
    assert.equal(result.comments[0].side, side);
    const output = appendComment('', result.comments[0]);
    assert.ok(output.includes(`\nSelected: ${side === 'left' ? 'Original' : 'Modified'} (`));
    assert.deepEqual(parse(output).comments[0].comparison, result.comments[0].comparison);
  }
  for (const [context, origin] of [
    ['  sElEcTeD : working\t TREE  ', 'changed'],
    ['\n \t\n Selected : STAGING   area\t ', 'staged'],
    ['SELECTED:\t head', 'head'],
    [` selected : CoMmIt   ${sha} `, `commit:${sha.toLowerCase()}`],
  ]) {
    const result = parse(`## \`src/file.ts\`:1\n${context}\n\nFeedback`);
    assert.deepEqual(result.diagnostics, [], context);
    assert.equal(result.comments[0].origin, origin);
    assert.equal(result.comments[0].side, 'document');
    assert.equal(result.comments[0].comparison, undefined);
  }
});

test('malformed headers and explicit metadata stay opaque with diagnostics and survive append', () => {
  const invalid = [
    '## `src/file.ts`:nope\nSelected: HEAD', '## `src/file.ts`:0\nSelected: HEAD', '## `src/file.ts`:3-2\nSelected: HEAD',
    '## `src/file.ts`:9007199254740992\nSelected: HEAD', '## `src/file.ts:1\nSelected: HEAD',
    '## ``:1\nSelected: HEAD', '## `../file.ts`:1\nSelected: HEAD', '## `/file.ts`:1\nSelected: HEAD',
    '## `src/file.ts`:1; Side: left\nSelected: HEAD', '## `src/file.ts`:1; Snippet: literal\nSelected: HEAD',
    '## `src/file.ts`:1; Snippet: elided\nSelected: HEAD',
    ...[
      '', 'Prose', 'changed', 'staged', 'Selected:', 'Selected: changed', 'Selected: staged', 'Selected: Index',
      'Selected: Commit abc', `Selected: Commit ${'a'.repeat(41)}`, `Selected: Commit ${'a'.repeat(65)}`,
      `Selected: Commit ${'g'.repeat(40)}`, 'Selected: Original', 'Selected: Modified',
      'Selected: Original (HEAD)', 'Selected: Modified (Working tree)', 'Selected: HEAD; Original',
      'Comparison: HEAD -> Staging area',
      'Comparison: HEAD -> Staging area\n\nProse instead of selection',
      'Comparison: HEAD -> Staging area\nSelected: HEAD',
      'Comparison: HEAD -> Staging area\nSelected: Original',
      'Comparison: HEAD -> Staging area\nSelected: Modified',
      'Comparison: HEAD -> Staging area\nSelected: (HEAD)',
      'Comparison: HEAD -> Staging area\nSelected: Left (HEAD)',
      'Comparison: HEAD -> Staging area\nSelected: Right (Staging area)',
      'Comparison: HEAD -> Staging area\nSelected: Original ()',
      'Comparison: HEAD -> Staging area\nSelected: Original (Working tree)',
      'Comparison: HEAD -> Staging area\nSelected: Original (Staging area)',
      'Comparison: HEAD -> Staging area\nSelected: Modified (HEAD)',
      'Comparison: HEAD -> Staging area\nSelected: Modified (Index)',
      'Comparison: HEAD -> Staging area\nSelected: Modified (Commit abc)',
      `Comparison: HEAD -> Staging area\nSelected: Original (Commit ${'a'.repeat(41)})`,
      'Comparison: HEAD -> HEAD\nSelected: HEAD',
      'Comparison: HEAD -> HEAD\nSelected: Original (HEAD); Modified',
      'Comparison: HEAD -> HEAD\nSelected: Original (HEAD) extra',
      'Comparison: HEAD -> HEAD\nSelected: Original (`src/file.ts` (HEAD))',
      'Comparison: HEAD -> HEAD\nComparison: HEAD -> HEAD\nSelected: Original (HEAD)',
      'Comparison: HEAD => Staging area\nSelected: Original (HEAD)',
      'Comparison: HEAD -> Staging area; extra\nSelected: Original (HEAD)',
      'Comparison: HEAD -> Staging area; Original\nSelected: Original (HEAD)',
      'Comparison: `other.ts` (HEAD) -> `new.ts` (Staging area)\nSelected: Original (HEAD)',
      'Comparison: `src/file.ts` (HEAD) -> `new.ts` (HEAD)\nSelected: Modified (HEAD)',
      'Comparison: `src/file.ts` (HEAD) -> `../bad.ts` (Staging area)\nSelected: Original (HEAD)',
      'Comparison: `/bad.ts` (HEAD) -> `src/file.ts` (Staging area)\nSelected: Modified (Staging area)',
      'Comparison: `` (HEAD) -> `src/file.ts` (Staging area)\nSelected: Modified (Staging area)',
      'Comparison: `src/file.ts` (HEAD) -> Staging area\nSelected: Original (HEAD)',
      'Comparison: HEAD -> `src/file.ts` (Staging area)\nSelected: Original (HEAD)',
      'Comparison: HEAD -> Staging area -> Working tree\nSelected: Original (HEAD)',
      'Comparison: HEAD -> changed\nSelected: Original (HEAD)',
      'Comparison: HEAD -> Index\nSelected: Original (HEAD)',
      'Comparison: HEAD -> Commit abc\nSelected: Original (HEAD)',
      `Comparison: Commit ${'a'.repeat(41)} -> HEAD\nSelected: Modified (HEAD)`,
      `Comparison: HEAD -> Commit ${'b'.repeat(65)}\nSelected: Original (HEAD)`,
      `Comparison: HEAD -> Commit ${'g'.repeat(40)}\nSelected: Original (HEAD)`,
      'Comparison: \nSelected: Original (HEAD)',
      'Comparison: HEAD -> Staging area\n```\nanchor\n```\nSelected: Original (HEAD)',
      '```\nanchor\n```\nSelected: HEAD',
      'HEAD', 'Working tree', 'Index', 'Staging area', `Commit ${'a'.repeat(40)}`,
      'HEAD; HEAD -> Index', 'Working tree; HEAD -> Working tree', 'HEAD; HEAD -> HEAD; Original',
      'Index; `old.ts` (HEAD) -> `src/file.ts` (Index); Modified',
      'Selected: HEAD; HEAD -> Staging area',
      'Comparison: HEAD -> Staging area; Selected: Original (HEAD)',
      'Comparison: Left: `src/file.ts` (head); Right: `src/file.ts` (changed)',
    ].map(context => `## \`src/file.ts\`:1\n${context}`),
  ];
  for (const block of invalid) {
    const text = block + '\n\nKeep raw feedback  \n';
    const parsed = parse(text);
    assert.equal(parsed.comments.length, 0, block);
    assert.equal(parsed.diagnostics.length, 1, block);
    const appended = appendComment(text, note());
    assert.ok(appended.startsWith(text));
    assert.equal(parse(appended).comments.length, 1, block);
    assert.equal(parse(appended).diagnostics.length, 1, block);
  }
  assert.equal(parse('## `src/file.ts`:1\n\nWrong context').diagnostics[0].line, 3);
  assert.equal(parse('## `src/file.ts`:1').diagnostics[0].line, 1);
  for (const trailing of ['', '\n', '\n\n \t']) {
    const parsed = parse('## `src/file.ts`:1\nComparison: HEAD -> Staging area' + trailing);
    assert.equal(parsed.comments.length, 0);
    assert.equal(parsed.diagnostics.length, 1);
  }
  assert.deepEqual(parse('## Unknown section\nOpaque prose').diagnostics, []);
});

test('metadata diagnostics identify comparison or selection lines across newlines and BOM', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const bom of ['', '\uFEFF']) {
      for (const [block, line] of [
        ['## `src/file.ts`:1\n\nSelected: Index', 3],
        ['## `src/file.ts`:1\n\nComparison: HEAD => Staging area\n\nSelected: Original (HEAD)', 3],
        ['## `src/file.ts`:1\n\nComparison: HEAD -> Staging area\n\nSelected: Modified (HEAD)', 5],
        ['## `src/file.ts`:1\nComparison: HEAD -> Staging area\n\nFeedback without selection', 4],
      ] as const) {
        const prefix = '# Preamble\n\n';
        const text = bom + (prefix + block).replace(/\n/g, eol);
        const parsed = parse(text);
        assert.equal(parsed.comments.length, 0);
        assert.equal(parsed.diagnostics.length, 1);
        assert.equal(parsed.diagnostics[0].line, line + 2, block);
      }
    }
  }
});

test('duplicate notes preserve exact offsets, context and sibling bytes under every newline and BOM', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const bom of ['', '\uFEFF']) {
      const path = 'src/a:1; Lines: 999; Snippet: elided; Original -> (HEAD).ts';
      const block = `## \`${path}\` : 2 - 3\n\nComparison: \`old:1; Lines.ts\` (HEAD) -> \`${path}\` (Working tree)\n\nSelected: Modified (Working tree)\n\n~~~ts\nfirst\nsecond\n~~~\n\nFeedback  \n`;
      const suffix = '\n\n## Unknown section\nUntouched\n\n## `bad`:nope\nKeep malformed\n';
      const text = bom + (Array<string>(4).fill(block).join('\n') + suffix).replace(/\n/g, eol);
      const parsed = parse(text);
      assert.equal(parsed.diagnostics.length, 1);
      assert.equal(parsed.comments.length, 4);
      assert.deepEqual(parsed.comments.map(item => item.startOffset),
        [0, 1, 2, 3].map(index => bom.length + index * (block.replace(/\n/g, eol).length + eol.length)));
      for (const item of parsed.comments) {
        assert.equal(item.path, path);
        assert.equal(item.side, 'right');
        assert.equal(text.slice(item.rangeStartOffset, item.rangeEndOffset), '2 - 3');
        assert.equal(text.slice(item.startOffset, item.endOffset), item.rawBlock);
        assert.equal(editComment(text, item, 'New\nbody'),
          text.slice(0, item.bodyStartOffset) + `New${eol}body` + text.slice(item.bodyEndOffset));
        assert.equal(deleteComment(text, item), text.slice(0, item.startOffset) + text.slice(item.deleteEndOffset));
        assert.equal(rewriteLines(text, item, 10, 12),
          text.slice(0, item.rangeStartOffset) + '10-12' + text.slice(item.rangeEndOffset));
      }
      const rewritten = rewriteLinesBatch(text, parsed.comments.map((item, index) => ({ comment: item, start: 10 + index, end: 10 + index })));
      assert.deepEqual(parse(rewritten).comments.map(item => item.startLine), [10, 11, 12, 13]);
      assert.ok(rewritten.endsWith(suffix.replace(/\n/g, eol)));
      assert.equal(rewritten.startsWith('\uFEFF'), !!bom);
      assert.ok(appendComment(text, note()).startsWith(text));
    }
  }
});

test('explicit context stays outside editable bodies, including empty and anchorless notes', () => {
  for (const context of ['Selected: HEAD', 'Comparison: HEAD -> Working tree\nSelected: Modified (Working tree)',
    'Comparison: HEAD -> HEAD\n\nSelected: Original (HEAD)']) {
    for (const anchor of ['', '\n\n```\ncode\n```']) {
      const text = `## \`src/file.ts\`:1\n${context}${anchor}`;
      const original = parse(text).comments[0];
      for (const body of ['', 'New feedback', 'HEAD',
        'Comparison: ordinary prose', 'Selected: ordinary prose', 'Body: fenced',
        'Comparison: HEAD -> Staging area\nSelected: Original (HEAD)', '```\ncode\n```',
        '## `fake`:1\nSelected: HEAD\n\nFake note', '~~~\nunclosed', '\n\nbody\n\n',
        'Prose\n\n```md\nComparison: HEAD -> Staging area\nSelected: Original (HEAD)\n```',
        'Prose\n\n~~~\n## `fake`:1\nSelected: HEAD\n~~~']) {
        const edited = editComment(text, original, body);
        assert.deepEqual(parse(edited).diagnostics, []);
        assert.equal(parse(edited).comments.length, 1);
        const updated = parse(edited).comments[0];
        assert.ok(edited.startsWith(text));
        assert.equal(updated.body, body);
        assert.equal(updated.origin, original.origin);
        assert.equal(updated.side, original.side);
        assert.deepEqual(updated.comparison, original.comparison);
        assert.equal(updated.anchorText, original.anchorText);
        assert.equal(parse(editComment(edited, updated, '')).comments[0].body, '');
      }
    }
  }
});

test('range rewrites preserve explicit or absent elision markers without inferring snippet shape', () => {
  const snippet = [...Array<string>(10).fill('first'), '...', ...Array<string>(5).fill('last')].join('\n');
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const marker of ['', '; Snippet: elided']) {
      const compactHeader = `## \`src/a:1; Lines: 9.ts\`:1-30${marker}`;
      const anchor = `\n\n\`\`\`\n${snippet}\n\`\`\`\n\nFeedback\n`;
      const block = compactHeader + '\nSelected: HEAD' + anchor;
      const text = '\uFEFF' + (block + '\n' + block).replace(/\n/g, eol);
      const parsed = parse(text);
      assert.deepEqual(parsed.diagnostics, []);
      const rewritten = rewriteLinesBatch(text, parsed.comments.map(item => ({ comment: item, start: 5, end: 19 })));
      assert.equal(rewritten, text.replace(/`:1-30/g, '`:5-19'));
      const updated = parse(rewritten);
      assert.deepEqual(updated.diagnostics, []);
      assert.deepEqual(updated.comments.map(item => item.elided), [marker ? true : undefined, marker ? true : undefined]);
      assert.deepEqual(updated.comments.map(item => item.anchorText), [snippet, snippet].map(value => value.replace(/\n/g, eol)));
    }
  }
});

test('legacy headers stay unknown and metadata-like lines after selection are body prose', () => {
  const oldBlock = '## File: `src/file.ts`; Lines: 1; Origin: head; Side: left\n\n```\ncode\n```\n\nComparison: Left: `src/file.ts` (head); Right: `src/file.ts` (changed)\n\nOld feedback\n';
  assert.deepEqual(parse(oldBlock), { comments: [], generalNotes: [], diagnostics: [] });
  const appended = appendComment(oldBlock, note());
  assert.ok(appended.startsWith(oldBlock));
  assert.deepEqual(parse(appended).diagnostics, []);
  assert.equal(parse(appended).comments.length, 1);
  for (const body of [
    'Comparison: Left: `src/file.ts` (head); Right: `src/file.ts` (changed)',
    'Comparison: HEAD -> Staging area\nSelected: Original (HEAD)',
    'Selected: Modified (Staging area)\nComparison: malformed endpoints',
    'Comparison: invalid\n\n```\nbody fence, not an anchor\n```',
    'Selected: HEAD\n\n```\nbody fence, not an anchor\n```',
  ]) {
    for (const anchorText of [undefined, 'code']) {
      const anchor = anchorText === undefined ? '' : `\n\n\`\`\`\n${anchorText}\n\`\`\``;
      const text = `## \`src/file.ts\`:2-3\nSelected: Working tree${anchor}\n\n${body}\n`;
      const parsed = parse(text);
      assert.deepEqual(parsed.diagnostics, []);
      assert.equal(parsed.comments[0].body, body);
      assert.equal(parsed.comments[0].comparison, undefined);
      assert.equal(parsed.comments[0].side, 'document');
      assert.equal(parsed.comments[0].origin, 'changed');
      assert.equal(parsed.comments[0].anchorText, anchorText);
      assert.equal(parsed.comments[0].rawBlock, text);
      assert.equal(text.slice(parsed.comments[0].bodyStartOffset, parsed.comments[0].bodyEndOffset), body);
    }
  }
});

test('body serialization leaves safe prose plain and protects anchorless fences and backtick collisions', () => {
  for (const anchorText of [undefined, 'code']) {
    const prefix = '## `src/file.ts`:2-3\nSelected: Working tree\n\n'
      + (anchorText === undefined ? '' : '```\ncode\n```\n\n');
    for (const body of ['', 'Plain prose  ', '### Heading\n\nMore prose',
      'Prose\n\n```md\n## example\nComparison: example\nSelected: example\nBody: fenced\n```',
      'Inline `code` and ``ticks``', 'Text\u2028Selected: literal\u2029Body: fenced']) {
      const text = appendComment('', note({ anchorText, body }));
      assert.equal(text, prefix + body + '\n');
      assert.deepEqual(parse(text).diagnostics, []);
      assert.equal(parse(text).comments[0].body, body);
    }
    for (const body of ['```md\ncode\n```', '~~~~md\ncode\n~~~~']) {
      const text = appendComment('', note({ anchorText, body }));
      let expected = body;
      if (anchorText === undefined) {
        const fence = body.startsWith('`') ? '````' : '```';
        expected = `Body: fenced\n${fence}markdown\n${body}\n${fence}`;
      }
      assert.equal(text, prefix + expected + '\n');
      assert.deepEqual(parse(text).diagnostics, []);
      assert.equal(parse(text).comments[0].body, body);
      assert.equal(parse(text).comments[0].anchorText, anchorText);
    }
    for (const length of [0, 1, 2, 3, 4, 5, 16, 64]) {
      const run = '`'.repeat(length);
      for (const body of [`## Heading\ninline ${run}collision${run}\nend`,
        `Body: fenced\n${run}markdown\n## fake\n${run}\n~~~\nunmatched`,
        `\uFEFF${run}\n\u96ea \ud83d\ude80 e\u0301\n${run}\n`]) {
        const fence = '`'.repeat(Math.max(3, length + 1));
        const text = appendComment('', note({ anchorText, body }));
        assert.equal(text, prefix + `Body: fenced\n${fence}markdown\n${body}\n${fence}\n`);
        const parsed = parse(text);
        assert.deepEqual(parsed.diagnostics, []);
        assert.equal(parsed.comments.length, 1);
        assert.equal(parsed.comments[0].body, body);
        assert.equal(parsed.comments[0].anchorText, anchorText);
      }
    }
  }
});

test('bare headings in file composer bodies are wrapped while fenced bare headings stay literal', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const anchorText of [undefined, 'code']) {
      for (const body of ['##', 'Before\n##\nAfter', 'Before\n##', '##\n\n##']) {
        const text = appendComment(`Preamble${eol}${eol}`, note({ anchorText, body }));
        const expected = body.replace(/\n/g, eol);
        assert.ok(text.includes(`Body: fenced${eol}\`\`\`markdown${eol}${expected}${eol}\`\`\``));
        const parsed = parse(text);
        assert.deepEqual(parsed.diagnostics, []);
        assert.equal(parsed.comments.length, 1);
        assert.equal(parsed.comments[0].body, expected);
        const edited = editComment(text, parsed.comments[0], `Changed\n${body}`);
        assert.equal(parse(edited).comments[0].body, `Changed${eol}${expected}`);
      }
      const body = 'Prose\n\n~~~markdown\n##\n~~~';
      const text = appendComment('', note({ anchorText, body }));
      assert.ok(!text.includes('Body: fenced'));
      assert.equal(parse(text).comments[0].body, body);
    }
  }
});

test('repeated plain/wrapper/empty edits preserve context and sibling bytes across BOM and newlines', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const bom of ['', '\uFEFF']) {
      for (const anchor of ['', '\n\n~~~ts\ncode\n~~~']) {
        const prefix = bom + ('## `before.ts`:1\nSelected: HEAD\n\nBefore  \n\n'
          + '## `src\\file.ts` : 2 - 3\n\nCOMPARISON : `old.ts` (HEAD) -> `src\\file.ts` (WORKING TREE)\n\n'
          + 'SELECTED : MODIFIED (WORKING TREE)' + anchor + '\n\n').replace(/\n/g, eol);
        const suffix = '\n\n\n## `after.ts`:9\nSelected: Staging area\n\nAfter  \n\n## Unknown\nOpaque\n'.replace(/\n/g, eol);
        let text = prefix + 'Initial' + suffix;
        const original = parse(text).comments;
        for (let pass = 0; pass < 3; pass++) {
          for (const [body, wrapped] of [
            ['## Heading', true], ['Plain\n\nprose  ', false],
            ['Body: fenced\n```markdown\ninner\n```', true], ['', false],
            ['\n \t\n\uFEFFliteral\r\n\n', true], ['Trailing blank\n \t', true], ['Restored', false],
            ['~~~\nunclosed', true], ['Final', false],
          ] as const) {
            text = editComment(text, parse(text).comments[1], body);
            const parsed = parse(text);
            assert.deepEqual(parsed.diagnostics, []);
            assert.equal(parsed.comments.length, 3);
            const item = parsed.comments[1];
            assert.equal(item.body, body.replace(/\r\n|\r|\n/g, eol));
            assert.equal(item.anchorText, original[1].anchorText);
            assert.equal(item.path, original[1].path);
            assert.equal(item.origin, original[1].origin);
            assert.equal(item.side, original[1].side);
            assert.deepEqual(item.comparison, original[1].comparison);
            assert.equal(item.rawBlock.includes(`Body: fenced${eol}`), wrapped);
            assert.ok(text.startsWith(prefix));
            assert.ok(text.endsWith(suffix));
            assert.equal(parsed.comments[0].rawBlock, original[0].rawBlock);
            assert.equal(parsed.comments[2].rawBlock, original[2].rawBlock);
          }
        }
      }
    }
  }
});

test('handcrafted body wrappers decode once and retain wrapper-inclusive splice offsets', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const bom of ['', '\uFEFF']) {
      for (const anchor of ['', '\n\n```ts\nanchor\n```']) {
        for (const body of ['', '\n\n', '\n \t\nbody\n\n', '\uFEFF\u96ea \ud83d\ude80\n',
          'Body: fenced\n```markdown\n## `fake`:1\nSelected: HEAD\n```']) {
          const prefix = bom + ('## `src/file.ts`:2-3\nSelected: HEAD' + anchor + '\n\n').replace(/\n/g, eol);
          const normalized = body.replace(/\n/g, eol);
          const wrapper = `Body: fenced${eol}\`\`\`\`markdown${eol}${normalized}${eol}\`\`\`\``;
          const suffix = `${eol}${eol}${eol}## Unknown${eol}Untouched${eol}`;
          const text = prefix + wrapper + suffix;
          const parsed = parse(text);
          assert.deepEqual(parsed.diagnostics, []);
          assert.equal(parsed.comments.length, 1);
          const item = parsed.comments[0];
          assert.equal(item.body, normalized);
          assert.equal(item.anchorText, anchor ? 'anchor' : undefined);
          assert.equal(item.bodyStartOffset, prefix.length);
          assert.equal(item.bodyEndOffset, prefix.length + wrapper.length);
          assert.equal(text.slice(item.bodyStartOffset, item.bodyEndOffset), wrapper);
          assert.equal(item.rawBlock, text.slice(bom.length, prefix.length + wrapper.length + eol.length));
          assert.equal(editComment(text, item, 'Plain'), prefix + 'Plain' + suffix);
          assert.equal(editComment(text, item, ''), prefix + suffix);
          assert.equal(rewriteLines(text, item, 8, 9), text.replace('`:2-3', '`:8-9'));
          assert.equal(deleteComment(text, item), bom + `${eol}## Unknown${eol}Untouched${eol}`);
        }
      }
    }
  }
});

test('only the exact marker at body start decodes a wrapper; lookalikes and later markers stay literal', () => {
  for (const anchor of ['', '\n\n```\nanchor\n```']) {
    for (const marker of ['body: fenced', 'BODY: fenced', 'Body: Fenced', ' Body: fenced',
      'Body : fenced', 'Body:\tfenced', 'Body: fenced ', 'Body: fenced extra', 'Body: plain',
      '\uFEFFBody: fenced', 'Prose\n\nBody: fenced', 'Comparison: literal\nBody: fenced',
      'Selected: literal\nBody: fenced']) {
      const body = marker + '\n````markdown\n## `fake`:1\nSelected: HEAD\n````';
      const text = `## \`src/file.ts\`:2-3\nSelected: Working tree${anchor}\n\n${body}\n`;
      const parsed = parse(text);
      assert.deepEqual(parsed.diagnostics, [], marker);
      assert.equal(parsed.comments.length, 1, marker);
      const item = parsed.comments[0];
      assert.equal(item.body, body, marker);
      assert.equal(item.anchorText, anchor ? 'anchor' : undefined, marker);
      assert.equal(item.origin, 'changed', marker);
      assert.equal(item.comparison, undefined, marker);
      assert.equal(text.slice(item.bodyStartOffset, item.bodyEndOffset), body, marker);
    }
  }
});

test('malformed raw body wrappers diagnose rather than discard payloads or trailing feedback', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const bom of ['', '\uFEFF']) {
      for (const anchor of ['', '\n\n```\nanchor\n```']) {
        for (const [wrapper, open, message] of [
          ['Body: fenced', false, /expected a fenced review note body/],
          ['Body: fenced\nnot a fence\nKeep feedback', false, /expected a fenced review note body/],
          ['Body: fenced\n~~~markdown\nKeep feedback\n~~~', false, /expected a fenced review note body/],
          ['Body: fenced\n```text\nKeep feedback\n```', false, /expected a fenced review note body/],
          ['Body: fenced\n```\nKeep feedback\n```', false, /expected a fenced review note body/],
          ['Body: fenced\n\n```markdown\nKeep feedback\n```', false, /expected a fenced review note body/],
          ['Body: fenced\n```markdown\nKeep feedback\n```\nDo not drop this', false, /must end at its closing fence/],
          ['Body: fenced\n```markdown\nKeep feedback\n```\n\n```\nNor this\n```', false, /must end at its closing fence/],
          ['Body: fenced\n```markdown\nKeep feedback', true, /unterminated/],
          ['Body: fenced\n````markdown\nKeep feedback\n```', true, /unterminated/],
          ['Body: fenced\n```markdown\nKeep feedback\n~~~', true, /unterminated/],
          ['Body: fenced\n```markdown\nKeep feedback\n``` trailing text', true, /unterminated/],
        ] as const) {
          const prefix = bom + '## `before.ts`:1\nSelected: HEAD\n\nBefore\n\n'.replace(/\n/g, eol);
          const block = ('## `src/file.ts`:2-3\nSelected: HEAD' + anchor + '\n\n' + wrapper + '\n').replace(/\n/g, eol);
          const text = prefix + block;
          const parsed = parse(text);
          assert.equal(parsed.comments.length, 1, wrapper);
          assert.equal(parsed.comments[0].body, 'Before', wrapper);
          assert.equal(parsed.diagnostics.length, 1, wrapper);
          assert.match(parsed.diagnostics[0].message, message, wrapper);
          const markerLine = (prefix + block.slice(0, block.indexOf('Body: fenced'))).split(eol).length;
          assert.equal(parsed.diagnostics[0].line, markerLine + (open ? 1 : 0), wrapper);
          assert.ok(editComment(text, parsed.comments[0], 'Updated').endsWith(block), wrapper);
          assert.ok(rewriteLines(text, parsed.comments[0], 4, 4).endsWith(block), wrapper);
          assert.equal(deleteComment(text, parsed.comments[0]), bom + block, wrapper);
          if (open) {
            assert.throws(() => appendComment(text, note()), /unterminated fence/, wrapper);
          } else {
            const appended = appendComment(text, note());
            assert.ok(appended.startsWith(text), wrapper);
            assert.equal(parse(appended).comments.length, 2, wrapper);
            assert.deepEqual(parse(appended).diagnostics, parsed.diagnostics, wrapper);
            const sibling = parse(appended).comments[1];
            assert.ok(editComment(appended, sibling, 'New').startsWith(text), wrapper);
            assert.ok(deleteComment(appended, sibling).startsWith(text), wrapper);
          }
        }
      }
    }
  }
});
