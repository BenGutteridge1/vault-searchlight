import { describe, expect, it } from "vitest";
import { deduplicateResults } from "./results";
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
});
