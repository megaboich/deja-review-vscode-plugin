import { normalizeComment, normalizeResource } from './model';
import type { Comparison, Origin, ParseResult, ReviewComment, Side } from './model';

/** Saved-file marker introducing a note body. The model and UI body never include it. */
export const BODY_MARKER = '💬';
/** Exact label following BODY_MARKER when the body needs a protective fenced wrapper. */
export const WRAPPER_LABEL = 'Body: fenced';

// `path`:range (context) with an optional trailing elision marker. The greedy context
// capture stops at the last `)` on the line, so paths may contain parentheses.
const HEADER = /^##\s+`(?<path>[^`]+)`\s*:\s*(?<range>(?<wholeFile>file)|(?<start>\d+)(?:\s*-\s*(?<end>\d+))?)\s+\((?<context>[^\r\n]*)\)(?:\s*;\s*Snippet\s*:\s*(?<elided>elided))?\s*$/di;
const ORIGIN_LABEL = '(?:Working\\s+tree|Staging\\s+area|HEAD|Commit\\s+(?:[0-9a-f]{40}|[0-9a-f]{64}))';
const DOCUMENT_CONTEXT = new RegExp(`^\\s*(?<origin>${ORIGIN_LABEL})\\s*$`, 'i');
const COMPARISON_CONTEXT = new RegExp(
  `^\\s*(?<side>Original|Modified)\\s*:\\s*(?<origin>${ORIGIN_LABEL})\\s+vs\\s+`
  + `(?:\`(?<oppositePath>[^\`]+)\`\\s*@\\s*)?(?<oppositeOrigin>${ORIGIN_LABEL})\\s*$`, 'i');
// Matches only a marker that ends the line or is followed by one separating space,
// so `💬Body: fenced` stays malformed rather than decoding as a wrapper.
const BODY_MARKER_PREFIX = new RegExp(`^${BODY_MARKER}(?: |$)`);

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
  const marker = first <= last ? BODY_MARKER_PREFIX.exec(lines[first].text) : null;
  if (!marker) {
    throw new Error(`expected ${BODY_MARKER} before the Review Note body`);
  }
  if (lines[first].text.slice(marker[0].length) !== WRAPPER_LABEL) {
    return text.slice(lines[first].start + marker[0].length, lines[last].end);
  }

  const opening = first + 1;
  if (opening >= last || !lines[opening].fenceOpen || !/^`{3,}markdown$/.test(lines[opening].text)) {
    throw new Error('expected a fenced Review Note body');
  }
  let closing = opening + 1;
  while (closing <= last && !lines[closing].fenceClose) {
    closing++;
  }
  if (closing !== last) {
    throw new Error('fenced Review Note body must end at its closing fence');
  }

  // Decode once, removing only the structural newline before the closing fence.
  return text.slice(lines[opening].next, lines[closing].start).replace(/(?:\r\n|\r|\n)$/, '');
}

export function parse(text: string): ParseResult {
  const result: ParseResult = { comments: [], generalNotes: [], diagnostics: [] };
  const { lines, openFence } = scanMarkdown(text);
  const headings = lines.flatMap((line, index) => line.heading ? [index] : []);

  for (let block = 0; block < headings.length; block++) {
    const first = headings[block];
    const limit = headings[block + 1] ?? lines.length;
    const header = lines[first];
    const general = header.text === '## General Review Note';
    if (!general && /^##\s+general\s+review\s+notes?[\s:\d]*$/i.test(header.text)) {
      // Near misses stay opaque, but silently ignoring them would hide the feedback from every view.
      result.diagnostics.push({ line: first + 1, message: 'unparseable review block: a general note heading must be exactly "## General Review Note"' });
      continue;
    }
    if (!general && !/^##\s+`/.test(header.text)) {
      continue;
    }

    let diagnosticLine = first;
    try {
      const match = HEADER.exec(header.text);
      const fields = match?.groups;
      const range = match?.indices?.groups?.range;
      if (!general && (!fields || !range)) {
        throw new Error('expected `path`:range (context) and optional Snippet suffix');
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
        const { path, start, end, elided, wholeFile, context } = fields;
        const selection = (COMPARISON_CONTEXT.exec(context) ?? DOCUMENT_CONTEXT.exec(context))?.groups;
        if (!selection) {
          throw new Error('invalid note context; use an origin or Original/Modified: selected origin vs opposite revision');
        }
        const origin = parseOrigin(selection.origin);
        let side: Side = 'document';
        let comparison: Comparison | undefined;
        if (selection.side) {
          side = selection.side.toLowerCase() === 'original' ? 'left' : 'right';
          const selected = normalizeResource({ path, origin });
          const opposite = normalizeResource({
            path: selection.oppositePath ?? path,
            origin: parseOrigin(selection.oppositeOrigin),
          });
          comparison = side === 'left' ? { left: selected, right: opposite } : { left: opposite, right: selected };
        }

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
          ...(wholeFile ? { wholeFile: true } : {}),
          startLine: wholeFile ? 1 : Number(start),
          endLine: wholeFile ? 1 : Number(end ?? start),
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
      // A missing or malformed body marker belongs to the body line, not the heading.
      diagnosticLine = cursor < limit ? cursor : first;
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
        const { rangeStartOffset, rangeEndOffset, ...commentFields } = file;
        // normalizeComment rejects ranges, elision shape and comparison endpoints: heading errors.
        diagnosticLine = first;
        const comment = normalizeComment({ ...commentFields, body });
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
        message: `unparseable review block: ${error instanceof Error ? error.message : 'invalid Review Note'}`,
      });
    }
  }
  return result;
}
