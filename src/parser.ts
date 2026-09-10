import { normalizeComment, normalizeResource } from './model';
import type { Comparison, Origin, ParseResult, ReviewComment, Side } from './model';

const HEADER = /^##\s+`(?<path>[^`]+)`\s*:\s*(?<range>(?<start>\d+)(?:\s*-\s*(?<end>\d+))?)(?:\s*;\s*Snippet\s*:\s*(?<elided>elided))?\s*$/di;
const ORIGIN_LABEL = '(?:Working\\s+tree|Staging\\s+area|HEAD|Commit\\s+(?:[0-9a-f]{40}|[0-9a-f]{64}))';
const DOCUMENT_SELECTION = new RegExp(`^\\s*Selected\\s*:\\s*(?<origin>${ORIGIN_LABEL})\\s*$`, 'i');
const COMPARISON_SELECTION = new RegExp(
  `^\\s*Selected\\s*:\\s*(?<side>Original|Modified)\\s*\\(\\s*(?<origin>${ORIGIN_LABEL})\\s*\\)\\s*$`, 'i');
const SAME_FILE_COMPARISON = new RegExp(
  `^\\s*Comparison\\s*:\\s*(?<leftOrigin>${ORIGIN_LABEL})\\s*->\\s*(?<rightOrigin>${ORIGIN_LABEL})\\s*$`, 'i');
const NAMED_FILE_COMPARISON = new RegExp(
  `^\\s*Comparison\\s*:\\s*\`(?<leftPath>[^\`]+)\`\\s*\\((?<leftOrigin>${ORIGIN_LABEL})\\)\\s*->\\s*`
  + `\`(?<rightPath>[^\`]+)\`\\s*\\((?<rightOrigin>${ORIGIN_LABEL})\\)\\s*$`, 'i');

function parseOrigin(label: string): Origin {
  const value = label.toLowerCase().replace(/\s+/g, ' ');
  switch (value) {
    case 'working tree':
      return 'changed';
    case 'staging area':
      return 'staged';
    case 'head':
      return 'head';
    default:
      return `commit:${value.slice('commit '.length)}`;
  }
}

function parseComparison(text: string, path: string): Comparison {
  const endpoints = (SAME_FILE_COMPARISON.exec(text) ?? NAMED_FILE_COMPARISON.exec(text))?.groups;
  if (!endpoints) {
    throw new Error('invalid Comparison metadata');
  }

  return {
    left: normalizeResource({ path: endpoints.leftPath ?? path, origin: parseOrigin(endpoints.leftOrigin) }),
    right: normalizeResource({ path: endpoints.rightPath ?? path, origin: parseOrigin(endpoints.rightOrigin) }),
  };
}

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

/** Scan only the Markdown structure needed for notes, retaining exact offsets for targeted writes. */
export function scanMarkdown(text: string): { lines: MarkdownLine[]; openFence: boolean } {
  const lines: MarkdownLine[] = [];
  let fence: string | undefined;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!match[0]) {
      continue;
    }
    const bomLength = match.index === 0 && match[0].startsWith('\uFEFF') ? 1 : 0;
    const value = match[0].slice(bomLength).replace(/(?:\r\n|\r|\n)$/, '');
    const start = match.index + bomLength;
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
        fence = open[1];
        fenceOpen = open[1];
      }
    }
    lines.push({
      text: value,
      start,
      end: start + value.length,
      next: match.index + match[0].length,
      heading: outsideFence && /^##(?:\s|$)/.test(value),
      outsideFence,
      fenceOpen,
      fenceClose,
    });
  }
  return { lines, openFence: !!fence };
}

