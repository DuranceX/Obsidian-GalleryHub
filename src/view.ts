import { ItemView, WorkspaceLeaf, Notice, setIcon } from "obsidian";
import { GalleryStore } from "./store";
import { Importer } from "./importer";
import { GalleryItem, ItemType } from "./types";
import {
  DetailModal,
  AddLinkModal,
  FolderPickModal,
  ConfirmDeleteModal,
} from "./detail";

export const VIEW_TYPE_GALLERY = "gallery-hub-view";

type RatingFilter = "all" | "unrated" | 4 | 5;

interface FilterState {
  search: string;
  type: ItemType | "all";
  tags: Set<string>;
  rating: RatingFilter;
  /** null = 全部;"" 不用;文件夹名 = assets/<name>/ 下的资产 */
  folder: string | null;
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
    rating: "all",
    folder: null,
  };
  private sideEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private countEl!: HTMLElement;
  private batchBarEl!: HTMLElement;
  private observer: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private colCount = 0;
  private resizeTimer: number | null = null;
  /** 多选:选中的条目 id */
  private selected = new Set<string>();
  /** assets/ 子文件夹缓存(侧边栏渲染用) */
  private folders: string[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    store: GalleryStore,
    importer: Importer,
    getTheme: () => string
  ) {
    super(leaf);
    this.store = store;
    this.importer = importer;
    this.getTheme = getTheme;
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
    return "layout-grid";
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
    this.gridEl = main.createDiv({ cls: "ghub-grid" });

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
  }

  // ---------- 顶栏 ----------

  private buildToolbar(main: HTMLElement): void {
    const bar = main.createDiv({ cls: "ghub-toolbar" });

    const search = bar.createEl("input", {
      cls: "ghub-search",
      attr: { type: "search", placeholder: "搜索标题 / prompt / 备注…" },
    });
    search.addEventListener("input", () => {
      this.filter.search = search.value.toLowerCase();
      this.renderGrid();
    });

    this.countEl = bar.createDiv({ cls: "ghub-count" });

    bar.createDiv({ cls: "ghub-spacer" });

    const importBtn = bar.createEl("button", {
      text: "＋ 导入文件",
      attr: { "aria-label": "从系统选择图片或视频导入" },
    });
    importBtn.addEventListener("click", () => this.pickFiles());

    const linkBtn = bar.createEl("button", {
      text: "＋ 链接",
      attr: { "aria-label": "添加外部链接" },
    });
    linkBtn.addEventListener("click", () => {
      new AddLinkModal(this.app, this.getTheme(), (url, title) => {
        if (this.importer.addLink(url, title)) new Notice("链接已添加");
      }).open();
    });
  }

  private pickFiles(): void {
    const input = createEl("input", {
      attr: { type: "file", multiple: "true", accept: "image/*,video/*" },
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

    bar.createSpan({ cls: "ghub-batch-count", text: `已选 ${n} 项` });

    const selAll = bar.createEl("button", { text: "全选当前" });
    selAll.addEventListener("click", () => {
      for (const it of this.filtered()) this.selected.add(it.id);
      this.renderGrid();
      this.renderBatchBar();
    });

    const move = bar.createEl("button", { text: "移动到…" });
    move.addEventListener("click", () => {
      const items = this.selectedItems().filter((it) => it.path);
      if (!items.length) {
        new Notice("选中项中没有可移动的文件(链接不占文件)");
        return;
      }
      void this.importer.listFolders().then((folders) => {
        new FolderPickModal(
          this.app,
          this.getTheme(),
          folders,
          `移动 ${items.length} 个资产到…`,
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

    const del = bar.createEl("button", { text: "删除…", cls: "ghub-danger" });
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

    const clear = bar.createEl("button", { text: "取消选择 (Esc)" });
    clear.addEventListener("click", () => this.clearSelection());
  }

  // ---------- 侧边栏 ----------

  private renderSidebar(): void {
    const side = this.sideEl;
    side.empty();
    const all = this.store.getItems();

    // 文件夹(assets/ 子目录 ↔ Hub)
    const head = side.createDiv({ cls: "ghub-side-head" });
    head.createEl("h3", { text: "文件夹" });
    const addBtn = head.createEl("button", {
      cls: "ghub-mini-btn",
      attr: { "aria-label": "新建文件夹" },
    });
    setIcon(addBtn, "folder-plus");
    addBtn.addEventListener("click", () => {
      new FolderPickModal(
        this.app,
        this.getTheme(),
        [],
        "新建文件夹",
        (name) => {
          void this.importer.createFolder(name).then((ok) => {
            if (ok) void this.refreshFolders();
          });
        }
      ).open();
    });

    this.fitem(side, "layers", "全部", all.length, this.filter.folder === null, () => {
      this.filter.folder = null;
      this.render();
    });
    for (const f of this.folders) {
      const n = all.filter((it) => this.importer.folderOf(it) === f).length;
      this.fitem(side, "folder", f, n, this.filter.folder === f, () => {
        this.filter.folder = this.filter.folder === f ? null : f;
        this.render();
      });
    }

    // 类型
    side.createEl("h3", { text: "类型" });
    const typeDefs: Array<[ItemType | "all", string, string, number]> = [
      ["all", "layers", "全部资产", all.length],
      ["image", "image", "图片", all.filter((i) => i.type === "image").length],
      ["video", "film", "视频", all.filter((i) => i.type === "video").length],
      ["link", "link", "链接", all.filter((i) => i.type === "link").length],
    ];
    for (const [val, icon, label, n] of typeDefs) {
      this.fitem(side, icon, label, n, this.filter.type === val, () => {
        this.filter.type = val;
        this.render();
      });
    }

    // 评分
    side.createEl("h3", { text: "评分" });
    const rateDefs: Array<[RatingFilter, string, number]> = [
      ["all", "全部评分", all.length],
      [5, "★★★★★", all.filter((i) => i.rating === 5).length],
      [4, "★★★★ 以上", all.filter((i) => i.rating >= 4).length],
      ["unrated", "未评分", all.filter((i) => i.rating === 0).length],
    ];
    for (const [val, label, n] of rateDefs) {
      this.fitem(side, null, label, n, this.filter.rating === val, () => {
        this.filter.rating = val;
        this.render();
      });
    }

    // 标签云
    side.createEl("h3", { text: "标签" });
    const counts = new Map<string, number>();
    for (const it of all)
      for (const t of it.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    if (!counts.size) {
      side.createDiv({ cls: "ghub-side-empty", text: "暂无标签" });
      return;
    }
    const cloud = side.createDiv({ cls: "ghub-tagcloud" });
    const sorted = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh")
    );
    for (const [tag, n] of sorted) {
      const chip = cloud.createEl("span", {
        text: `${tag} ${n}`,
        cls: "ghub-tag" + (this.filter.tags.has(tag) ? " is-active" : ""),
      });
      chip.addEventListener("click", () => {
        if (this.filter.tags.has(tag)) this.filter.tags.delete(tag);
        else this.filter.tags.add(tag);
        this.render();
      });
    }
    if (this.filter.tags.size) {
      const clear = cloud.createEl("span", {
        text: "✕ 清除",
        cls: "ghub-tag",
      });
      clear.addEventListener("click", () => {
        this.filter.tags.clear();
        this.render();
      });
    }
  }

  private fitem(
    parent: HTMLElement,
    icon: string | null,
    label: string,
    count: number,
    active: boolean,
    onClick: () => void
  ): void {
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
      if (f.folder !== null && this.importer.folderOf(it) !== f.folder)
        return false;
      if (f.type !== "all" && it.type !== f.type) return false;
      if (f.rating === "unrated") {
        if (it.rating !== 0) return false;
      } else if (f.rating === 5) {
        if (it.rating !== 5) return false;
      } else if (f.rating === 4) {
        if (it.rating < 4) return false;
      }
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

  /** 目标列宽 220px,按容器实际宽度算列数 */
  private computeColCount(): number {
    const w = this.gridEl.clientWidth || 800;
    return Math.max(1, Math.min(8, Math.floor(w / 230)));
  }

  private renderGrid(): void {
    const items = this.filtered();
    this.countEl.setText(
      `${items.length} / ${this.store.getItems().length} 项` +
        (this.store.readOnly ? " · 只读模式" : "")
    );
    this.gridEl.empty();

    if (!items.length) {
      const empty = this.gridEl.createDiv({ cls: "ghub-empty" });
      if (this.store.getItems().length === 0) {
        const ic = empty.createDiv({ cls: "ghub-empty-icon" });
        setIcon(ic, "image-plus");
        empty.createDiv({ text: "库是空的" });
        empty.createDiv({
          cls: "ghub-empty-hint",
          text: "点击右上角「＋ 导入文件」,或直接把图片/视频拖进本窗口",
        });
        const btn = empty.createEl("button", {
          text: "导入第一批资产",
          cls: "mod-cta",
        });
        btn.addEventListener("click", () => this.pickFiles());
      } else {
        empty.createDiv({ text: "没有符合筛选条件的资产" });
        const btn = empty.createEl("button", { text: "清除全部筛选" });
        btn.addEventListener("click", () => {
          this.filter = {
            search: "",
            type: "all",
            tags: new Set(),
            rating: "all",
            folder: null,
          };
          this.render();
        });
      }
      return;
    }

    // JS 瀑布流:新→旧排序,从左到右放入"当前最矮的列"
    // (CSS columns 是竖排+滚动重排,顺序和稳定性都不对,弃用)
    const sorted = [...items].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    this.colCount = this.computeColCount();
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
      // 用已知宽高比估算卡片高度;未知(旧数据/视频/链接)按 4:3 估
      const ratio = it.w && it.h ? it.h / it.w : 0.75;
      heights[target] += ratio + 0.06; // 0.06 ≈ 卡片间距占比
    }
  }

  private card(it: GalleryItem): HTMLElement {
    const card = createDiv({ cls: "ghub-card", attr: { tabindex: "0" } });
    if (this.selected.has(it.id)) card.addClass("is-selected");

    const thumb = card.createDiv({ cls: "ghub-thumb" });
    // CLS 防护:已知尺寸时用 aspect-ratio 预留空间
    if (it.w && it.h) {
      thumb.style.aspectRatio = `${it.w} / ${it.h}`;
    }
    if (it.type === "image" && it.path) {
      const img = thumb.createEl("img", {
        attr: { loading: "lazy", alt: it.title || it.fileName || "图片资产" },
      });
      if (it.w && it.h) {
        img.width = it.w;
        img.height = it.h;
      }
      img.dataset.src = this.app.vault.adapter.getResourcePath(it.path);
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
    } else if (it.type === "link") {
      const box = thumb.createDiv({ cls: "ghub-linkbox" });
      const ic = box.createDiv({ cls: "ghub-linkbox-icon" });
      setIcon(ic, "link");
      try {
        box.createDiv({
          cls: "ghub-linkbox-domain",
          text: new URL(it.url ?? "").hostname,
        });
      } catch {
        /* ignore */
      }
    }

    // 覆盖层:悬停/聚焦时浮现的元数据(画面优先,不占卡片空间)
    const veil = card.createDiv({ cls: "ghub-veil" });
    const top = veil.createDiv({ cls: "ghub-veil-top" });
    if (it.gen.prompt) top.createSpan({ cls: "ghub-chip-p", text: "PROMPT" });
    if (it.type === "video") top.createSpan({ cls: "ghub-chip-v", text: "▶ VIDEO" });
    const bottom = veil.createDiv({ cls: "ghub-veil-bottom" });
    bottom.createDiv({ cls: "ghub-vtitle", text: it.title || "(无标题)" });
    const meta = bottom.createDiv({ cls: "ghub-veil-meta" });
    if (it.rating > 0)
      meta.createSpan({ text: "★".repeat(it.rating), cls: "ghub-stars" });
    if (it.gen.model) meta.createSpan({ text: it.gen.model });
    if (it.tags.length) meta.createSpan({ text: it.tags.slice(0, 2).join(" · ") });

    // 选择圆钮:悬停或已选中时可见;点击只切换选择,不打开详情
    const check = card.createDiv({
      cls: "ghub-check",
      attr: { role: "checkbox", "aria-label": "选择", tabindex: "-1" },
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
      new DetailModal(this.app, this.store, it, this.getTheme()).open();
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter") open(e);
      if (e.key === " ") {
        e.preventDefault();
        this.toggleSelect(it, card);
      }
    });

    return card;
  }
}
