import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("rewards compact matches", () => {
    expect(fuzzyScore("atlas", "project atlas") ?? 0).toBeGreaterThan(
      fuzzyScore("atlas", "a long trail across space") ?? 0,
    );
  });

  it("rejects missing character sequences", () => {
    expect(fuzzyScore("atlas", "project beta")).toBeUndefined();
  });
});
