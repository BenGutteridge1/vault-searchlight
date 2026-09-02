import type { SearchResult } from "./types";

interface NormalizedResult {
  hierarchyKey: string;
  markdown: string;
}

const normalizedResultCache = new WeakMap<SearchResult, NormalizedResult>();

function normalizeResult(result: SearchResult): NormalizedResult {
  let normalized = normalizedResultCache.get(result);
  if (!normalized) {
    const hierarchy = result.hierarchy.map((part) => part.trim().replace(/\s+/g, " "));
    normalized = {
      hierarchyKey: [result.file.path, ...hierarchy].join("\u0000"),
      markdown: result.markdown.trim().replace(/\s+/g, " "),
    };
    normalizedResultCache.set(result, normalized);
  }
  return normalized;
}

/** Collapse overlapping line hits that render the same visible result card. */
export function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const unique: SearchResult[] = [];
  interface ResultEntry {
    index: number;
    markdown: string;
    result: SearchResult;
  }
  interface ResultBucket {
    byLine: Map<number, Set<ResultEntry>>;
    byMarkdown: Map<string, Set<ResultEntry>>;
  }
  const buckets = new Map<string, ResultBucket>();

  for (const result of results) {
    const { hierarchyKey, markdown: normalizedMarkdown } = normalizeResult(result);
    const bucket = buckets.get(hierarchyKey) ?? {
      byLine: new Map<number, Set<ResultEntry>>(),
      byMarkdown: new Map<string, Set<ResultEntry>>(),
    };
    buckets.set(hierarchyKey, bucket);
    let duplicate: ResultEntry | undefined;
    const considerDuplicate = (candidate: ResultEntry): void => {
      if (!duplicate || candidate.index < duplicate.index) duplicate = candidate;
    };
    for (const sameMarkdown of bucket.byMarkdown.get(normalizedMarkdown) ?? []) {
      considerDuplicate(sameMarkdown);
    }
    for (let line = result.line - 1; line <= result.line + 1; line += 1) {
      for (const neighboringLine of bucket.byLine.get(line) ?? []) {
        considerDuplicate(neighboringLine);
      }
    }

    if (!duplicate) {
      const entry = { index: unique.length, markdown: normalizedMarkdown, result };
      unique.push(result);
      const markdownEntries = bucket.byMarkdown.get(normalizedMarkdown) ?? new Set<ResultEntry>();
      markdownEntries.add(entry);
      bucket.byMarkdown.set(normalizedMarkdown, markdownEntries);
      const lineEntries = bucket.byLine.get(result.line) ?? new Set<ResultEntry>();
      lineEntries.add(entry);
      bucket.byLine.set(result.line, lineEntries);
    } else if (result.score > duplicate.result.score) {
      const oldMarkdownEntries = bucket.byMarkdown.get(duplicate.markdown);
      oldMarkdownEntries?.delete(duplicate);
      if (oldMarkdownEntries?.size === 0) bucket.byMarkdown.delete(duplicate.markdown);
      const oldLineEntries = bucket.byLine.get(duplicate.result.line);
      oldLineEntries?.delete(duplicate);
      if (oldLineEntries?.size === 0) bucket.byLine.delete(duplicate.result.line);
      unique[duplicate.index] = result;
      duplicate.markdown = normalizedMarkdown;
      duplicate.result = result;
      const markdownEntries = bucket.byMarkdown.get(normalizedMarkdown) ?? new Set<ResultEntry>();
      markdownEntries.add(duplicate);
      bucket.byMarkdown.set(normalizedMarkdown, markdownEntries);
      const lineEntries = bucket.byLine.get(result.line) ?? new Set<ResultEntry>();
      lineEntries.add(duplicate);
      bucket.byLine.set(result.line, lineEntries);
    }
  }

  return unique;
}

/** Keep repeated searches bounded without changing the active sort semantics. */
export function selectTopResults(
  results: SearchResult[],
  limit: number,
  compare: (left: SearchResult, right: SearchResult) => number,
): SearchResult[] {
  return deduplicateResults(results).sort(compare).slice(0, limit);
}
