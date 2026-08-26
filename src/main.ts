import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";
import { GalleryStore, ASSETS_DIR, DB_PATH, setDataRoot } from "./store";
import { Importer } from "./importer";
import { ThumbCache } from "./thumbs";
import { GalleryView, VIEW_TYPE_GALLERY } from "./view";
import { GalleryHubSettings, DEFAULT_SETTINGS } from "./types";
import { t, setLocale, detectObsidianLocale } from "./i18n";
import {
  AssetIndex,
  AssetIndexReport,
  AssetPathRepair,
} from "./asset-index";

export default class GalleryHubPlugin extends Plugin {
  store!: GalleryStore;
  importer!: Importer;
  assetIndex!: AssetIndex;
  thumbs!: ThumbCache;
  settings: GalleryHubSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyLocale();
    this.applyAccent();
    setDataRoot(this.settings.dataFolder);
    this.store = new GalleryStore(this.app);
    this.assetIndex = new AssetIndex(this.app, this.store);
    this.importer = new Importer(
      this.app,
      this.store,
      () => this.settings.preserveOriginalFileName
    );
    this.thumbs = new ThumbCache(this.app);
    this.importer.thumbs = this.thumbs;

    this.registerView(
      VIEW_TYPE_GALLERY,
      (leaf) => {
        const view = new GalleryView(
          leaf,
          this.store,
          this.importer,
          () => this.themeClass(),
          () => this.settings,
          this.thumbs
        );
        view.onSettingsChanged = () => void this.saveSettings();
        return view;
      }
    );

    this.addSettingTab(new GalleryHubSettingTab(this.app, this));

    this.addRibbonIcon("images", t("openGalleryHub"), () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-gallery",
      name: t("cmdOpenGallery"),
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "register-current-file",
      name: t("cmdRegisterCurrentFile"),
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return false;
        if (checking) return true;
        void this.importer.registerVaultFile(f.path).then((ok) => {
          if (ok) new Notice(t("registered", { name: f.name }));
        });
        return true;
      },
    });

    // 数据初始化(布局就绪后,避免拖慢启动)
    this.app.workspace.onLayoutReady(() => {
      void this.store.init().then(() => this.assetIndex.startBackgroundIndexing());
      void this.thumbs.init();
    });

    // 运行期间的文件/文件夹重命名：同步 assets 路径与库内 link 引用。
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.assetIndex.handleVaultRename(file, oldPath);
      })
    );

    // 外部修改检测(OneDrive 同步等)
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path === DB_PATH && !this.store.isSelfWriting()) {
          new Notice(t("dbExternallyModified"));
          void this.store.load();
        }
      })
    );

    // 跟随模式:Obsidian 明暗切换时同步
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        if (this.settings.colorMode === "follow") this.applyThemeToViews();
      })
    );
  }

  onunload(): void {
    this.assetIndex.stop();
    // 清除注入到 body 的强调色变量,避免禁用后残留
    document.body.style.removeProperty("--ghub-accent-user");
    document.body.style.removeProperty("--ghub-accent-hover-user");
    document.body.style.removeProperty("--ghub-on-accent-user");
    void this.store.flush();
  }

  // ---------- 语言 ----------

  applyLocale(): void {
    const lang = this.settings.language;
    setLocale(lang === "auto" ? detectObsidianLocale() : lang);
  }

  /** 语言变更后重建所有已打开的画廊视图(文案在 DOM 构建时固化,需整体重渲染) */
  rebuildViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GALLERY)) {
      const view = leaf.view;
      if (view instanceof GalleryView) void view.onOpen();
    }
  }

  // ---------- 主题 ----------

  /** 解析当前应使用的主题类 */
  themeClass(): "ghub-theme-dark" | "ghub-theme-light" {
    const mode = this.settings.colorMode;
    const dark =
      mode === "dark" ||
      (mode === "follow" && document.body.classList.contains("theme-dark"));
    return dark ? "ghub-theme-dark" : "ghub-theme-light";
  }

  /** 把最新主题应用到所有已打开的画廊视图 */
  applyThemeToViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GALLERY)) {
      const view = leaf.view;
      if (view instanceof GalleryView) view.applyTheme(this.themeClass());
    }
  }

  /**
   * 应用用户自定义强调色:注入到 document.body 的 CSS 变量,
   * 经继承链对主视图(.ghub-root)与所有弹窗(.ghub-detail-modal)同时生效。
   * 留空则清除覆盖,回落到明暗主题各自的默认强调色。
   */
  applyAccent(): void {
    const s = document.body.style;
    const hex = normalizeHex(this.settings.accentColor);
    if (!hex) {
      s.removeProperty("--ghub-accent-user");
      s.removeProperty("--ghub-accent-hover-user");
      s.removeProperty("--ghub-on-accent-user");
      return;
    }
    s.setProperty("--ghub-accent-user", hex);
    // hover 略微提亮;accent 底上的文字色按亮度选深/浅,保证对比度
    s.setProperty("--ghub-accent-hover-user", lightenHex(hex, 0.12));
    s.setProperty("--ghub-on-accent-user", isLightColor(hex) ? "#14120c" : "#ffffff");
  }

  /** 侧边栏模块开关变化后刷新所有已打开视图 */
  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GALLERY)) {
      const view = leaf.view;
      if (view instanceof GalleryView) view.refreshSidebar();
    }
  }

  // ---------- 设置 ----------

  async loadSettings(): Promise<void> {
    const data: unknown = await this.loadData();
    this.settings = parseSettings(data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---------- 视图 ----------

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_GALLERY);
    if (existing.length) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_GALLERY, active: true });
    }
    void workspace.revealLeaf(leaf);
  }
}

