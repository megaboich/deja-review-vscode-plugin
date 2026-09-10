import { isGeneralNote, normalizeComment, parsedNotes, validateRange } from './model';
import type { Origin, ParsedComment, ParsedNote, ReviewComment } from './model';
import { parse, scanMarkdown } from './parser';

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

function serializeBody(body: string, eol: string, hasAnchor: boolean): string {
  body = body.replace(/\r\n|\r|\n/g, eol);
  const scanned = scanMarkdown(body);
  const first = scanned.lines.find(line => line.text.trim());
  const hasReservedLines = scanned.lines.some(line => {
    if (line.heading) {
      return true;
    }
    return line.outsideFence && /^\s*(?:Comparison|Selected|Body)\s*:/i.test(line.text);
  });
  const couldBecomeAnchor = !hasAnchor && !!first?.fenceOpen;
  const hasBoundaryWhitespace = body !== '' && (
    !scanned.lines[0]?.text.trim()
    || !scanned.lines.at(-1)?.text.trim()
    || /[\r\n]$/.test(body)
    || body.startsWith('\uFEFF')
  );
  if (!scanned.openFence && !hasReservedLines && !couldBecomeAnchor && !hasBoundaryWhitespace) {
    return body;
  }

  // The wrapper must outlast every backtick run, including unbalanced body fences.
  const runs = body.match(/`+/g) ?? [];
  const fence = '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
  return ['Body: fenced', `${fence}markdown`, body, fence].join(eol);
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

export function appendComment(text: string, input: ReviewComment, base?: string): string {
  const comment = normalizeComment(input);
  const eol = newline(text);
  const convert = (value: string): string => value.replace(/\r\n|\r|\n/g, eol);
  const range = comment.startLine === comment.endLine ? `${comment.startLine}` : `${comment.startLine}-${comment.endLine}`;

  const context: string[] = [];
  let selected = originLabel(comment.origin);
  if (comment.comparison) {
    const { left, right } = comment.comparison;
    const samePath = left.path === right.path;
    let original = originLabel(left.origin);
    let modified = originLabel(right.origin);
    if (!samePath) {
      original = `\`${left.path}\` (${original})`;
      modified = `\`${right.path}\` (${modified})`;
    }
    context.push(`Comparison: ${original} -> ${modified}`);
    selected = `${comment.side === 'left' ? 'Original' : 'Modified'} (${selected})`;
  }
  context.push(`Selected: ${selected}`);

  const header = `## \`${comment.path}\`:${range}${comment.elided ? '; Snippet: elided' : ''}`;
  let block = [header, ...context, ''].join(eol);
  if (comment.anchorText !== undefined) {
    const anchor = convert(comment.anchorText);
    const runs = anchor.match(/`+/g) ?? [];
    const fence = '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
    block += `${eol}${fence}${eol}${anchor}${eol}${fence}${eol}`;
  }
  block += `${eol}${serializeBody(comment.body, eol, comment.anchorText !== undefined)}${eol}`;

  const parsed = parse(block);
  if (parsed.diagnostics.length || parsed.comments.length !== 1
    || parsed.comments[0].anchorText !== (comment.anchorText === undefined ? undefined : convert(comment.anchorText))
    || parsed.comments[0].body !== convert(comment.body)) {
    throw new Error('Review note could not be serialized without changing its content');
  }
  return appendBlock(text, block, base);
}

export function appendGeneralNote(text: string, body: string, base?: string): string {
  const eol = newline(text);
  const block = `## General Review Note${eol}${eol}${serializeBody(body, eol, false)}${eol}`;
  const parsed = parse(block);
  if (parsed.diagnostics.length || parsed.generalNotes.length !== 1 || parsed.comments.length
    || parsed.generalNotes[0].body !== body.replace(/\r\n|\r|\n/g, eol)) {
    throw new Error('Review note could not be serialized without changing its content');
  }
  return appendBlock(text, block, base);
}

function appendBlock(text: string, block: string, base?: string): string {
  if (scanMarkdown(text).openFence) {
    throw new Error('Cannot append after an unterminated fence; repair REVIEW-NOTES.md first');
  }
  const eol = newline(text);
  let prefix = text;
  if (!prefix && base !== undefined) {
    if (!/^[0-9a-f]{4,64}$/i.test(base)) {
      throw new Error('invalid base SHA');
    }
    prefix = `# Review \u00b7 base ${base}${eol}${eol}`;
  }
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
  const hasAnchor = !isGeneralNote(comment) && comment.anchorText !== undefined;
  let replacement = serializeBody(body, eol, hasAnchor);
  if (comment.bodyStartOffset === comment.bodyEndOffset && replacement) {
    const prefix = text.slice(0, comment.bodyStartOffset);
    const separator = /[\r\n]$/.test(prefix) ? eol : eol + eol;
    replacement = separator + replacement + eol;
  }

  const result = text.slice(0, comment.bodyStartOffset) + replacement + text.slice(comment.bodyEndOffset);
  assertUtf8Text(result);

  // Validate the splice by reparsing without regenerating context or sibling blocks.
  const updated = parsedNotes(parse(result)).find(item => item.startOffset === comment.startOffset);
  if (!updated || isGeneralNote(updated) !== isGeneralNote(comment)
    || updated.body !== body.replace(/\r\n|\r|\n/g, eol)) {
    throw new Error('Review note could not be serialized without changing its content');
  }
  if (!isGeneralNote(updated) && !isGeneralNote(comment)
    && (updated.anchorText !== comment.anchorText
      || JSON.stringify(updated.comparison) !== JSON.stringify(comment.comparison))) {
    throw new Error('Review note could not be serialized without changing its content');
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
