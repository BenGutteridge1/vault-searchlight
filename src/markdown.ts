const ATX_HEADING_PATTERN = /^\s{0,3}#{1,6}(?:[ \t]+|$)/;
const SETEXT_UNDERLINE_PATTERN = /^\s{0,3}(?:=+|-+)\s*$/;
const ATX_HEADING_CAPTURE = /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FRONTMATTER_BOUNDARY = /^---\s*$/;
const PROPERTY_KEY_PATTERN = /^\s*([\p{L}\p{N}_-]+)\s*:/u;
const INLINE_TAG_PATTERN = /(^|[\s([{>])#[\p{L}\p{N}_/-]+/gu;

export function isFrontmatterBoundary(source: string): boolean {
  return FRONTMATTER_BOUNDARY.test(source);
}

/** Return whether a source line is the visible text line of a Markdown heading. */
export function isMarkdownHeadingLine(lines: string[], line: number): boolean {
  const source = lines[line] ?? "";
  if (ATX_HEADING_PATTERN.test(source)) return true;
  return source.trim().length > 0 && SETEXT_UNDERLINE_PATTERN.test(lines[line + 1] ?? "");
}

export function findFrontmatterLines(lines: string[]): Set<number> {
  const found = new Set<number>();
  if (!FRONTMATTER_BOUNDARY.test(lines[0] ?? "")) return found;

  for (let line = 0; line < lines.length; line += 1) {
    found.add(line);
    if (line > 0 && FRONTMATTER_BOUNDARY.test(lines[line])) break;
  }
  return found;
}

export function plainHeadingText(markdown: string): string {
  return markdown
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .trim();
}

export function findExcalidrawDataLines(lines: string[]): Set<number> {
  const found = new Set<number>();
  let sectionLevel: number | undefined;

  for (let line = 0; line < lines.length; line += 1) {
    const heading = lines[line].match(ATX_HEADING_CAPTURE);
    if (sectionLevel !== undefined) {
      if (heading && heading[1].length <= sectionLevel) sectionLevel = undefined;
      else {
        found.add(line);
        continue;
      }
    }
    if (
      heading &&
      plainHeadingText(heading[2]).toLocaleLowerCase() === "excalidraw data"
    ) {
      sectionLevel = heading[1].length;
      found.add(line);
    }
  }
  return found;
}

export function linesWithoutSearchableTags(
  lines: string[],
  frontmatterLines: Set<number>,
): string[] {
  let inTagProperty = false;
  return lines.map((source, line) => {
    if (frontmatterLines.has(line)) {
      const property = source.match(PROPERTY_KEY_PATTERN);
      if (property) inTagProperty = /^tags?$/i.test(property[1]);
      if (inTagProperty || FRONTMATTER_BOUNDARY.test(source)) return "";
    } else {
      inTagProperty = false;
    }
    return source.replace(INLINE_TAG_PATTERN, "$1");
  });
}

export interface TagSearchLines {
  lines: string[];
  lineIndexes: Set<number>;
}

function cleanTagValues(value: string): string {
  return value.replace(/[[\],"']/g, " ").replace(/^\s*-\s*/, "").trim();
}

export function buildTagSearchLines(
  lines: string[],
  frontmatterLines: Set<number>,
): TagSearchLines {
  const searchable = lines.map(() => "");
  const lineIndexes = new Set<number>();
  let inTagProperty = false;

  for (let line = 0; line < lines.length; line += 1) {
    const source = lines[line];
    if (frontmatterLines.has(line)) {
      if (FRONTMATTER_BOUNDARY.test(source)) {
        inTagProperty = false;
        continue;
      }
      const property = source.match(PROPERTY_KEY_PATTERN);
      if (property) {
        inTagProperty = /^tags?$/i.test(property[1]);
        if (inTagProperty) {
          searchable[line] = cleanTagValues(source.slice(source.indexOf(":") + 1));
          lineIndexes.add(line);
        }
        continue;
      }
      if (inTagProperty) {
        searchable[line] = cleanTagValues(source);
        lineIndexes.add(line);
      }
      continue;
    }

    const tags = [...source.matchAll(INLINE_TAG_PATTERN)].map((match) => match[0].trim());
    if (tags.length > 0) {
      searchable[line] = tags.join(" ");
      lineIndexes.add(line);
    }
  }
  return { lines: searchable, lineIndexes };
}
