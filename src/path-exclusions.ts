function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegex(character);
  }
  return source;
}

/** Compile newline-separated vault-relative paths and globs into a fast matcher. */
export function compilePathExclusions(source: string): (path: string) => boolean {
  const patterns = source
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\/+/, ""))
    .filter(Boolean)
    .map((pattern) => {
      const directory = pattern.endsWith("/");
      const normalized = directory ? pattern.slice(0, -1) : pattern;
      const containsSlash = normalized.includes("/");
      const containsGlob = /[*?]/.test(normalized);
      const prefix = containsSlash ? "^" : "(?:^|.*/)";
      const suffix = directory || !containsGlob ? "(?:/.*)?$" : "$";
      return new RegExp(`${prefix}${globSource(normalized)}${suffix}`, "i");
    });

  return (path: string): boolean => {
    const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
    return patterns.some((pattern) => pattern.test(normalized));
  };
}
