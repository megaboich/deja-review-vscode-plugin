import assert = require('node:assert/strict');
import { test } from 'node:test';
import { isGeneralNote, parsedNotes } from '../src/model';
import type { GeneralReviewNote, ParsedNote, ReviewComment } from '../src/model';
import { parse } from '../src/parser';
import { appendComment, appendGeneralNote, deleteComment, editComment, rewriteLinesBatch } from '../src/writer';

const fileNote: ReviewComment = {
  path: 'src/file.ts', origin: 'changed', side: 'right', startLine: 2, endLine: 3,
  comparison: { left: { path: 'old.ts', origin: 'head' }, right: { path: 'src/file.ts', origin: 'changed' } },
  anchorText: 'first\nsecond', body: 'File feedback',
};

const bodies = [
  '', 'Plain prose  ', '### Heading\n\nMore prose', '## General Review Note',
  '##', 'Before\n##\nAfter', 'Before\n##', 'Prose\n\n~~~markdown\n##\n~~~',
  '## `fake.ts`:1\nSelected: HEAD\n\nFake file note',
  'Comparison: HEAD -> Staging area\nSelected: Original (HEAD)', 'Selected: HEAD', 'Body: fenced',
  '```', '~~~\nunclosed', 'Prose\n````markdown\n```\n## still inside',
  '```md\ncode\n```', '~~~md\ncode\n~~~',
  'Prose\n\n~~~~md\n## General Review Note\n~~~\n~~~~',
  '\n', '\r\n\r\n', ' \t', '\n\nleading', 'trailing\n\n', '\n \t\nbody\n \t\n',
  'first\rsecond\r\nthird\nfourth',
  'Body: fenced\n````markdown\nBody: fenced\n```markdown\nnested\n```\n````',
  '\uFEFF', '\uFEFF## General Review Note\nSelected: HEAD', '\uFEFF```\ncode\n```',
  '\uFEFF\u96ea \ud83d\ude80 e\u0301\u2028literal\u2029text\u0000\tend  ',
  ...[3, 4, 16, 64].map(length => `## Heading\n${'`'.repeat(length)}collision\n~~~\nunclosed`),
];

test('general notes serialize the exact header without synthetic file fields or metadata', () => {
  const input: GeneralReviewNote = { kind: 'general', body: 'Project-wide feedback' };
  const text = appendGeneralNote('', input.body);
  assert.equal(text, '## General Review Note\n\nProject-wide feedback\n');
  const result = parse(text);
  assert.deepEqual(result.comments, []);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.generalNotes.length, 1);
  const note: ParsedNote = parsedNotes(result)[0];
  assert.ok(isGeneralNote(note));
  assert.equal(note.kind, input.kind);
  assert.equal(note.body, input.body);
  assert.deepEqual(Object.keys(note).sort(), ['kind', 'body', 'index', 'startOffset', 'endOffset',
    'bodyStartOffset', 'bodyEndOffset', 'headerEndOffset', 'deleteEndOffset', 'rawBlock'].sort());
  assert.deepEqual(parse(''), { comments: [], generalNotes: [], diagnostics: [] });
  assert.equal(isGeneralNote(parse(appendComment('', fileNote)).comments[0]), false);
});

test('only the exact unfenced general header is recognized; general bodies have no metadata or anchor', () => {
  for (const header of ['## general review note', '## General Review Notes', '## General Review Note ',
    '##  General Review Note', '## General Review Note:1', '### General Review Note']) {
    assert.deepEqual(parsedNotes(parse(`${header}\n\nOpaque prose\n`)), [], header);
  }
  assert.deepEqual(parsedNotes(parse('```markdown\n## General Review Note\n```')), []);
  for (const body of ['Selected: HEAD', 'Comparison: arbitrary prose\nSelected: arbitrary prose',
    '```ts\nnot an anchor\n```', '~~~ts\nnot an anchor\n~~~']) {
    const result = parse(`## General Review Note\n\n${body}\n`);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.generalNotes[0].body, body);
    assert.equal('anchorText' in result.generalNotes[0], false);
    assert.deepEqual(result.comments, []);
  }
});

