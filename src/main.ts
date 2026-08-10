import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";
import { GalleryStore, DB_PATH } from "./store";
import { Importer } from "./importer";
import { GalleryView, VIEW_TYPE_GALLERY } from "./view";
import { GalleryHubSettings, DEFAULT_SETTINGS } from "./types";

export default class GalleryHubPlugin extends Plugin {
  store!: GalleryStore;
  importer!: Importer;
  settings: GalleryHubSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new GalleryStore(this.app);
    this.importer = new Importer(this.app, this.store);

    this.registerView(
      VIEW_TYPE_GALLERY,
      (leaf) =>
        new GalleryView(
          leaf,
          this.store,
          this.importer,
          () => this.themeClass(),
          () => this.settings
        )
    );

    this.addSettingTab(new GalleryHubSettingTab(this.app, this));

    this.addRibbonIcon("layout-grid", "打开 GalleryHub", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-gallery",
      name: "打开画廊",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "register-current-file",
      name: "将当前文件登记到画廊",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return false;
        if (checking) return true;
        void this.importer.registerVaultFile(f.path).then((ok) => {
          if (ok) new Notice(`已登记:${f.name}`);
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
          new Notice("GalleryHub:数据文件被外部修改,已重新加载。");
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
      .setName("颜色模式")
      .setDesc("画廊界面的配色。「跟随 Obsidian」会随应用的明暗主题自动切换。")
      .addDropdown((d) =>
        d
          .addOption("dark", "暗色(暗房)")
          .addOption("light", "浅色(画廊)")
          .addOption("follow", "跟随 Obsidian")
          .setValue(this.plugin.settings.colorMode)
          .onChange(async (v) => {
            this.plugin.settings.colorMode = v as GalleryHubSettings["colorMode"];
            await this.plugin.saveSettings();
            this.plugin.applyThemeToViews();
          })
      );

    new Setting(containerEl)
      .setName("默认文件夹")
      .setDesc(
        "打开画廊时默认进入的文件夹(assets 下的相对路径,如「角色/机甲」;留空为全部)。"
      )
      .addText((t) =>
        t
          .setPlaceholder("留空 = 全部")
          .setValue(this.plugin.settings.defaultFolder)
          .onChange(async (v) => {
            this.plugin.settings.defaultFolder = v.trim().replace(/^\/+|\/+$/g, "");
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("侧边栏模块").setHeading();

    const moduleToggle = (
      name: string,
      desc: string,
      key: "showFolders" | "showBoards" | "showTypes" | "showRatings" | "showTags"
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(this.plugin.settings[key]).onChange(async (v) => {
            this.plugin.settings[key] = v;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
        );
    };
    moduleToggle("文件树", "assets 目录树(含新建/重命名/拖拽)", "showFolders");
    moduleToggle("画布", "画布列表(点击直接打开)", "showBoards");
    moduleToggle("类型", "全部/图片/视频/链接 筛选", "showTypes");
    moduleToggle("评分", "按星级筛选", "showRatings");
    moduleToggle("标签", "标签云筛选", "showTags");
  }
}