// ---------- 颜色工具 ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只接受已知设置字段，旧版或损坏数据按字段回退默认值。 */
function parseSettings(value: unknown): GalleryHubSettings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS };

  const colorMode = value.colorMode;
  const language = value.language;
  return {
    colorMode:
      colorMode === "dark" || colorMode === "light" || colorMode === "follow"
        ? colorMode
        : DEFAULT_SETTINGS.colorMode,
    accentColor:
      typeof value.accentColor === "string"
        ? value.accentColor
        : DEFAULT_SETTINGS.accentColor,
    language:
      language === "auto" || language === "zh" || language === "en"
        ? language
        : DEFAULT_SETTINGS.language,
    dataFolder:
      typeof value.dataFolder === "string"
        ? value.dataFolder
        : DEFAULT_SETTINGS.dataFolder,
    showFolders:
      typeof value.showFolders === "boolean"
        ? value.showFolders
        : DEFAULT_SETTINGS.showFolders,
    showBoards:
      typeof value.showBoards === "boolean"
        ? value.showBoards
        : DEFAULT_SETTINGS.showBoards,
    showTypes:
      typeof value.showTypes === "boolean"
        ? value.showTypes
        : DEFAULT_SETTINGS.showTypes,
    showRatings:
      typeof value.showRatings === "boolean"
        ? value.showRatings
        : DEFAULT_SETTINGS.showRatings,
    showTags:
      typeof value.showTags === "boolean"
        ? value.showTags
        : DEFAULT_SETTINGS.showTags,
    skipDeleteConfirm:
      typeof value.skipDeleteConfirm === "boolean"
        ? value.skipDeleteConfirm
        : DEFAULT_SETTINGS.skipDeleteConfirm,
    preserveOriginalFileName:
      typeof value.preserveOriginalFileName === "boolean"
        ? value.preserveOriginalFileName
        : DEFAULT_SETTINGS.preserveOriginalFileName,
  };
}

