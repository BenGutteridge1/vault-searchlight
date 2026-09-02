import { describe, expect, it } from "vitest";
import { findMatchRange, findMatchRanges } from "./editor-highlight";
import type { HighlightTerm } from "./types";

function term(value: string, exact = false): HighlightTerm {
  return { value, exact, caseSensitive: false };
}

describe("findMatchRange", () => {
  it("finds literal and exact whole-word matches", () => {
    expect(findMatchRange("Project Atlas ships", [term("atlas")], false)).toEqual({
      from: 8,
      to: 13,
    });
    expect(findMatchRange("Concatenate cat", [term("cat", true)], false)).toEqual({
      from: 12,
      to: 15,
    });
  });

  it("finds regular-expression matches", () => {
    expect(
      findMatchRange(
        "Project   Atlas",
        [{ value: "", exact: false, caseSensitive: false, regex: /project\s+atlas/i }],
        false,
      ),
    ).toEqual({ from: 0, to: 15 });
  });

  it("spans a fuzzy character sequence when fuzzy matching is enabled", () => {
    expect(findMatchRange("nebula-local-4827", [term("nbl4827")], true)).toEqual({
      from: 0,
      to: 17,
    });
  });

  it("returns every matched word on the destination line", () => {
    expect(
      findMatchRanges(
        "Atlas links to plan and atlas",
        [term("atlas"), term("plan")],
        false,
      ),
    ).toEqual([
      { from: 0, to: 5 },
      { from: 15, to: 19 },
      { from: 24, to: 29 },
    ]);
  });

  it("merges overlapping phrase and word matches into safe selections", () => {
    expect(
      findMatchRanges(
        "Project Atlas and Project Atlas",
        [term("project atlas", true), term("atlas")],
        false,
      ),
    ).toEqual([
      { from: 0, to: 13 },
      { from: 18, to: 31 },
    ]);
  });

  it("returns every regular-expression match", () => {
    expect(
      findMatchRanges(
        "Atlas, atlas, ATLAS",
        [{ value: "", exact: false, caseSensitive: false, regex: /atlas/i }],
        false,
      ),
    ).toEqual([
      { from: 0, to: 5 },
      { from: 7, to: 12 },
      { from: 14, to: 19 },
    ]);
  });
});
