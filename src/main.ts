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
import { ThumbCache } from "./thumbs";
import { GalleryView, VIEW_TYPE_GALLERY } from "./view";
import { GalleryHubSettings, DEFAULT_SETTINGS } from "./types";
import { t, setLocale, detectObsidianLocale } from "./i18n";

export default class GalleryHubPlugin extends Plugin {
  store!: GalleryStore;
  importer!: Importer;
  thumbs!: ThumbCache;
  settings: GalleryHubSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyLocale();
    this.applyAccent();
    setDataRoot(this.settings.dataFolder);
    this.store = new GalleryStore(this.app);
    this.importer = new Importer(this.app, this.store);
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
      void this.store.init();
      void this.thumbs.init();
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
    // 清除注入到 body 的强调色变量,避免禁用后残留
    document.body.style.removeProperty("--ghub-accent-user");
    document.body.style.removeProperty("--ghub-accent-hover-user");
    document.body.style.removeProperty("--ghub-on-accent-user");
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

// ---------- 颜色工具 ----------

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
