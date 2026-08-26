import { findExcalidrawDataLines, findFrontmatterLines, plainHeadingText } from "./markdown";

const ATX_HEADING = /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const SETEXT_HEADING = /^\s{0,3}(=+|-+)\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

export interface HeadingEntry {
  level: number;
  line: number;
  markdown: string;
  text: string;
  parents: string[];
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
  const target = heading.text.toLocaleLowerCase();
  return terms.every((term) => target.includes(term));
}

export function matchingHeadingIndexes(headings: HeadingEntry[], query: string): number[] {
  if (!query.trim()) return headings.map((_, index) => index);
  return headings.flatMap((heading, index) =>
    headingMatchesQuery(heading, query) ? [index] : [],
  );
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
    const heading: HeadingEntry = {
      level,
      line,
      markdown,
      text: plainHeadingText(markdown),
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