function decodeBody(text: string, lines: MarkdownLine[], first: number, last: number): string {
  if (first > last) {
    return '';
  }
  if (lines[first].text !== 'Body: fenced') {
    return text.slice(lines[first].start, lines[last].end);
  }

  const opening = first + 1;
  if (opening >= last || !lines[opening].fenceOpen || !/^`{3,}markdown$/.test(lines[opening].text)) {
    throw new Error('expected a fenced review note body');
  }
  let closing = opening + 1;
  while (closing <= last && !lines[closing].fenceClose) {
    closing++;
  }
  if (closing !== last) {
    throw new Error('fenced review note body must end at its closing fence');
  }

  // Decode once, removing only the structural newline before the closing fence.
  return text.slice(lines[opening].next, lines[closing].start).replace(/(?:\r\n|\r|\n)$/, '');
}

export function parse(text: string): ParseResult {
  const result: ParseResult = { comments: [], generalNotes: [], diagnostics: [] };
  const { lines, openFence } = scanMarkdown(text);
  const headings = lines.flatMap((line, index) => line.heading ? [index] : []);

  const preambleEnd = headings[0] ?? lines.length;
  for (const line of lines.slice(0, preambleEnd)) {
    const base = line.outsideFence && /^#\s+Review\s+\u00b7\s+base\s+([0-9a-f]{4,64})\s*$/i.exec(line.text);
    if (base) {
      result.base = base[1].toLowerCase();
      break;
    }
  }

  for (let block = 0; block < headings.length; block++) {
    const first = headings[block];
    const limit = headings[block + 1] ?? lines.length;
    const header = lines[first];
    const general = header.text === '## General Review Note';
    if (!general && !/^##\s+`/.test(header.text)) {
      continue;
    }

    let diagnosticLine = first;
    try {
      const match = HEADER.exec(header.text);
      const fields = match?.groups;
      const range = match?.indices?.groups?.range;
      if (!general && (!fields || !range)) {
        throw new Error('expected `path`:range and optional Snippet suffix');
      }
      if (limit === lines.length && openFence) {
        for (let index = first + 1; index < limit; index++) {
          if (lines[index].fenceOpen) {
            diagnosticLine = index;
          }
        }
        throw new Error('unterminated fenced block');
      }

      let cursor = first + 1;
      const skipBlanks = (): void => {
        while (cursor < limit && !lines[cursor].text.trim()) {
          cursor++;
        }
      };
      skipBlanks();

      // File grammar consumes context and an optional anchor; general notes start at the body.
      let file: (Omit<ReviewComment, 'body'> & { rangeStartOffset: number; rangeEndOffset: number }) | undefined;
      if (!general && fields && range) {
        const { path, start, end, elided } = fields;
        diagnosticLine = cursor < limit ? cursor : first;
        let comparison: Comparison | undefined;
        if (cursor < limit && /^\s*Comparison\s*:/i.test(lines[cursor].text)) {
          comparison = parseComparison(lines[cursor].text, path);
          cursor++;
          skipBlanks();
          diagnosticLine = cursor < limit ? cursor : diagnosticLine;
        }

        const selection = (comparison ? COMPARISON_SELECTION : DOCUMENT_SELECTION)
          .exec(cursor < limit ? lines[cursor].text : '')?.groups;
        if (!selection) {
          throw new Error('invalid or missing Selected metadata');
        }
        const origin = parseOrigin(selection.origin);
        let side: Side = 'document';
        if (comparison) {
          side = selection.side.toLowerCase() === 'original' ? 'left' : 'right';
        }
        cursor++;
        skipBlanks();

        let anchorText: string | undefined;
        if (cursor < limit && lines[cursor].fenceOpen) {
          const opening = cursor;
          cursor++;
          while (cursor < limit && !lines[cursor].fenceClose) {
            cursor++;
          }
          if (cursor === limit) {
            diagnosticLine = opening;
            throw new Error('unterminated anchor fence');
          }
          // Remove only the structural newline immediately before the closing fence.
          anchorText = text.slice(lines[opening].next, lines[cursor].start).replace(/(?:\r\n|\r|\n)$/, '');
          cursor++;
          skipBlanks();
        }
        file = {
          path,
          startLine: Number(start),
          endLine: Number(end ?? start),
          origin,
          side,
          comparison,
          anchorText,
          elided: elided ? true : undefined,
          rangeStartOffset: header.start + range[0],
          rangeEndOffset: header.start + range[1],
        };
      }

      // Decode the body separately from its serialized span, which includes any wrapper.
      let last = limit - 1;
      while (last > first && !lines[last].text.trim()) {
        last--;
      }
      const endOffset = lines[last].next;
      const bodyStartOffset = cursor <= last ? lines[cursor].start : endOffset;
      const bodyEndOffset = cursor <= last ? lines[last].end : bodyStartOffset;
      if (cursor <= last && lines[cursor].text === 'Body: fenced') {
        diagnosticLine = cursor;
      }
      const body = decodeBody(text, lines, cursor, last);
      const splice = {
        startOffset: header.start,
        endOffset,
        bodyStartOffset,
        bodyEndOffset,
        headerEndOffset: header.end,
        deleteEndOffset: last + 1 < limit ? lines[last + 1].next : endOffset,
        rawBlock: text.slice(header.start, endOffset),
      };
      if (file) {
        const { rangeStartOffset, rangeEndOffset, ...context } = file;
        const comment = normalizeComment({ ...context, body });
        result.comments.push({
          ...comment,
          ...splice,
          index: result.comments.length,
          rangeStartOffset,
          rangeEndOffset,
        });
      } else {
        result.generalNotes.push({ kind: 'general', body, ...splice, index: result.generalNotes.length });
      }
    } catch (error) {
      result.diagnostics.push({
        line: diagnosticLine + 1,
        message: `unparseable review block: ${error instanceof Error ? error.message : 'invalid review note'}`,
      });
    }
  }
  return result;
}
