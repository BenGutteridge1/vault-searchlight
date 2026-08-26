import { describe, expect, it } from "vitest";
import { compilePathExclusions } from "./path-exclusions";

describe("compilePathExclusions", () => {
  it("matches exact files and folders from the vault root", () => {
    const excluded = compilePathExclusions("Private.md\nArchive/\nTemplates");
    expect(excluded("Private.md")).toBe(true);
    expect(excluded("Archive/2026/Note.md")).toBe(true);
    expect(excluded("Templates/Daily.md")).toBe(true);
    expect(excluded("Research/Private.md")).toBe(true);
    expect(excluded("Research/Archive Note.md")).toBe(false);
  });

  it("supports basename and vault-relative glob patterns", () => {
    const excluded = compilePathExclusions("*.excalidraw.md\nPeople/**/Private?.md");
    expect(excluded("Drawings/Map.excalidraw.md")).toBe(true);
    expect(excluded("People/Team/Private1.md")).toBe(true);
    expect(excluded("People/Private-long.md")).toBe(false);
    expect(excluded("Drawings/Map.md")).toBe(false);
  });

  it("ignores blank lines and normalizes separators", () => {
    const excluded = compilePathExclusions("\n  Projects/**  \n");
    expect(excluded("Projects\\Atlas\\Plan.md")).toBe(true);
    expect(excluded("Project/Atlas.md")).toBe(false);
  });
});
