import { getAllTags, MetadataCache, Plugin, TAbstractFile, TFile, Vault } from "obsidian";
import {
  buildTagSearchLines,
  findExcalidrawDataLines,
  findFrontmatterLines,
  linesWithoutSearchableTags,
} from "./markdown";
import { isSearchExcludedLine, searchIndexedFile } from "./search-engine";
import { deduplicateResults } from "./results";
import type {
  IndexedFile,
  ParsedQuery,
  SearchContentOptions,
  SearchResult,
  SortMode,
} from "./types";

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
function createSnippet(
  indexed: IndexedFile,
  line: number,
  options: SearchContentOptions,
): { markdown: string; endLine: number } {
  const start = Math.max(0, line - 1);
  const end = Math.min(indexed.lines.length - 1, line + 1);
  const selected: string[] = [];
  const sourceLines = options.mode === "tags" ? indexed.tagSearchLines : indexed.lines;

  for (let index = start; index <= end; index += 1) {
    const candidate = sourceLines[index];
    if (index !== line && isSearchExcludedLine(indexed, index, options)) continue;
    if (index !== line && (candidate.trim() === "" || HEADING_PATTERN.test(candidate))) continue;
    selected.push(candidate);
  }

  return {
    markdown: selected.join("\n").trim() || sourceLines[line] || "",
    endLine: end,
  };
}

export class SearchIndex {
  private readonly entries = new Map<string, IndexedFile>();
  private readyPromise: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly updateTimers = new Map<string, number>();

  constructor(
    private readonly vault: Vault,
    private readonly metadataCache: MetadataCache,
  ) {}

  start(plugin: Plugin): void {
    this.readyPromise = this.rebuildAll();
    plugin.registerEvent(this.vault.on("create", (file) => this.onChanged(file)));
    plugin.registerEvent(this.vault.on("modify", (file) => this.onChanged(file)));
    plugin.registerEvent(this.vault.on("delete", (file) => this.onDeleted(file)));
    plugin.registerEvent(
      this.vault.on("rename", (file, oldPath) => {
        this.entries.delete(oldPath);
        this.onChanged(file);
      }),
    );
    plugin.register(() => {
      for (const timer of this.updateTimers.values()) window.clearTimeout(timer);
      this.updateTimers.clear();
    });
  }

  private async rebuildAll(): Promise<void> {
    const files = this.vault.getMarkdownFiles();
    const batchSize = 8;
    for (let index = 0; index < files.length; index += batchSize) {
      await Promise.all(files.slice(index, index + batchSize).map((file) => this.indexFileSafe(file)));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  private onChanged(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const existingTimer = this.updateTimers.get(file.path);
    if (existingTimer) window.clearTimeout(existingTimer);
    const timer = window.setTimeout(() => {
      this.updateTimers.delete(file.path);
      void this.indexFileSafe(file);
    }, 160);
    this.updateTimers.set(file.path, timer);
  }

  private onDeleted(file: TAbstractFile): void {
    this.entries.delete(file.path);
  }

  async indexFile(file: TFile): Promise<IndexedFile> {
    const content = await this.vault.cachedRead(file);
    const lines = content.split(/\r?\n/);
    const headingsByLine: string[][] = [];
    const hierarchy: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const heading = lines[index].match(HEADING_PATTERN);
      if (heading) {
        const level = heading[1].length;
        hierarchy.length = level - 1;
        hierarchy[level - 1] = heading[2].trim();
      }
      headingsByLine[index] = hierarchy.filter(Boolean);
    }

    const cache = this.metadataCache.getFileCache(file);
    const frontmatterLines = findFrontmatterLines(lines);
    const linesWithoutTags = linesWithoutSearchableTags(lines, frontmatterLines);
    const tagSearch = buildTagSearchLines(lines, frontmatterLines);
    const tags = new Set(
      (cache ? getAllTags(cache) ?? [] : []).map((tag) => tag.toLocaleLowerCase()),
    );
    const indexed: IndexedFile = {
      file,
      content,
      lowerContent: content.toLocaleLowerCase(),
      lines,
      lowerLines: lines.map((line) => line.toLocaleLowerCase()),
      linesWithoutTags,
      lowerLinesWithoutTags: linesWithoutTags.map((line) => line.toLocaleLowerCase()),
      tagSearchLines: tagSearch.lines,
      lowerTagSearchLines: tagSearch.lines.map((line) => line.toLocaleLowerCase()),
      tagLineIndexes: tagSearch.lineIndexes,
      headingsByLine,
      frontmatterLines,
      excalidrawDataLines: findExcalidrawDataLines(lines),
      tags,
    };
    this.entries.set(file.path, indexed);
    return indexed;
  }

  private async indexFileSafe(file: TFile): Promise<IndexedFile | undefined> {
    try {
      return await this.indexFile(file);
    } catch (error) {
      this.entries.delete(file.path);
      console.warn(`Beacon could not index ${file.path}`, error);
      return undefined;
    }
  }

  async search(
    query: ParsedQuery,
    files: TFile[],
    fuzzy: boolean,
    contentOptions: SearchContentOptions,
    sort: SortMode,
    limit: number,
  ): Promise<SearchResult[]> {
    const requestGeneration = ++this.generation;
    if (files.length > 1) await this.readyPromise;

    const results: SearchResult[] = [];
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      if (requestGeneration !== this.generation) return [];
      const file = files[fileIndex];
      const indexed = this.entries.get(file.path) ?? (await this.indexFileSafe(file));
      if (!indexed) continue;
      const fileHits = searchIndexedFile(query, indexed, fuzzy, contentOptions);

      for (const hit of fileHits) {
        const line = hit.line;
        const snippet = createSnippet(indexed, line, contentOptions);
        results.push({
          file,
          line,
          endLine: snippet.endLine,
          markdown: snippet.markdown,
          hierarchy: indexed.headingsByLine[line],
          score: hit.score,
          matchTerms: query.highlightTerms,
        });

        if (results.length >= Math.max(limit * 4, 500)) break;
      }

      if (fileIndex > 0 && fileIndex % 24 === 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const uniqueResults = deduplicateResults(results);
    uniqueResults.sort((left, right) => {
      if (sort === "file") {
        return collator.compare(left.file.basename, right.file.basename) || left.line - right.line;
      }
      if (sort === "location") {
        return collator.compare(left.file.path, right.file.path) || left.line - right.line;
      }
      if (sort === "modified") return right.file.stat.mtime - left.file.stat.mtime;
      return right.score - left.score || collator.compare(left.file.path, right.file.path);
    });
    return uniqueResults.slice(0, limit);
  }
}
