import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";
import { GalleryStore, DB_PATH, setDataRoot } from "./store";
import { Importer } from "./importer";
import { GalleryView, VIEW_TYPE_GALLERY } from "./view";
import { GalleryHubSettings, DEFAULT_SETTINGS } from "./types";
import { t, setLocale, detectObsidianLocale } from "./i18n";

export default class GalleryHubPlugin extends Plugin {
  store!: GalleryStore;
  importer!: Importer;
  settings: GalleryHubSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyLocale();
    setDataRoot(this.settings.dataFolder);
    this.store = new GalleryStore(this.app);
    this.importer = new Importer(this.app, this.store);

    this.registerView(
      VIEW_TYPE_GALLERY,
      (leaf) => {
        const view = new GalleryView(
          leaf,
          this.store,
          this.importer,
          () => this.themeClass(),
          () => this.settings
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
      void this.store.init();
    });

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

  async onunload(): Promise<void> {
    await this.store.flush();
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

  /** 侧边栏模块开关变化后刷新所有已打开视图 */
  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GALLERY)) {
      const view = leaf.view;
      if (view instanceof GalleryView) view.refreshSidebar();
    }
  }

  // ---------- 设置 ----------

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
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
            await this.plugin.store.init();
            this.plugin.refreshViews();
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
