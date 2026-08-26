import {
  App,
  Component,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  setIcon,
  TFile,
} from "obsidian";
import {
  extractMarkdownHeadings,
  headingHighlightTerms,
  headingSelectionRange,
  matchingHeadingIndexes,
} from "./headings";
import type { HeadingEntry } from "./headings";
import type FloatingSearchPlugin from "./main";

function clearHighlights(root: HTMLElement): void {
  for (const mark of Array.from(root.querySelectorAll("mark.heading-navigator-highlight"))) {
    mark.replaceWith(mark.textContent ?? "");
  }
  root.normalize();
}

function highlightTerms(root: HTMLElement, terms: string[]): void {
  clearHighlights(root);
  if (terms.length === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current: Node | null;
  while ((current = walker.nextNode())) nodes.push(current as Text);

  for (const node of nodes) {
    const text = node.data;
    const lower = text.toLocaleLowerCase();
    const ranges: Array<[number, number]> = [];
    for (const term of terms) {
      let index = lower.indexOf(term);
      while (index >= 0) {
        ranges.push([index, index + term.length]);
        index = lower.indexOf(term, index + Math.max(1, term.length));
      }
    }
    if (ranges.length === 0) continue;
    ranges.sort((left, right) => left[0] - right[0]);
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else merged.push([...range]);
    }

    const fragment = createFragment();
    let cursor = 0;
    for (const [start, end] of merged) {
      if (start > cursor) fragment.append(text.slice(cursor, start));
      const mark = createEl("mark", { cls: "heading-navigator-highlight" });
      mark.textContent = text.slice(start, end);
      fragment.append(mark);
      cursor = end;
    }
    if (cursor < text.length) fragment.append(text.slice(cursor));
    node.replaceWith(fragment);
  }
}

async function renderHeading(
  app: App,
  markdown: string,
  target: HTMLElement,
  sourcePath: string,
  component: Component,
  cache: Map<string, HTMLElement>,
): Promise<void> {
  let template = cache.get(markdown);
  if (!template) {
    template = createSpan();
    await MarkdownRenderer.render(app, markdown, template, sourcePath, component);
    cache.set(markdown, template);
  }
  for (const child of Array.from(template.childNodes)) {
    target.appendChild(child.cloneNode(true));
  }
}

export class HeadingNavigatorModal extends Modal {
  private headings: HeadingEntry[] = [];
  private selectedIndex = 0;
  private matchIndexes: number[] = [];
  private matchCursor = -1;
  private renderGeneration = 0;
  private previewGeneration = 0;
  private renderer: Component | undefined;
  private readonly headingRenderCache = new Map<string, HTMLElement>();
  private closeButtonObserver: MutationObserver | undefined;

  private inputEl!: HTMLInputElement;
  private currentHeadingEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private statusEl!: HTMLElement;

  constructor(
    app: App,
    private readonly plugin: FloatingSearchPlugin,
    private readonly file: TFile,
  ) {
    super(app);
  }

