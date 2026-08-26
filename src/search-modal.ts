import {
  App,
  Component,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  setIcon,
  TFile,
} from "obsidian";
import { findMatchRange } from "./editor-highlight";
import { parseQuery } from "./query";
import type FloatingSearchPlugin from "./main";
import type { HighlightTerm, SearchResult, SearchScope, SortMode } from "./types";

const SORT_LABELS: Record<SortMode, string> = {
  relevance: "Relevance",
  file: "File name",
  location: "Location",
  modified: "Modified",
};

const SORT_ORDER: SortMode[] = ["relevance", "file", "location", "modified"];

const SORT_ICONS: Record<SortMode, string> = {
  relevance: "list-filter",
  file: "file-text",
  location: "map-pin",
  modified: "clock-3",
};

const SCOPE_LABELS: Record<SearchScope, string> = {
  file: "This file",
  vault: "All files",
  properties: "Properties",
  tags: "Tags",
};

const SCOPE_ICONS: Record<SearchScope, string> = {
  file: "file-text",
  vault: "files",
  properties: "braces",
  tags: "tags",
};

function createControlContent(
  element: HTMLElement,
  leadingIcon: string | undefined,
): void {
  element.empty();
  if (leadingIcon) {
    const icon = element.createSpan({ cls: "floating-search-control-icon" });
    setIcon(icon, leadingIcon);
  }
  const chevron = element.createSpan({ cls: "floating-search-chevron" });
  setIcon(chevron, "chevron-down");
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

function markTextMatches(
  root: HTMLElement,
  terms: HighlightTerm[],
  fuzzy: boolean,
  includeTags = false,
): void {
  if (terms.length === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (
      current.parentElement?.closest("mark, code") ||
      (!includeTags && current.parentElement?.closest(".tag"))
    ) continue;
    nodes.push(current as Text);
  }

  for (const node of nodes) {
    const text = node.data;
    const lower = text.toLocaleLowerCase();
    const ranges: Array<[number, number]> = [];

    for (const termSpec of terms) {
      if (termSpec.regex) {
        const flags = [...new Set(`${termSpec.regex.flags.replace(/[gy]/g, "")}g`)].join("");
        const regex = new RegExp(termSpec.regex.source, flags);
        let match = regex.exec(text);
        while (match) {
          if (match[0].length > 0) ranges.push([match.index, match.index + match[0].length]);
          else regex.lastIndex += 1;
          match = regex.exec(text);
        }
        continue;
      }

      const rawTerm = termSpec.value;
      const term = termSpec.caseSensitive ? rawTerm : rawTerm.toLocaleLowerCase();
      const source = termSpec.caseSensitive ? text : lower;
      const wholeWord = termSpec.exact && /^[\p{L}\p{N}_-]+$/u.test(rawTerm);
      let from = 0;
      let index = source.indexOf(term, from);
      let foundLiteral = false;
      while (index >= 0 && term.length > 0) {
        const end = index + term.length;
        const onBoundary =
          !wholeWord ||
          (!isWordCharacter(text[index - 1]) && !isWordCharacter(text[end]));
        if (onBoundary) {
          ranges.push([index, end]);
          foundLiteral = true;
        }
        from = Math.max(index + term.length, index + 1);
        index = source.indexOf(term, from);
      }

      if (fuzzy && !foundLiteral && !termSpec.exact && !termSpec.caseSensitive) {
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
        for (const fuzzyIndex of fuzzyIndexes) ranges.push([fuzzyIndex, fuzzyIndex + 1]);
      }
    }

    if (ranges.length === 0) continue;
    ranges.sort((left, right) => left[0] - right[0]);
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }

    const fragment = createFragment();
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) fragment.append(text.slice(cursor, start));
      const mark = createEl("mark");
      mark.addClass("floating-search-highlight");
      mark.textContent = text.slice(start, end);
      fragment.append(mark);
      cursor = end;
    }
    if (cursor < text.length) fragment.append(text.slice(cursor));
    node.replaceWith(fragment);
  }
}

async function renderLocationHeading(
  app: App,
  markdown: string,
  target: HTMLElement,
  sourcePath: string,
  component: Component,
  cache: Map<string, HTMLElement>,
): Promise<void> {
  const cacheKey = `${sourcePath}\u0000${markdown}`;
  let template = cache.get(cacheKey);
  if (!template) {
    template = createSpan();
    await MarkdownRenderer.render(app, markdown, template, sourcePath, component);
    cache.set(cacheKey, template);
  }

  for (const child of Array.from(template.childNodes)) {
    target.appendChild(child.cloneNode(true));
  }
}

