import type { ResolvedAnchor, ReviewComment } from './model';

function normalize(lines: string[], ignoreIndent: boolean): string[] {
  const trimmed = lines.map(line => line.replace(/[\t ]+$/, ''));
  if (!ignoreIndent) { return trimmed; }
  let indent: string | undefined;
  for (const line of trimmed) {
    if (!line) { continue; }
    const leading = /^[\t ]*/.exec(line)?.[0] ?? '';
    if (indent === undefined) { indent = leading; }
    while (!leading.startsWith(indent)) { indent = indent.slice(0, -1); }
  }
  return trimmed.map(line => line.slice(indent?.length ?? 0));
}

export function resolveAnchor(comment: ReviewComment, content: string, radius = 50): ResolvedAnchor | undefined {
  if (comment.wholeFile) {
    return undefined;
  }
  const { startLine, endLine } = comment;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    return undefined;
  }
  if (comment.anchorText === undefined) { return { startLine, endLine, confidence: 'low' }; }
  const source = content.split(/\r\n|\r|\n/);
  const anchor = comment.anchorText.split(/\r\n|\r|\n/);
  const elided = comment.elided && anchor.length === 16 && anchor[10] === '...';
  const prefix = elided ? anchor.slice(0, 10) : anchor;
  const suffix = elided ? anchor.slice(11) : [];
  const visible = [...prefix, ...suffix];
  const recorded = startLine - 1;
  const distance = Number.isFinite(radius) ? Math.max(0, Math.floor(radius)) : 50;
  const trimmedSource = normalize(source, false);

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

    // Index endpoints by the shared indentation added to the jointly normalized
    // snippet. This preserves relative indentation without enumerating pairs.
    const blockIndent = (start: number, block: string[]): string | undefined => {
      let indent: string | undefined;
      for (let index = 0; index < block.length; index++) {
        const actual = trimmedSource[start + index];
        const line = block[index];
        if (!ignoreIndent || !line) {
          if (actual !== line) { return undefined; }
        } else {
          if (indent === undefined) {
            if (!actual.endsWith(line)) { return undefined; }
            indent = actual.slice(0, actual.length - line.length);
            if (!/^[\t ]*$/.test(indent)) { return undefined; }
          }
          if (actual !== indent + line) { return undefined; }
        }
      }
      return indent ?? '';
    };
    const expectedPrefix = expected.slice(0, prefix.length);
    const expectedSuffix = expected.slice(prefix.length);
    const prefixBlank = expectedPrefix.every(line => !line);
    const suffixBlank = expectedSuffix.every(line => !line);
    const suffixEnds: number[] = [];
    const suffixesByIndent = new Map<string, number[]>();
    if (elided) {
      for (let end = suffix.length - 1; end < source.length; end++) {
        const indent = blockIndent(end - suffix.length + 1, expectedSuffix);
        if (indent === undefined) { continue; }
        suffixEnds.push(end);
        let ends = suffixesByIndent.get(indent);
        if (!ends) {
          ends = [];
          suffixesByIndent.set(indent, ends);
        }
        ends.push(end);
      }
    }
    const lowerBound = (ends: number[], target: number): number => {
      let low = 0;
      let high = ends.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (ends[middle] < target) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      return low;
    };
    const search = (min: number, max: number): ResolvedAnchor | undefined => {
      let best: { start: number; end: number } | undefined;
      let hits = 0;
      for (let start = Math.max(0, min); start <= Math.min(max, source.length - prefix.length); start++) {
        let end = start + prefix.length - 1;
        if (elided) {
          const indent = blockIndent(start, expectedPrefix);
          if (indent === undefined) { continue; }
          let ends = suffixEnds;
          if (!prefixBlank) {
            const matchingEnds = suffixesByIndent.get(suffixBlank ? '' : indent);
            if (!matchingEnds) { continue; }
            ends = matchingEnds;
          }
          const first = lowerBound(ends, start + visible.length - 1);
          if (first === ends.length) { continue; }
          hits = Math.min(2, hits + ends.length - first);
          const target = start + (endLine - startLine);
          const nearest = Math.max(first, lowerBound(ends, target));
          end = ends[Math.min(nearest, ends.length - 1)];
          if (nearest > first && Math.abs(ends[nearest - 1] - target) <= Math.abs(end - target)) {
            end = ends[nearest - 1];
          }
        } else {
          if (!matches(start, end)) { continue; }
          hits = Math.min(2, hits + 1);
        }
        // Rank by start distance, then captured-span distance, then earlier start
        // and end. Keep this lexicographic order independent of scan order.
        if (!best) {
          best = { start, end };
          continue;
        }
        let rank = Math.abs(start - recorded) - Math.abs(best.start - recorded);
        if (rank === 0) {
          const capturedSpan = endLine - startLine;
          rank = Math.abs(end - start - capturedSpan) - Math.abs(best.end - best.start - capturedSpan);
        }
        if (rank === 0) { rank = start - best.start; }
        if (rank === 0) { rank = end - best.end; }
        if (rank < 0) {
          best = { start, end };
        }
      }
      if (!best) { return undefined; }
      return {
        startLine: best.start + 1,
        endLine: best.end + 1,
        confidence: hits === 1 ? 'high' : 'low',
      };
    };
    const found = search(recorded - distance, recorded + distance) ?? search(0, source.length - 1);
    if (found) { return found; }
  }
  return undefined;
}
