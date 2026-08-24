import type { SearchResult } from "./types";

/** Collapse overlapping line hits that render the same visible result card. */
export function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const unique: SearchResult[] = [];

  for (const result of results) {
    const normalizedHierarchy = result.hierarchy.map((part) => part.trim().replace(/\s+/g, " "));
    const normalizedMarkdown = result.markdown.trim().replace(/\s+/g, " ");
    const hierarchyKey = [result.file.path, ...normalizedHierarchy].join("\u0000");
    const duplicateIndex = unique.findIndex((candidate) => {
      const candidateHierarchy = candidate.hierarchy.map((part) => part.trim().replace(/\s+/g, " "));
      const candidateHierarchyKey = [candidate.file.path, ...candidateHierarchy].join("\u0000");
      if (candidateHierarchyKey !== hierarchyKey) return false;

      const candidateMarkdown = candidate.markdown.trim().replace(/\s+/g, " ");
      return candidateMarkdown === normalizedMarkdown || Math.abs(candidate.line - result.line) <= 1;
    });

    if (duplicateIndex < 0) unique.push(result);
    else if (result.score > unique[duplicateIndex].score) unique[duplicateIndex] = result;
  }

  return unique;
}
