import { fuzzyScore } from "./fuzzy";
import { isFrontmatterBoundary, isMarkdownHeadingLine } from "./markdown";
import { exactPattern } from "./query";
import type {
  IndexedFile,
  ParsedQuery,
  QueryClause,
  SearchContentOptions,
} from "./types";

const TASK_PATTERN = /^\s*[-*+]\s+\[([ xX])\]/;

interface LineHit {
  line: number;
  score: number;
}

function regexMatches(regex: RegExp, target: string): boolean {
  regex.lastIndex = 0;
  return regex.test(target);
}

function textMatch(
  clause: QueryClause,
  target: string,
  lowerTarget: string,
  fuzzy: boolean,
): number | undefined {
  if (clause.regex) return regexMatches(clause.regex, target) ? 118 : undefined;
  const caseSensitive = clause.caseSensitive === true;
  if (clause.exact) {
    if (!caseSensitive) return exactPattern(clause.value).test(target) ? 120 : undefined;
    const escaped = clause.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const word = /^[\p{L}\p{N}_-]+$/u.test(clause.value);
    const pattern = word
      ? new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, "u")
      : new RegExp(escaped, "u");
    return pattern.test(target) ? 120 : undefined;
  }
  const needle = caseSensitive ? clause.value : clause.value.toLocaleLowerCase();
  const haystack = caseSensitive ? target : lowerTarget;
  const index = haystack.indexOf(needle);
  if (index >= 0) return 95 - Math.min(index * 0.1, 20);
  if (!fuzzy || clause.value.length < 3 || caseSensitive) return undefined;
  return fuzzyScore(clause.value, target);
}

function fileTarget(clause: QueryClause, indexed: IndexedFile): string | undefined {
  switch (clause.kind) {
    case "path":
      return indexed.file.path;
    case "file":
      return indexed.file.basename;
    case "tag":
      return [...indexed.tags].join(" ");
    default:
      return undefined;
  }
}

function fileClauseScore(
  clause: QueryClause,
  indexed: IndexedFile,
  options: SearchContentOptions,
): number | undefined {
  if (clause.kind === "tag" && options.mode !== "tags") return undefined;
  const target = fileTarget(clause, indexed);
  if (target === undefined) return undefined;
  if (clause.kind === "tag" && !clause.regex) {
    const normalized = clause.value.startsWith("#") ? clause.value : `#${clause.value}`;
    return indexed.tags.has(normalized.toLocaleLowerCase()) ? 105 : undefined;
  }
  return textMatch(clause, target, target.toLocaleLowerCase(), false);
}

function lineClauseScore(
  clause: QueryClause,
  indexed: IndexedFile,
  line: number,
  fuzzy: boolean,
  options: SearchContentOptions,
): number | undefined {
  if (isSearchExcludedLine(indexed, line, options)) return undefined;
  const target =
    options.mode === "tags"
      ? indexed.tagSearchLines[line] ?? ""
      : options.mode === "properties"
        ? indexed.lines[line] ?? ""
        : indexed.linesWithoutTags[line] ?? "";
  const lowerTarget =
    options.mode === "tags"
      ? indexed.lowerTagSearchLines[line] ?? target.toLocaleLowerCase()
      : options.mode === "properties"
        ? indexed.lowerLines[line] ?? target.toLocaleLowerCase()
        : indexed.lowerLinesWithoutTags[line] ?? target.toLocaleLowerCase();
  if (clause.kind.startsWith("task")) {
    const task = target.match(TASK_PATTERN);
    if (!task) return undefined;
    if (clause.kind === "task-todo" && task[1].toLowerCase() === "x") return undefined;
    if (clause.kind === "task-done" && task[1].toLowerCase() !== "x") return undefined;
    if (clause.value === "*") return 108;
  }
  if (clause.kind === "section") {
    const hierarchy = indexed.headingsByLine[line].join(" › ");
    return textMatch(clause, hierarchy, hierarchy.toLocaleLowerCase(), false);
  }
  return textMatch(
    clause,
    target,
    lowerTarget,
    clause.kind === "text" && fuzzy,
  );
}

function isFileClause(clause: QueryClause): boolean {
  return clause.kind === "path" || clause.kind === "file" || clause.kind === "tag";
}

/**
 * Evaluate one indexed file using Obsidian-like file-level AND semantics.
 * Plain terms may occur on different lines; the returned hits are the lines
 * that contain the positive terms so the UI can render useful contexts.
 */
export function searchIndexedFile(
  query: ParsedQuery,
  indexed: IndexedFile,
  fuzzy: boolean,
  options: SearchContentOptions,
): LineHit[] {
  const hits = new Map<number, number>();

  for (const group of query.groups) {
    let groupMatched = true;
    let filterScore = 0;
    const groupLineScores = new Map<number, number>();

    for (const clause of group) {
      if (isFileClause(clause)) {
        const score = fileClauseScore(clause, indexed, options);
        const matched = score !== undefined;
        if ((clause.negative && matched) || (!clause.negative && !matched)) {
          groupMatched = false;
          break;
        }
        if (!clause.negative && score !== undefined) filterScore += score;
        continue;
      }

      const clauseHits = new Map<number, number>();
      for (let line = 0; line < indexed.lines.length; line += 1) {
        const score = lineClauseScore(clause, indexed, line, fuzzy, options);
        if (score !== undefined) clauseHits.set(line, score);
      }
      const matched = clauseHits.size > 0;
      if ((clause.negative && matched) || (!clause.negative && !matched)) {
        groupMatched = false;
        break;
      }
      if (!clause.negative) {
        for (const [line, score] of clauseHits) {
          groupLineScores.set(line, (groupLineScores.get(line) ?? 0) + score);
        }
      }
    }

    if (!groupMatched) continue;
    if (groupLineScores.size === 0) {
      const firstVisibleLine = indexed.lines.findIndex(
        (_, line) => !isSearchExcludedLine(indexed, line, options),
      );
      if (firstVisibleLine >= 0) groupLineScores.set(firstVisibleLine, 0);
    }
    for (const [line, score] of groupLineScores) {
      const total = score + filterScore * 0.2 + Math.max(0, 12 - line * 0.01);
      hits.set(line, Math.max(hits.get(line) ?? 0, total));
    }
  }

  return [...hits].map(([line, score]) => ({ line, score }));
}

export function isSearchExcludedLine(
  indexed: IndexedFile,
  line: number,
  options: SearchContentOptions,
): boolean {
  return (
    (options.excludeHeadingMatches && isMarkdownHeadingLine(indexed.lines, line)) ||
    (options.excludeExcalidrawData && indexed.excalidrawDataLines.has(line)) ||
    (options.mode === "content" && indexed.frontmatterLines.has(line)) ||
    (options.mode === "properties" &&
      (!indexed.frontmatterLines.has(line) ||
        indexed.tagLineIndexes.has(line) ||
        isFrontmatterBoundary(indexed.lines[line] ?? ""))) ||
    (options.mode === "tags" && !indexed.tagLineIndexes.has(line))
  );
}
