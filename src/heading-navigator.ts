import {
  App,
  Component,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Platform,
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
import { installResponsiveViewport } from "./mobile-layout";

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
  private previewFrame: number | undefined;
  private renderer: Component | undefined;
  private readonly headingRenderCache = new Map<string, HTMLElement>();
  private headingRows: HTMLElement[] = [];
  private highlightedMatchIndexes = new Set<number>();
  private closeButtonObserver: MutationObserver | undefined;
  private disposeViewport = (): void => undefined;

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
    this.buildShell();
    this.registerKeyboardNavigation();
    void this.loadHeadings();
    if (!Platform.isMobileApp) window.setTimeout(() => this.inputEl.focus(), 0);
  }

  onClose(): void {
    this.closeButtonObserver?.disconnect();
    this.closeButtonObserver = undefined;
    this.disposeViewport();
    this.disposeViewport = () => undefined;
    this.renderGeneration += 1;
    this.previewGeneration += 1;
    if (this.previewFrame !== undefined) window.cancelAnimationFrame(this.previewFrame);
    this.previewFrame = undefined;
    this.renderer?.unload();
    this.renderer = undefined;
    this.headingRows = [];
    this.highlightedMatchIndexes.clear();
    this.headingRenderCache.clear();
    this.plugin.headingNavigatorClosed(this);
    this.contentEl.empty();
  }

  private removeModalCloseButton(): boolean {
    const closeButtons = this.containerEl.querySelectorAll<HTMLElement>(
      ".modal-close-button, .modal-header-button",
    );
    closeButtons.forEach((button) => button.remove());
    return closeButtons.length > 0;
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
        inputmode: "search",
        enterkeyhint: "search",
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
    this.resultsEl.addEventListener("pointerover", (event) => this.onHeadingPointerOver(event));
    this.resultsEl.addEventListener("click", (event) => this.onHeadingClick(event));
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
    this.selectHeading(this.selectedIndex, true, false);
  }

  private async renderHeadings(generation: number): Promise<void> {
    this.renderer?.unload();
    const renderer = new Component();
    renderer.load();
    this.renderer = renderer;
    this.headingRenderCache.clear();
    this.headingRows = [];
    this.highlightedMatchIndexes.clear();
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

    const batchSize = Platform.isMobileApp ? 12 : 24;
    const frameBudget = Platform.isMobileApp ? 6 : 10;
    let batchCount = 0;
    let sliceStarted = performance.now();
    let batch = createFragment();
    for (let index = 0; index < this.headings.length; index += 1) {
      if (generation !== this.renderGeneration) return;
      const heading = this.headings[index];
      const row = createDiv({
        cls: `heading-navigator-row is-level-${heading.level}`,
        attr: {
          role: "option",
          tabindex: "-1",
          "aria-selected": index === this.selectedIndex ? "true" : "false",
        },
      });
      row.dataset.headingIndex = String(index);
      this.headingRows.push(row);
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

      batch.appendChild(row);
      batchCount += 1;
      const batchComplete =
        batchCount >= batchSize || performance.now() - sliceStarted >= frameBudget;
      const isLastHeading = index === this.headings.length - 1;
      if (batchComplete || isLastHeading) {
        this.resultsEl.appendChild(batch);
        batch = createFragment();
        batchCount = 0;
      }
      if (batchComplete && !isLastHeading) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        sliceStarted = performance.now();
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
    const terms = headingHighlightTerms(query);
    this.matchIndexes = matchingHeadingIndexes(this.headings, terms);
    this.matchCursor = -1;
    const nextHighlights = terms.length > 0 ? new Set(this.matchIndexes) : new Set<number>();
    this.resultsEl.toggleClass("is-searching", terms.length > 0);
    for (const index of this.highlightedMatchIndexes) {
      if (nextHighlights.has(index)) continue;
      const row = this.headingRows[index];
      row?.removeClass("is-match");
      const title = row?.querySelector<HTMLElement>(".heading-navigator-title");
      if (title) clearHighlights(title);
    }
    for (const index of nextHighlights) {
      const row = this.headingRows[index];
      row?.addClass("is-match");
      const title = row?.querySelector<HTMLElement>(".heading-navigator-title");
      if (title) highlightTerms(title, terms);
    }
    this.highlightedMatchIndexes = nextHighlights;
    const count = query ? this.matchIndexes.length : this.headings.length;
    this.statusEl.setText(`${count} ${query ? "matching " : ""}heading${count === 1 ? "" : "s"}`);
  }

  private cycleMatches(): void {
    if (this.matchIndexes.length === 0) return;
    this.matchCursor = (this.matchCursor + 1) % this.matchIndexes.length;
    this.selectHeading(this.matchIndexes[this.matchCursor], true);
  }

  private moveSelection(direction: number): void {
    if (this.headings.length === 0) return;
    this.selectHeading(
      (this.selectedIndex + direction + this.headings.length) % this.headings.length,
      true,
    );
  }

  private selectHeading(index: number, scroll: boolean, updatePreview = true): void {
    if (index < 0 || index >= this.headings.length) return;
    const previousRow = this.headingRows[this.selectedIndex];
    if (previousRow && this.selectedIndex !== index) {
      previousRow.removeClass("is-selected");
      previousRow.setAttr("aria-selected", "false");
    }
    this.selectedIndex = index;
    const selectedRow = this.headingRows[index];
    if (selectedRow) {
      selectedRow.addClass("is-selected");
      selectedRow.setAttr("aria-selected", "true");
      if (scroll) selectedRow.scrollIntoView({ block: "nearest" });
    }
    if (updatePreview) this.scheduleCurrentHeading(index);
  }

  private scheduleCurrentHeading(index: number): void {
    if (this.previewFrame !== undefined) window.cancelAnimationFrame(this.previewFrame);
    this.previewFrame = window.requestAnimationFrame(() => {
      this.previewFrame = undefined;
      void this.updateCurrentHeading(index);
    });
  }

  private headingIndexFromEvent(event: Event): number | undefined {
    const ElementClass = this.resultsEl.ownerDocument.defaultView?.Element;
    if (!ElementClass || !(event.target instanceof ElementClass)) return undefined;
    const row = event.target.closest<HTMLElement>(".heading-navigator-row");
    if (!row || !this.resultsEl.contains(row)) return undefined;
    const index = Number(row.dataset.headingIndex);
    return Number.isInteger(index) ? index : undefined;
  }

  private onHeadingPointerOver(event: PointerEvent): void {
    const index = this.headingIndexFromEvent(event);
    if (index !== undefined && index !== this.selectedIndex) this.selectHeading(index, false);
  }

  private onHeadingClick(event: MouseEvent): void {
    const index = this.headingIndexFromEvent(event);
    if (index === undefined) return;
    this.selectHeading(index, false, false);
    void this.jumpToSelected();
  }

  private async jumpToSelected(): Promise<void> {
    const heading = this.headings[this.selectedIndex];
    if (!heading) return;
    this.close();
    let view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (this.app.workspace.getActiveFile()?.path !== this.file.path) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(this.file);
      view =
        leaf.view instanceof MarkdownView
          ? leaf.view
          : this.app.workspace.getActiveViewOfType(MarkdownView);
    }
    if (!view?.editor) return;
    const line = Math.min(Math.max(heading.line, 0), view.editor.lineCount() - 1);
    const range = headingSelectionRange(line, view.editor.getLine(line));
    view.editor.setSelection(range.from, range.to);
    view.editor.scrollIntoView(range, true);
    if (!Platform.isMobileApp) view.editor.focus();
  }
}
