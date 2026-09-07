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
  body: string;
}

export interface ParsedComment extends ReviewComment {
  index: number;
  /** String offsets (UTF-16), suitable for lossless String.slice splices. */
  startOffset: number;
  endOffset: number;
  bodyStartOffset: number;
  bodyEndOffset: number;
  headerEndOffset: number;
  deleteEndOffset: number;
  rangeStartOffset: number;
  rangeEndOffset: number;
  rawBlock: string;
}

export interface ParseResult {
  comments: ParsedComment[];
  diagnostics: { line: number; message: string }[];
  base?: string;
}

export interface ResolvedAnchor {
  startLine: number;
  endLine: number;
  confidence: 'high' | 'low';
}

export function normalizeResource(resource: Resource): Resource {
  const path = resource.path.replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path)
    || /[\x00-\x1f\x7f`]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('expected a repo-relative path without traversal');
  }
  const origin = resource.origin.toLowerCase();
  if (!/^(?:changed|staged|head|commit:(?:[0-9a-f]{40}|[0-9a-f]{64}))$/.test(origin)) {
    throw new Error('invalid Origin');
  }
  return { path, origin: origin as Origin };
}

export function validateRange(start: number, end: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new Error('expected positive, ordered Lines');
  }
}

export function normalizeComment(comment: ReviewComment): ReviewComment {
  validateRange(comment.startLine, comment.endLine);
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
    if (comparison) { throw new Error('Side: document must omit Comparison'); }
  } else {
    if (!comparison) { throw new Error('comparison Side requires Comparison'); }
    const selected = comparison[comment.side];
    if (selected.path !== resource.path || selected.origin !== resource.origin) {
      throw new Error('Comparison endpoint disagrees with File or Origin');
    }
  }
  return { ...comment, ...resource, comparison };
}
