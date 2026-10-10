import { isGeneralNote, normalizeComment, parsedNotes, validateRange } from './model';
import type { Comparison, Origin, ParsedComment, ParsedNote, ReviewComment } from './model';
import { BODY_MARKER, WRAPPER_LABEL, parse, scanMarkdown } from './parser';

/** Reject text that UTF-8 encoding would silently replace; never normalize valid Unicode. */
export function assertUtf8Text(text: string): void {
  // Unicode mode matches lone surrogate code points, not valid surrogate pairs.
  if (/[\uD800-\uDFFF]/u.test(text)) {
    throw new Error('Review note text contains an unpaired UTF-16 surrogate and cannot be saved losslessly as UTF-8.');
  }
}

function newline(text: string): string {
  return /\r\n|\r|\n/.exec(text)?.[0] ?? '\n';
}

function checkSnapshot(text: string, comment: ParsedNote): void {
  if (text.slice(comment.startOffset, comment.endOffset) !== comment.rawBlock) {
    throw new Error('This review note has changed on disk; re-parse before writing');
  }
}

/** A backtick fence that outlasts every backtick run in text, including unbalanced body fences. */
function longestFence(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  return '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
}

function serializeBody(body: string, eol: string): string {
  body = body.replace(/\r\n|\r|\n/g, eol);
  const scanned = scanMarkdown(body);
  const hasHeading = scanned.lines.some(line => line.heading);
  // Prefixing the marker would leave the body's own first line reading as the wrapper label.
  const collidesWithWrapperMarker = scanned.lines[0]?.text === WRAPPER_LABEL;
  // A marker before a leading fence would stop Markdown recognizing that fence.
  const startsWithFence = !!scanned.lines.find(line => line.text.trim())?.fenceOpen;
  const hasBoundaryWhitespace = body !== '' && (
    !scanned.lines[0]?.text.trim()
    || !scanned.lines.at(-1)?.text.trim()
    || /[\r\n]$/.test(body)
    || body.startsWith('\uFEFF')
  );
  if (!scanned.openFence && !hasHeading && !collidesWithWrapperMarker && !startsWithFence && !hasBoundaryWhitespace) {
    return body ? `${BODY_MARKER} ${body}` : BODY_MARKER;
  }

  const fence = longestFence(body);
  return [`${BODY_MARKER} ${WRAPPER_LABEL}`, `${fence}markdown`, body, fence].join(eol);
}

function originLabel(origin: Origin): string {
  switch (origin) {
    case 'changed':
      return 'Working tree';
    case 'staged':
      return 'Staging area';
    case 'head':
      return 'HEAD';
    default:
      return `Commit ${origin.slice('commit:'.length)}`;
  }
}

function rangeLabel(comment: ReviewComment): string {
  if (comment.wholeFile) {
    return 'file';
  }
  return comment.startLine === comment.endLine
    ? `${comment.startLine}`
    : `${comment.startLine}-${comment.endLine}`;
}

/** Selected origin first, with explicit side provenance and the opposite endpoint for comparisons. */
function contextLabel(comment: ReviewComment): string {
  const selected = originLabel(comment.origin);
  if (!comment.comparison) {
    return selected;
  }

  const opposite = comment.side === 'left' ? comment.comparison.right : comment.comparison.left;
  let endpoint = originLabel(opposite.origin);
  if (opposite.path !== comment.path) {
    endpoint = `\`${opposite.path}\` @ ${endpoint}`;
  }
  return `${comment.side === 'left' ? 'Original' : 'Modified'}: ${selected} vs ${endpoint}`;
}

function sameComparison(left: Comparison | undefined, right: Comparison | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.left.path === right.left.path && left.left.origin === right.left.origin
    && left.right.path === right.right.path && left.right.origin === right.right.origin;
}

export function appendComment(text: string, input: ReviewComment): string {
  const comment = normalizeComment(input);
  const eol = newline(text);
  const convert = (value: string): string => value.replace(/\r\n|\r|\n/g, eol);

  const elision = comment.elided ? '; Snippet: elided' : '';
  let block = `## \`${comment.path}\`:${rangeLabel(comment)} (${contextLabel(comment)})${elision}${eol}`;
  if (comment.anchorText !== undefined) {
    const anchor = convert(comment.anchorText);
    const fence = longestFence(anchor);
    block += `${eol}${fence}${eol}${anchor}${eol}${fence}${eol}`;
  }
  block += `${eol}${serializeBody(comment.body, eol)}${eol}`;

  const parsed = parse(block);
  if (parsed.diagnostics.length || parsed.comments.length !== 1
    || parsed.comments[0].anchorText !== (comment.anchorText === undefined ? undefined : convert(comment.anchorText))
    || parsed.comments[0].body !== convert(comment.body)) {
    throw new Error('Review note could not be serialized without changing its content');
  }
  return appendBlock(text, block);
}

