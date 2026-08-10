import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { GalleryStore, DB_PATH } from "./store";
import { Importer } from "./importer";
import { GalleryView, VIEW_TYPE_GALLERY } from "./view";

export default class GalleryHubPlugin extends Plugin {
  store!: GalleryStore;
  importer!: Importer;

  async onload(): Promise<void> {
    this.store = new GalleryStore(this.app);
    this.importer = new Importer(this.app, this.store);

    this.registerView(
      VIEW_TYPE_GALLERY,
      (leaf) => new GalleryView(leaf, this.store, this.importer)
    );

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
  }

  async onunload(): Promise<void> {
    await this.store.flush();
  }

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
