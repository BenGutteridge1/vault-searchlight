import { describe, expect, it } from "vitest";
import { deduplicateResults, selectTopResults } from "./results";
import type { SearchResult } from "./types";

function result(line: number, score: number, markdown: string): SearchResult {
  return {
    file: { path: "Notes/Atlas.md" } as SearchResult["file"],
    line,
    endLine: line + 1,
    markdown,
    hierarchy: ["Atlas", "Tasks"],
    score,
    matchTerms: [],
  };
}

function legacyDeduplicateResults(results: SearchResult[]): SearchResult[] {
  const unique: SearchResult[] = [];
  for (const candidate of results) {
    const normalizedHierarchy = candidate.hierarchy.map((part) => part.trim().replace(/\s+/g, " "));
    const normalizedMarkdown = candidate.markdown.trim().replace(/\s+/g, " ");
    const duplicateIndex = unique.findIndex(
      (existing) =>
        existing.file.path === candidate.file.path &&
        existing.hierarchy.map((part) => part.trim().replace(/\s+/g, " ")).join("\u0000") ===
          normalizedHierarchy.join("\u0000") &&
        (existing.markdown.trim().replace(/\s+/g, " ") === normalizedMarkdown ||
          Math.abs(existing.line - candidate.line) <= 1),
    );
    if (duplicateIndex < 0) unique.push(candidate);
    else if (candidate.score > unique[duplicateIndex].score) unique[duplicateIndex] = candidate;
  }
  return unique;
}

describe("deduplicateResults", () => {
  it("keeps only the strongest of identical rendered snippets", () => {
    const duplicate = "- [ ] Review Atlas\n- [x] Archive Atlas";
    const unique = deduplicateResults([
      result(8, 105, duplicate),
      result(9, 104, "- [x] Archive Atlas"),
      result(14, 99, "Atlas appears elsewhere"),
    ]);

    expect(unique).toHaveLength(2);
    expect(unique[0].line).toBe(8);
    expect(unique[1].line).toBe(14);
  });

  it("does not merge neighboring hits from different files or heading paths", () => {
    const first = result(8, 105, "Atlas");
    const otherFile = result(9, 104, "Atlas");
    otherFile.file = { path: "Notes/Other.md" } as SearchResult["file"];
    const otherHeading = result(9, 103, "Atlas");
    otherHeading.hierarchy = ["Atlas", "Findings"];

    expect(deduplicateResults([first, otherFile, otherHeading])).toHaveLength(3);
  });

  it("retains only the strongest bounded candidates", () => {
    const candidates = Array.from({ length: 1_000 }, (_, index) => {
      const candidate = result(index * 3, index, `Atlas ${index}`);
      candidate.file = { path: `Notes/${index}.md` } as SearchResult["file"];
      return candidate;
    });

    const selected = selectTopResults(candidates, 50, (left, right) => right.score - left.score);
    expect(selected).toHaveLength(50);
    expect(selected[0].score).toBe(999);
    expect(selected[49].score).toBe(950);
  });

  it("preserves the previous deduplication behavior while using indexed lookups", () => {
    let state = 0x5eed1234;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const candidates = Array.from({ length: 500 }, (_, index) => {
      const candidate = result(random() % 60, random() % 300, `Atlas ${random() % 11}`);
      candidate.file = { path: `Notes/${random() % 4}.md` } as SearchResult["file"];
      candidate.hierarchy = [`Section ${random() % 5}`];
      candidate.endLine = candidate.line + (index % 2);
      return candidate;
    });

    expect(deduplicateResults(candidates)).toEqual(legacyDeduplicateResults(candidates));
  });
});