  onOpen(): void {
    this.containerEl.addClass("heading-navigator-container");
    this.modalEl.addClass("heading-navigator-modal");
    this.contentEl.addClass("heading-navigator-content");
    this.titleEl.hide();
    this.removeModalCloseButton();
    this.closeButtonObserver = new MutationObserver(() => this.removeModalCloseButton());
    this.closeButtonObserver.observe(this.containerEl, { childList: true, subtree: true });
    this.buildShell();
    this.registerKeyboardNavigation();
    void this.loadHeadings();
    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  onClose(): void {
    this.closeButtonObserver?.disconnect();
    this.closeButtonObserver = undefined;
    this.renderGeneration += 1;
    this.previewGeneration += 1;
    this.renderer?.unload();
    this.renderer = undefined;
    this.headingRenderCache.clear();
    this.plugin.headingNavigatorClosed(this);
    this.contentEl.empty();
  }

  private removeModalCloseButton(): void {
    this.containerEl
      .querySelectorAll<HTMLElement>(".modal-close-button, .modal-header-button")
      .forEach((button) => button.remove());
  }

  private buildShell(): void {
    const toolbar = this.contentEl.createDiv({ cls: "heading-navigator-toolbar" });
    const searchIcon = toolbar.createSpan({ cls: "heading-navigator-search-icon" });
    setIcon(searchIcon, "search");
    this.inputEl = toolbar.createEl("input", {
      cls: "heading-navigator-input",
      attr: {
        type: "text",
        placeholder: "Search headings",
        autocomplete: "off",
        autocapitalize: "off",
        spellcheck: "false",
        "aria-label": "Search headings",
      },
    });
    const shortcut = toolbar.createSpan({ cls: "heading-navigator-shortcut", text: "↵" });
    shortcut.setAttr("aria-hidden", "true");

    const panel = this.contentEl.createDiv({ cls: "heading-navigator-panel" });
    this.currentHeadingEl = panel.createDiv({
      cls: "heading-navigator-current",
      attr: { "aria-label": "Current heading" },
    });
    this.resultsEl = panel.createDiv({
      cls: "heading-navigator-results",
      attr: { role: "listbox", "aria-label": `Headings in ${this.file.basename}` },
    });
    this.statusEl = this.contentEl.createDiv({
      cls: "heading-navigator-status",
      attr: { "aria-live": "polite", "aria-atomic": "true" },
    });
    this.inputEl.addEventListener("input", () => this.updateMatches());
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
      this.cycleMatches();
      return false;
    });
    this.scope.register(["Shift"], "Enter", (event) => {
      event.preventDefault();
      void this.jumpToSelected();
      return false;
    });
  }

  private async loadHeadings(): Promise<void> {
    const generation = ++this.renderGeneration;
    this.resultsEl.empty();
    this.resultsEl.createDiv({ cls: "heading-navigator-empty", text: "Loading headings…" });
    const content = await this.app.vault.cachedRead(this.file);
    if (generation !== this.renderGeneration) return;
    this.headings = extractMarkdownHeadings(
      content.split(/\r?\n/),
      this.plugin.settings.excludeExcalidrawDataFromHeadings,
    );
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cursorLine = view?.file?.path === this.file.path ? view.editor.getCursor().line : 0;
    const currentIndex = this.headings.findLastIndex((heading) => heading.line <= cursorLine);
    this.selectedIndex = Math.max(0, currentIndex);
    await this.renderHeadings(generation);
    if (generation !== this.renderGeneration) return;
    this.updateMatches();
    this.updateSelectedRow(true, false);
  }

  private async renderHeadings(generation: number): Promise<void> {
    this.renderer?.unload();
    const renderer = new Component();
    renderer.load();
    this.renderer = renderer;
    this.headingRenderCache.clear();
    this.resultsEl.empty();

    if (this.headings.length === 0) {
      this.currentHeadingEl.hide();
      this.resultsEl.createDiv({ cls: "heading-navigator-empty", text: "No headings in this file" });
      this.statusEl.setText("No headings");
      return;
    }

    this.currentHeadingEl.show();
    await this.updateCurrentHeading(this.selectedIndex, generation);
    if (generation !== this.renderGeneration) return;

    for (let index = 0; index < this.headings.length; index += 1) {
      if (generation !== this.renderGeneration) return;
      const heading = this.headings[index];
      const row = this.resultsEl.createDiv({
        cls: `heading-navigator-row is-level-${heading.level}`,
        attr: {
          role: "option",
          "aria-selected": index === this.selectedIndex ? "true" : "false",
        },
      });
      row.createSpan({ cls: "heading-navigator-level", text: `H${heading.level}` });
      const body = row.createDiv({ cls: "heading-navigator-row-body" });
      const title = body.createDiv({ cls: "heading-navigator-title markdown-rendered" });
      await renderHeading(
        this.app,
        heading.markdown,
        title,
        this.file.path,
        renderer,
        this.headingRenderCache,
      );
      if (generation !== this.renderGeneration) return;

      row.addEventListener("mouseenter", () => {
        this.selectedIndex = index;
        this.updateSelectedRow(false);
      });
      row.addEventListener("click", () => {
        this.selectedIndex = index;
        void this.jumpToSelected();
      });
      if (index > 0 && index % 24 === 0) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
    }
  }

  private async updateCurrentHeading(index: number, generation = this.renderGeneration): Promise<void> {
    const previewGeneration = ++this.previewGeneration;
    const heading = this.headings[index];
    const renderer = this.renderer;
    if (!heading || !renderer) return;

    // Render into a detached preview so an older hover cannot overwrite a
    // newer selection while MarkdownRenderer is still resolving.
    const preview = createDiv();
    const title = preview.createDiv({ cls: "heading-navigator-current-title markdown-rendered" });
    await renderHeading(
      this.app,
      heading.markdown,
      title,
      this.file.path,
      renderer,
      this.headingRenderCache,
    );
    if (
      generation !== this.renderGeneration ||
      previewGeneration !== this.previewGeneration ||
      index !== this.selectedIndex
    ) return;

    if (heading.parents.length > 0) {
      const path = preview.createDiv({ cls: "heading-navigator-current-path" });
      for (let parentIndex = 0; parentIndex < heading.parents.length; parentIndex += 1) {
        if (parentIndex > 0) {
          const divider = path.createSpan({ cls: "heading-navigator-context-divider" });
          setIcon(divider, "chevron-right");
        }
        const parent = path.createSpan({ cls: "heading-navigator-parent markdown-rendered" });
        await renderHeading(
          this.app,
          heading.parents[parentIndex],
          parent,
          this.file.path,
          renderer,
          this.headingRenderCache,
        );
        if (
          generation !== this.renderGeneration ||
          previewGeneration !== this.previewGeneration ||
          index !== this.selectedIndex
        ) return;
      }
    }

    this.currentHeadingEl.empty();
    while (preview.firstChild) this.currentHeadingEl.appendChild(preview.firstChild);
  }

  private updateMatches(): void {
    const query = this.inputEl.value.trim();
    this.matchIndexes = matchingHeadingIndexes(this.headings, query);
    this.matchCursor = -1;
    const terms = headingHighlightTerms(query);
    const matches = new Set(this.matchIndexes);
    const rows = Array.from(this.resultsEl.querySelectorAll<HTMLElement>(".heading-navigator-row"));
    rows.forEach((row, index) => {
      row.toggleClass("is-searching", terms.length > 0);
      row.toggleClass("is-match", terms.length > 0 && matches.has(index));
      const title = row.querySelector<HTMLElement>(".heading-navigator-title");
      if (title) highlightTerms(title, matches.has(index) ? terms : []);
    });
    const count = query ? this.matchIndexes.length : this.headings.length;
    this.statusEl.setText(`${count} ${query ? "matching " : ""}heading${count === 1 ? "" : "s"}`);
  }

  private cycleMatches(): void {
    if (this.matchIndexes.length === 0) return;
    this.matchCursor = (this.matchCursor + 1) % this.matchIndexes.length;
    this.selectedIndex = this.matchIndexes[this.matchCursor];
    this.updateSelectedRow(true);
  }

  private moveSelection(direction: number): void {
    if (this.headings.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex + direction + this.headings.length) % this.headings.length;
    this.updateSelectedRow(true);
  }

  private updateSelectedRow(scroll: boolean, updatePreview = true): void {
    const rows = Array.from(this.resultsEl.querySelectorAll<HTMLElement>(".heading-navigator-row"));
    rows.forEach((row, index) => {
      const selected = index === this.selectedIndex;
      row.toggleClass("is-selected", selected);
      row.setAttr("aria-selected", selected ? "true" : "false");
      if (selected && scroll) row.scrollIntoView({ block: "nearest" });
    });
    if (updatePreview) void this.updateCurrentHeading(this.selectedIndex);
  }

  private async jumpToSelected(): Promise<void> {
    const heading = this.headings[this.selectedIndex];
    if (!heading) return;
    this.close();
    if (this.app.workspace.getActiveFile()?.path !== this.file.path) {
      await this.app.workspace.getLeaf(false).openFile(this.file);
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.editor) return;
    const line = Math.min(Math.max(heading.line, 0), view.editor.lineCount() - 1);
    const range = headingSelectionRange(line, view.editor.getLine(line));
    view.editor.setSelection(range.from, range.to);
    view.editor.scrollIntoView(range, true);
    view.editor.focus();
  }
}
