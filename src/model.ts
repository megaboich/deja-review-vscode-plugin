export type Origin = 'changed' | 'staged' | 'head' | `commit:${string}`;
export type Side = 'document' | 'left' | 'right';

export interface Resource {
  path: string;
  origin: Origin;
}

export interface Comparison {
  left: Resource;
  right: Resource;
}

export interface ReviewComment extends Resource {
  startLine: number;
  endLine: number;
  side: Side;
  comparison?: Comparison;
  anchorText?: string;
  /**
   * True when anchorText omits the middle of a captured range: first 10 lines,
   * a bare `...` line, then last 5 lines. The range still covers all captured lines.
   * Serialized as `Snippet: elided`; remains true if re-anchoring shrinks the range.
   * When false or absent, `...` in anchorText is literal source text.
   */
  elided?: boolean;
  body: string;
}

export interface ParsedComment extends ReviewComment {
  index: number;
  /** String offsets (UTF-16), suitable for lossless String.slice splices. */
  startOffset: number;
  endOffset: number;
  /** Serialized body span, including any protective wrapper; not necessarily equal to body. */
  bodyStartOffset: number;
  bodyEndOffset: number;
  headerEndOffset: number;
  deleteEndOffset: number;
  rangeStartOffset: number;
  rangeEndOffset: number;
  rawBlock: string;
}

export interface GeneralReviewNote {
  kind: 'general';
  body: string;
}

export interface ParsedGeneralNote extends GeneralReviewNote {
  index: number;
  /** String offsets (UTF-16), suitable for lossless String.slice splices. */
  startOffset: number;
  endOffset: number;
  /** Serialized body span, including any protective wrapper. */
  bodyStartOffset: number;
  bodyEndOffset: number;
  headerEndOffset: number;
  deleteEndOffset: number;
  rawBlock: string;
}

export type ParsedNote = ParsedComment | ParsedGeneralNote;

export function isGeneralNote(note: ParsedNote): note is ParsedGeneralNote {
  return 'kind' in note && note.kind === 'general';
}

export interface ParseResult {
  comments: ParsedComment[];
  generalNotes: ParsedGeneralNote[];
  diagnostics: { line: number; message: string }[];
  base?: string;
}

export function parsedNotes(result: ParseResult): ParsedNote[] {
  return [...result.comments, ...result.generalNotes].sort((a, b) => a.startOffset - b.startOffset);
}

export interface ResolvedAnchor {
  startLine: number;
  endLine: number;
  confidence: 'high' | 'low';
}

function isOrigin(value: string): value is Origin {
  return /^(?:changed|staged|head|commit:(?:[0-9a-f]{40}|[0-9a-f]{64}))$/.test(value);
}

export function normalizeResource(resource: Resource): Resource {
  const path = resource.path.replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path)
    || /[\x00-\x1f\x7f`]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('expected a repo-relative path without traversal');
  }

  const origin = resource.origin.toLowerCase();
  if (!isOrigin(origin)) {
    throw new Error('invalid Origin');
  }
  return { path, origin };
}

export function validateRange(start: number, end: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new Error('expected positive, ordered Lines');
  }
}

export function normalizeComment(comment: ReviewComment): ReviewComment {
  validateRange(comment.startLine, comment.endLine);
  if (comment.elided) {
    const anchor = comment.anchorText?.split(/\r\n|\r|\n/);
    if (anchor?.length !== 16 || anchor[10] !== '...') {
      throw new Error('Snippet: elided requires first 10 lines, a bare ..., and last 5 lines');
    }
  }

  const resource = normalizeResource(comment);
  if (!['document', 'left', 'right'].includes(comment.side)) {
    throw new Error('invalid Side');
  }

  let comparison: Comparison | undefined;
  if (comment.comparison) {
    comparison = {
      left: normalizeResource(comment.comparison.left),
      right: normalizeResource(comment.comparison.right),
    };
  }

  if (comment.side === 'document') {
    if (comparison) {
      throw new Error('Side: document must omit Comparison');
    }
  } else {
    if (!comparison) {
      throw new Error('comparison Side requires Comparison');
    }
    const selected = comparison[comment.side];
    if (selected.path !== resource.path || selected.origin !== resource.origin) {
      throw new Error('Comparison endpoint disagrees with File or Origin');
    }
  }

  return { ...comment, ...resource, comparison };
}
