import { fuzzyScoreLowered } from "./fuzzy";
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

interface PreparedClause {
  clause: QueryClause;
  exactPattern?: RegExp;
  lowerValue: string;
  normalizedTag?: string;
}

interface SearchContext {
  eligibleLines?: Uint32Array;
  indexed: IndexedFile;
  lowerTargets: string[];
  options: SearchContentOptions;
  sectionCache: Map<string[], { lower: string; text: string }>;
  targets: string[];
}

const preparedQueries = new WeakMap<ParsedQuery, PreparedClause[][]>();
const eligibleLineCaches = new WeakMap<IndexedFile, Map<string, Uint32Array>>();
const sectionCaches = new WeakMap<IndexedFile, Map<string[], { lower: string; text: string }>>();
const fileTargetCaches = new WeakMap<
  IndexedFile,
  { basename: string; lowerBasename: string; lowerPath: string; path: string; tags?: string }
>();

function caseSensitiveExactPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = /^[\p{L}\p{N}_-]+$/u.test(value);
  return word
    ? new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, "u")
    : new RegExp(escaped, "u");
}

function prepareClause(clause: QueryClause): PreparedClause {
  return {
    clause,
    exactPattern:
      clause.exact && !clause.regex
        ? clause.caseSensitive === true
          ? caseSensitiveExactPattern(clause.value)
          : exactPattern(clause.value)
        : undefined,
    lowerValue: clause.value.toLocaleLowerCase(),
    normalizedTag:
      clause.kind === "tag" && !clause.regex
        ? (clause.value.startsWith("#") ? clause.value : `#${clause.value}`).toLocaleLowerCase()
        : undefined,
  };
}

function prepareQuery(query: ParsedQuery): PreparedClause[][] {
  let prepared = preparedQueries.get(query);
  if (!prepared) {
    prepared = query.groups.map((group) => group.map(prepareClause));
    preparedQueries.set(query, prepared);
  }
  return prepared;
}

function getEligibleLines(context: SearchContext): Uint32Array {
  if (context.eligibleLines !== undefined) return context.eligibleLines;
  const cacheKey = `${context.options.mode}:${context.options.excludeHeadingMatches ? 1 : 0}:${context.options.excludeExcalidrawData ? 1 : 0}`;
  let cache = eligibleLineCaches.get(context.indexed);
  const cached = cache?.get(cacheKey);
  if (cached) {
    context.eligibleLines = cached;
    return cached;
  }
  const eligibleLines: number[] = [];
  for (let line = 0; line < context.indexed.lines.length; line += 1) {
    if (!isSearchExcludedLine(context.indexed, line, context.options)) eligibleLines.push(line);
  }
  const compactLines = Uint32Array.from(eligibleLines);
  if (!cache) {
    cache = new Map();
    eligibleLineCaches.set(context.indexed, cache);
  }
  cache.set(cacheKey, compactLines);
  context.eligibleLines = compactLines;
  return compactLines;
}

function regexMatches(regex: RegExp, target: string): boolean {
  regex.lastIndex = 0;
  return regex.test(target);
}

function textMatch(
  prepared: PreparedClause,
  target: string,
  lowerTarget: string,
  fuzzy: boolean,
): number | undefined {
  const { clause } = prepared;
  if (clause.regex) return regexMatches(clause.regex, target) ? 118 : undefined;
  const caseSensitive = clause.caseSensitive === true;
  if (clause.exact) {
    return prepared.exactPattern?.test(target) ? 120 : undefined;
  }
  const needle = caseSensitive ? clause.value : prepared.lowerValue;
  const haystack = caseSensitive ? target : lowerTarget;
  const index = haystack.indexOf(needle);
  if (index >= 0) return 95 - Math.min(index * 0.1, 20);
  if (!fuzzy || clause.value.length < 3 || caseSensitive) return undefined;
  return fuzzyScoreLowered(prepared.lowerValue, lowerTarget);
}

function fileTargets(indexed: IndexedFile): {
  basename: string;
  lowerBasename: string;
  lowerPath: string;
  path: string;
  tags?: string;
} {
  let targets = fileTargetCaches.get(indexed);
  if (!targets) {
    targets = {
      basename: indexed.file.basename,
      lowerBasename: indexed.file.basename.toLocaleLowerCase(),
      lowerPath: indexed.file.path.toLocaleLowerCase(),
      path: indexed.file.path,
    };
    fileTargetCaches.set(indexed, targets);
  }
  return targets;
}

