import type { HighlightTerm } from "./types";

export interface MatchRange {
  from: number;
  to: number;
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

/** Find every visible query match on a result line for editor multi-selection. */
export function findMatchRanges(
  text: string,
  terms: HighlightTerm[],
  fuzzy: boolean,
): MatchRange[] {
  const lower = text.toLocaleLowerCase();
  const ranges: MatchRange[] = [];

  for (const termSpec of terms) {
    if (termSpec.regex) {
      const flags = [...new Set(`${termSpec.regex.flags.replace(/[gy]/g, "")}g`)].join("");
      const regex = new RegExp(termSpec.regex.source, flags);
      let match = regex.exec(text);
      while (match) {
        if (match[0].length > 0) {
          ranges.push({ from: match.index, to: match.index + match[0].length });
        } else {
          regex.lastIndex += 1;
        }
        match = regex.exec(text);
      }
      continue;
    }

    const rawTerm = termSpec.value;
    if (!rawTerm) continue;
    const term = termSpec.caseSensitive ? rawTerm : rawTerm.toLocaleLowerCase();
    const source = termSpec.caseSensitive ? text : lower;
    const wholeWord = termSpec.exact && /^[\p{L}\p{N}_-]+$/u.test(rawTerm);
    let index = source.indexOf(term);
    let foundLiteral = false;
    while (index >= 0) {
      const end = index + term.length;
      if (!wholeWord || (!isWordCharacter(text[index - 1]) && !isWordCharacter(text[end]))) {
        ranges.push({ from: index, to: end });
        foundLiteral = true;
      }
      index = source.indexOf(term, index + Math.max(1, term.length));
    }

    if (foundLiteral || !fuzzy || termSpec.exact || termSpec.caseSensitive) continue;
    let textIndex = 0;
    const fuzzyIndexes: number[] = [];
    for (const character of term.toLocaleLowerCase()) {
      const found = lower.indexOf(character, textIndex);
      if (found < 0) {
        fuzzyIndexes.length = 0;
        break;
      }
      fuzzyIndexes.push(found);
      textIndex = found + 1;
    }
    if (fuzzyIndexes.length > 0) {
      ranges.push({ from: fuzzyIndexes[0], to: fuzzyIndexes[fuzzyIndexes.length - 1] + 1 });
    }
  }

  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: MatchRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

/** Retained for callers that only need the earliest match. */
export function findMatchRange(
  text: string,
  terms: HighlightTerm[],
  fuzzy: boolean,
): MatchRange | undefined {
  return findMatchRanges(text, terms, fuzzy)[0];
}