test('general append preserves existing bytes, base semantics and destination newlines', () => {
  assert.equal(appendGeneralNote('', 'Feedback', 'ABCDEF1'),
    '# Review \u00b7 base ABCDEF1\n\n## General Review Note\n\nFeedback\n');
  assert.equal(parse(appendGeneralNote('', 'Feedback', 'ABCDEF1')).base, 'abcdef1');
  assert.throws(() => appendGeneralNote('', 'Feedback', 'invalid'), /invalid base SHA/);
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const prefix of ['', '\uFEFF', 'Preamble', `Preamble${eol}`, `Preamble${eol}${eol}`,
      `\uFEFF# Review \u00b7 base ABCDEF1${eol}${eol}## Unknown${eol}Opaque  ${eol}`]) {
      const text = appendGeneralNote(prefix, 'Feedback\r\nsecond\rthird', prefix ? 'ignored' : undefined);
      assert.ok(text.startsWith(prefix));
      const result = parse(text);
      assert.deepEqual(result.diagnostics, []);
      const expectedEol = /\r\n|\r|\n/.exec(prefix)?.[0] ?? '\n';
      assert.equal(result.generalNotes[0].body, `Feedback${expectedEol}second${expectedEol}third`);
    }
  }
});

test('arbitrary general bodies round-trip and edit losslessly beside duplicate general and file notes', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const bom of ['', '\uFEFF']) {
      for (const body of bodies) {
        const label = JSON.stringify({ eol, bom, body });
        const prefix = bom + `# Review \u00b7 base ABCDEF1${eol}${eol}`;
        const first = appendGeneralNote(prefix, body);
        const withFile = appendComment(first, fileNote);
        const suffix = `${eol}${eol}## Unknown${eol}Opaque bytes  ${eol}`;
        const text = appendComment(appendGeneralNote(withFile, body), fileNote) + suffix;
        assert.ok(withFile.startsWith(first), label);
        assert.ok(text.startsWith(withFile), label);
        const result = parse(text);
        const notes = parsedNotes(result);
        assert.deepEqual(result.diagnostics, [], label);
        assert.equal(result.base, 'abcdef1', label);
        assert.deepEqual(result.comments.map(note => note.index), [0, 1], label);
        assert.deepEqual(result.generalNotes.map(note => note.index), [0, 1], label);
        assert.deepEqual(notes.map(isGeneralNote), [true, false, true, false], label);
        assert.strictEqual(notes[0], result.generalNotes[0]);
        assert.strictEqual(notes[1], result.comments[0]);
        assert.deepEqual(result.generalNotes.map(note => note.body), Array(2).fill(body.replace(/\r\n|\r|\n/g, eol)), label);
        assert.equal(result.generalNotes[0].rawBlock, result.generalNotes[1].rawBlock, label);
        for (const [index, note] of notes.entries()) {
          assert.equal(text.slice(note.startOffset, note.endOffset), note.rawBlock, label);
          for (const replacement of ['', 'Plain replacement', '\n## General Review Note\r\nSelected: literal\r\n\n']) {
            const edited = editComment(text, note, replacement);
            const updated = parse(edited);
            const updatedNotes = parsedNotes(updated);
            assert.deepEqual(updated.diagnostics, [], label);
            assert.equal(updatedNotes.length, 4, label);
            assert.ok(edited.startsWith(text.slice(0, note.bodyStartOffset)), label);
            assert.ok(edited.endsWith(text.slice(note.bodyEndOffset)), label);
            assert.equal(updatedNotes[index].body, replacement.replace(/\r\n|\r|\n/g, eol), label);
            for (const [siblingIndex, sibling] of updatedNotes.entries()) {
              if (siblingIndex !== index) {
                assert.equal(sibling.rawBlock, notes[siblingIndex].rawBlock, label);
              }
            }
          }
          const deleted = deleteComment(text, note);
          assert.equal(deleted, text.slice(0, note.startOffset) + text.slice(note.deleteEndOffset), label);
          assert.deepEqual(parse(deleted).diagnostics, [], label);
          assert.deepEqual(parsedNotes(parse(deleted)).map(sibling => sibling.rawBlock),
            notes.filter(sibling => sibling !== note).map(sibling => sibling.rawBlock), label);
        }
        const rewritten = rewriteLinesBatch(text, result.comments.map((comment, index) => ({
          comment, start: 10 + index, end: 20 + index,
        })));
        assert.deepEqual(parse(rewritten).generalNotes.map(note => note.rawBlock), result.generalNotes.map(note => note.rawBlock), label);
        assert.deepEqual(parse(rewritten).comments.map(note => [note.startLine, note.endLine]), [[10, 20], [11, 21]], label);
      }
    }
  }
});

