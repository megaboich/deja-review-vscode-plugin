import { ParsedComment, ReviewComment, normalizeComment, validateRange } from './model';
import { parse, scanMarkdown } from './parser';

function newline(text: string): string {
  return /\r?\n/.exec(text)?.[0] ?? '\n';
}

function checkSnapshot(text: string, comment: ParsedComment): void {
  if (text.slice(comment.startOffset, comment.endOffset) !== comment.rawBlock) {
    throw new Error('This comment has changed on disk; re-parse before writing');
  }
}

function checkBody(body: string): void {
  const scanned = scanMarkdown(body);
  if (scanned.openFence || scanned.lines.some(line => line.heading)) {
    throw new Error('Comment body must have balanced fences and no unfenced ## headings');
  }
}

export function appendComment(text: string, input: ReviewComment, base?: string): string {
  const comment = normalizeComment(input);
  if (scanMarkdown(text).openFence) {
    throw new Error('Cannot append after an unterminated fence; repair COMMENTS.md first');
  }
  checkBody(comment.body);
  const eol = newline(text);
  const convert = (value: string): string => value.replace(/\r?\n/g, eol);
  const range = comment.startLine === comment.endLine ? `${comment.startLine}` : `${comment.startLine}-${comment.endLine}`;
  let block = `## File: \`${comment.path}\`; Lines: ${range}; Origin: ${comment.origin}; Side: ${comment.side}${eol}`;
  if (comment.anchorText !== undefined) {
    const anchor = convert(comment.anchorText);
    const runs = anchor.match(/`+/g) ?? [];
    const fence = '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
    block += `${eol}${fence}${eol}${anchor}${eol}${fence}${eol}`;
  }
  if (comment.comparison) {
    const { left, right } = comment.comparison;
    block += `${eol}Comparison: Left: \`${left.path}\` (${left.origin}); Right: \`${right.path}\` (${right.origin})${eol}`;
  }
  block += `${eol}${convert(comment.body)}${eol}`;
  const parsed = parse(block);
  if (parsed.diagnostics.length || parsed.comments.length !== 1
    || parsed.comments[0].anchorText !== (comment.anchorText === undefined ? undefined : convert(comment.anchorText))) {
    throw new Error('Body occupies the reserved anchor or Comparison metadata position');
  }
  let prefix = text;
  if (!prefix && base !== undefined) {
    if (!/^[0-9a-f]{4,64}$/i.test(base)) { throw new Error('invalid base SHA'); }
    prefix = `# Review \u00b7 base ${base}${eol}${eol}`;
  }
  if (prefix && !/(?:\r?\n)[\t ]*(?:\r?\n)$/.test(prefix)) {
    prefix += prefix.endsWith('\n') ? eol : eol + eol;
  }
  return prefix + block;
}

export function editComment(text: string, comment: ParsedComment, body: string): string {
  checkSnapshot(text, comment);
  checkBody(body);
  const eol = newline(comment.rawBlock || text);
  let replacement = body.replace(/\r?\n/g, eol);
  if (comment.bodyStartOffset === comment.bodyEndOffset && replacement) {
    replacement = (text.slice(0, comment.bodyStartOffset).endsWith('\n') ? eol : eol + eol)
      + replacement + eol;
  }
  const result = text.slice(0, comment.bodyStartOffset) + replacement + text.slice(comment.bodyEndOffset);
  const updated = parse(result).comments.find(item => item.startOffset === comment.startOffset);
  if (!updated || updated.anchorText !== comment.anchorText
    || JSON.stringify(updated.comparison) !== JSON.stringify(comment.comparison)) {
    throw new Error('Body occupies the reserved anchor or Comparison metadata position');
  }
  return result;
}

export function deleteComment(text: string, comment: ParsedComment): string {
  checkSnapshot(text, comment);
  return text.slice(0, comment.startOffset) + text.slice(comment.deleteEndOffset);
}

export function rewriteLines(text: string, comment: ParsedComment, start: number, end: number): string {
  checkSnapshot(text, comment);
  validateRange(start, end);
  const range = start === end ? `${start}` : `${start}-${end}`;
  return text.slice(0, comment.rangeStartOffset) + range + text.slice(comment.rangeEndOffset);
}
