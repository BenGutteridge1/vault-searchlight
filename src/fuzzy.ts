export function fuzzyScore(needle: string, haystack: string): number | undefined {
  const query = needle.toLocaleLowerCase();
  const text = haystack.toLocaleLowerCase();
  return fuzzyScoreLowered(query, text);
}

/** Score strings that the caller has already normalized for repeated matching. */
export function fuzzyScoreLowered(query: string, text: string): number | undefined {
  if (query.length === 0) return 0;

  let queryIndex = 0;
  let first = -1;
  let previous = -2;
  let gaps = 0;
  let consecutive = 0;

  for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex += 1) {
    if (text[textIndex] !== query[queryIndex]) continue;
    if (first < 0) first = textIndex;
    if (textIndex === previous + 1) consecutive += 1;
    else if (previous >= 0) gaps += textIndex - previous - 1;
    previous = textIndex;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return undefined;
  return Math.max(1, 55 + consecutive * 3 - gaps - Math.max(first, 0) * 0.15);
}
