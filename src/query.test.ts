import { describe, expect, it } from "vitest";
import { exactPattern, parseQuery } from "./query";

describe("parseQuery", () => {
  it("keeps quoted phrases exact", () => {
    const parsed = parseQuery('"project atlas" -draft');
    expect(parsed.groups[0]).toMatchObject([
      { kind: "text", value: "project atlas", exact: true, negative: false },
      { kind: "text", value: "draft", exact: false, negative: true },
    ]);
  });

  it("supports operators, regex, and OR groups", () => {
    const parsed = parseQuery("tag:work /atlas\\s+plan/i OR path:Research");
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0][0].kind).toBe("tag");
    expect(parsed.groups[0][1].regex?.test("Atlas plan")).toBe(true);
    expect(parsed.groups[1][0]).toMatchObject({ kind: "path", value: "Research" });
  });

  it("supports regex operands and case operators", () => {
    const parsed = parseQuery("path:/Daily.*2026/ match-case:Atlas ignore-case:PLAN");
    expect(parsed.error).toBeUndefined();
    expect(parsed.groups[0]).toMatchObject([
      { kind: "path", exact: true },
      { kind: "match-case", value: "Atlas", caseSensitive: true },
      { kind: "ignore-case", value: "PLAN", caseSensitive: false },
    ]);
    expect(parsed.groups[0][0].regex?.test("Daily notes/2026")).toBe(true);
  });

  it("reports invalid regular expressions", () => {
    expect(parseQuery("path:/[broken/").error).toBeDefined();
    expect(parseQuery('"unfinished phrase').error).toBe("Unclosed quoted phrase.");
  });

  it("unescapes quotes inside exact phrases", () => {
    const parsed = parseQuery('"they said \\"hello\\""');
    expect(parsed.groups[0][0]).toMatchObject({
      value: 'they said "hello"',
      exact: true,
    });
  });
});

describe("exactPattern", () => {
  it("matches a quoted word on word boundaries", () => {
    const pattern = exactPattern("cat");
    expect(pattern.test("a cat naps")).toBe(true);
    expect(pattern.test("concatenate")).toBe(false);
  });

  it("matches an exact sentence", () => {
    expect(exactPattern("project atlas").test("The project atlas ships.")).toBe(true);
  });
});