test('general notes preserve BOM-aware offsets and remove exactly one blank separator', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const block = ['## General Review Note', '', 'Feedback', ''].join(eol);
    const suffix = `${eol}${eol}${eol}## Unknown${eol}Keep${eol}`;
    const text = '\uFEFF' + block + suffix;
    const note = parse(text).generalNotes[0];
    assert.equal(note.startOffset, 1);
    assert.equal(text.slice(note.startOffset, note.headerEndOffset), '## General Review Note');
    assert.equal(text.slice(note.bodyStartOffset, note.bodyEndOffset), 'Feedback');
    assert.equal(editComment(text, note, 'Updated'), text.replace('Feedback', 'Updated'));
    assert.equal(deleteComment(text, note), '\uFEFF' + suffix.slice(eol.length));
    assert.equal(deleteComment('\uFEFF' + block, parse('\uFEFF' + block).generalNotes[0]), '\uFEFF');
    for (const ending of ['', eol, eol + eol]) {
      let empty = '\uFEFF## General Review Note' + ending;
      for (const body of ['Plain', '', 'Body: fenced', '\n\n', '', 'Restored']) {
        empty = editComment(empty, parse(empty).generalNotes[0], body);
        assert.equal(parse(empty).generalNotes[0].body, body.replace(/\n/g, /\r\n|\r|\n/.exec(empty)?.[0] ?? '\n'));
        assert.ok(empty.startsWith('\uFEFF## General Review Note'));
      }
    }
  }
});

test('general body wrappers decode once, include splice bytes and leave marker lookalikes literal', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const body = 'Body: fenced\n```markdown\n## General Review Note\n```\n'.replace(/\n/g, eol);
    const prefix = `\uFEFF## General Review Note${eol}${eol}`;
    const wrapper = `Body: fenced${eol}\`\`\`\`markdown${eol}${body}${eol}\`\`\`\``;
    const suffix = `${eol}${eol}## Unknown${eol}Keep${eol}`;
    const text = prefix + wrapper + suffix;
    const note = parse(text).generalNotes[0];
    assert.equal(note.body, body);
    assert.equal(text.slice(note.bodyStartOffset, note.bodyEndOffset), wrapper);
    assert.equal(editComment(text, note, 'Plain'), prefix + 'Plain' + suffix);
    for (const marker of ['body: fenced', 'Body: Fenced', ' Body: fenced', 'Body: fenced ', 'Prose\nBody: fenced']) {
      const literal = `${marker}\n\`\`\`markdown\n## General Review Note\n\`\`\``.replace(/\n/g, eol);
      assert.equal(parse(prefix + literal + eol).generalNotes[0].body, literal);
    }
  }
});

test('malformed general wrappers remain opaque through sibling writes and appends', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const bom of ['', '\uFEFF']) {
      for (const [wrapper, open, message] of [
        ['Body: fenced', false, /expected a fenced review note body/],
        ['Body: fenced\nnot a fence\nKeep feedback', false, /expected a fenced review note body/],
        ['Body: fenced\n~~~markdown\nKeep feedback\n~~~', false, /expected a fenced review note body/],
        ['Body: fenced\n```text\nKeep feedback\n```', false, /expected a fenced review note body/],
        ['Body: fenced\n\n```markdown\nKeep feedback\n```', false, /expected a fenced review note body/],
        ['Body: fenced\n```markdown\nKeep feedback\n```\nDo not drop this', false, /must end at its closing fence/],
        ['Body: fenced\n```markdown\nKeep feedback', true, /unterminated/],
        ['Body: fenced\n````markdown\nKeep feedback\n```', true, /unterminated/],
      ] as const) {
        const prefix = bom + appendGeneralNote('', 'Before').replace(/\n/g, eol) + eol;
        const block = `## General Review Note\n\n${wrapper}\n`.replace(/\n/g, eol);
        const text = prefix + block;
        const result = parse(text);
        assert.equal(result.generalNotes.length, 1, wrapper);
        assert.equal(result.diagnostics.length, 1, wrapper);
        assert.match(result.diagnostics[0].message, message, wrapper);
        assert.equal(result.diagnostics[0].line, prefix.split(eol).length + 2 + (open ? 1 : 0), wrapper);
        assert.ok(editComment(text, result.generalNotes[0], 'Updated').endsWith(block), wrapper);
        assert.equal(deleteComment(text, result.generalNotes[0]), bom + block, wrapper);
        if (open) {
          assert.throws(() => appendGeneralNote(text, 'After'), /unterminated fence/, wrapper);
        } else {
          const appended = appendGeneralNote(text, 'After');
          assert.ok(appended.startsWith(text), wrapper);
          assert.deepEqual(parse(appended).diagnostics, result.diagnostics, wrapper);
          assert.equal(parse(appended).generalNotes.length, 2, wrapper);
          const sibling = parse(appended).generalNotes[1];
          assert.ok(editComment(appended, sibling, 'New').startsWith(text), wrapper);
          assert.ok(deleteComment(appended, sibling).startsWith(text), wrapper);
        }
      }
    }
  }
});

