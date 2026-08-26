import { describe, expect, it } from "vitest";
import {
  extractMarkdownHeadings,
  headingMatchesQuery,
  headingSelectionRange,
  matchingHeadingIndexes,
} from "./headings";

describe("extractMarkdownHeadings", () => {
  it("extracts H1-H6 structure including Setext headings", () => {
    const headings = extractMarkdownHeadings([
      "Project *Atlas*",
      "===============",
      "## Findings",
      "#### [[Notes|Linked notes]]",
      "###### Detail",
    ], false);

    expect(headings.map(({ level, text }) => [level, text])).toEqual([
      [1, "Project Atlas"],
      [2, "Findings"],
      [4, "Linked notes"],
      [6, "Detail"],
    ]);
    expect(headings[3].parents).toEqual(["Project *Atlas*", "Findings", "[[Notes|Linked notes]]"]);
  });

  it("ignores frontmatter, fenced code, and optionally Excalidraw data", () => {
    const lines = [
      "---",
      "title: '# Not a heading'",
      "---",
      "# Visible",
      "```md",
      "## Code heading",
      "```",
      "# Excalidraw Data",
      "## Text Elements",
      "# After",
    ];
    expect(extractMarkdownHeadings(lines, false).map((heading) => heading.text)).toEqual([
      "Visible",
      "Excalidraw Data",
      "Text Elements",
      "After",
    ]);
    expect(extractMarkdownHeadings(lines, true).map((heading) => heading.text)).toEqual([
      "Visible",
      "After",
    ]);
  });
});

describe("heading query matching", () => {
  const headings = extractMarkdownHeadings([
    "# Project Atlas",
    "## Research plan",
    "## Atlas findings",
  ], false);

  it("keeps matching independent from the hierarchy context", () => {
    expect(headingMatchesQuery(headings[1], "atlas")).toBe(false);
    expect(headingMatchesQuery(headings[2], '"atlas findings"')).toBe(true);
  });

  it("returns indexes without filtering the source list", () => {
    expect(matchingHeadingIndexes(headings, "atlas")).toEqual([0, 2]);
    expect(headings).toHaveLength(3);
  });
});

describe("heading selection ranges", () => {
  it("selects the complete heading line", () => {
    expect(headingSelectionRange(4, "## Findings")).toEqual({
      from: { line: 4, ch: 0 },
      to: { line: 4, ch: 11 },
    });
  });

  it("keeps empty and negative inputs safe", () => {
    expect(headingSelectionRange(-2, "")).toEqual({
      from: { line: 0, ch: 0 },
      to: { line: 0, ch: 0 },
    });
  });
});
