import type { HighlightTerm } from "./types";

export interface MatchRange {
  from: number;
  to: number;
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

/** Find the first visible query match so opening a result can select it in the editor. */
export function findMatchRange(
  text: string,
  terms: HighlightTerm[],
  fuzzy: boolean,
): MatchRange | undefined {
  const lower = text.toLocaleLowerCase();
  const ranges: MatchRange[] = [];

  for (const termSpec of terms) {
    if (termSpec.regex) {
      const flags = termSpec.regex.flags.replace(/[gy]/g, "");
      const regex = new RegExp(termSpec.regex.source, flags);
      const match = regex.exec(text);
      if (match?.[0].length) ranges.push({ from: match.index, to: match.index + match[0].length });
      continue;
    }

    const rawTerm = termSpec.value;
    if (!rawTerm) continue;
    const term = termSpec.caseSensitive ? rawTerm : rawTerm.toLocaleLowerCase();
    const source = termSpec.caseSensitive ? text : lower;
    const wholeWord = termSpec.exact && /^[\p{L}\p{N}_-]+$/u.test(rawTerm);
    let index = source.indexOf(term);
    while (index >= 0) {
      const end = index + term.length;
      if (!wholeWord || (!isWordCharacter(text[index - 1]) && !isWordCharacter(text[end]))) {
        ranges.push({ from: index, to: end });
        break;
      }
      index = source.indexOf(term, index + 1);
    }

    if (index >= 0 || !fuzzy || termSpec.exact || termSpec.caseSensitive) continue;
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

  return ranges.sort((left, right) => left.from - right.from || left.to - right.to)[0];
}
