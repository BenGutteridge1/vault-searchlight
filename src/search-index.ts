import {
  getAllTags,
  MetadataCache,
  Platform,
  Plugin,
  TAbstractFile,
  TFile,
  Vault,
} from "obsidian";
import { buildSearchLines, findExcalidrawDataLines, findFrontmatterLines } from "./markdown";
import { isSearchExcludedLine, searchIndexedFile } from "./search-engine";
import { selectTopResults } from "./results";
import type {
  IndexedFile,
  ParsedQuery,
  SearchContentOptions,
  SearchResult,
  SortMode,
} from "./types";

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RESULT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const locationOrderCache = new WeakMap<TFile[], TFile[]>();

function filesInLocationOrder(files: TFile[]): TFile[] {
  let ordered = locationOrderCache.get(files);
  if (!ordered) {
    ordered = [...files].sort((left, right) => RESULT_COLLATOR.compare(left.path, right.path));
    locationOrderCache.set(files, ordered);
  }
  return ordered;
}

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
  private generation = 0;
  private active = true;
  private readonly fileRevisions = new WeakMap<TFile, number>();
  private readonly indexingTasks = new Map<string, Promise<IndexedFile | undefined>>();
  private readonly updateTimers = new Map<string, number>();

  constructor(
    private readonly vault: Vault,
    private readonly metadataCache: MetadataCache,
  ) {}

  start(plugin: Plugin): void {
    this.active = true;
    void this.rebuildAll();
    plugin.registerEvent(this.vault.on("create", (file) => this.onChanged(file)));
    plugin.registerEvent(this.vault.on("modify", (file) => this.onChanged(file)));
    plugin.registerEvent(this.vault.on("delete", (file) => this.onDeleted(file)));
    plugin.registerEvent(
      this.vault.on("rename", (file, oldPath) => {
        this.entries.delete(oldPath);
        this.indexingTasks.delete(oldPath);
        this.clearUpdateTimer(oldPath);
        this.onChanged(file);
      }),
    );
    plugin.register(() => {
      this.active = false;
      this.generation += 1;
      for (const timer of this.updateTimers.values()) window.clearTimeout(timer);
      this.updateTimers.clear();
      this.indexingTasks.clear();
    });
  }

  cancelPendingSearch(): void {
    this.generation += 1;
  }

  private async rebuildAll(): Promise<void> {
    const files = this.vault.getMarkdownFiles();
    const batchSize = Platform.isMobileApp ? 4 : 8;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    for (let index = 0; index < files.length; index += batchSize) {
      if (!this.active) return;
      await Promise.all(
        files.slice(index, index + batchSize).map((file) => this.indexFileSafe(file)),
      );
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  private onChanged(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const changedPath = file.path;
    this.bumpFileRevision(file);
    this.entries.delete(changedPath);
    this.indexingTasks.delete(changedPath);
    this.clearUpdateTimer(changedPath);
    const timer = window.setTimeout(() => {
      this.updateTimers.delete(changedPath);
      void this.indexFileSafe(file);
    }, 160);
    this.updateTimers.set(changedPath, timer);
  }

  private onDeleted(file: TAbstractFile): void {
    if (file instanceof TFile) this.bumpFileRevision(file);
    this.entries.delete(file.path);
    this.indexingTasks.delete(file.path);
    this.clearUpdateTimer(file.path);
  }

  private clearUpdateTimer(path: string): void {
    const timer = this.updateTimers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    this.updateTimers.delete(path);
  }

  async indexFile(file: TFile): Promise<IndexedFile | undefined> {
    const indexedPath = file.path;
    const indexedRevision = this.fileRevisions.get(file) ?? 0;
    const content = await this.vault.cachedRead(file);
    const lines = content.split(/\r?\n/);
    const headingsByLine: string[][] = [];
    const hierarchy: string[] = [];
    let visibleHierarchy: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const heading = lines[index].match(HEADING_PATTERN);
      if (heading) {
        const level = heading[1].length;
        hierarchy.length = level - 1;
        hierarchy[level - 1] = heading[2].trim();
        visibleHierarchy = hierarchy.filter(Boolean);
      }
      headingsByLine[index] = visibleHierarchy;
    }

    const cache = this.metadataCache.getFileCache(file);
    const frontmatterLines = findFrontmatterLines(lines);
    const { linesWithoutTags, tagSearch } = buildSearchLines(lines, frontmatterLines);
    const lowerLines = lines.map((line) => line.toLocaleLowerCase());
    const lowerLinesWithoutTags = linesWithoutTags.map((line, index) =>
      line === lines[index] ? lowerLines[index] : line.toLocaleLowerCase(),
    );
    const lowerTagSearchLines = tagSearch.lines.map((line) =>
      line.length === 0 ? "" : line.toLocaleLowerCase(),
    );
    const tags = new Set(
      (cache ? getAllTags(cache) ?? [] : []).map((tag) => tag.toLocaleLowerCase()),
    );
    const indexed: IndexedFile = {
      file,
      lines,
      lowerLines,
      linesWithoutTags,
      lowerLinesWithoutTags,
      tagSearchLines: tagSearch.lines,
      lowerTagSearchLines,
      tagLineIndexes: tagSearch.lineIndexes,
      headingsByLine,
      frontmatterLines,
      excalidrawDataLines: findExcalidrawDataLines(lines),
      tags,
    };
    if (!this.active || (this.fileRevisions.get(file) ?? 0) !== indexedRevision) {
      return undefined;
    }
    this.entries.set(indexedPath, indexed);
    return indexed;
  }

  private indexFileSafe(file: TFile): Promise<IndexedFile | undefined> {
    const indexedPath = file.path;
    const indexedRevision = this.fileRevisions.get(file) ?? 0;
    const existing = this.entries.get(indexedPath);
    if (existing) return Promise.resolve(existing);
    const pending = this.indexingTasks.get(indexedPath);
    if (pending) return pending;

    const task = this.indexFile(file)
      .catch((error: unknown) => {
        if (
          this.active &&
          (this.fileRevisions.get(file) ?? 0) === indexedRevision
        ) {
          console.warn(`Beacon could not index ${indexedPath}`, error);
        }
        return undefined;
      })
      .finally(() => {
        if (this.indexingTasks.get(indexedPath) === task) this.indexingTasks.delete(indexedPath);
      });
    this.indexingTasks.set(indexedPath, task);
    return task;
  }

  private bumpFileRevision(file: TFile): void {
    this.fileRevisions.set(file, (this.fileRevisions.get(file) ?? 0) + 1);
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

    const compareResults = (left: SearchResult, right: SearchResult): number => {
      const pathOrder = RESULT_COLLATOR.compare(left.file.path, right.file.path);
      if (sort === "file") {
        return (
          RESULT_COLLATOR.compare(left.file.basename, right.file.basename) ||
          left.line - right.line
        );
      }
      if (sort === "location") return pathOrder || left.line - right.line;
      if (sort === "modified") return right.file.stat.mtime - left.file.stat.mtime;
      return right.score - left.score || pathOrder;
    };
    const candidateLimit = Math.max(limit * 4, 500);
    const orderedFiles =
      sort === "location"
        ? filesInLocationOrder(files)
        : sort === "modified"
          ? [...files].sort((left, right) => right.stat.mtime - left.stat.mtime)
          : files;
    let results: SearchResult[] = [];
    let sliceStarted = performance.now();
    const sliceBudget = Platform.isMobileApp ? 8 : 12;
    for (const file of orderedFiles) {
      if (!this.active || requestGeneration !== this.generation) return [];
      const indexed = this.entries.get(file.path) ?? (await this.indexFileSafe(file));
      if (!this.active || requestGeneration !== this.generation) return [];
      if (!indexed) continue;
      const fileHits = searchIndexedFile(query, indexed, fuzzy, contentOptions);
      if (fileHits.length > candidateLimit) {
        fileHits.sort((left, right) =>
          sort === "relevance"
            ? right.score - left.score || left.line - right.line
            : left.line - right.line,
        );
      }

      let fileResults: SearchResult[] = [];
      for (let hitIndex = 0; hitIndex < fileHits.length; hitIndex += 1) {
        const hit = fileHits[hitIndex];
        const line = hit.line;
        const snippet = createSnippet(indexed, line, contentOptions);
        fileResults.push({
          file,
          line,
          endLine: snippet.endLine,
          markdown: snippet.markdown,
          hierarchy: indexed.headingsByLine[line],
          score: hit.score,
          matchTerms: query.highlightTerms,
        });

        if ((hitIndex + 1) % candidateLimit === 0) {
          fileResults = selectTopResults(fileResults, candidateLimit, compareResults);
          if (fileResults.length >= candidateLimit) break;
        }
      }
      results.push(...selectTopResults(fileResults, candidateLimit, compareResults));

      if (results.length >= candidateLimit * 2) {
        results = selectTopResults(results, candidateLimit, compareResults);
      }
      if ((sort === "location" || sort === "modified") && results.length >= limit) {
        const leadingResults = selectTopResults(results, candidateLimit, compareResults);
        if (leadingResults.length >= limit) return leadingResults.slice(0, limit);
        results = leadingResults;
      }

      if (performance.now() - sliceStarted >= sliceBudget) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        sliceStarted = performance.now();
      }
    }

    return selectTopResults(results, limit, compareResults);
  }
}
