import {
  App,
  Plugin,
  PluginSettingTab,
} from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { SearchIndex } from "./search-index";
import { FloatingSearchModal, noticeNoActiveFile } from "./search-modal";
import type {
  FloatingSearchSettings,
  SearchScope,
  SortMode,
} from "./types";

const DEFAULT_SETTINGS: FloatingSearchSettings = {
  defaultScope: "file",
  fuzzy: false,
  excludeHeadingMatches: false,
  excludeExcalidrawData: false,
  sort: "relevance",
  resultLimit: 100,
};

export default class FloatingSearchPlugin extends Plugin {
  settings: FloatingSearchSettings = DEFAULT_SETTINGS;
  index!: SearchIndex;
  private activeModal: FloatingSearchModal | undefined;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.index = new SearchIndex(this.app.vault, this.app.metadataCache);
    this.index.start(this);
    this.addSettingTab(new FloatingSearchSettingTab(this.app, this));

    this.addCommand({
      id: "open-current-file-search",
      name: "Open search for current file",
      checkCallback: (checking) => {
        const available = this.app.workspace.getActiveFile()?.extension === "md";
        if (available && !checking) this.openSearch("file");
        return available;
      },
    });
    this.addCommand({
      id: "open-vault-search",
      name: "Open search for all files",
      callback: () => this.openSearch("vault"),
    });
    this.addCommand({
      id: "toggle-search-scope",
      name: "Toggle current file / all files",
      callback: () => {
        if (this.activeModal) void this.activeModal.toggleScope();
        else this.openSearch(this.settings.defaultScope === "file" ? "vault" : "file");
      },
    });
    this.addCommand({
      id: "cycle-result-sort",
      name: "Cycle result sorting",
      callback: () => {
        if (this.activeModal) void this.activeModal.cycleSort();
        else void this.cycleStoredSort();
      },
    });
    this.addCommand({
      id: "open-property-search",
      name: "Open property search",
      callback: () => {
        if (this.activeModal) void this.activeModal.setScope("properties");
        else this.openSearch("properties");
      },
    });
    this.addCommand({
      id: "open-tag-search",
      name: "Open tag search",
      callback: () => {
        if (this.activeModal) void this.activeModal.setScope("tags");
        else this.openSearch("tags");
      },
    });
  }

  openSearch(scope: SearchScope): void {
    if (scope === "file" && this.app.workspace.getActiveFile()?.extension !== "md") {
      noticeNoActiveFile();
      return;
    }
    this.activeModal?.close();
    this.activeModal = new FloatingSearchModal(this.app, this, scope);
    this.activeModal.open();
  }

  modalClosed(modal: FloatingSearchModal): void {
    if (this.activeModal === modal) this.activeModal = undefined;
  }

  async updateSettings(patch: Partial<FloatingSearchSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await this.saveData(this.settings);
  }

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<FloatingSearchSettings> | null;
    this.settings = {
      defaultScope: loaded?.defaultScope === "vault" ? "vault" : "file",
      fuzzy: loaded?.fuzzy ?? DEFAULT_SETTINGS.fuzzy,
      excludeHeadingMatches:
        loaded?.excludeHeadingMatches ?? DEFAULT_SETTINGS.excludeHeadingMatches,
      excludeExcalidrawData:
        loaded?.excludeExcalidrawData ?? DEFAULT_SETTINGS.excludeExcalidrawData,
      sort: loaded?.sort ?? DEFAULT_SETTINGS.sort,
      resultLimit: loaded?.resultLimit ?? DEFAULT_SETTINGS.resultLimit,
    };
  }

  private async cycleStoredSort(): Promise<void> {
    const sorts: SortMode[] = ["relevance", "file", "location", "modified"];
    const next = sorts[(sorts.indexOf(this.settings.sort) + 1) % sorts.length];
    await this.updateSettings({ sort: next });
  }
}

class FloatingSearchSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: FloatingSearchPlugin) {
    super(app, plugin);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Default scope",
        desc: "Choose where search starts. The scope dropdown never changes your query text.",
        control: {
          type: "dropdown",
          key: "defaultScope",
          options: { file: "This file", vault: "All files" },
          defaultValue: DEFAULT_SETTINGS.defaultScope,
        },
      },
      {
        name: "Fuzzy matching",
        desc: "Allow characters to match in sequence when there is no direct match.",
        control: {
          type: "toggle",
          key: "fuzzy",
          defaultValue: DEFAULT_SETTINGS.fuzzy,
        },
      },
      {
        name: "Exclude heading matches",
        desc: "Hide result cards caused by matches on heading lines. Headings still appear as location context for matching content.",
        control: {
          type: "toggle",
          key: "excludeHeadingMatches",
          defaultValue: DEFAULT_SETTINGS.excludeHeadingMatches,
        },
      },
      {
        name: "Exclude Excalidraw data",
        desc: "Ignore the Excalidraw data section and its nested content until the next peer heading.",
        control: {
          type: "toggle",
          key: "excludeExcalidrawData",
          defaultValue: DEFAULT_SETTINGS.excludeExcalidrawData,
        },
      },
      {
        name: "Result limit",
        desc: "Limit rendered results to keep the panel fast in large vaults.",
        control: {
          type: "dropdown",
          key: "resultLimit",
          options: { "50": "50", "100": "100", "200": "200" },
          defaultValue: String(DEFAULT_SETTINGS.resultLimit),
        },
      },
    ];
  }

  override getControlValue(key: string): unknown {
    if (key === "resultLimit") return String(this.plugin.settings.resultLimit);
    if (key in this.plugin.settings) {
      return this.plugin.settings[key as keyof FloatingSearchSettings];
    }
    return undefined;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    switch (key) {
      case "defaultScope":
        if (value === "file" || value === "vault") {
          await this.plugin.updateSettings({ defaultScope: value });
        }
        return;
      case "fuzzy":
      case "excludeHeadingMatches":
      case "excludeExcalidrawData":
        if (typeof value === "boolean") {
          await this.plugin.updateSettings({ [key]: value });
        }
        return;
      case "resultLimit": {
        const limit = Number(value);
        if (limit === 50 || limit === 100 || limit === 200) {
          await this.plugin.updateSettings({ resultLimit: limit });
        }
        return;
      }
      default:
        return;
    }
  }
}