test('general mutations reject stale snapshots and append rejects open preexisting fences', () => {
  const text = appendGeneralNote('', 'Original');
  const note = parse(text).generalNotes[0];
  for (const changed of ['prefix' + text, text.replace('Original', 'Changed!')]) {
    assert.throws(() => editComment(changed, note, 'New'), /changed on disk/);
    assert.throws(() => deleteComment(changed, note), /changed on disk/);
  }
  for (const fence of ['```', '~~~~', '`````']) {
    assert.throws(() => appendGeneralNote(`${fence}\nOpaque`, 'New'), /unterminated fence/);
  }
});

test('bare unknown sections survive edits, deletion and append beside either note kind', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const bom of ['', '\uFEFF']) {
      for (const block of [appendGeneralNote('', 'Feedback'), appendComment('', fileNote)]) {
        for (const unknown of ['##', '##\nKeep unknown bytes  \n']) {
          const prefix = bom + block.replace(/\n/g, eol);
          const suffix = eol + unknown.replace(/\n/g, eol);
          const text = prefix + suffix;
          const parsed = parse(text);
          const [note] = parsedNotes(parsed);
          assert.deepEqual(parsed.diagnostics, []);
          assert.equal(parsedNotes(parsed).length, 1);
          assert.equal(note.rawBlock, block.replace(/\n/g, eol));
          assert.ok(editComment(text, note, 'Updated').endsWith(suffix));
          assert.equal(deleteComment(text, note), bom + unknown.replace(/\n/g, eol));
          const appended = appendGeneralNote(text, 'Next');
          assert.ok(appended.startsWith(text));
          assert.equal(parsedNotes(parse(appended)).length, 2);
          if (!isGeneralNote(note)) {
            assert.ok(rewriteLinesBatch(text, [{ comment: note, start: 8, end: 9 }]).endsWith(suffix));
          }
        }
      }
    }
  }
});

test('deletion rejects stale separator spans without consuming new feedback or siblings', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const block of [appendGeneralNote('', 'Feedback'), appendComment('', fileNote)]) {
      const prefix = '\uFEFF' + block.replace(/\n/g, eol);
      const sibling = appendGeneralNote('', 'Sibling').replace(/\n/g, eol);
      const text = prefix + ` \t${eol}` + sibling;
      const [note] = parsedNotes(parse(text));
      assert.equal(deleteComment(text, note), '\uFEFF' + sibling);
      for (const separator of [`x\t${eol}`, '', eol, ` \t${eol}Extra feedback${eol}`, `##${eol}`]) {
        const changed = prefix + separator + sibling;
        assert.equal(changed.slice(note.startOffset, note.endOffset), note.rawBlock);
        assert.throws(() => deleteComment(changed, note), /changed on disk/);
      }
      // Changing only blank whitespace with the same span remains safe to delete.
      assert.equal(deleteComment(prefix + `\t ${eol}` + sibling, note), '\uFEFF' + sibling);
    }
  }
});

test('general writing rejects unpaired surrogates but preserves valid Unicode without normalization', () => {
  const text = appendGeneralNote('', 'Original');
  const note = parse(text).generalNotes[0];
  for (const invalid of ['\uD800', '\uDC00', 'before\uDBFFafter', '\uDFFF\uD800']) {
    assert.throws(() => appendGeneralNote('', invalid), /unpaired UTF-16 surrogate/);
    assert.throws(() => editComment(text, note, invalid), /unpaired UTF-16 surrogate/);
  }
  const body = '\uFEFF\u96EA \uD83D\uDE80 e\u0301 \u00E9 \uFFFD \uD800\uDC00 \uDBFF\uDFFF\n';
  const appended = appendGeneralNote('', body);
  assert.equal(parse(appended).generalNotes[0].body, body);
  assert.equal(parse(editComment(text, note, body)).generalNotes[0].body, body);
});