function fileTarget(
  clause: QueryClause,
  indexed: IndexedFile,
): { lower: string; text: string } | undefined {
  const targets = fileTargets(indexed);
  switch (clause.kind) {
    case "path":
      return { lower: targets.lowerPath, text: targets.path };
    case "file":
      return { lower: targets.lowerBasename, text: targets.basename };
    case "tag":
      targets.tags ??= [...indexed.tags].join(" ");
      return { lower: targets.tags, text: targets.tags };
    default:
      return undefined;
  }
}

function fileClauseScore(
  prepared: PreparedClause,
  indexed: IndexedFile,
  options: SearchContentOptions,
): number | undefined {
  const { clause } = prepared;
  if (clause.kind === "tag" && options.mode !== "tags") return undefined;
  if (clause.kind === "tag" && !clause.regex) {
    return prepared.normalizedTag !== undefined && indexed.tags.has(prepared.normalizedTag)
      ? 105
      : undefined;
  }
  const target = fileTarget(clause, indexed);
  if (target === undefined) return undefined;
  return textMatch(prepared, target.text, target.lower, false);
}

function lineClauseScore(
  prepared: PreparedClause,
  context: SearchContext,
  line: number,
  fuzzy: boolean,
): number | undefined {
  const { clause } = prepared;
  const { indexed, targets, lowerTargets } = context;
  const target = targets[line] ?? "";
  const lowerTarget = lowerTargets[line] ?? "";
  if (clause.kind.startsWith("task")) {
    const task = target.match(TASK_PATTERN);
    if (!task) return undefined;
    if (clause.kind === "task-todo" && task[1].toLowerCase() === "x") return undefined;
    if (clause.kind === "task-done" && task[1].toLowerCase() !== "x") return undefined;
    if (clause.value === "*") return 108;
  }
  if (clause.kind === "section") {
    const hierarchy = indexed.headingsByLine[line];
    let section = context.sectionCache.get(hierarchy);
    if (!section) {
      const text = hierarchy.join(" › ");
      section = { lower: text.toLocaleLowerCase(), text };
      context.sectionCache.set(hierarchy, section);
    }
    return textMatch(prepared, section.text, section.lower, false);
  }
  return textMatch(
    prepared,
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
  const targets =
    options.mode === "tags"
      ? indexed.tagSearchLines
      : options.mode === "properties"
        ? indexed.lines
        : indexed.linesWithoutTags;
  const lowerTargets =
    options.mode === "tags"
      ? indexed.lowerTagSearchLines
      : options.mode === "properties"
        ? indexed.lowerLines
        : indexed.lowerLinesWithoutTags;
  const context: SearchContext = {
    indexed,
    lowerTargets,
    options,
    sectionCache:
      sectionCaches.get(indexed) ?? new Map<string[], { lower: string; text: string }>(),
    targets,
  };
  if (!sectionCaches.has(indexed)) sectionCaches.set(indexed, context.sectionCache);
  const hits = new Map<number, number>();
  const preparedGroups = prepareQuery(query);

  for (const group of preparedGroups) {
    let groupMatched = true;
    let filterScore = 0;
    const groupLineScores = new Map<number, number>();

    for (const prepared of group) {
      const { clause } = prepared;
      if (isFileClause(clause)) {
        const score = fileClauseScore(prepared, indexed, options);
        const matched = score !== undefined;
        if ((clause.negative && matched) || (!clause.negative && !matched)) {
          groupMatched = false;
          break;
        }
        if (!clause.negative && score !== undefined) filterScore += score;
        continue;
      }

      let matched = false;
      for (const line of getEligibleLines(context)) {
        const score = lineClauseScore(prepared, context, line, fuzzy);
        if (score === undefined) continue;
        matched = true;
        if (clause.negative) break;
        groupLineScores.set(line, (groupLineScores.get(line) ?? 0) + score);
      }
      if ((clause.negative && matched) || (!clause.negative && !matched)) {
        groupMatched = false;
        break;
      }
    }

    if (!groupMatched) continue;
    if (groupLineScores.size === 0) {
      const firstVisibleLine = getEligibleLines(context)[0] ?? -1;
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
