import type { TFile } from "obsidian";

export type FileSearchScope = "file" | "vault";
export type SearchScope = FileSearchScope | "properties" | "tags";
export type SortMode = "relevance" | "file" | "location" | "modified";
export type SearchContentMode = "content" | "properties" | "tags";

export interface SearchContentOptions {
  excludeHeadingMatches: boolean;
  excludeExcalidrawData: boolean;
  mode: SearchContentMode;
}

export interface FloatingSearchSettings {
  defaultScope: FileSearchScope;
  fuzzy: boolean;
  excludeHeadingMatches: boolean;
  excludeExcalidrawData: boolean;
  sort: SortMode;
  resultLimit: number;
}

export interface IndexedFile {
  file: TFile;
  content: string;
  lowerContent: string;
  lines: string[];
  lowerLines: string[];
  linesWithoutTags: string[];
  lowerLinesWithoutTags: string[];
  tagSearchLines: string[];
  lowerTagSearchLines: string[];
  tagLineIndexes: Set<number>;
  headingsByLine: string[][];
  frontmatterLines: Set<number>;
  excalidrawDataLines: Set<number>;
  tags: Set<string>;
}

export interface QueryClause {
  kind:
    | "text"
    | "path"
    | "file"
    | "tag"
    | "section"
    | "content"
    | "line"
    | "task"
    | "task-todo"
    | "task-done"
    | "match-case"
    | "ignore-case"
    | "regex";
  value: string;
  exact: boolean;
  negative: boolean;
  caseSensitive?: boolean;
  regex?: RegExp;
}

export interface HighlightTerm {
  value: string;
  exact: boolean;
  caseSensitive: boolean;
  regex?: RegExp;
}

export interface ParsedQuery {
  groups: QueryClause[][];
  highlightTerms: HighlightTerm[];
  error?: string;
}

export interface SearchResult {
  file: TFile;
  line: number;
  endLine: number;
  markdown: string;
  hierarchy: string[];
  score: number;
  matchTerms: HighlightTerm[];
}
