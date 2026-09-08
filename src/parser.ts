import { Comparison, Origin, ParseResult, ReviewComment, Side, normalizeComment } from './model';

const HEADER = /^##\s+File\s*:\s*`([^`]+)`\s*;\s*Lines\s*:\s*(\d+)(?:\s*-\s*(\d+))?\s*;\s*Origin\s*:\s*(changed|staged|head|commit:(?:[0-9a-f]{40}|[0-9a-f]{64}))\s*;\s*Side\s*:\s*(document|left|right)\s*$/i;
const COMPARISON = /^Comparison\s*:\s*Left\s*:\s*`([^`]+)`\s*\(([^)]+)\)\s*;\s*Right\s*:\s*`([^`]+)`\s*\(([^)]+)\)\s*$/i;

interface MarkdownLine {
  text: string;
  start: number;
  end: number;
  next: number;
  heading: boolean;
  outsideFence: boolean;
  fenceOpen?: string;
  fenceClose: boolean;
}

/** Shared by parser and writer so append safety uses the same fence rules. */
export function scanMarkdown(text: string): { lines: MarkdownLine[]; openFence: boolean } {
  const lines: MarkdownLine[] = [];
  let fence: string | undefined;
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) { continue; }
    const bomLength = match.index === 0 && match[0].startsWith('\uFEFF') ? 1 : 0;
    const value = match[0].slice(bomLength).replace(/\r?\n$/, '');
    const start = match.index! + bomLength;
    const outsideFence = !fence;
    let fenceOpen: string | undefined;
    let fenceClose = false;
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(value);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = undefined;
        fenceClose = true;
      }
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(value);
      if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
        fence = fenceOpen = open[1];
      }
    }
    lines.push({ text: value, start, end: start + value.length, next: match.index! + match[0].length,
      heading: outsideFence && /^##\s/.test(value), outsideFence, fenceOpen, fenceClose });
  }
  return { lines, openFence: !!fence };
}

export function parse(text: string): ParseResult {
  const result: ParseResult = { comments: [], diagnostics: [] };
  const { lines, openFence } = scanMarkdown(text);
  const headings = lines.flatMap((line, index) => line.heading ? [index] : []);
  const preambleEnd = headings[0] ?? lines.length;
  for (const line of lines.slice(0, preambleEnd)) {
    const base = line.outsideFence && /^#\s+Review\s+\u00b7\s+base\s+([0-9a-f]{4,64})\s*$/i.exec(line.text);
    if (base) { result.base = base[1]; break; }
  }
  for (let block = 0; block < headings.length; block++) {
    const first = headings[block];
    const limit = headings[block + 1] ?? lines.length;
    const header = lines[first];
    if (!/^##\s+File\b/i.test(header.text)) { continue; }
    let diagnosticLine = first;
    try {
      const match = HEADER.exec(header.text);
      if (!match) { throw new Error('expected File, Lines, Origin and Side fields'); }
      if (limit === lines.length && openFence) {
        for (let index = first + 1; index < limit; index++) {
          if (lines[index].fenceOpen) { diagnosticLine = index; }
        }
        throw new Error('unterminated fenced block');
      }
      let cursor = first + 1;
      const skipBlanks = (): void => {
        while (cursor < limit && !lines[cursor].text.trim()) { cursor++; }
      };
      skipBlanks();
      let anchorText: string | undefined;
      if (cursor < limit && lines[cursor].fenceOpen) {
        const opening = cursor++;
        while (cursor < limit && !lines[cursor].fenceClose) { cursor++; }
        if (cursor === limit) {
          diagnosticLine = opening;
          throw new Error('unterminated anchor fence');
        }
        // Remove only the structural newline immediately before the closing fence.
        anchorText = text.slice(lines[opening].next, lines[cursor].start).replace(/\r?\n$/, '');
        cursor++;
        skipBlanks();
      }
      let comparison: Comparison | undefined;
      if (cursor < limit && /^Comparison\s*:/i.test(lines[cursor].text)) {
        diagnosticLine = cursor;
        const metadata = COMPARISON.exec(lines[cursor].text);
        if (!metadata) { throw new Error('invalid Comparison metadata'); }
        comparison = {
          left: { path: metadata[1], origin: metadata[2].trim() as Origin },
          right: { path: metadata[3], origin: metadata[4].trim() as Origin },
        };
        cursor++;
        skipBlanks();
      }
      let last = limit - 1;
      while (last > first && !lines[last].text.trim()) { last--; }
      const endOffset = lines[last].next;
      const bodyStartOffset = cursor <= last ? lines[cursor].start : endOffset;
      const bodyEndOffset = cursor <= last ? lines[last].end : bodyStartOffset;
      const comment: ReviewComment = normalizeComment({
        path: match[1], startLine: Number(match[2]), endLine: Number(match[3] ?? match[2]),
        origin: match[4] as Origin, side: match[5].toLowerCase() as Side,
        comparison, anchorText, body: text.slice(bodyStartOffset, bodyEndOffset),
      });
      const range = /;\s*Lines\s*:\s*(\d+(?:\s*-\s*\d+)?)/i.exec(header.text)!;
      const rangeStartOffset = header.start + range.index + range[0].length - range[1].length;
      result.comments.push({ ...comment, index: result.comments.length,
        startOffset: header.start, endOffset, bodyStartOffset, bodyEndOffset,
        headerEndOffset: header.end,
        deleteEndOffset: last + 1 < limit ? lines[last + 1].next : endOffset,
        rangeStartOffset, rangeEndOffset: rangeStartOffset + range[1].length,
        rawBlock: text.slice(header.start, endOffset),
      });
    } catch (error) {
      result.diagnostics.push({ line: diagnosticLine + 1,
        message: `unparseable review block: ${(error as Error).message}` });
    }
  }
  return result;
}
