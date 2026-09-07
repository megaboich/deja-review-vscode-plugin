import { ResolvedAnchor, ReviewComment } from './model';

function normalize(lines: string[], ignoreIndent: boolean): string[] {
  const trimmed = lines.map(line => line.replace(/[\t ]+$/, ''));
  if (!ignoreIndent) { return trimmed; }
  let indent: string | undefined;
  for (const line of trimmed) {
    if (!line) { continue; }
    const leading = /^[\t ]*/.exec(line)![0];
    if (indent === undefined) { indent = leading; }
    while (!leading.startsWith(indent)) { indent = indent.slice(0, -1); }
  }
  return trimmed.map(line => line.slice(indent?.length ?? 0));
}

export function resolveAnchor(comment: ReviewComment, content: string, radius = 50): ResolvedAnchor | undefined {
  const { startLine, endLine } = comment;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    return undefined;
  }
  if (comment.anchorText === undefined) { return { startLine, endLine, confidence: 'low' }; }
  const source = content.split(/\r?\n/);
  const anchor = comment.anchorText.split(/\r?\n/);
  const elided = endLine - startLine + 1 > 20 && anchor.length === 16 && anchor[10] === '...';
  const prefix = elided ? anchor.slice(0, 10) : anchor;
  const suffix = elided ? anchor.slice(11) : [];
  const visible = [...prefix, ...suffix];
  const recorded = startLine - 1;
  const distance = Number.isFinite(radius) ? Math.max(0, Math.floor(radius)) : 50;

  for (const ignoreIndent of [false, true]) {
    const expected = normalize(visible, ignoreIndent);
    const matches = (start: number, end: number): boolean => {
      if (start < 0 || end >= source.length || end < start + visible.length - 1) { return false; }
      const actual = normalize(elided
        ? [...source.slice(start, start + prefix.length), ...source.slice(end - suffix.length + 1, end + 1)]
        : source.slice(start, end + 1), ignoreIndent);
      return actual.length === expected.length && actual.every((line, index) => line === expected[index]);
    };
    if (matches(recorded, endLine - 1)) { return { startLine, endLine, confidence: 'high' }; }

    // Pre-filter the suffix once; both ends are then checked together so relative
    // indentation between the prefix and suffix is still significant.
    const suffixEnds: number[] = [];
    if (elided) {
      const expectedSuffix = normalize(suffix, ignoreIndent);
      for (let end = suffix.length - 1; end < source.length; end++) {
        const actual = normalize(source.slice(end - suffix.length + 1, end + 1), ignoreIndent);
        if (actual.every((line, index) => line === expectedSuffix[index])) { suffixEnds.push(end); }
      }
    }
    const expectedPrefix = normalize(prefix, ignoreIndent);
    const search = (min: number, max: number): ResolvedAnchor | undefined => {
      const hits: { start: number; end: number }[] = [];
      for (let start = Math.max(0, min); start <= Math.min(max, source.length - prefix.length); start++) {
        if (elided) {
          const actualPrefix = normalize(source.slice(start, start + prefix.length), ignoreIndent);
          if (!actualPrefix.every((line, index) => line === expectedPrefix[index])) { continue; }
        }
        for (const end of elided ? suffixEnds : [start + prefix.length - 1]) {
          if (matches(start, end)) { hits.push({ start, end }); }
        }
      }
      hits.sort((a, b) => Math.abs(a.start - recorded) - Math.abs(b.start - recorded)
        || Math.abs(a.end - a.start - (endLine - startLine)) - Math.abs(b.end - b.start - (endLine - startLine))
        || a.start - b.start || a.end - b.end);
      return hits.length ? { startLine: hits[0].start + 1, endLine: hits[0].end + 1,
        confidence: hits.length === 1 ? 'high' : 'low' } : undefined;
    };
    const found = search(recorded - distance, recorded + distance) ?? search(0, source.length - 1);
    if (found) { return found; }
  }
  return undefined;
}
