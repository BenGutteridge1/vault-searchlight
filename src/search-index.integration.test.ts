import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { parseQuery } from "./query";
import type { SearchContentOptions } from "./types";

const options: SearchContentOptions = {
  excludeExcalidrawData: false,
  excludeHeadingMatches: false,
  mode: "content",
};

interface FakeFile {
  basename: string;
  extension: string;
  path: string;
  stat: { ctime: number; mtime: number; size: number };
}

function file(path: string, mtime = 1): FakeFile {
  return {
    basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path,
    extension: "md",
    path,
    stat: { ctime: mtime, mtime, size: 10 },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SearchIndex scheduling and candidate selection", () => {
  it("shares an in-flight startup read with an immediate search", async () => {
    vi.stubGlobal("window", { clearTimeout, setTimeout });
    const note = file("Notes/Atlas.md");
    let finishRead: ((content: string) => void) | undefined;
    const cachedRead = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishRead = resolve;
        }),
    );
    const vault = {
      cachedRead,
      getMarkdownFiles: () => [note],
      on: () => ({}),
    };
    const cleanups: Array<() => void> = [];
    const plugin = {
      register: (cleanup: () => void) => cleanups.push(cleanup),
      registerEvent: () => undefined,
    };
    const metadata = { getFileCache: () => null };
    const { SearchIndex } = await import("./search-index");
    const index = new SearchIndex(
      vault as never,
      metadata as never,
    );

    index.start(plugin as never);
    const pendingSearch = index.search(
      parseQuery("atlas"),
      [note] as never,
      false,
      options,
      "relevance",
      10,
    );
    await vi.waitFor(() => expect(cachedRead).toHaveBeenCalledTimes(1));
    finishRead?.("Project Atlas");

    expect((await pendingSearch).map((result) => result.file.path)).toEqual(["Notes/Atlas.md"]);
    expect(cachedRead).toHaveBeenCalledTimes(1);
    cleanups.forEach((cleanup) => cleanup());
  });

  it("orders location candidates before reading and stops after enough results", async () => {
    const notes = [file("Notes/B.md"), file("Notes/A.md"), file("Notes/C.md")];
    const cachedRead = vi.fn(async (_note: FakeFile) => "Atlas");
    const { SearchIndex } = await import("./search-index");
    const index = new SearchIndex(
      { cachedRead, getMarkdownFiles: () => notes } as never,
      { getFileCache: () => null } as never,
    );

    const results = await index.search(
      parseQuery("atlas"),
      notes as never,
      false,
      options,
      "location",
      1,
    );

    expect(results.map((result) => result.file.path)).toEqual(["Notes/A.md"]);
    expect(cachedRead).toHaveBeenCalledTimes(1);
    expect(cachedRead.mock.calls[0][0]).toBe(notes[1]);
  });

  it("scans every file for relevance so a later stronger match can win", async () => {
    const notes = [file("Notes/A.md"), file("Notes/B.md")];
    const content = new Map([
      ["Notes/A.md", "A long prefix before atlas"],
      ["Notes/B.md", "atlas"],
    ]);
    const cachedRead = vi.fn(async (note: FakeFile) => content.get(note.path) ?? "");
    const { SearchIndex } = await import("./search-index");
    const index = new SearchIndex(
      { cachedRead, getMarkdownFiles: () => notes } as never,
      { getFileCache: () => null } as never,
    );

    const results = await index.search(
      parseQuery("atlas"),
      notes as never,
      false,
      options,
      "relevance",
      1,
    );

    expect(results.map((result) => result.file.path)).toEqual(["Notes/B.md"]);
    expect(cachedRead).toHaveBeenCalledTimes(2);
  });

  it("cancels a stale request while sharing its pending index read", async () => {
    const note = file("Notes/Atlas.md");
    let finishRead: ((content: string) => void) | undefined;
    const cachedRead = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishRead = resolve;
        }),
    );
    const { SearchIndex } = await import("./search-index");
    const index = new SearchIndex(
      { cachedRead, getMarkdownFiles: () => [note] } as never,
      { getFileCache: () => null } as never,
    );

    const stale = index.search(
      parseQuery("atlas"),
      [note] as never,
      false,
      options,
      "relevance",
      10,
    );
    const current = index.search(
      parseQuery("project"),
      [note] as never,
      false,
      options,
      "relevance",
      10,
    );
    finishRead?.("Project Atlas");

    expect(await stale).toEqual([]);
    expect((await current).map((result) => result.file.path)).toEqual(["Notes/Atlas.md"]);
    expect(cachedRead).toHaveBeenCalledTimes(1);
  });

  it("never publishes content from a read invalidated by a file change", async () => {
    vi.stubGlobal("window", {
      clearTimeout: vi.fn(),
      setTimeout: vi.fn(() => 1),
    });
    const note = Object.assign(new TFile(), file("Notes/Atlas.md"));
    const finishReads: Array<(content: string) => void> = [];
    const cachedRead = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishReads.push(resolve);
        }),
    );
    const { SearchIndex } = await import("./search-index");
    const index = new SearchIndex(
      { cachedRead, getMarkdownFiles: () => [note] } as never,
      { getFileCache: () => null } as never,
    );

    const staleIndexing = index.indexFile(note);
    await vi.waitFor(() => expect(cachedRead).toHaveBeenCalledTimes(1));
    Reflect.apply(
      Reflect.get(index as object, "onChanged") as (changed: TFile) => void,
      index,
      [note],
    );
    const freshIndexing = Reflect.apply(
      Reflect.get(index as object, "indexFileSafe") as (changed: TFile) => Promise<unknown>,
      index,
      [note],
    );
    await vi.waitFor(() => expect(cachedRead).toHaveBeenCalledTimes(2));
    finishReads[0]("Old atlas content");
    finishReads[1]("Fresh beacon content");

    expect(await staleIndexing).toBeUndefined();
    await freshIndexing;
    expect(
      await index.search(
        parseQuery("atlas"),
        [note] as never,
        false,
        options,
        "relevance",
        10,
      ),
    ).toEqual([]);
    expect(
      (
        await index.search(
          parseQuery("beacon"),
          [note] as never,
          false,
          options,
          "relevance",
          10,
        )
      ).map((result) => result.file.path),
    ).toEqual(["Notes/Atlas.md"]);
    expect(cachedRead).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale failed read evict a newer successful index", async () => {
    vi.stubGlobal("window", {
      clearTimeout: vi.fn(),
      setTimeout: vi.fn(() => 1),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const note = Object.assign(new TFile(), file("Notes/Atlas.md"));
    let rejectStale: ((error: Error) => void) | undefined;
    let resolveFresh: ((content: string) => void) | undefined;
    const cachedRead = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectStale = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFresh = resolve;
          }),
      );
    const { SearchIndex } = await import("./search-index");
    const index = new SearchIndex(
      { cachedRead, getMarkdownFiles: () => [note] } as never,
      { getFileCache: () => null } as never,
    );
    const callIndexFileSafe = (): Promise<unknown> =>
      Reflect.apply(
        Reflect.get(index as object, "indexFileSafe") as (changed: TFile) => Promise<unknown>,
        index,
        [note],
      );

    const staleIndexing = callIndexFileSafe();
    await vi.waitFor(() => expect(cachedRead).toHaveBeenCalledTimes(1));
    Reflect.apply(
      Reflect.get(index as object, "onChanged") as (changed: TFile) => void,
      index,
      [note],
    );
    const freshIndexing = callIndexFileSafe();
    await vi.waitFor(() => expect(cachedRead).toHaveBeenCalledTimes(2));
    resolveFresh?.("Fresh beacon content");
    await freshIndexing;
    rejectStale?.(new Error("superseded read"));
    expect(await staleIndexing).toBeUndefined();

    expect(
      (
        await index.search(
          parseQuery("beacon"),
          [note] as never,
          false,
          options,
          "relevance",
          10,
        )
      ).map((result) => result.file.path),
    ).toEqual(["Notes/Atlas.md"]);
    expect(cachedRead).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("continues past a duplicate-heavy candidate chunk to fill the result limit", async () => {
    const note = file("Notes/Repeated.md");
    const repeated = Array.from({ length: 500 }, () => "atlas");
    const unique = Array.from({ length: 120 }, (_, index) => `atlas unique result ${index}`);
    const { SearchIndex } = await import("./search-index");
    const index = new SearchIndex(
      { cachedRead: async () => [...repeated, ...unique].join("\n") } as never,
      { getFileCache: () => null } as never,
    );

    const results = await index.search(
      parseQuery("atlas"),
      [note] as never,
      false,
      options,
      "relevance",
      10,
    );

    expect(results).toHaveLength(10);
    expect(results.some((result) => result.markdown.includes("unique result"))).toBe(true);
  });
});
