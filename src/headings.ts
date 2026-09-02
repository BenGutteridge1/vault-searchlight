import { findExcalidrawDataLines, findFrontmatterLines, plainHeadingText } from "./markdown";

const ATX_HEADING = /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const SETEXT_HEADING = /^\s{0,3}(=+|-+)\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

export interface HeadingEntry {
  level: number;
  line: number;
  lowerText: string;
  markdown: string;
  text: string;
  parents: string[];
}

export interface HeadingSelectionRange {
  from: { line: number; ch: number };
  to: { line: number; ch: number };
}

export function headingSelectionRange(line: number, lineText: string): HeadingSelectionRange {
  const safeLine = Math.max(0, Math.trunc(line));
  const end = Math.max(0, lineText.length);
  return {
    from: { line: safeLine, ch: 0 },
    to: { line: safeLine, ch: end },
  };
}

function queryTerms(query: string): string[] {
  return (query.match(/"[^"]+"|\S+/g) ?? [])
    .map((term) => term.replace(/^"|"$/g, "").toLocaleLowerCase())
    .filter(Boolean);
}

export function headingHighlightTerms(query: string): string[] {
  return queryTerms(query);
}

export function headingMatchesQuery(heading: HeadingEntry, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  return terms.every((term) => heading.lowerText.includes(term));
}

export function matchingHeadingIndexes(
  headings: HeadingEntry[],
  query: string | readonly string[],
): number[] {
  const terms = typeof query === "string" ? queryTerms(query) : query;
  const matches: number[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    if (terms.every((term) => headings[index].lowerText.includes(term))) matches.push(index);
  }
  return matches;
}

export function extractMarkdownHeadings(
  lines: string[],
  excludeExcalidrawData: boolean,
): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  const hierarchy: Array<HeadingEntry | undefined> = [];
  const frontmatter = findFrontmatterLines(lines);
  const excalidrawLines = excludeExcalidrawData ? findExcalidrawDataLines(lines) : new Set<number>();
  let fence: { character: string; length: number } | undefined;

  for (let line = 0; line < lines.length; line += 1) {
    if (frontmatter.has(line)) continue;
    const source = lines[line];
    const fenceMatch = source.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || excalidrawLines.has(line)) continue;

    const atx = source.match(ATX_HEADING);
    const setext = !atx && source.trim() ? lines[line + 1]?.match(SETEXT_HEADING) : undefined;
    if (!atx && !setext) continue;

    const level = atx ? atx[1].length : setext?.[1].startsWith("=") ? 1 : 2;
    const markdown = (atx ? atx[2] : source.trim()).trim();
    const text = plainHeadingText(markdown);
    const heading: HeadingEntry = {
      level,
      line,
      lowerText: text.toLocaleLowerCase(),
      markdown,
      text,
      parents: hierarchy
        .slice(0, level - 1)
        .filter((parent): parent is HeadingEntry => parent !== undefined)
        .map((parent) => parent.markdown),
    };
    hierarchy.length = level - 1;
    hierarchy[level - 1] = heading;
    headings.push(heading);
  }

  return headings;
}
