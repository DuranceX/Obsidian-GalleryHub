import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { GalleryStore } from "./store";
import { Importer } from "./importer";
import { GalleryItem, ItemType } from "./types";
import { DetailModal, AddLinkModal } from "./detail";

export const VIEW_TYPE_GALLERY = "gallery-hub-view";

type RatingFilter = "all" | "unrated" | 4 | 5;

interface FilterState {
  search: string;
  type: ItemType | "all";
  tags: Set<string>;
  rating: RatingFilter;
}

export class GalleryView extends ItemView {
  private store: GalleryStore;
  private importer: Importer;
  private unsubscribe: (() => void) | null = null;
  private filter: FilterState = {
    search: "",
    type: "all",
    tags: new Set(),
    rating: "all",
  };
  private sideEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private countEl!: HTMLElement;
  private observer: IntersectionObserver | null = null;

  constructor(leaf: WorkspaceLeaf, store: GalleryStore, importer: Importer) {
    super(leaf);
    this.store = store;
    this.importer = importer;
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
        void this.importer.importFiles(e.dataTransfer.files);
      }
    });

    this.unsubscribe = this.store.onChange(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.observer?.disconnect();
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

    const importBtn = bar.createEl("button", { text: "＋ 导入文件" });
    importBtn.addEventListener("click", () => {
      const input = createEl("input", {
        attr: { type: "file", multiple: "true", accept: "image/*,video/*" },
      });
      input.addEventListener("change", () => {
        if (input.files?.length) void this.importer.importFiles(input.files);
      });
      input.click();
    });

    const linkBtn = bar.createEl("button", { text: "＋ 链接" });
    linkBtn.addEventListener("click", () => {
      new AddLinkModal(this.app, (url, title) => {
        if (this.importer.addLink(url, title)) new Notice("链接已添加");
      }).open();
    });
  }

  // ---------- 侧边栏 ----------

  private renderSidebar(): void {
    const side = this.sideEl;
    side.empty();
    const all = this.store.getItems();

    // 类型
    side.createEl("h3", { text: "类型" });
    const typeDefs: Array<[ItemType | "all", string, number]> = [
      ["all", "全部资产", all.length],
      ["image", "🖼 图片", all.filter((i) => i.type === "image").length],
      ["video", "🎬 视频", all.filter((i) => i.type === "video").length],
      ["link", "🔗 链接", all.filter((i) => i.type === "link").length],
    ];
    for (const [val, label, n] of typeDefs) {
      this.fitem(side, label, n, this.filter.type === val, () => {
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
      this.fitem(side, label, n, this.filter.rating === val, () => {
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
    label: string,
    count: number,
    active: boolean,
    onClick: () => void
  ): void {
    const el = parent.createDiv({
      cls: "ghub-fitem" + (active ? " is-active" : ""),
    });
    el.createSpan({ text: label });
    el.createSpan({ cls: "ghub-n", text: String(count) });
    el.addEventListener("click", onClick);
  }

  // ---------- 渲染 ----------

  private render(): void {
    this.renderSidebar();
    this.renderGrid();
  }

  private filtered(): GalleryItem[] {
    const f = this.filter;
    return this.store.getItems().filter((it) => {
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

  private renderGrid(): void {
    const items = this.filtered();
    this.countEl.setText(
      `${items.length} / ${this.store.getItems().length} 项` +
        (this.store.readOnly ? " · 只读模式" : "")
    );
    this.gridEl.empty();

    if (!items.length) {
      const empty = this.gridEl.createDiv({ cls: "ghub-empty" });
      empty.setText(
        this.store.getItems().length === 0
          ? "库是空的。点击「＋ 导入文件」或直接把图片/视频拖进来。"
          : "没有符合筛选条件的资产。"
      );
      return;
    }

    for (const it of items) {
      this.gridEl.appendChild(this.card(it));
    }
  }

  private card(it: GalleryItem): HTMLElement {
    const card = createDiv({ cls: "ghub-card", attr: { tabindex: "0" } });

    const thumb = card.createDiv({ cls: "ghub-thumb" });
    if (it.type === "image" && it.path) {
      const img = thumb.createEl("img", { attr: { loading: "lazy" } });
      img.dataset.src = this.app.vault.adapter.getResourcePath(it.path);
      this.observer?.observe(img);
    } else if (it.type === "video" && it.path) {
      const video = thumb.createEl("video", {
        attr: { muted: "true", loop: "true", playsinline: "true" },
      });
      video.dataset.src = this.app.vault.adapter.getResourcePath(it.path);
      this.observer?.observe(video);
      thumb.createDiv({ cls: "ghub-badge", text: "▶ VIDEO" });
      card.addEventListener(
        "mouseenter",
        () => void video.play().catch(() => {})
      );
      card.addEventListener("mouseleave", () => video.pause());
    } else if (it.type === "link") {
      const box = thumb.createDiv({ cls: "ghub-linkbox" });
      box.createDiv({ cls: "ghub-linkbox-icon", text: "🔗" });
      try {
        box.createDiv({
          cls: "ghub-linkbox-domain",
          text: new URL(it.url ?? "").hostname,
        });
      } catch {
        /* ignore */
      }
    }

    // 信息区(工作台式外显)
    const body = card.createDiv({ cls: "ghub-card-body" });
    body.createDiv({ cls: "ghub-card-title", text: it.title || "(无标题)" });

    const sub = body.createDiv({ cls: "ghub-card-sub" });
    if (it.rating > 0)
      sub.createSpan({ text: "★".repeat(it.rating), cls: "ghub-stars" });
    if (it.gen.model)
      sub.createSpan({ text: it.gen.model, cls: "ghub-card-model" });

    if (it.gen.prompt) {
      body.createDiv({ cls: "ghub-prompt-snippet", text: it.gen.prompt });
    }

    if (it.tags.length) {
      const tags = body.createDiv({ cls: "ghub-card-tags" });
      for (const t of it.tags.slice(0, 4))
        tags.createSpan({ cls: "ghub-ctag", text: t });
    }

    const open = (e: MouseEvent | KeyboardEvent) => {
      if (
        it.type === "link" &&
        "ctrlKey" in e &&
        (e.ctrlKey || e.metaKey) &&
        it.url
      ) {
        window.open(it.url);
        return;
      }
      new DetailModal(this.app, this.store, it).open();
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter") open(e);
    });

    return card;
  }
}
