import type { ParsedQuery, QueryClause } from "./types";

const OPERATORS = new Set<QueryClause["kind"]>([
  "path",
  "file",
  "tag",
  "section",
  "content",
  "line",
  "task",
  "task-todo",
  "task-done",
  "match-case",
  "ignore-case",
]);

interface Token {
  value: string;
  quoted: boolean;
}

interface TokenizeResult {
  tokens: Token[];
  error?: string;
}

function tokenize(input: string): TokenizeResult {
  const tokens: Token[] = [];
  let value = "";
  let quoted = false;
  let inQuote = false;
  let inRegex = false;
  let escaped = false;

  const push = (): void => {
    if (value.length > 0) tokens.push({ value, quoted });
    value = "";
    quoted = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      if (inQuote && input[index + 1] === '"') {
        escaped = true;
        continue;
      }
      value += character;
      escaped = true;
      continue;
    }
    if (character === '"' && !inRegex) {
      inQuote = !inQuote;
      quoted = true;
      continue;
    }
    if (character === "/" && !inQuote && (value === "" || inRegex)) {
      inRegex = !inRegex;
      value += character;
      continue;
    }
    if (/\s/.test(character) && !inQuote && !inRegex) {
      push();
      continue;
    }
    value += character;
  }
  push();
  return {
    tokens,
    error:
      inQuote || inRegex
        ? `Unclosed ${inQuote ? "quoted phrase" : "regular expression"}.`
        : undefined,
  };
}

function createRegex(token: string): RegExp | undefined {
  const match = token.match(/^\/(.*)\/([gimsuy]*)$/);
  if (!match) return undefined;
  try {
    return new RegExp(match[1], match[2].replace("g", ""));
  } catch {
    return undefined;
  }
}

function parseClause(token: Token): QueryClause | undefined {
  let raw = token.value;
  const negative = raw.startsWith("-") && raw.length > 1;
  if (negative) raw = raw.slice(1);

  const regex = createRegex(raw);
  if (regex) {
    return { kind: "regex", value: raw, exact: true, negative, regex };
  }

  const separator = raw.indexOf(":");
  if (separator > 0) {
    const possibleKind = raw.slice(0, separator).toLowerCase() as QueryClause["kind"];
    const operand = raw.slice(separator + 1);
    if (OPERATORS.has(possibleKind) && operand.length > 0) {
      const operandRegex = createRegex(operand);
      return {
        kind: possibleKind,
        value: operand,
        exact: token.quoted || operandRegex !== undefined,
        negative,
        caseSensitive: possibleKind === "match-case",
        regex: operandRegex,
      };
    }
  }

  if (raw.length === 0) return undefined;
  return { kind: "text", value: raw, exact: token.quoted, negative };
}

export function parseQuery(input: string): ParsedQuery {
  const groups: QueryClause[][] = [[]];
  let invalidRegex = false;
  const tokenized = tokenize(input.trim());

  for (const token of tokenized.tokens) {
    if (token.value.toUpperCase() === "OR" && !token.quoted) {
      if (groups[groups.length - 1].length > 0) groups.push([]);
      continue;
    }
    const rawWithoutNegation = token.value.replace(/^-/, "");
    const operand = rawWithoutNegation.slice(rawWithoutNegation.indexOf(":") + 1);
    if (
      (/^\//.test(rawWithoutNegation) && !createRegex(rawWithoutNegation)) ||
      (/^[^:]+:\//.test(rawWithoutNegation) && !createRegex(operand))
    ) {
      invalidRegex = true;
    }
    const clause = parseClause(token);
    if (clause) groups[groups.length - 1].push(clause);
  }

  const nonEmptyGroups = groups.filter((group) => group.length > 0);
  const highlightTerms = nonEmptyGroups
    .flat()
    .filter(
      (clause) =>
        !clause.negative &&
        ["text", "content", "line", "section", "match-case", "ignore-case", "regex"].includes(
          clause.kind,
        ),
    )
    .map((clause) => ({
      value: clause.value,
      exact: clause.exact,
      caseSensitive: clause.caseSensitive ?? false,
      regex: clause.regex,
    }));

  return {
    groups: nonEmptyGroups,
    highlightTerms,
    error:
      tokenized.error ??
      (invalidRegex ? "One of the regular expressions is invalid." : undefined),
  };
}

export function exactPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^[\p{L}\p{N}_-]+$/u.test(value)) {
    return new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, "iu");
  }
  return new RegExp(escaped, "iu");
}