export class FloatingSearchModal extends Modal {
  private scopeMode: SearchScope;
  private query = "";
  private results: SearchResult[] = [];
  private selectedIndex = 0;
  private searchTimer: number | undefined;
  private renderGeneration = 0;
  private resultRenderer: Component | undefined;
  private closeButtonObserver: MutationObserver | undefined;

  private inputEl!: HTMLInputElement;
  private scopeButton!: HTMLButtonElement;
  private sortButton!: HTMLButtonElement;
  private resultsEl!: HTMLElement;
  private statusEl!: HTMLElement;

  constructor(
    app: App,
    private readonly plugin: FloatingSearchPlugin,
    initialScope: SearchScope,
  ) {
    super(app);
    this.scopeMode = initialScope;
  }

  onOpen(): void {
    this.containerEl.addClass("floating-search-container");
    this.modalEl.addClass("floating-search-modal");
    this.contentEl.addClass("floating-search-content");
    this.titleEl.hide();
    this.removeModalCloseButton();
    this.closeButtonObserver = new MutationObserver(() => this.removeModalCloseButton());
    this.closeButtonObserver.observe(this.containerEl, { childList: true, subtree: true });
    this.buildToolbar();
    this.resultsEl = this.contentEl.createDiv({
      cls: "floating-search-results is-hidden",
      attr: { role: "listbox", "aria-label": "Search results" },
    });
    this.statusEl = this.contentEl.createDiv({
      cls: "floating-search-status",
      text: "Type to search",
      attr: { "aria-live": "polite", "aria-atomic": "true" },
    });
    this.registerKeyboardNavigation();
    void this.runSearch();
    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  onClose(): void {
    this.closeButtonObserver?.disconnect();
    this.closeButtonObserver = undefined;
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.renderGeneration += 1;
    this.plugin.modalClosed(this);
    this.disposeResultRenderer();
    this.contentEl.empty();
  }

  private removeModalCloseButton(): void {
    document
      .querySelectorAll<HTMLElement>(".modal-close-button, .modal-header-button")
      .forEach((closeButton) => {
        const closeButtonModal = closeButton.closest(".modal");
        const sharesContainer = closeButton.parentElement?.contains(this.modalEl) ?? false;
        if (
          closeButtonModal === this.modalEl ||
          this.containerEl.contains(closeButton) ||
          sharesContainer
        ) {
          closeButton.remove();
        }
      });
  }

  private buildToolbar(): void {
    const toolbar = this.contentEl.createDiv({ cls: "floating-search-toolbar" });

    this.scopeButton = toolbar.createEl("button", {
      cls: "floating-search-select floating-search-scope",
      attr: { type: "button", "aria-label": "Choose search scope" },
    });
    this.updateScopeButton();
    this.scopeButton.addEventListener("click", (event) => this.showScopeMenu(event));

    const inputWrap = toolbar.createDiv({ cls: "floating-search-input-wrap" });
    const searchIcon = inputWrap.createSpan({ cls: "floating-search-input-icon" });
    setIcon(searchIcon, "search");
    this.inputEl = inputWrap.createEl("input", {
      cls: "floating-search-input",
      attr: {
        type: "text",
        placeholder: "Search…",
        autocomplete: "off",
        autocapitalize: "off",
        spellcheck: "false",
        "aria-label": "Search term",
      },
    });
    this.inputEl.addEventListener("input", () => {
      this.query = this.inputEl.value;
      this.queueSearch();
    });

    this.sortButton = toolbar.createEl("button", {
      cls: "floating-search-icon-button floating-search-sort",
      attr: {
        type: "button",
        "aria-label": "Choose result sorting",
        "data-tooltip-position": "top",
      },
    });
    this.updateSortButton();
    this.sortButton.addEventListener("click", (event) => this.showSortMenu(event));
  }

  private registerKeyboardNavigation(): void {
    this.scope.register([], "ArrowDown", (event) => {
      event.preventDefault();
      this.moveSelection(1);
      return false;
    });
    this.scope.register([], "ArrowUp", (event) => {
      event.preventDefault();
      this.moveSelection(-1);
      return false;
    });
    this.scope.register([], "Enter", (event) => {
      event.preventDefault();
      void this.openSelected();
      return false;
    });
    this.scope.register(["Mod", "Alt"], "f", (event) => {
      event.preventDefault();
      void this.toggleScope();
      return false;
    });
    this.scope.register(["Mod", "Alt"], "s", (event) => {
      event.preventDefault();
      void this.cycleSort();
      return false;
    });
  }

  private moveSelection(direction: number): void {
    if (this.results.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex + direction + this.results.length) % this.results.length;
    this.updateSelectedRow(true);
  }

  private updateSelectedRow(scroll: boolean): void {
    const rows = Array.from(this.resultsEl.querySelectorAll<HTMLElement>(".floating-search-result"));
    rows.forEach((row, index) => {
      const selected = index === this.selectedIndex;
      row.toggleClass("is-selected", selected);
      row.setAttr("aria-selected", selected ? "true" : "false");
      if (selected && scroll) row.scrollIntoView({ block: "nearest" });
    });
  }

  private showScopeMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("This file")
        .setIcon("file-text")
        .onClick(() => void this.setScope("file")),
    );
    menu.addItem((item) =>
      item
        .setTitle("All files")
        .setIcon("files")
        .onClick(() => void this.setScope("vault")),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Properties")
        .setIcon("braces")
        .onClick(() => void this.setScope("properties")),
    );
    menu.addItem((item) =>
      item
        .setTitle("Tags")
        .setIcon("tags")
        .onClick(() => void this.setScope("tags")),
    );
    menu.showAtMouseEvent(event);
  }

  private showSortMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const sort of SORT_ORDER) {
      menu.addItem((item) =>
        item
          .setTitle(SORT_LABELS[sort])
          .setChecked(this.plugin.settings.sort === sort)
          .onClick(() => void this.setSort(sort)),
      );
    }
    menu.showAtMouseEvent(event);
  }

  private updateScopeButton(): void {
    const label = SCOPE_LABELS[this.scopeMode];
    createControlContent(this.scopeButton, SCOPE_ICONS[this.scopeMode]);
    this.scopeButton.setAttr("aria-label", `Search scope: ${label}`);
  }

  private updateSortButton(): void {
    const sort = this.plugin.settings.sort;
    this.sortButton.empty();
    const icon = this.sortButton.createSpan({ cls: "floating-search-control-icon" });
    setIcon(icon, SORT_ICONS[sort]);
    const chevron = this.sortButton.createSpan({ cls: "floating-search-chevron" });
    setIcon(chevron, "chevron-down");
    this.sortButton.setAttr(
      "aria-label",
      `Sort results: ${SORT_LABELS[sort]}`,
    );
  }

  async setScope(scope: SearchScope): Promise<void> {
    this.scopeMode = scope;
    this.updateScopeButton();
    if (scope === "file" || scope === "vault") {
      await this.plugin.updateSettings({ defaultScope: scope });
    }
    await this.runSearch();
    this.inputEl.focus();
  }

  async toggleScope(): Promise<void> {
    await this.setScope(this.scopeMode === "file" ? "vault" : "file");
  }

  async setSort(sort: SortMode): Promise<void> {
    await this.plugin.updateSettings({ sort });
    this.updateSortButton();
    await this.runSearch();
    this.inputEl.focus();
  }

  async cycleSort(): Promise<void> {
    const index = SORT_ORDER.indexOf(this.plugin.settings.sort);
    await this.setSort(SORT_ORDER[(index + 1) % SORT_ORDER.length]);
  }

  private queueSearch(): void {
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => void this.runSearch(), 70);
  }

  private async runSearch(): Promise<void> {
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    const renderGeneration = ++this.renderGeneration;
    const trimmed = this.query.trim();
    if (!trimmed) {
      this.results = [];
      this.resultsEl.empty();
      this.resultsEl.addClass("is-hidden");
      this.statusEl.setText("Type to search");
      return;
    }
    this.resultsEl.removeClass("is-hidden");

    const parsed = parseQuery(trimmed);
    if (parsed.error) {
      this.results = [];
      this.resultsEl.empty();
      this.resultsEl.createDiv({ cls: "floating-search-empty is-error", text: parsed.error });
      this.statusEl.setText("Invalid query");
      return;
    }
    if (parsed.groups.length === 0) return;

    const files = this.filesForScope();
    if (files.length === 0) {
      const activeFile = this.app.workspace.getActiveFile();
      const activeMarkdownFile = activeFile?.extension === "md";
      const activeFileExcluded =
        this.scopeMode === "file" &&
        activeMarkdownFile &&
        this.plugin.isFileExcluded(activeFile.path);
      this.results = [];
      this.resultsEl.empty();
      this.resultsEl.createDiv({
        cls: "floating-search-empty",
        text: activeFileExcluded
          ? "This file is excluded by the plugin settings."
          : this.scopeMode === "file"
            ? "Focus a Markdown note to search this file."
            : "No Markdown files are included in search.",
      });
      this.statusEl.setText(
        activeFileExcluded
          ? "File excluded"
          : this.scopeMode === "file"
            ? "No focused note"
            : "No included files",
      );
      return;
    }

    this.statusEl.setText("Searching…");
    const results = await this.plugin.index.search(
      parsed,
      files,
      this.plugin.settings.fuzzy,
      {
        excludeHeadingMatches: this.plugin.settings.excludeHeadingMatches,
        excludeExcalidrawData: this.plugin.settings.excludeExcalidrawData,
        mode:
          this.scopeMode === "properties" || this.scopeMode === "tags"
            ? this.scopeMode
            : "content",
      },
      this.plugin.settings.sort,
      this.plugin.settings.resultLimit,
    );
    if (renderGeneration !== this.renderGeneration) return;
    this.results = results;
    this.selectedIndex = 0;
    await this.renderResults();
  }

  private filesForScope(): TFile[] {
    if (this.scopeMode !== "file") {
      return this.app.vault
        .getMarkdownFiles()
        .filter((file) => !this.plugin.isFileExcluded(file.path));
    }
    const active = this.app.workspace.getActiveFile();
    return active?.extension === "md" && !this.plugin.isFileExcluded(active.path)
      ? [active]
      : [];
  }

  private async renderResults(): Promise<void> {
    const generation = ++this.renderGeneration;
    this.disposeResultRenderer();
    const renderer = new Component();
    renderer.load();
    this.resultRenderer = renderer;
    const headingRenderCache = new Map<string, HTMLElement>();
    this.resultsEl.removeClass("is-hidden");
    this.resultsEl.empty();
    if (this.results.length === 0) {
      this.resultsEl.createDiv({ cls: "floating-search-empty", text: "No matches" });
      this.statusEl.setText("No results");
      return;
    }

    for (let index = 0; index < this.results.length; index += 1) {
      if (generation !== this.renderGeneration) return;
      const result = this.results[index];
      const row = this.resultsEl.createDiv({
        cls: `floating-search-result${index === this.selectedIndex ? " is-selected" : ""}`,
        attr: { role: "option", "aria-selected": index === this.selectedIndex ? "true" : "false" },
      });
      const fileIcon = row.createSpan({ cls: "floating-search-result-icon" });
      setIcon(fileIcon, "file-text");
      const content = row.createDiv({ cls: "floating-search-result-content" });
      const location = content.createDiv({ cls: "floating-search-location" });
      location.createSpan({ cls: "floating-search-file-name", text: result.file.basename });
      for (const heading of result.hierarchy) {
        const divider = location.createSpan({ cls: "floating-search-location-divider" });
        setIcon(divider, "chevron-right");
        const headingEl = location.createSpan({
          cls: "floating-search-location-heading markdown-rendered",
        });
        await renderLocationHeading(
          this.app,
          heading,
          headingEl,
          result.file.path,
          renderer,
          headingRenderCache,
        );
        if (generation !== this.renderGeneration) return;
        markTextMatches(headingEl, result.matchTerms, this.plugin.settings.fuzzy);
      }
      const excerpt = content.createDiv({ cls: "floating-search-excerpt markdown-rendered" });
      await MarkdownRenderer.render(
        this.app,
        result.markdown,
        excerpt,
        result.file.path,
        renderer,
      );
      if (generation !== this.renderGeneration) return;
      markTextMatches(
        excerpt,
        result.matchTerms,
        this.plugin.settings.fuzzy,
        this.scopeMode === "tags",
      );
      const openIcon = row.createSpan({ cls: "floating-search-open-icon" });
      setIcon(openIcon, "arrow-up-right");

      row.addEventListener("mouseenter", () => {
        this.selectedIndex = index;
        this.updateSelectedRow(false);
      });
      row.addEventListener("click", () => {
        this.selectedIndex = index;
        void this.openSelected();
      });
      if (index > 0 && index % 12 === 0) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
    }
    const capped = this.results.length >= this.plugin.settings.resultLimit;
    this.statusEl.setText(`${this.results.length}${capped ? "+" : ""} result${this.results.length === 1 ? "" : "s"}`);
  }

  private disposeResultRenderer(): void {
    this.resultRenderer?.unload();
    this.resultRenderer = undefined;
  }

  private async openSelected(): Promise<void> {
    const result = this.results[this.selectedIndex];
    if (!result) return;
    this.close();
    await this.app.workspace.getLeaf(false).openFile(result.file);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.editor) return;
    const lastLine = Math.max(0, view.editor.lineCount() - 1);
    const line = Math.min(result.line, lastLine);
    const lineText = view.editor.getLine(line);
    const match = findMatchRange(lineText, result.matchTerms, this.plugin.settings.fuzzy);
    const from = { line, ch: match?.from ?? 0 };
    const fallbackEndLine = Math.min(result.endLine, lastLine);
    const to = match
      ? { line, ch: match.to }
      : { line: fallbackEndLine, ch: view.editor.getLine(fallbackEndLine).length };
    view.editor.setSelection(from, to);
    view.editor.scrollIntoView({ from, to }, true);
    view.editor.focus();
  }
}

export function noticeNoActiveFile(): void {
  new Notice("Focus a Markdown note before searching this file.");
}
