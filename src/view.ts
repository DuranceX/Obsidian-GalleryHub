import { ItemView, WorkspaceLeaf, Menu, Notice, setIcon } from "obsidian";
import { GalleryStore } from "./store";
import { Importer } from "./importer";
import { GalleryItem, ItemType, SortMode, GalleryHubSettings } from "./types";
import { CanvasBoard } from "./canvas";
import { ThumbCache } from "./thumbs";
import { t } from "./i18n";
import {
  DetailModal,
  AddLinkModal,
  FolderPickModal,
  ConfirmDeleteModal,
  ConfirmTrashModal,
  BatchEditModal,
} from "./detail";

export const VIEW_TYPE_GALLERY = "gallery-hub-view";

interface FilterState {
  search: string;
  type: ItemType | "all";
  tags: Set<string>;
  /** 评分多选:选中的星级集合(0=未评分也可加入);空 = 全部 */
  ratings: Set<number>;
  /** null = 全部;"" = assets 根直存;其他 = assets 相对路径(含选中文件夹的整棵子树) */
  folder: string | null;
}

/** 文件树节点 */
interface TreeNode {
  name: string;
  rel: string;
  children: TreeNode[];
}

function sortOptions(): Array<[SortMode, string]> {
  return [
    ["created-desc", t("sortCreatedDesc")],
    ["created-asc", t("sortCreatedAsc")],
    ["title-asc", t("sortTitleAsc")],
    ["rating-desc", t("sortRatingDesc")],
    ["type", t("sortByType")],
  ];
}

export class GalleryView extends ItemView {
  private store: GalleryStore;
  private importer: Importer;
  private getTheme: () => string;
  private unsubscribe: (() => void) | null = null;
  private filter: FilterState = {
    search: "",
    type: "all",
    tags: new Set(),
    ratings: new Set(),
    folder: null,
  };
  private sideEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private countEl!: HTMLElement;
  private batchBarEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private progressTextEl!: HTMLElement;
  private progressBarEl!: HTMLElement;
  private observer: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private colCount = 0;
  private resizeTimer: number | null = null;
  /** 多选:选中的条目 id */
  private selected = new Set<string>();
  /** assets/ 全部子文件夹(相对路径,含嵌套) */
  private folders: string[] = [];
  /** 树中已展开的文件夹 */
  private expanded = new Set<string>();
  /** 内联重命名中的文件夹(rel);新建后也进入此状态 */
  private renaming: string | null = null;
  /** 排序方式(页面内状态) */
  private sortMode: SortMode = "created-desc";
  private getSettings: () => GalleryHubSettings;
  /** 设置被视图内交互修改后(如"不再提醒")回调插件持久化 */
  onSettingsChanged: (() => void) | null = null;
  /** 画布模式状态 */
  private mode: "grid" | "canvas" = "grid";
  private canvasHostEl!: HTMLElement;
  private canvas: CanvasBoard | null = null;
  private activeBoardId: string | null = null;
  private modeBtns: { grid: HTMLElement; canvas: HTMLElement } | null = null;
  private boardBtnEl: HTMLButtonElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private sortBtnEl: HTMLButtonElement | null = null;
  private thumbs!: ThumbCache;

  constructor(
    leaf: WorkspaceLeaf,
    store: GalleryStore,
    importer: Importer,
    getTheme: () => string,
    getSettings: () => GalleryHubSettings,
    thumbs: ThumbCache
  ) {
    super(leaf);
    this.store = store;
    this.importer = importer;
    this.getTheme = getTheme;
    this.getSettings = getSettings;
    this.thumbs = thumbs;
  }

  /** 切换颜色模式(设置变更/Obsidian 主题变化时由插件调用) */
  applyTheme(themeClass: string): void {
    this.contentEl.removeClass("ghub-theme-dark", "ghub-theme-light");
    this.contentEl.addClass(themeClass);
  }

  getViewType(): string {
    return VIEW_TYPE_GALLERY;
  }

  getDisplayText(): string {
    return "GalleryHub";
  }

