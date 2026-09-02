import { describe, expect, it } from "vitest";
import {
  buildTagSearchLines,
  findExcalidrawDataLines,
  findFrontmatterLines,
  linesWithoutSearchableTags,
} from "./markdown";
import { parseQuery } from "./query";
import { searchIndexedFile } from "./search-engine";
import type { IndexedFile, SearchContentOptions } from "./types";

const DEFAULT_OPTIONS: SearchContentOptions = {
  excludeHeadingMatches: false,
  excludeExcalidrawData: false,
  mode: "content",
};

function options(patch: Partial<SearchContentOptions> = {}): SearchContentOptions {
  return { ...DEFAULT_OPTIONS, ...patch };
}

function indexedFile(lines: string[], path = "Research/Atlas.md"): IndexedFile {
  const content = lines.join("\n");
  const frontmatterLines = findFrontmatterLines(lines);
  const linesWithoutTags = linesWithoutSearchableTags(lines, frontmatterLines);
  const tagSearch = buildTagSearchLines(lines, frontmatterLines);
  return {
    file: {
      path,
      basename: path.split("/").pop()?.replace(/\.md$/, "") ?? "Atlas",
      stat: { mtime: 100, ctime: 50, size: content.length },
    } as IndexedFile["file"],
    lines,
    lowerLines: lines.map((line) => line.toLocaleLowerCase()),
    linesWithoutTags,
    lowerLinesWithoutTags: linesWithoutTags.map((line) => line.toLocaleLowerCase()),
    tagSearchLines: tagSearch.lines,
    lowerTagSearchLines: tagSearch.lines.map((line) => line.toLocaleLowerCase()),
    tagLineIndexes: tagSearch.lineIndexes,
    headingsByLine: lines.map(() => ["Project Atlas", "Findings"]),
    frontmatterLines,
    excalidrawDataLines: findExcalidrawDataLines(lines),
    tags: new Set(["#project"]),
  };
}

describe("searchIndexedFile", () => {
  it("uses file-level AND semantics while returning matching lines", () => {
    const file = indexedFile(["Atlas appears here.", "An unrelated line.", "The plan appears later."]);
    const hits = searchIndexedFile(parseQuery("atlas plan"), file, false, options());
    expect(hits.map((hit) => hit.line)).toEqual([0, 2]);
  });

  it("enforces exact whole words and exact phrases", () => {
    const file = indexedFile(["Concatenate this.", "An atlas is here.", "Project Atlas ships."]);
    expect(searchIndexedFile(parseQuery('"atlas"'), file, false, options()).map((hit) => hit.line)).toEqual([
      1,
      2,
    ]);
    expect(searchIndexedFile(parseQuery('"project atlas"'), file, false, options()).map((hit) => hit.line)).toEqual([
      2,
    ]);
  });

  it("applies exclusions across the file", () => {
    const file = indexedFile(["Atlas appears here.", "This is still a draft."]);
    expect(searchIndexedFile(parseQuery("atlas -draft"), file, false, options())).toEqual([]);
  });

  it("supports OR, tags, path regex, tasks, and case matching", () => {
    const file = indexedFile(["- [ ] Call the Atlas team #project", "PLAN is uppercase"]);
    expect(searchIndexedFile(parseQuery("roadmap OR task-todo:Atlas"), file, false, options())).toHaveLength(1);
    expect(searchIndexedFile(parseQuery("tag:project path:/Research/"), file, false, options({ mode: "tags" }))).toHaveLength(1);
    expect(searchIndexedFile(parseQuery("match-case:PLAN"), file, false, options())).toHaveLength(1);
    expect(searchIndexedFile(parseQuery("match-case:plan"), file, false, options())).toHaveLength(0);
  });

  it("supports fuzzy matching only when enabled", () => {
    const file = indexedFile(["Project Atlas"]);
    expect(searchIndexedFile(parseQuery("prjatl"), file, false, options())).toHaveLength(0);
    expect(searchIndexedFile(parseQuery("prjatl"), file, true, options())).toHaveLength(1);
  });

  it("can exclude direct heading matches without hiding matching body lines", () => {
    const file = indexedFile([
      "# Project Atlas",
      "Atlas appears in body content.",
      "Setext Atlas",
      "------------",
    ]);

    expect(searchIndexedFile(parseQuery("atlas"), file, false, options()).map((hit) => hit.line)).toEqual([
      0,
      1,
      2,
    ]);
    expect(searchIndexedFile(parseQuery("atlas"), file, false, options({ excludeHeadingMatches: true })).map((hit) => hit.line)).toEqual([
      1,
    ]);
  });

  it("excludes Excalidraw Data sections without hiding later peer sections", () => {
    const file = indexedFile([
      "# Intro",
      "Visible payload",
      "# Excalidraw Data",
      "Hidden payload",
      "## Text Elements",
      "Nested payload",
      "# Notes",
      "Visible payload after drawing data",
    ]);

    expect(searchIndexedFile(parseQuery("payload"), file, false, options()).map((hit) => hit.line)).toEqual([
      1,
      3,
      5,
      7,
    ]);
    expect(
      searchIndexedFile(
        parseQuery("payload"),
        file,
        false,
        options({ excludeExcalidrawData: true }),
      ).map((hit) => hit.line),
    ).toEqual([1, 7]);
  });

  it("keeps content, property, and tag search modes isolated", () => {
    const file = indexedFile([
      "---",
      "project: Atlas property",
      "tags:",
      "  - project",
      "---",
      "Visible Atlas body #secret-tag",
    ]);

    expect(searchIndexedFile(parseQuery("property"), file, false, options())).toEqual([]);
    expect(
      searchIndexedFile(parseQuery("property"), file, false, options({ mode: "properties" })).map(
        (hit) => hit.line,
      ),
    ).toEqual([1]);
    expect(searchIndexedFile(parseQuery("secret-tag"), file, false, options())).toEqual([]);
    expect(
      searchIndexedFile(parseQuery("secret-tag"), file, false, options({ mode: "tags" })).map(
        (hit) => hit.line,
      ),
    ).toEqual([5]);
    expect(
      searchIndexedFile(
        parseQuery("visible"),
        file,
        false,
        options(),
      ).map((hit) => hit.line),
    ).toEqual([5]);
    expect(
      searchIndexedFile(
        parseQuery("tag:project"),
        file,
        false,
        options({ mode: "tags" }),
      ),
    ).toHaveLength(1);
  });

  it("reuses prepared exact and regex queries without leaking matcher state", () => {
    const file = indexedFile(["Atlas starts here", "Project Atlas", "No match"]);
    const exact = parseQuery('"project atlas"');
    const regex = parseQuery("/Atlas/g");

    expect(searchIndexedFile(exact, file, false, options())).toEqual(
      searchIndexedFile(exact, file, false, options()),
    );
    expect(searchIndexedFile(regex, file, false, options())).toEqual(
      searchIndexedFile(regex, file, false, options()),
    );
    expect(searchIndexedFile(regex, file, false, options()).map((hit) => hit.line)).toEqual([0, 1]);
  });
});