/** 规范化为 #rrggbb;非法/空返回 "" */
function normalizeHex(input: string): string {
  const v = (input || "").trim();
  if (!v) return "";
  let m = /^#?([0-9a-fA-F]{6})$/.exec(v);
  if (m) return `#${m[1].toLowerCase()}`;
  // 支持 #rgb 简写
  m = /^#?([0-9a-fA-F]{3})$/.exec(v);
  if (m) {
    const [r, g, b] = m[1];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return "";
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** 相对亮度(sRGB 感知加权),> 0.6 视为浅色 */
function isLightColor(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6;
}

/** 朝白色方向提亮 amount(0~1) */
function lightenHex(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const up = (c: number) => Math.round(c + (255 - c) * amount);
  const to2 = (c: number) => up(c).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

class GalleryHubSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GalleryHubPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(t("settingLanguage"))
      .setDesc(t("settingLanguageDesc"))
      .addDropdown((d) =>
        d
          .addOption("auto", t("langAuto"))
          .addOption("zh", t("langZh"))
          .addOption("en", t("langEn"))
          .setValue(this.plugin.settings.language)
          .onChange(async (v) => {
            this.plugin.settings.language = v as GalleryHubSettings["language"];
            await this.plugin.saveSettings();
            this.plugin.applyLocale();
            this.plugin.rebuildViews();
            this.display(); // 设置页自身也切语言
          })
      );

    new Setting(containerEl)
      .setName(t("settingColorMode"))
      .setDesc(t("settingColorModeDesc"))
      .addDropdown((d) =>
        d
          .addOption("dark", t("colorDark"))
          .addOption("light", t("colorLight"))
          .addOption("follow", t("colorFollow"))
          .setValue(this.plugin.settings.colorMode)
          .onChange(async (v) => {
            this.plugin.settings.colorMode = v as GalleryHubSettings["colorMode"];
            await this.plugin.saveSettings();
            this.plugin.applyThemeToViews();
            this.display(); // 主题默认色变了,刷新取色器回显
          })
      );

    // 主题色:留空跟随主题,取色器回显当前生效色
    const themeDefaultAccent =
      this.plugin.themeClass() === "ghub-theme-dark" ? "#e8b04b" : "#a16207";
    new Setting(containerEl)
      .setName(t("settingAccentColor"))
      .setDesc(t("settingAccentColorDesc"))
      .addColorPicker((cp) =>
        cp
          .setValue(this.plugin.settings.accentColor || themeDefaultAccent)
          .onChange(async (v) => {
            this.plugin.settings.accentColor = v;
            await this.plugin.saveSettings();
            this.plugin.applyAccent();
          })
      )
      .addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip(t("accentReset"))
          .onClick(async () => {
            this.plugin.settings.accentColor = "";
            await this.plugin.saveSettings();
            this.plugin.applyAccent();
            this.display(); // 回显恢复到主题默认色
          })
      );

    new Setting(containerEl)
      .setName(t("settingDataFolder"))
      .setDesc(t("settingDataFolderDesc"))
      .addText((txt) =>
        txt
          .setPlaceholder("GalleryHub")
          .setValue(this.plugin.settings.dataFolder)
          .onChange(async (v) => {
            const clean = v.trim().replace(/^\/+|\/+$/g, "");
            this.plugin.settings.dataFolder = clean || "GalleryHub";
            await this.plugin.saveSettings();
            setDataRoot(this.plugin.settings.dataFolder);
            this.plugin.assetIndex.stop();
            await this.plugin.store.init();
            this.plugin.assetIndex.startBackgroundIndexing();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t("settingPreserveOriginalFileName"))
      .setDesc(t("settingPreserveOriginalFileNameDesc"))
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.preserveOriginalFileName)
          .onChange(async (v) => {
            this.plugin.settings.preserveOriginalFileName = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settingFileIndex"))
      .setDesc(t("settingFileIndexDesc"))
      .addButton((button) =>
        button.setButtonText(t("checkRepairIndex")).onClick(async () => {
          if (!this.plugin.store.loaded) {
            new Notice(t("indexNotReady"));
            return;
          }
          if (this.plugin.store.readOnly) {
            new Notice(t("readOnlyNotice"));
            return;
          }
          button.setDisabled(true);
          button.setButtonText(t("indexScanning"));
          try {
            const report = await this.plugin.assetIndex.scanForRepairs(
              (current, total) => {
                button.setButtonText(
                  total ? t("indexScanningN", { current, total }) : t("indexScanning")
                );
              }
            );
            const autoRepaired = this.plugin.assetIndex.applyRepairs(
              report.repairs
            );
            new AssetIndexRepairModal(
              this.app,
              this.plugin.themeClass(),
              report,
              autoRepaired,
              (repairs) => this.plugin.assetIndex.applyRepairs(repairs)
            ).open();
          } catch (e) {
            new Notice(t("indexScanFailed", { msg: (e as Error).message }), 6000);
          } finally {
            button.setDisabled(false);
            button.setButtonText(t("checkRepairIndex"));
          }
        })
      );

    new Setting(containerEl).setName(t("settingSidebarModules")).setHeading();

    const moduleToggle = (
      name: string,
      desc: string,
      key: "showFolders" | "showBoards" | "showTypes" | "showRatings" | "showTags"
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((tg) =>
          tg.setValue(this.plugin.settings[key]).onChange(async (v) => {
            this.plugin.settings[key] = v;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
        );
    };
    moduleToggle(t("settingModFolders"), t("settingModFoldersDesc"), "showFolders");
    moduleToggle(t("settingModBoards"), t("settingModBoardsDesc"), "showBoards");
    moduleToggle(t("settingModTypes"), t("settingModTypesDesc"), "showTypes");
    moduleToggle(t("settingModRatings"), t("settingModRatingsDesc"), "showRatings");
    moduleToggle(t("settingModTags"), t("settingModTagsDesc"), "showTags");

    new Setting(containerEl)
      .setName(t("settingSkipDeleteConfirm"))
      .setDesc(t("settingSkipDeleteConfirmDesc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.skipDeleteConfirm).onChange(async (v) => {
          this.plugin.settings.skipDeleteConfirm = v;
          await this.plugin.saveSettings();
        })
      );
  }
}

class AssetIndexRepairModal extends Modal {
  private selections = new Map<string, string>();
  private selects = new Map<string, HTMLSelectElement>();
  private candidateRows = new Map<
    string,
    { row: HTMLElement; status: HTMLElement }
  >();
  private applyButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private themeClassName: string,
    private report: AssetIndexReport,
    private autoRepaired: number,
    private applyRepairs: (repairs: AssetPathRepair[]) => number
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass(
      "ghub-detail-modal",
      "ghub-index-modal",
      this.themeClassName
    );
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: t("indexReportTitle") });
    const report = contentEl.createDiv({ cls: "ghub-index-report" });
    const rows: Array<[string, number]> = [
      [t("indexManaged"), this.report.managed],
      [t("indexHealthy"), this.report.healthy],
      [t("indexAutoRepaired"), this.autoRepaired],
      [t("indexMissing"), this.report.unresolved],
      [t("indexCandidates"), this.report.unmatchedCandidates.length],
      [t("indexAmbiguous"), this.report.ambiguous],
      [t("indexHashesAdded"), this.report.hashesAdded],
    ];
    for (const [label, value] of rows) {
      const row = report.createDiv({ cls: "ghub-index-report-row" });
      row.createSpan({ text: label });
      row.createEl("strong", { text: String(value) });
    }
    contentEl.createDiv({
      cls: "ghub-index-report-note",
      text: t("indexReportNote"),
    });

    this.renderManualPairing(contentEl);

    const actions = contentEl.createDiv({ cls: "ghub-actions" });
    const close = actions.createEl("button", {
      text: t("close"),
    });
    close.addEventListener("click", () => this.close());

    if (
      this.report.unresolvedItems.length &&
      this.report.unmatchedCandidates.length
    ) {
      this.applyButton = actions.createEl("button", {
        text: t("applySelectedPairs", { n: 0 }),
        cls: "mod-cta",
      });
      this.applyButton.disabled = true;
      this.applyButton.addEventListener("click", () => {
        const candidates = new Map(
          this.report.unmatchedCandidates.map((candidate) => [
            candidate.path,
            candidate,
          ])
        );
        const missing = new Map(
          this.report.unresolvedItems.map((item) => [item.id, item])
        );
        const repairs: AssetPathRepair[] = [];
        for (const [id, newPath] of this.selections) {
          const oldItem = missing.get(id);
          const candidate = candidates.get(newPath);
          if (!oldItem || !candidate) continue;
          repairs.push({
            id,
            oldPath: oldItem.path,
            newPath,
            hash: candidate.hash,
            systemFileObservation: candidate.systemFileObservation,
          });
        }
        const count = this.applyRepairs(repairs);
        new Notice(t("indexManualRepairApplied", { n: count }));
        this.close();
      });
    }
  }

  private renderManualPairing(contentEl: HTMLElement): void {
    if (this.report.unresolvedItems.length) {
      contentEl.createEl("h3", {
        cls: "ghub-index-section-title",
        text: t("indexManualPairingTitle"),
      });
      contentEl.createDiv({
        cls: "ghub-index-section-desc",
        text: t("indexManualPairingDesc"),
      });
      const pairs = contentEl.createDiv({ cls: "ghub-index-pairs" });
      const candidates = [...this.report.unmatchedCandidates].sort((a, b) =>
        a.path.localeCompare(b.path, "zh")
      );
      for (const item of [...this.report.unresolvedItems].sort((a, b) =>
        a.path.localeCompare(b.path, "zh")
      )) {
        const row = pairs.createDiv({ cls: "ghub-index-pair-row" });
        row.createDiv({
          cls: "ghub-index-path",
          text: this.relativeAssetPath(item.path),
          attr: { title: item.path },
        });
        row.createSpan({ cls: "ghub-index-pair-arrow", text: "→" });
        const select = row.createEl("select", {
          cls: "dropdown ghub-index-pair-select",
        });
        select.createEl("option", { value: "", text: t("indexDoNotPair") });
        for (const candidate of candidates) {
          select.createEl("option", {
            value: candidate.path,
            text: this.relativeAssetPath(candidate.path),
          });
        }
        select.addEventListener("change", () => {
          if (select.value) this.selections.set(item.id, select.value);
          else this.selections.delete(item.id);
          this.refreshPairingState();
        });
        this.selects.set(item.id, select);
      }
    }

    if (this.report.unmatchedCandidates.length) {
      contentEl.createEl("h3", {
        cls: "ghub-index-section-title",
        text: t("indexUnownedFilesTitle"),
      });
      const list = contentEl.createDiv({ cls: "ghub-index-candidates" });
      for (const candidate of [...this.report.unmatchedCandidates].sort((a, b) =>
        a.path.localeCompare(b.path, "zh")
      )) {
        const row = list.createDiv({ cls: "ghub-index-candidate-row" });
        row.createDiv({
          cls: "ghub-index-path",
          text: this.relativeAssetPath(candidate.path),
          attr: { title: candidate.path },
        });
        const status = row.createSpan({
          cls: "ghub-index-candidate-status",
          text: t("indexCandidateAvailable"),
        });
        this.candidateRows.set(candidate.path, { row, status });
      }
    }
  }

  private refreshPairingState(): void {
    const used = new Set(this.selections.values());
    for (const [id, select] of this.selects) {
      const current = this.selections.get(id) ?? "";
      for (const option of Array.from(select.options)) {
        option.disabled =
          !!option.value && used.has(option.value) && option.value !== current;
      }
    }
    for (const [path, { row, status }] of this.candidateRows) {
      const paired = used.has(path);
      row.classList.toggle("is-paired", paired);
      status.setText(
        paired ? t("indexCandidatePaired") : t("indexCandidateAvailable")
      );
    }
    if (this.applyButton) {
      this.applyButton.disabled = this.selections.size === 0;
      this.applyButton.setText(
        t("applySelectedPairs", { n: this.selections.size })
      );
    }
  }

  private relativeAssetPath(path: string): string {
    const prefix = `${ASSETS_DIR}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }

  onClose(): void {
    this.selections.clear();
    this.selects.clear();
    this.candidateRows.clear();
    this.applyButton = null;
    this.contentEl.empty();
  }
}