  getIcon(): string {
    return "images";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ghub-root");
    this.applyTheme(this.getTheme());

    // 懒加载 observer
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            const el = en.target as HTMLElement;
            const src = el.dataset.src;
            if (src) {
              if (el instanceof HTMLImageElement) el.src = src;
              if (el instanceof HTMLVideoElement) {
                el.src = src;
                el.preload = "metadata";
              }
              delete el.dataset.src;
              this.observer?.unobserve(el);
            }
          }
        }
      },
      { root, rootMargin: "400px" }
    );

    // 骨架:侧边栏 + 主区
    this.sideEl = root.createDiv({ cls: "ghub-side" });
    const main = root.createDiv({ cls: "ghub-main" });
    this.buildToolbar(main);
    this.batchBarEl = main.createDiv({ cls: "ghub-batchbar" });
    // 页面内导入进度条(工具栏下方,批量导入时出现)
    this.progressEl = main.createDiv({ cls: "ghub-import-progress" });
    this.progressTextEl = this.progressEl.createDiv({
      cls: "ghub-import-progress-text",
    });
    const track = this.progressEl.createDiv({
      cls: "ghub-import-progress-track",
    });
    this.progressBarEl = track.createDiv({ cls: "ghub-import-progress-bar" });
    this.importer.onProgress = (current, total, name) => {
      this.progressEl.addClass("is-visible");
      this.progressTextEl.setText(
        t("importProgress", { current, total, name })
      );
      this.progressBarEl.style.width = `${Math.round((current / total) * 100)}%`;
    };
    this.importer.onProgressDone = () => {
      this.progressEl.removeClass("is-visible");
      this.progressBarEl.style.width = "0";
    };
    this.gridEl = main.createDiv({ cls: "ghub-grid" });
    this.canvasHostEl = main.createDiv({ cls: "ghub-canvas-host" });

    // 拖拽导入(系统文件)
    root.addEventListener("dragover", (e) => {
      e.preventDefault();
      root.addClass("ghub-dragging");
    });
    root.addEventListener("dragleave", () => root.removeClass("ghub-dragging"));
    root.addEventListener("drop", (e) => {
      e.preventDefault();
      root.removeClass("ghub-dragging");
      if (e.dataTransfer?.files?.length) {
        // 若正在浏览某文件夹,导入直接落到该文件夹
        void this.importer.importFiles(
          e.dataTransfer.files,
          this.filter.folder ?? undefined
        );
      }
    });

    // Esc 清除多选
    this.registerDomEvent(root, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.selected.size) {
        this.clearSelection();
      }
    });

    this.unsubscribe = this.store.onChange(() => {
      // 数据变更后清理已不存在条目的选择
      for (const id of [...this.selected]) {
        if (!this.store.getItem(id)) this.selected.delete(id);
      }
      this.render();
      this.renderBatchBar();
      this.canvas?.refresh();
    });

    // 容器宽度变化 → 列数变化时重排(防抖,避免拖动面板时狂刷)
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        this.resizeTimer = null;
        if (this.computeColCount() !== this.colCount) this.renderGrid();
      }, 120);
    });
    this.resizeObserver.observe(this.gridEl);

    void this.refreshFolders();
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.canvas?.destroy();
    // 释放进度监听(避免视图关闭后 Importer 持有失效 DOM)
    this.importer.onProgress = null;
    this.importer.onProgressDone = null;
  }

  // ---------- 顶栏 ----------

  private buildToolbar(main: HTMLElement): void {
    const bar = main.createDiv({ cls: "ghub-toolbar" });

    // 模式切换:画廊 / 画布
    const modeWrap = bar.createDiv({ cls: "ghub-mode" });
    const gridBtn = modeWrap.createEl("button", {
      cls: "ghub-mode-btn is-active",
      attr: { "aria-label": t("galleryMode"), title: t("galleryMode") },
    });
    setIcon(gridBtn, "gallery-thumbnails");
    const canvasBtn = modeWrap.createEl("button", {
      cls: "ghub-mode-btn",
      attr: { "aria-label": t("canvasMode"), title: t("canvasMode") },
    });
    setIcon(canvasBtn, "frame");
    gridBtn.addEventListener("click", () => this.setMode("grid"));
    canvasBtn.addEventListener("click", () => this.setMode("canvas"));
    this.modeBtns = { grid: gridBtn, canvas: canvasBtn };

    // 画布选择器(画布模式可见):按钮 + Menu,与工具栏样式统一
    this.boardBtnEl = bar.createEl("button", {
      cls: "ghub-board-btn",
      attr: { "aria-label": t("switchBoard") },
    });
    this.boardBtnEl.addEventListener("click", (e) => {
      const menu = new Menu();
      const boards = this.store.getBoards();
      for (const [id, meta] of Object.entries(boards)) {
        menu.addItem((mi) =>
          mi
            .setTitle(meta.name)
            .setIcon(id === this.activeBoardId ? "check" : "frame")
            .onClick(() => this.openBoard(id))
        );
      }
      menu.addSeparator();
      menu.addItem((mi) =>
        mi.setTitle(t("newBoard")).setIcon("plus").onClick(() => {
          const id = this.store.createBoard(
            t("boardNumbered", { n: Object.keys(this.store.getBoards()).length + 1 })
          );
          if (id) this.openBoard(id);
        })
      );
      menu.addItem((mi) =>
        mi.setTitle(t("renameBoard")).setIcon("pencil").onClick(() => {
          this.renameActiveBoard();
        })
      );
      if (Object.keys(boards).length > 1) {
        menu.addItem((mi) =>
          mi.setTitle(t("deleteBoard")).setIcon("trash-2").onClick(() => {
            this.deleteActiveBoard();
          })
        );
      }
      menu.showAtMouseEvent(e as MouseEvent);
    });

    const search = bar.createEl("input", {
      cls: "ghub-search",
      attr: { type: "search", placeholder: t("searchPlaceholder") },
    });
    search.addEventListener("input", () => {
      this.filter.search = search.value.toLowerCase();
      this.renderGrid();
    });
    this.searchEl = search;

    this.countEl = bar.createDiv({ cls: "ghub-count" });

    // 排序方式(按钮 + Menu,与画布切换器统一样式)
    this.sortBtnEl = bar.createEl("button", {
      cls: "ghub-board-btn",
      attr: { "aria-label": t("sortBy") },
    });
    this.sortBtnEl.addEventListener("click", (e) => {
      const menu = new Menu();
      for (const [val, label] of sortOptions()) {
        menu.addItem((mi) =>
          mi
            .setTitle(label)
            .setIcon(this.sortMode === val ? "check" : "arrow-up-down")
            .onClick(() => {
              this.sortMode = val;
              this.refreshSortButton();
              this.renderGrid();
            })
        );
      }
      menu.showAtMouseEvent(e as MouseEvent);
    });
    this.refreshSortButton();

    bar.createDiv({ cls: "ghub-spacer" });

    const importBtn = bar.createEl("button", {
      text: t("importFiles"),
      attr: { "aria-label": t("importFilesAria") },
    });
    importBtn.addEventListener("click", () => this.pickFiles());

    const linkBtn = bar.createEl("button", {
      text: t("addLink"),
      attr: { "aria-label": t("addLinkAria") },
    });
    linkBtn.addEventListener("click", () => {
      new AddLinkModal(this.app, this.getTheme(), (url, title) => {
        if (this.importer.addLink(url, title)) new Notice(t("linkAdded"));
      }).open();
    });

    this.updateToolbarMode();
  }

  /** 刷新排序按钮内容(图标+当前排序名+chevron) */
  private refreshSortButton(): void {
    const btn = this.sortBtnEl;
    if (!btn) return;
    btn.empty();
    const ic = btn.createSpan({ cls: "ghub-board-btn-ic" });
    setIcon(ic, "arrow-up-down");
    const label =
      sortOptions().find(([v]) => v === this.sortMode)?.[1] ?? t("sortBy");
    btn.createSpan({ text: label, cls: "ghub-board-btn-t" });
    const chev = btn.createSpan({ cls: "ghub-board-btn-ic" });
    setIcon(chev, "chevron-down");
  }

  // ---------- 画布模式 ----------

  /** 侧边栏点击画布:切到画布模式并打开 */
  private openBoardFromSidebar(id: string): void {
    this.activeBoardId = id;
    if (this.mode !== "canvas") {
      this.setMode("canvas");
    } else {
      this.openBoard(id);
    }
    this.renderSidebar();
  }

  private setMode(mode: "grid" | "canvas"): void {
    if (this.mode === mode) return;
    this.mode = mode;
    // 先切换容器可见性(移除 display:none),再渲染 —— 否则网格在隐藏状态下
    // clientWidth=0,列数算成 1,图片先撑满整行再被 ResizeObserver 重排(闪烁)
    this.updateToolbarMode();
    if (mode === "canvas") {
      // 默认进入第一个画布
      if (!this.activeBoardId) {
        const ids = Object.keys(this.store.getBoards());
        this.activeBoardId = ids[0] ?? this.store.createBoard(t("defaultBoard"));
      }
      this.openBoard(this.activeBoardId!);
    } else {
      this.canvas?.destroy();
      this.canvas = null;
      this.renderGrid();
      this.renderSidebar(); // 清除侧边栏画布模块的选中态
    }
  }

  private updateToolbarMode(): void {
    const isCanvas = this.mode === "canvas";
    this.contentEl.toggleClass("ghub-mode-canvas", isCanvas);
    this.modeBtns?.grid.toggleClass("is-active", !isCanvas);
    this.modeBtns?.canvas.toggleClass("is-active", isCanvas);
    if (this.boardBtnEl)
      this.boardBtnEl.style.display = isCanvas ? "" : "none";
    if (this.searchEl) this.searchEl.style.display = isCanvas ? "none" : "";
    if (this.sortBtnEl) this.sortBtnEl.style.display = isCanvas ? "none" : "";
    this.refreshBoardSelect();
  }

  private refreshBoardSelect(): void {
    const btn = this.boardBtnEl;
    if (!btn) return;
    btn.empty();
    const ic = btn.createSpan({ cls: "ghub-board-btn-ic" });
    setIcon(ic, "frame");
    const name = this.activeBoardId
      ? this.store.getBoards()[this.activeBoardId]?.name ?? t("canvasMode")
      : t("canvasMode");
    btn.createSpan({ text: name, cls: "ghub-board-btn-t" });
    const chev = btn.createSpan({ cls: "ghub-board-btn-ic" });
    setIcon(chev, "chevron-down");
  }

  private openBoard(id: string): void {
    this.activeBoardId = id;
    this.canvas?.destroy();
    this.canvas = new CanvasBoard(
      this.app,
      this.store,
      id,
      this.canvasHostEl,
      () => this.getTheme(),
      this.importer,
      this.thumbs
    );
    this.refreshBoardSelect();
    this.renderSidebar(); // 更新侧边栏画布模块的选中态
    this.countEl.setText(
      t("itemsOnBoard", { n: this.store.itemsOnBoard(id).length })
    );
  }

  private renameActiveBoard(): void {
    if (!this.activeBoardId) return;
    const cur = this.store.getBoards()[this.activeBoardId];
    const name = window.prompt(t("boardNamePrompt"), cur?.name ?? "");
    if (name?.trim()) this.store.renameBoard(this.activeBoardId, name);
    this.refreshBoardSelect();
  }

  private deleteActiveBoard(): void {
    if (!this.activeBoardId) return;
    const boards = this.store.getBoards();
    const cur = boards[this.activeBoardId];
    new ConfirmDeleteModal(
      this.app,
      this.getTheme(),
      this.store.itemsOnBoard(this.activeBoardId).length,
      () => {
        const doomed = this.activeBoardId!;
        this.store.deleteBoard(doomed);
        const next = Object.keys(this.store.getBoards())[0];
        this.openBoard(next);
      },
      t("deleteBoardTitle", { name: cur?.name ?? "" }),
      t("deleteBoardDesc")
    ).open();
  }

  private pickFiles(): void {
    const input = createEl("input", {
      attr: { type: "file", multiple: "true", accept: "image/*,video/*,audio/*" },
    });
    input.addEventListener("change", () => {
      if (input.files?.length)
        void this.importer.importFiles(
          input.files,
          this.filter.folder ?? undefined
        );
    });
    input.click();
  }

  // ---------- 多选 ----------

  private clearSelection(): void {
    this.selected.clear();
    this.renderBatchBar();
    this.gridEl
      .querySelectorAll(".ghub-card.is-selected")
      .forEach((el) => el.removeClass("is-selected"));
  }

  private toggleSelect(it: GalleryItem, card: HTMLElement): void {
    if (this.selected.has(it.id)) {
      this.selected.delete(it.id);
      card.removeClass("is-selected");
    } else {
      this.selected.add(it.id);
      card.addClass("is-selected");
    }
    this.renderBatchBar();
  }

  private selectedItems(): GalleryItem[] {
    return [...this.selected]
      .map((id) => this.store.getItem(id))
      .filter((it): it is GalleryItem => !!it);
  }

  /** 批量操作栏:有选中时出现 */
  private renderBatchBar(): void {
    const bar = this.batchBarEl;
    bar.empty();
    const n = this.selected.size;
    bar.toggleClass("is-visible", n > 0);
    if (!n) return;

    bar.createSpan({ cls: "ghub-batch-count", text: t("selectedCount", { n }) });

    const selAll = bar.createEl("button", { text: t("selectAllCurrent") });
    selAll.addEventListener("click", () => {
      for (const it of this.filtered()) this.selected.add(it.id);
      this.renderGrid();
      this.renderBatchBar();
    });

    const move = bar.createEl("button", { text: t("moveTo") });
    move.addEventListener("click", () => {
      const items = this.selectedItems().filter((it) => it.path);
      if (!items.length) {
        new Notice(t("noMovableInSelection"));
        return;
      }
      void this.importer.listFolders().then((folders) => {
        new FolderPickModal(
          this.app,
          this.getTheme(),
          folders,
          t("moveNTo", { n: items.length }),
          (folder) => {
            void (async () => {
              if (!(await this.importer.createFolderIfMissing(folder))) return;
              await this.importer.moveItems(items, folder);
              await this.refreshFolders();
              this.clearSelection();
            })();
          }
        ).open();
      });
    });

    // 批量编辑(标签/星级)
    const edit = bar.createEl("button", { text: t("batchEdit") });
    edit.addEventListener("click", () => {
      const items = this.selectedItems();
      if (!items.length) return;
      new BatchEditModal(this.app, this.getTheme(), items, this.store).open();
    });

    // 发送到画布
    const toBoard = bar.createEl("button", { text: t("sendToBoard") });
    toBoard.addEventListener("click", (e) => {
      this.sendToBoard(this.selectedItems(), e as MouseEvent);
    });

    const del = bar.createEl("button", { text: t("deleteBtn"), cls: "ghub-danger" });
    del.addEventListener("click", () => {
      const items = this.selectedItems();
      new ConfirmDeleteModal(
        this.app,
        this.getTheme(),
        items.length,
        (alsoTrash) => {
          void this.importer.deleteItems(items, alsoTrash).then(() => {
            this.selected.clear();
            this.renderBatchBar();
          });
        }
      ).open();
    });

    bar.createDiv({ cls: "ghub-spacer" });

    const clear = bar.createEl("button", { text: t("clearSelection") });
    clear.addEventListener("click", () => this.clearSelection());
  }

  // ---------- 侧边栏 ----------

  private renderSidebar(): void {
    const side = this.sideEl;
    side.empty();
    const all = this.store.getItems();
    const cfg = this.getSettings();

    // 文件夹树(assets/ 目录树 ↔ Hub)
    if (cfg.showFolders) {
      const head = side.createDiv({ cls: "ghub-side-head" });
      head.createEl("h3", { text: t("folders") });
      const addBtn = head.createEl("button", {
        cls: "ghub-mini-btn",
        attr: { "aria-label": t("newFolderInRoot") },
      });
      setIcon(addBtn, "folder-plus");
      addBtn.addEventListener("click", () => void this.quickCreateFolder(""));

      // "全部" 根节点(也是"移到根"的拖放目标)
      const allRow = this.fitem(
        side,
        "layers",
        t("all"),
        all.length,
        this.filter.folder === null,
        () => {
          this.filter.folder = null;
          this.render();
        }
      );
      this.makeDropTarget(allRow, "");

      // 树渲染
      const tree = this.buildTree();
      const treeEl = side.createDiv({ cls: "ghub-tree" });
      for (const node of tree) this.renderTreeNode(treeEl, node, 0);
    }

    // 画布(在文件夹与类型之间)
    if (cfg.showBoards) {
      const bhead = side.createDiv({ cls: "ghub-side-head" });
      bhead.createEl("h3", { text: t("boards") });
      const baddBtn = bhead.createEl("button", {
        cls: "ghub-mini-btn",
        attr: { "aria-label": t("newBoard") },
      });
      setIcon(baddBtn, "plus");
      baddBtn.addEventListener("click", () => {
        const id = this.store.createBoard(
          t("boardNumbered", { n: Object.keys(this.store.getBoards()).length + 1 })
        );
        if (id) this.openBoardFromSidebar(id);
      });
      for (const [id, meta] of Object.entries(this.store.getBoards())) {
        this.fitem(
          side,
          "frame",
          meta.name,
          this.store.itemsOnBoard(id).length,
          this.mode === "canvas" && this.activeBoardId === id,
          () => this.openBoardFromSidebar(id)
        );
      }
    }

    // 类型
    if (cfg.showTypes) {
      side.createEl("h3", { text: t("types") });
      const typeDefs: Array<[ItemType | "all", string, string, number]> = [
        ["all", "layers", t("allAssets"), all.length],
        ["image", "image", t("image"), all.filter((i) => i.type === "image").length],
        ["video", "film", t("video"), all.filter((i) => i.type === "video").length],
        ["audio", "music", t("audio"), all.filter((i) => i.type === "audio").length],
        ["link", "link", t("link"), all.filter((i) => i.type === "link").length],
      ];
      for (const [val, icon, label, n] of typeDefs) {
        this.fitem(side, icon, label, n, this.filter.type === val, () => {
          this.filter.type = val;
          this.render();
        });
      }
    }

    // 评分(多选:点亮任意组合,全部=清空)
    if (cfg.showRatings) {
      side.createEl("h3", { text: t("ratings") });
      this.fitem(
        side,
        null,
        t("allRatings"),
        all.length,
        this.filter.ratings.size === 0,
        () => {
          this.filter.ratings.clear();
          this.render();
        }
      );
      for (let star = 5; star >= 1; star--) {
        const n = all.filter((i) => i.rating === star).length;
        this.fitem(
          side,
          null,
          "★".repeat(star),
          n,
          this.filter.ratings.has(star),
          () => {
            if (this.filter.ratings.has(star)) this.filter.ratings.delete(star);
            else this.filter.ratings.add(star);
            this.render();
          }
        );
      }
    }

    // 标签云
    if (cfg.showTags) {
      side.createEl("h3", { text: t("tags") });
      const counts = new Map<string, number>();
      for (const it of all)
        for (const t of it.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      if (!counts.size) {
        side.createDiv({ cls: "ghub-side-empty", text: t("noTags") });
        return;
      }
      const cloud = side.createDiv({ cls: "ghub-tagcloud" });
      const sorted = [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh")
      );
      for (const [tag, n] of sorted) {
        const chip = cloud.createEl("span", {
          cls: "ghub-tag" + (this.filter.tags.has(tag) ? " is-active" : ""),
        });
        chip.createSpan({ text: `${tag} ${n}` });
        // 悬停显示的删除钮:从所有卡片移除该标签
        const x = chip.createSpan({
          cls: "ghub-tag-x",
          attr: { "aria-label": t("deleteTagAria", { tag }) },
        });
        setIcon(x, "x");
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          new ConfirmDeleteModal(
            this.app,
            this.getTheme(),
            n,
            () => {
              const changed = this.store.removeTagEverywhere(tag);
              this.filter.tags.delete(tag);
              new Notice(t("tagRemovedN", { tag, n: changed }));
            },
            t("deleteTagTitle", { tag }),
            t("deleteTagDesc", { n })
          ).open();
        });
        chip.addEventListener("click", () => {
          if (this.filter.tags.has(tag)) this.filter.tags.delete(tag);
          else this.filter.tags.add(tag);
          this.render();
        });
      }
      if (this.filter.tags.size) {
        const clear = cloud.createEl("span", {
          text: t("clearTags"),
          cls: "ghub-tag",
        });
        clear.addEventListener("click", () => {
          this.filter.tags.clear();
          this.render();
        });
      }
    }
  }

  /** 设置变化后由插件调用:重渲染侧边栏(隐藏模块对应的筛选同时复位);数据根变更时同步刷新文件树与网格 */
  refreshSidebar(): void {
    const cfg = this.getSettings();
    let gridDirty = false;
    if (!cfg.showFolders && this.filter.folder !== null) {
      this.filter.folder = null;
      gridDirty = true;
    }
    if (!cfg.showTypes && this.filter.type !== "all") {
      this.filter.type = "all";
      gridDirty = true;
    }
    if (!cfg.showRatings && this.filter.ratings.size) {
      this.filter.ratings.clear();
      gridDirty = true;
    }
    if (!cfg.showTags && this.filter.tags.size) {
      this.filter.tags.clear();
      gridDirty = true;
    }
    void gridDirty;
    // 数据根可能已变更:文件树与网格一并刷新
    void this.refreshFolders();
    this.renderGrid();
  }

  private fitem(
    parent: HTMLElement,
    icon: string | null,
    label: string,
    count: number,
    active: boolean,
    onClick: () => void
  ): HTMLElement {
    const el = parent.createDiv({
      cls: "ghub-fitem" + (active ? " is-active" : ""),
      attr: { role: "button", tabindex: "0", "aria-pressed": String(active) },
    });
    const left = el.createSpan({ cls: "ghub-fitem-label" });
    if (icon) {
      const ic = left.createSpan({ cls: "ghub-ficon" });
      setIcon(ic, icon);
    }
    left.createSpan({ text: label });
    el.createSpan({ cls: "ghub-n", text: String(count) });
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    });
    return el;
  }

  // ---------- 文件树 ----------

  /** folders(相对路径列表)→ 嵌套树 */
  private buildTree(): TreeNode[] {
    const roots: TreeNode[] = [];
    const map = new Map<string, TreeNode>();
    for (const rel of this.folders) {
      const name = rel.split("/").pop()!;
      const node: TreeNode = { name, rel, children: [] };
      map.set(rel, node);
      const parent = rel.includes("/")
        ? map.get(rel.slice(0, rel.lastIndexOf("/")))
        : null;
      if (parent) parent.children.push(node);
      else if (!rel.includes("/")) roots.push(node);
    }
    return roots;
  }

  /** 该文件夹(含子树)内的资产数 */
  private countInFolder(rel: string): number {
    return this.store.getItems().filter((it) => {
      const f = this.importer.folderOf(it);
      return f !== null && (f === rel || f.startsWith(`${rel}/`));
    }).length;
  }

  private renderTreeNode(
    parent: HTMLElement,
    node: TreeNode,
    depth: number
  ): void {
    const hasChildren = node.children.length > 0;
    const isExpanded = this.expanded.has(node.rel);
    const active = this.filter.folder === node.rel;

    const row = parent.createDiv({
      cls: "ghub-fitem ghub-tree-row" + (active ? " is-active" : ""),
      attr: { role: "button", tabindex: "0", "aria-pressed": String(active) },
    });
    row.style.paddingLeft = `${9 + depth * 14}px`;

    // 展开箭头
    const arrow = row.createSpan({ cls: "ghub-tree-arrow" });
    if (hasChildren) {
      setIcon(arrow, isExpanded ? "chevron-down" : "chevron-right");
      arrow.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isExpanded) this.expanded.delete(node.rel);
        else this.expanded.add(node.rel);
        this.renderSidebar();
      });
    }

    const left = row.createSpan({ cls: "ghub-fitem-label" });
    const ic = left.createSpan({ cls: "ghub-ficon" });
    setIcon(ic, isExpanded && hasChildren ? "folder-open" : "folder");

    // 内联重命名
    if (this.renaming === node.rel) {
      const input = left.createEl("input", {
        cls: "ghub-rename-input",
        attr: { type: "text" },
      });
      input.value = node.name;
      input.addEventListener("click", (e) => e.stopPropagation());
      const commit = async () => {
        this.renaming = null;
        const name = input.value.trim();
        if (!name || name === node.name) {
          this.renderSidebar();
          return;
        }
        const newRel = await this.importer.renameFolder(node.rel, name);
        if (newRel) this.remapAfterFolderChange(node.rel, newRel);
        await this.refreshFolders();
        this.renderGrid();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void commit();
        if (e.key === "Escape") {
          this.renaming = null;
          this.renderSidebar();
        }
      });
      input.addEventListener("blur", () => void commit());
      window.setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    } else {
      left.createSpan({ text: node.name });
    }

    row.createSpan({
      cls: "ghub-n",
      text: String(this.countInFolder(node.rel)),
    });

    // 点击筛选
    row.addEventListener("click", () => {
      if (this.renaming) return;
      this.filter.folder = active ? null : node.rel;
      this.render();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.filter.folder = active ? null : node.rel;
        this.render();
      }
      if (e.key === "F2") {
        this.renaming = node.rel;
        this.renderSidebar();
      }
    });

    // 右键菜单
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((mi) =>
        mi
          .setTitle(t("newSubfolder"))
          .setIcon("folder-plus")
          .onClick(() => void this.quickCreateFolder(node.rel))
      );
      menu.addItem((mi) =>
        mi
          .setTitle(t("rename"))
          .setIcon("pencil")
          .onClick(() => {
            this.renaming = node.rel;
            this.renderSidebar();
          })
      );
      menu.addSeparator();
      menu.addItem((mi) =>
        mi
          .setTitle(t("deleteFolderMenu"))
          .setIcon("trash-2")
          .onClick(() => {
            const n = this.countInFolder(node.rel);
            new ConfirmDeleteModal(
              this.app,
              this.getTheme(),
              n,
              () => {
                void this.importer.deleteFolder(node.rel).then((deleted) => {
                  if (deleted === null) return;
                  if (
                    this.filter.folder === node.rel ||
                    this.filter.folder?.startsWith(`${node.rel}/`)
                  )
                    this.filter.folder = null;
                  void this.refreshFolders().then(() => this.renderGrid());
                });
              },
              t("deleteFolderTitle", { name: node.name }),
              t("deleteFolderDesc", { n })
            ).open();
          })
      );
      menu.showAtMouseEvent(e);
    });

    // 拖拽:文件夹自身可拖;也可作为放置目标(接受文件夹/卡片/系统文件)
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("application/ghub-folder", node.rel);
      e.stopPropagation();
    });
    this.makeDropTarget(row, node.rel);

    if (hasChildren && isExpanded) {
      for (const child of node.children)
        this.renderTreeNode(parent, child, depth + 1);
    }
  }

  /** 同级快速新建:直接创建"新建文件夹 N"并进入内联重命名 */
  private async quickCreateFolder(parent: string): Promise<void> {
    const rel = await this.importer.createFolderIn(parent);
    if (!rel) return;
    if (parent) this.expanded.add(parent);
    this.renaming = rel;
    await this.refreshFolders();
  }

  /** 文件夹改名/移动后同步筛选状态与展开状态 */
  private remapAfterFolderChange(oldRel: string, newRel: string): void {
    const remap = (v: string) =>
      v === oldRel
        ? newRel
        : v.startsWith(`${oldRel}/`)
          ? `${newRel}${v.slice(oldRel.length)}`
          : v;
    if (this.filter.folder) this.filter.folder = remap(this.filter.folder);
    this.expanded = new Set([...this.expanded].map(remap));
  }

  /** 使元素成为放置目标:接受文件夹移动、卡片移动、系统文件导入 */
  private makeDropTarget(el: HTMLElement, rel: string): void {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.addClass("ghub-drop-hover");
    });
    el.addEventListener("dragleave", () => el.removeClass("ghub-drop-hover"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.removeClass("ghub-drop-hover");
      const dt = e.dataTransfer;
      if (!dt) return;

      const folderRel = dt.getData("application/ghub-folder");
      if (folderRel) {
        if (folderRel === rel) return;
        void this.importer.moveFolder(folderRel, rel).then((newRel) => {
          if (newRel) this.remapAfterFolderChange(folderRel, newRel);
          void this.refreshFolders().then(() => this.renderGrid());
        });
        return;
      }

      const itemIds = dt.getData("application/ghub-items");
      if (itemIds) {
        const items = itemIds
          .split(",")
          .map((id) => this.store.getItem(id))
          .filter((it): it is GalleryItem => !!it && !!it.path);
        if (items.length)
          void this.importer.moveItems(items, rel).then(() => {
            this.clearSelection();
            this.renderSidebar();
          });
        return;
      }

      if (dt.files?.length) {
        void this.importer.importFiles(dt.files, rel || undefined);
      }
    });
  }

  // ---------- 渲染 ----------

  private async refreshFolders(): Promise<void> {
    this.folders = await this.importer.listFolders();
    this.renderSidebar();
  }

  private render(): void {
    this.renderSidebar();
    this.renderGrid();
  }

  private filtered(): GalleryItem[] {
    const f = this.filter;
    return this.store.getItems().filter((it) => {
      if (f.folder !== null) {
        const fo = this.importer.folderOf(it);
        // 选中文件夹时包含其整棵子树
        if (fo === null || (fo !== f.folder && !fo.startsWith(`${f.folder}/`)))
          return false;
      }
      if (f.type !== "all" && it.type !== f.type) return false;
      if (f.ratings.size && !f.ratings.has(it.rating)) return false;
      if (f.tags.size && ![...f.tags].every((t) => it.tags.includes(t)))
        return false;
      if (f.search) {
        const hay = `${it.title}\n${it.gen.prompt}\n${it.note}\n${
          it.fileName ?? ""
        }`.toLowerCase();
        if (!hay.includes(f.search)) return false;
      }
      return true;
    });
  }

  /** 目标列宽 220px,按容器实际宽度算列数;容器隐藏/未布局时返回 0 表示暂不可排 */
  private computeColCount(): number {
    const w = this.gridEl.clientWidth;
    if (!w) return 0;
    return Math.max(1, Math.min(8, Math.floor(w / 230)));
  }

  private renderGrid(): void {
    if (this.mode === "canvas") {
      if (this.activeBoardId)
        this.countEl.setText(
          t("itemsOnBoard", { n: this.store.itemsOnBoard(this.activeBoardId).length })
        );
      return;
    }
    const items = this.filtered();
    this.countEl.setText(
      t("itemCount", { shown: items.length, total: this.store.getItems().length }) +
        (this.store.readOnly ? t("readOnlySuffix") : "")
    );
    this.gridEl.empty();

    if (!items.length) {
      const empty = this.gridEl.createDiv({ cls: "ghub-empty" });
      if (this.store.getItems().length === 0) {
        const ic = empty.createDiv({ cls: "ghub-empty-icon" });
        setIcon(ic, "image-plus");
        empty.createDiv({ text: t("emptyLibrary") });
        empty.createDiv({
          cls: "ghub-empty-hint",
          text: t("emptyLibraryHint"),
        });
        const btn = empty.createEl("button", {
          text: t("importFirstBatch"),
          cls: "mod-cta",
        });
        btn.addEventListener("click", () => this.pickFiles());
      } else {
        empty.createDiv({ text: t("noFilterResults") });
        const btn = empty.createEl("button", { text: t("clearAllFilters") });
        btn.addEventListener("click", () => {
          this.filter = {
            search: "",
            type: "all",
            tags: new Set(),
            ratings: new Set(),
            folder: null,
          };
          this.render();
        });
      }
      return;
    }

    // JS 瀑布流:按 sortMode 排序后,从左到右放入"当前最矮的列"
    // (CSS columns 是竖排+滚动重排,顺序和稳定性都不对,弃用)
    const sorted = this.sortItems(items);
    this.colCount = this.computeColCount();
    if (!this.colCount) {
      // 容器尚无宽度(隐藏或未完成布局):等下一帧再排,避免按错误列数闪烁
      window.requestAnimationFrame(() => {
        if (this.mode === "grid") this.renderGrid();
      });
      return;
    }
    const cols: HTMLElement[] = [];
    const heights: number[] = [];
    for (let i = 0; i < this.colCount; i++) {
      cols.push(this.gridEl.createDiv({ cls: "ghub-col" }));
      heights.push(0);
    }
    for (const it of sorted) {
      let target = 0;
      for (let i = 1; i < heights.length; i++) {
        if (heights[i] < heights[target]) target = i;
      }
      cols[target].appendChild(this.card(it));
      // 估算卡片高度占比:图片按宽高比;音频/链接为紧凑固定高;视频兜底 4:3
      const ratio =
        it.w && it.h
          ? it.h / it.w
          : it.type === "audio"
            ? 0.52
            : it.type === "link"
              ? 0.32
              : 0.75;
      heights[target] += ratio + 0.06; // 0.06 ≈ 卡片间距占比
    }
  }

  private sortItems(items: GalleryItem[]): GalleryItem[] {
    const arr = [...items];
    switch (this.sortMode) {
      case "created-asc":
        return arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      case "title-asc":
        return arr.sort(
          (a, b) =>
            a.title.localeCompare(b.title, "zh") ||
            b.createdAt.localeCompare(a.createdAt)
        );
      case "rating-desc":
        return arr.sort(
          (a, b) =>
            b.rating - a.rating || b.createdAt.localeCompare(a.createdAt)
        );
      case "type": {
        const order = { image: 0, video: 1, audio: 2, link: 3 };
        return arr.sort(
          (a, b) =>
            order[a.type] - order[b.type] ||
            b.createdAt.localeCompare(a.createdAt)
        );
      }
      case "created-desc":
      default:
        return arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
  }

  private card(it: GalleryItem): HTMLElement {
    const card = createDiv({ cls: "ghub-card", attr: { tabindex: "0" } });
    if (this.selected.has(it.id)) card.addClass("is-selected");

    // 卡片可拖到侧边栏文件夹(拖已选中的=整批移动)
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      const ids = this.selected.has(it.id)
        ? [...this.selected]
        : [it.id];
      e.dataTransfer?.setData("application/ghub-items", ids.join(","));
    });

    const thumb = card.createDiv({ cls: "ghub-thumb" });
    // CLS 防护:已知尺寸时用 aspect-ratio 预留空间
    if (it.w && it.h) {
      thumb.style.aspectRatio = `${it.w} / ${it.h}`;
    }
    if (it.type === "image" && it.path) {
      const img = thumb.createEl("img", {
        attr: { loading: "lazy", alt: it.title || it.fileName || t("image") },
      });
      if (it.w && it.h) {
        img.width = it.w;
        img.height = it.h;
      }
      // 缩略图优先:有缓存直接用;没有则先显示原图并后台生成,
      // 生成完成后原位替换(下次打开即秒开)
      if (this.thumbs.has(it.id)) {
        img.dataset.src = this.app.vault.adapter.getResourcePath(
          this.thumbs.path(it.id)
        );
      } else {
        img.dataset.src = this.app.vault.adapter.getResourcePath(it.path);
        this.thumbs.ensure(it, (thumbPath) => {
          if (img.isConnected)
            img.src = this.app.vault.adapter.getResourcePath(thumbPath);
        });
      }
      this.observer?.observe(img);
    } else if (it.type === "video" && it.path) {
      const video = thumb.createEl("video", {
        attr: { loop: "true", playsinline: "true" },
      });
      // muted 必须设 IDL 属性:setAttribute 不影响已创建元素,悬停自动播放会被拒绝
      video.muted = true;
      video.dataset.src = this.app.vault.adapter.getResourcePath(it.path);
      this.observer?.observe(video);
      card.addEventListener(
        "mouseenter",
        () => void video.play().catch(() => {})
      );
      card.addEventListener("mouseleave", () => video.pause());
    } else if (it.type === "audio" && it.path) {
      const box = thumb.createDiv({ cls: "ghub-audiobox" });
      const head = box.createDiv({ cls: "ghub-audiobox-head" });
      const ic = head.createDiv({ cls: "ghub-audiobox-icon" });
      setIcon(ic, "music");
      const tw = head.createDiv({ cls: "ghub-audiobox-titles" });
      tw.createDiv({ cls: "ghub-audiobox-title", text: it.title || t("noTitle") });
      if (it.fileName && it.fileName !== it.title)
        tw.createDiv({ cls: "ghub-linkbox-domain", text: it.fileName });
      const audio = box.createEl("audio", {
        cls: "ghub-audio-player",
        attr: { controls: "true", preload: "none" },
      });
      audio.src = this.app.vault.adapter.getResourcePath(it.path);
      // 播放器交互不触发卡片打开/选择
      audio.addEventListener("click", (e) => e.stopPropagation());
      audio.addEventListener("pointerdown", (e) => e.stopPropagation());
    } else if (it.type === "link") {
      const box = thumb.createDiv({ cls: "ghub-linkbox" });
      const ic = box.createDiv({ cls: "ghub-linkbox-icon" });
      setIcon(ic, "link");
      const tw = box.createDiv({ cls: "ghub-audiobox-titles" });
      tw.createDiv({ cls: "ghub-audiobox-title", text: it.title || t("noTitle") });
      try {
        tw.createDiv({
          cls: "ghub-linkbox-domain",
          text: new URL(it.url ?? "").hostname,
        });
      } catch {
        /* ignore */
      }
    }

    // 覆盖层:悬停浮现元数据(音频/链接卡片信息已外显,不加遮挡)
    if (it.type !== "audio" && it.type !== "link") {
      const veil = card.createDiv({ cls: "ghub-veil" });
      const top = veil.createDiv({ cls: "ghub-veil-top" });
      if (it.gen.prompt) top.createSpan({ cls: "ghub-chip-p", text: "PROMPT" });
      if (it.type === "video") top.createSpan({ cls: "ghub-chip-v", text: "▶ VIDEO" });
      const bottom = veil.createDiv({ cls: "ghub-veil-bottom" });
      bottom.createDiv({ cls: "ghub-vtitle", text: it.title || t("noTitle") });
      const meta = bottom.createDiv({ cls: "ghub-veil-meta" });
      if (it.rating > 0)
        meta.createSpan({ text: "★".repeat(it.rating), cls: "ghub-stars" });
      if (it.gen.model) meta.createSpan({ text: it.gen.model });
      if (it.tags.length) meta.createSpan({ text: it.tags.slice(0, 2).join(" · ") });
    }

    // 选择圆钮:悬停或已选中时可见;点击只切换选择,不打开详情
    const check = card.createDiv({
      cls: "ghub-check",
      attr: { role: "checkbox", "aria-label": t("selectAria"), tabindex: "-1" },
    });
    setIcon(check, "check");
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleSelect(it, card);
    });

    const open = (e: MouseEvent | KeyboardEvent) => {
      // 多选模式/Ctrl/Meta 点击 → 切换选择
      if (
        ("ctrlKey" in e && (e.ctrlKey || e.metaKey)) ||
        this.selected.size > 0
      ) {
        if (it.type === "link" && this.selected.size === 0 && it.url) {
          // 无选择时 Ctrl+点击链接保留"直接打开"行为
          window.open(it.url);
          return;
        }
        this.toggleSelect(it, card);
        return;
      }
      this.openDetail(it);
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter") open(e);
      if (e.key === " ") {
        e.preventDefault();
        this.toggleSelect(it, card);
      }
    });

    // 右键菜单(多选时作用于选中集)
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const targets = this.selected.has(it.id)
        ? this.selectedItems()
        : [it];
      const many = targets.length > 1;
      const label = many ? t("nItems", { n: targets.length }) : "";
      const menu = new Menu();
      if (!many) {
        menu.addItem((mi) =>
          mi.setTitle(t("editDetail")).setIcon("pencil").onClick(() => this.openDetail(it))
        );
      } else {
        menu.addItem((mi) =>
          mi.setTitle(t("batchEditN", { label })).setIcon("pencil").onClick(() => {
            new BatchEditModal(this.app, this.getTheme(), targets, this.store).open();
          })
        );
      }
      menu.addItem((mi) =>
        mi.setTitle(t("sendToBoardN", { label: label ? ` (${label})` : "" })).setIcon("frame").onClick(() => {
          this.sendToBoard(targets);
        })
      );
      const movable = targets.filter((t) => t.path);
      if (movable.length) {
        menu.addItem((mi) =>
          mi.setTitle(t("moveToN", { label: label ? ` (${label})` : "" })).setIcon("folder-input").onClick(() => {
            void this.moveItemsViaPicker(movable);
          })
        );
      }
      if (!many && (it.path || it.originPath)) {
        menu.addItem((mi) =>
          mi.setTitle(t("openOrigin")).setIcon("folder-open").onClick(() => {
            this.revealOrigin(it);
          })
        );
      }
      menu.addSeparator();
      menu.addItem((mi) =>
        mi.setTitle(t("removeFromLibraryN", { label: label ? ` (${label})` : "" })).setIcon("x").onClick(() => {
          void this.importer.deleteItems(targets, false).then(() => this.clearSelection());
        })
      );
      menu.addItem((mi) =>
        mi.setTitle(t("deleteFilesN", { label: label ? ` (${label})` : "" })).setIcon("trash-2").onClick(() => {
          this.deleteWithConfirm(targets);
        })
      );
      menu.showAtMouseEvent(e);
    });

    return card;
  }

  /** 打开源文件位置:自定义 originPath 优先(URL 开浏览器/路径开资源管理器),否则揭示库内文件 */
  private revealOrigin(it: GalleryItem): void {
    const origin = it.originPath?.trim();
    if (origin) {
      if (/^https?:\/\//i.test(origin)) {
        window.open(origin);
        return;
      }
      // 系统绝对路径:在资源管理器中显示
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { shell } = require("electron");
        void shell.showItemInFolder(origin);
      } catch {
        new Notice(t("cannotOpenPath"));
      }
      return;
    }
    if (it.path) {
      // 库内文件:换算绝对路径后在资源管理器中显示
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { shell } = require("electron");
        const adapter = this.app.vault.adapter as { getFullPath?: (p: string) => string };
        const full = adapter.getFullPath?.(it.path);
        if (full) void shell.showItemInFolder(full);
        else new Notice(t("cannotLocateFile"));
      } catch {
        new Notice(t("cannotOpenLocation"));
      }
    }
  }

  private openDetail(it: GalleryItem): void {
    new DetailModal(
      this.app,
      this.store,
      it,
      this.getTheme(),
      undefined,
      this.sortItems(this.filtered())
    ).open();
  }

  /** 发送到画布:多画布时弹选择菜单,明确目标 */
  private sendToBoard(items: GalleryItem[], evt?: MouseEvent): void {
    if (!items.length) return;
    const boards = Object.entries(this.store.getBoards());
    // 单画布(或无画布)直接发,不打扰
    if (boards.length <= 1) {
      const boardId = boards[0]?.[0] ?? this.store.createBoard(t("defaultBoard"));
      if (boardId) this.doSendToBoard(items, boardId);
      return;
    }
    const menu = new Menu();
    for (const [id, meta] of boards) {
      menu.addItem((mi) =>
        mi
          .setTitle(meta.name + (id === this.activeBoardId ? t("currentSuffix") : ""))
          .setIcon("frame")
          .onClick(() => this.doSendToBoard(items, id))
      );
    }
    menu.addSeparator();
    menu.addItem((mi) =>
      mi.setTitle(t("newBoardAndSend")).setIcon("plus").onClick(() => {
        const id = this.store.createBoard(t("boardNumbered", { n: boards.length + 1 }));
        if (id) this.doSendToBoard(items, id);
      })
    );
    if (evt) menu.showAtMouseEvent(evt);
    else menu.showAtPosition({ x: window.innerWidth / 2, y: 120 });
  }

  private doSendToBoard(items: GalleryItem[], boardId: string): void {
    this.activeBoardId = boardId;
    if (this.mode !== "canvas") this.setMode("canvas");
    else this.openBoard(boardId);
    const added = this.canvas?.addItems(items) ?? 0;
    new Notice(
      added
        ? t("sentToBoard", { n: added, board: this.store.getBoards()[boardId]?.name ?? "" })
        : t("alreadyOnBoard")
    );
    this.clearSelection();
  }

  /** 移动到…(文件夹选择弹窗) */
  private async moveItemsViaPicker(items: GalleryItem[]): Promise<void> {
    const folders = await this.importer.listFolders();
    new FolderPickModal(
      this.app,
      this.getTheme(),
      folders,
      t("moveNTo", { n: items.length }),
      (folder) => {
        void (async () => {
          if (!(await this.importer.createFolderIfMissing(folder))) return;
          await this.importer.moveItems(items, folder);
          await this.refreshFolders();
          this.clearSelection();
        })();
      }
    ).open();
  }

  /** 物理删除:带"不再提醒"的二次确认 */
  private deleteWithConfirm(items: GalleryItem[]): void {
    const doDelete = () => {
      void this.importer.deleteItems(items, true).then(() => {
        this.selected.clear();
        this.renderBatchBar();
      });
    };
    if (this.getSettings().skipDeleteConfirm) {
      doDelete();
      return;
    }
    new ConfirmTrashModal(
      this.app,
      this.getTheme(),
      items.length,
      (skipNextTime) => {
        if (skipNextTime) {
          this.getSettings().skipDeleteConfirm = true;
          this.onSettingsChanged?.();
        }
        doDelete();
      }
    ).open();
  }
}