export function appendGeneralNote(text: string, body: string): string {
  const eol = newline(text);
  const block = `## General Review Note${eol}${eol}${serializeBody(body, eol)}${eol}`;
  const parsed = parse(block);
  if (parsed.diagnostics.length || parsed.generalNotes.length !== 1 || parsed.comments.length
    || parsed.generalNotes[0].body !== body.replace(/\r\n|\r|\n/g, eol)) {
    throw new Error('Review note could not be serialized without changing its content');
  }
  return appendBlock(text, block);
}

function appendBlock(text: string, block: string): string {
  if (scanMarkdown(text).openFence) {
    throw new Error('Cannot append after an unterminated fence; repair REVIEW-NOTES.md first');
  }
  const eol = newline(text);
  let prefix = text;
  if (prefix && !/(?:\r\n|\r(?!\n)|\n)[\t ]*(?:\r\n|\r|\n)$/.test(prefix)) {
    prefix += /[\r\n]$/.test(prefix) ? eol : eol + eol;
  }
  const result = prefix + block;
  assertUtf8Text(result);
  return result;
}

/** The target must come from a fresh parse of text, not an entry from an earlier projection. */
export function editComment(text: string, comment: ParsedNote, body: string): string {
  checkSnapshot(text, comment);

  const eol = newline(comment.rawBlock || text);
  const replacement = serializeBody(body, eol);

  const result = text.slice(0, comment.bodyStartOffset) + replacement + text.slice(comment.bodyEndOffset);
  assertUtf8Text(result);

  // Validate the splice by reparsing without regenerating context or sibling blocks.
  const updated = parsedNotes(parse(result)).find(item => item.startOffset === comment.startOffset);
  if (!updated || isGeneralNote(updated) !== isGeneralNote(comment)
    || updated.body !== body.replace(/\r\n|\r|\n/g, eol)) {
    throw new Error('Edited Review Note body could not be spliced without changing its content');
  }
  if (!isGeneralNote(updated) && !isGeneralNote(comment)
    && (updated.anchorText !== comment.anchorText
      || !sameComparison(updated.comparison, comment.comparison))) {
    throw new Error('Editing this Review Note would change its captured file context');
  }
  return result;
}

/** Reparse stale targets before calling; deletion also validates the following separator span. */
export function deleteComment(text: string, comment: ParsedNote): string {
  checkSnapshot(text, comment);
  const current = parsedNotes(parse(text)).find(item => item.startOffset === comment.startOffset);
  if (!current || current.rawBlock !== comment.rawBlock || current.deleteEndOffset !== comment.deleteEndOffset) {
    throw new Error('This review note or its separator has changed on disk; re-parse before writing');
  }
  return text.slice(0, comment.startOffset) + text.slice(comment.deleteEndOffset);
}

/** The target and its range offsets must come from a fresh parse of text. */
export function rewriteLines(text: string, comment: ParsedComment, start: number, end: number): string {
  checkSnapshot(text, comment);
  if (comment.wholeFile) {
    throw new Error('Whole-file Review Notes have no line numbers to rewrite');
  }
  validateRange(start, end);
  const range = start === end ? `${start}` : `${start}-${end}`;
  return text.slice(0, comment.rangeStartOffset) + range + text.slice(comment.rangeEndOffset);
}

/** All comments must be resolved against the same initial text snapshot. */
export function rewriteLinesBatch(text: string,
  updates: readonly { comment: ParsedComment; start: number; end: number }[]): string {
  const ordered = [...updates].sort((a, b) => b.comment.startOffset - a.comment.startOffset);
  for (let index = 0; index < ordered.length; index++) {
    const { comment, start, end } = ordered[index];
    checkSnapshot(text, comment);
    validateRange(start, end);
    if (index && comment.endOffset > ordered[index - 1].comment.startOffset) {
      throw new Error('Cannot rewrite the same or overlapping review note twice');
    }
  }

  for (const { comment, start, end } of ordered) {
    text = rewriteLines(text, comment, start, end);
  }
  return text;
}
