import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { GalleryStore } from "./store";
import { Importer } from "./importer";
import { GalleryItem, ItemType } from "./types";
import { DetailModal, AddLinkModal } from "./detail";

export const VIEW_TYPE_GALLERY = "gallery-hub-view";

interface FilterState {
  search: string;
  type: ItemType | "all";
  tags: Set<string>;
  minRating: number;
}

export class GalleryView extends ItemView {
  private store: GalleryStore;
  private importer: Importer;
  private unsubscribe: (() => void) | null = null;
  private filter: FilterState = {
    search: "",
    type: "all",
    tags: new Set(),
    minRating: 0,
  };
  private gridEl!: HTMLElement;
  private tagBarEl!: HTMLElement;
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
      { root, rootMargin: "300px" }
    );

    this.buildToolbar(root);
    this.tagBarEl = root.createDiv({ cls: "ghub-tagbar" });
    this.countEl = root.createDiv({ cls: "ghub-count" });
    this.gridEl = root.createDiv({ cls: "ghub-grid" });

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

  // ---------- 工具栏 ----------

  private buildToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "ghub-toolbar" });

    // 搜索
    const search = bar.createEl("input", {
      cls: "ghub-search",
      attr: { type: "search", placeholder: "搜索标题 / prompt / 备注…" },
    });
    search.addEventListener("input", () => {
      this.filter.search = search.value.toLowerCase();
      this.renderGrid();
    });

    // 类型
    const typeSel = bar.createEl("select", { cls: "dropdown" });
    for (const [v, label] of [
      ["all", "全部类型"],
      ["image", "图片"],
      ["video", "视频"],
      ["link", "链接"],
    ]) {
      typeSel.createEl("option", { text: label, attr: { value: v } });
    }
    typeSel.addEventListener("change", () => {
      this.filter.type = typeSel.value as FilterState["type"];
      this.renderGrid();
    });

    // 评分
    const rateSel = bar.createEl("select", { cls: "dropdown" });
    for (let i = 0; i <= 5; i++) {
      rateSel.createEl("option", {
        text: i === 0 ? "全部评分" : "≥ " + "★".repeat(i),
        attr: { value: String(i) },
      });
    }
    rateSel.addEventListener("change", () => {
      this.filter.minRating = Number(rateSel.value);
      this.renderGrid();
    });

    bar.createDiv({ cls: "ghub-spacer" });

    // 导入按钮
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

  // ---------- 渲染 ----------

  private render(): void {
    this.renderTagBar();
    this.renderGrid();
  }

  private renderTagBar(): void {
    this.tagBarEl.empty();
    const tags = this.store.allTags();
    if (!tags.length) return;
    for (const tag of tags) {
      const chip = this.tagBarEl.createEl("span", {
        text: tag,
        cls: "ghub-tag" + (this.filter.tags.has(tag) ? " is-active" : ""),
      });
      chip.addEventListener("click", () => {
        if (this.filter.tags.has(tag)) this.filter.tags.delete(tag);
        else this.filter.tags.add(tag);
        this.render();
      });
    }
    if (this.filter.tags.size) {
      const clear = this.tagBarEl.createEl("span", {
        text: "✕ 清除",
        cls: "ghub-tag ghub-tag-clear",
      });
      clear.addEventListener("click", () => {
        this.filter.tags.clear();
        this.render();
      });
    }
  }

  private filtered(): GalleryItem[] {
    const f = this.filter;
    return this.store.getItems().filter((it) => {
      if (f.type !== "all" && it.type !== f.type) return false;
      if (it.rating < f.minRating) return false;
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
    const card = createDiv({ cls: "ghub-card" });

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
      thumb.createDiv({ cls: "ghub-badge", text: "▶" });
      card.addEventListener("mouseenter", () => void video.play().catch(() => {}));
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

    const meta = card.createDiv({ cls: "ghub-card-meta" });
    meta.createDiv({ cls: "ghub-card-title", text: it.title || "(无标题)" });
    const sub = meta.createDiv({ cls: "ghub-card-sub" });
    if (it.rating > 0)
      sub.createSpan({ text: "★".repeat(it.rating), cls: "ghub-stars" });
    if (it.gen.prompt) sub.createSpan({ text: "P", cls: "ghub-flag", attr: { title: "含 prompt" } });
    if (it.tags.length)
      sub.createSpan({ text: it.tags.slice(0, 3).join(" · "), cls: "ghub-card-tags" });

    card.addEventListener("click", (e) => {
      if (it.type === "link" && (e.ctrlKey || e.metaKey) && it.url) {
        window.open(it.url);
        return;
      }
      new DetailModal(this.app, this.store, it).open();
    });

    return card;
  }
}
