import {
  App,
  Component,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Platform,
  setIcon,
  TFile,
} from "obsidian";
import { findMatchRanges } from "./editor-highlight";
import { installResponsiveViewport } from "./mobile-layout";
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

interface PreparedHighlightTerm {
  caseSensitive: boolean;
  exact: boolean;
  lowerValue: string;
  regex?: RegExp;
  value: string;
  wholeWord: boolean;
}

function prepareHighlightTerms(terms: HighlightTerm[]): PreparedHighlightTerm[] {
  return terms.map((term) => {
    const flags = term.regex
      ? [...new Set(`${term.regex.flags.replace(/[gy]/g, "")}g`)].join("")
      : undefined;
    return {
      caseSensitive: term.caseSensitive,
      exact: term.exact,
      lowerValue: term.value.toLocaleLowerCase(),
      regex: term.regex ? new RegExp(term.regex.source, flags) : undefined,
      value: term.value,
      wholeWord: term.exact && /^[\p{L}\p{N}_-]+$/u.test(term.value),
    };
  });
}

function markTextMatches(
  root: HTMLElement,
  terms: PreparedHighlightTerm[],
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
        const regex = termSpec.regex;
        regex.lastIndex = 0;
        let match = regex.exec(text);
        while (match) {
          if (match[0].length > 0) ranges.push([match.index, match.index + match[0].length]);
          else regex.lastIndex += 1;
          match = regex.exec(text);
        }
        continue;
      }

      const rawTerm = termSpec.value;
      const term = termSpec.caseSensitive ? rawTerm : termSpec.lowerValue;
      const source = termSpec.caseSensitive ? text : lower;
      let from = 0;
      let index = source.indexOf(term, from);
      let foundLiteral = false;
      while (index >= 0 && term.length > 0) {
        const end = index + term.length;
        const onBoundary =
          !termSpec.wholeWord ||
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
        for (const character of termSpec.lowerValue) {
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
  private resultRows: HTMLElement[] = [];
  private closeButtonObserver: MutationObserver | undefined;
  private disposeViewport = (): void => undefined;

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
    this.disposeViewport = installResponsiveViewport(this.containerEl, Platform.isMobileApp);
    this.titleEl.hide();
    if (!this.removeModalCloseButton()) {
      this.closeButtonObserver = new MutationObserver(() => {
        if (this.removeModalCloseButton()) {
          this.closeButtonObserver?.disconnect();
          this.closeButtonObserver = undefined;
        }
      });
      this.closeButtonObserver.observe(this.containerEl, { childList: true, subtree: true });
      window.setTimeout(() => {
        this.removeModalCloseButton();
        this.closeButtonObserver?.disconnect();
        this.closeButtonObserver = undefined;
      }, 0);
    }
    this.buildToolbar();
    this.resultsEl = this.contentEl.createDiv({
      cls: "floating-search-results is-hidden",
      attr: { role: "listbox", "aria-label": "Search results" },
    });
    this.resultsEl.addEventListener("pointerover", (event) => this.onResultPointerOver(event));
    this.resultsEl.addEventListener("click", (event) => this.onResultClick(event));
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
    this.disposeViewport();
    this.disposeViewport = () => undefined;
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.renderGeneration += 1;
    this.plugin.index.cancelPendingSearch();
    this.plugin.modalClosed(this);
    this.disposeResultRenderer();
    this.resultRows = [];
    this.contentEl.empty();
  }

  private removeModalCloseButton(): boolean {
    const closeButtons = this.containerEl.querySelectorAll<HTMLElement>(
      ".modal-close-button, .modal-header-button",
    );
    closeButtons.forEach((closeButton) => closeButton.remove());
    return closeButtons.length > 0;
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
        inputmode: "search",
        enterkeyhint: "search",
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
    this.selectResult(
      (this.selectedIndex + direction + this.results.length) % this.results.length,
      true,
    );
  }

  private selectResult(index: number, scroll: boolean): void {
    if (index < 0 || index >= this.results.length) return;
    const previousRow = this.resultRows[this.selectedIndex];
    if (previousRow && this.selectedIndex !== index) {
      previousRow.removeClass("is-selected");
      previousRow.setAttr("aria-selected", "false");
    }
    this.selectedIndex = index;
    const selectedRow = this.resultRows[index];
    if (!selectedRow) return;
    selectedRow.addClass("is-selected");
    selectedRow.setAttr("aria-selected", "true");
    if (scroll) selectedRow.scrollIntoView({ block: "nearest" });
  }

  private resultIndexFromEvent(event: Event): number | undefined {
    const ElementClass = this.resultsEl.ownerDocument.defaultView?.Element;
    if (!ElementClass || !(event.target instanceof ElementClass)) return undefined;
    const row = event.target.closest<HTMLElement>(".floating-search-result");
    if (!row || !this.resultsEl.contains(row)) return undefined;
    const index = Number(row.dataset.resultIndex);
    return Number.isInteger(index) ? index : undefined;
  }

  private onResultPointerOver(event: PointerEvent): void {
    const index = this.resultIndexFromEvent(event);
    if (index !== undefined && index !== this.selectedIndex) this.selectResult(index, false);
  }

  private onResultClick(event: MouseEvent): void {
    const index = this.resultIndexFromEvent(event);
    if (index === undefined) return;
    this.selectResult(index, false);
    void this.openSelected();
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
    this.showControlMenu(menu, this.scopeButton, event);
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
    this.showControlMenu(menu, this.sortButton, event);
  }

  private showControlMenu(menu: Menu, control: HTMLElement, event: MouseEvent): void {
    if (!Platform.isMobileApp) {
      menu.showAtMouseEvent(event);
      return;
    }

    const bounds = control.getBoundingClientRect();
    menu.showAtPosition(
      {
        x: Math.round(bounds.left),
        y: Math.round(bounds.bottom + 4),
      },
      control.ownerDocument,
    );
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
    const settingsUpdate =
      scope === "file" || scope === "vault"
        ? this.plugin.updateSettings({ defaultScope: scope })
        : Promise.resolve();
    await this.runSearch();
    await settingsUpdate;
    this.inputEl.focus();
  }

  async toggleScope(): Promise<void> {
    await this.setScope(this.scopeMode === "file" ? "vault" : "file");
  }

  async setSort(sort: SortMode): Promise<void> {
    const settingsUpdate = this.plugin.updateSettings({ sort });
    this.updateSortButton();
    await this.runSearch();
    await settingsUpdate;
    this.inputEl.focus();
  }

  async cycleSort(): Promise<void> {
    const index = SORT_ORDER.indexOf(this.plugin.settings.sort);
    await this.setSort(SORT_ORDER[(index + 1) % SORT_ORDER.length]);
  }

  private queueSearch(): void {
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.renderGeneration += 1;
    this.plugin.index.cancelPendingSearch();
    this.searchTimer = window.setTimeout(() => void this.runSearch(), 70);
  }

  private async runSearch(): Promise<void> {
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
    const renderGeneration = ++this.renderGeneration;
    const trimmed = this.query.trim();
    if (!trimmed) {
      this.results = [];
      this.clearRenderedResults();
      this.resultsEl.addClass("is-hidden");
      this.statusEl.setText("Type to search");
      return;
    }
    this.resultsEl.removeClass("is-hidden");

    const parsed = parseQuery(trimmed);
    if (parsed.error) {
      this.results = [];
      this.clearRenderedResults();
      this.resultsEl.createDiv({ cls: "floating-search-empty is-error", text: parsed.error });
      this.statusEl.setText("Invalid query");
      return;
    }
    if (parsed.groups.length === 0) {
      this.results = [];
      this.clearRenderedResults();
      this.resultsEl.addClass("is-hidden");
      this.statusEl.setText("Type to search");
      return;
    }

    const files = this.filesForScope();
    if (files.length === 0) {
      const activeFile = this.app.workspace.getActiveFile();
      const activeMarkdownFile = activeFile?.extension === "md";
      const activeFileExcluded =
        this.scopeMode === "file" &&
        activeMarkdownFile &&
        this.plugin.isFileExcluded(activeFile.path);
      this.results = [];
      this.clearRenderedResults();
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
      return this.plugin.getSearchableMarkdownFiles();
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
    const highlightTerms = prepareHighlightTerms(this.results[0]?.matchTerms ?? []);
    this.resultRows = [];
    this.resultsEl.removeClass("is-hidden");
    this.resultsEl.empty();
    if (this.results.length === 0) {
      this.resultsEl.createDiv({ cls: "floating-search-empty", text: "No matches" });
      this.statusEl.setText("No results");
      return;
    }

    const batchSize = Platform.isMobileApp ? 6 : 12;
    const frameBudget = Platform.isMobileApp ? 6 : 10;
    let batchCount = 0;
    let sliceStarted = performance.now();
    let batch = createFragment();
    for (let index = 0; index < this.results.length; index += 1) {
      if (generation !== this.renderGeneration) return;
      const result = this.results[index];
      const row = createDiv({
        cls: `floating-search-result${index === this.selectedIndex ? " is-selected" : ""}`,
        attr: {
          role: "option",
          tabindex: "-1",
          "aria-selected": index === this.selectedIndex ? "true" : "false",
        },
      });
      row.dataset.resultIndex = String(index);
      this.resultRows.push(row);
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
        markTextMatches(headingEl, highlightTerms, this.plugin.settings.fuzzy);
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
        highlightTerms,
        this.plugin.settings.fuzzy,
        this.scopeMode === "tags",
      );
      const openIcon = row.createSpan({ cls: "floating-search-open-icon" });
      setIcon(openIcon, "arrow-up-right");

      batch.appendChild(row);
      batchCount += 1;
      const batchComplete =
        batchCount >= batchSize || performance.now() - sliceStarted >= frameBudget;
      const isLastResult = index === this.results.length - 1;
      if (batchComplete || isLastResult) {
        this.resultsEl.appendChild(batch);
        batch = createFragment();
        batchCount = 0;
      }
      if (batchComplete && !isLastResult) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        sliceStarted = performance.now();
      }
    }
    const capped = this.results.length >= this.plugin.settings.resultLimit;
    this.statusEl.setText(`${this.results.length}${capped ? "+" : ""} result${this.results.length === 1 ? "" : "s"}`);
  }

  private disposeResultRenderer(): void {
    this.resultRenderer?.unload();
    this.resultRenderer = undefined;
  }

  private clearRenderedResults(): void {
    this.disposeResultRenderer();
    this.resultRows = [];
    this.resultsEl.empty();
  }

  private async openSelected(): Promise<void> {
    const result = this.results[this.selectedIndex];
    if (!result) return;
    this.close();
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(result.file);
    const view =
      leaf.view instanceof MarkdownView
        ? leaf.view
        : this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.editor) return;
    const lastLine = Math.max(0, view.editor.lineCount() - 1);
    const line = Math.min(result.line, lastLine);
    const lineText = view.editor.getLine(line);
    const matches = findMatchRanges(
      lineText,
      result.matchTerms,
      this.plugin.settings.fuzzy,
    );
    const fallbackEndLine = Math.min(result.endLine, lastLine);
    if (matches.length > 0) {
      const selections = matches.map((match) => ({
        anchor: { line, ch: match.from },
        head: { line, ch: match.to },
      }));
      view.editor.setSelections(selections, 0);
      view.editor.scrollIntoView(
        {
          from: selections[0].anchor,
          to: selections[selections.length - 1].head,
        },
        true,
      );
    } else {
      const from = { line, ch: 0 };
      const to = {
        line: fallbackEndLine,
        ch: view.editor.getLine(fallbackEndLine).length,
      };
      view.editor.setSelection(from, to);
      view.editor.scrollIntoView({ from, to }, true);
    }
    if (!Platform.isMobileApp) view.editor.focus();
  }
}

export function noticeNoActiveFile(): void {
  new Notice("Focus a Markdown note before searching this file.");
}
