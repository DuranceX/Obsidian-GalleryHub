import { App, Menu, setIcon } from "obsidian";
import { GalleryStore } from "./store";
import { GalleryItem, LayoutPos } from "./types";
import { DetailModal } from "./detail";

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const DEFAULT_CARD_W = 320;

/**
 * 无限画布:单个 transform 容器承载所有卡片。
 * - 空格/中键/空白处左键拖拽平移;滚轮缩放(以指针为中心)
 * - 卡片拖拽移动、右下角手柄缩放,写回 layouts[boardId]
 * - 双击卡片开详情;右键卡片菜单(置顶/置底/从画布移除)
 */
export class CanvasBoard {
  private app: App;
  private store: GalleryStore;
  private boardId: string;
  private getTheme: () => string;

  private hostEl: HTMLElement;
  private worldEl!: HTMLElement;
  /** 视口变换 */
  private tx = 0;
  private ty = 0;
  private scale = 1;
  /** 卡片 DOM 索引 */
  private cardEls = new Map<string, HTMLElement>();
  private detachFns: Array<() => void> = [];

  constructor(
    app: App,
    store: GalleryStore,
    boardId: string,
    hostEl: HTMLElement,
    getTheme: () => string
  ) {
    this.app = app;
    this.store = store;
    this.boardId = boardId;
    this.hostEl = hostEl;
    this.getTheme = getTheme;
    this.build();
  }

  destroy(): void {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    this.hostEl.empty();
  }

  // ================= 构建 =================

  private build(): void {
    const host = this.hostEl;
    host.empty();
    host.addClass("ghub-canvas");
    this.worldEl = host.createDiv({ cls: "ghub-world" });

    this.renderAll();
    this.fitAll(false);

    // ---- 平移:空白左键 / 中键 / 空格+左键 ----
    let panning = false;
    let spaceHeld = false;
    let lastX = 0;
    let lastY = 0;

    const keydown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !this.isEditableTarget(e)) {
        spaceHeld = true;
        host.addClass("is-pan-ready");
        e.preventDefault();
      }
    };
    const keyup = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceHeld = false;
        host.removeClass("is-pan-ready");
      }
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    this.detachFns.push(() => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
    });

    host.addEventListener("pointerdown", (e) => {
      const onCard = (e.target as HTMLElement).closest(".ghub-cnode");
      const panButton =
        e.button === 1 || (e.button === 0 && (spaceHeld || !onCard));
      if (!panButton) return;
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      host.addClass("is-panning");
      host.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    host.addEventListener("pointermove", (e) => {
      if (!panning) return;
      this.tx += e.clientX - lastX;
      this.ty += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.applyTransform();
    });
    const endPan = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      host.removeClass("is-panning");
      try {
        host.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    host.addEventListener("pointerup", endPan);
    host.addEventListener("pointercancel", endPan);

    // ---- 缩放:滚轮,以指针为中心 ----
    host.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = host.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
        const k = next / this.scale;
        // 指针下的世界点保持不动
        this.tx = px - (px - this.tx) * k;
        this.ty = py - (py - this.ty) * k;
        this.scale = next;
        this.applyTransform();
      },
      { passive: false }
    );

    // ---- 空白右键:适应全部 ----
    host.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest(".ghub-cnode")) return;
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((mi) =>
        mi.setTitle("适应全部").setIcon("maximize").onClick(() => this.fitAll())
      );
      menu.addItem((mi) =>
        mi.setTitle("重置缩放 (100%)").setIcon("search").onClick(() => {
          this.scale = 1;
          this.applyTransform();
        })
      );
      menu.showAtMouseEvent(e);
    });
  }

  private isEditableTarget(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable);
  }

  private applyTransform(): void {
    this.worldEl.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
  }

  // ================= 渲染 =================

  /** 数据变更后的全量重渲染(外部订阅调用) */
  refresh(): void {
    this.renderAll();
  }

  private renderAll(): void {
    this.worldEl.empty();
    this.cardEls.clear();
    const items = this.store.itemsOnBoard(this.boardId);
    // 按 z 排序渲染,DOM 顺序即叠放次序
    items.sort(
      (a, b) => (a.layouts[this.boardId]?.z ?? 0) - (b.layouts[this.boardId]?.z ?? 0)
    );
    for (const it of items) this.renderCard(it);

    if (!items.length) {
      const empty = this.worldEl.createDiv({ cls: "ghub-canvas-empty" });
      empty.setText("画布是空的 — 在画廊中多选资产后「发送到画布」,或直接拖资产卡片进来");
    }
  }

  private renderCard(it: GalleryItem): void {
    const pos = it.layouts[this.boardId];
    if (!pos) return;
    const node = this.worldEl.createDiv({ cls: "ghub-cnode" });
    this.cardEls.set(it.id, node);
    const ratio = it.w && it.h ? it.h / it.w : 0.75;
    const width = pos.w || DEFAULT_CARD_W;
    const height = pos.h ?? width * ratio;
    node.style.left = `${pos.x}px`;
    node.style.top = `${pos.y}px`;
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;

    // 内容
    if (it.type === "image" && it.path) {
      node.createEl("img", {
        attr: {
          src: this.app.vault.adapter.getResourcePath(it.path),
          alt: it.title || "",
          draggable: "false",
        },
      });
    } else if (it.type === "video" && it.path) {
      const v = node.createEl("video", {
        attr: { loop: "true", playsinline: "true", controls: "true" },
      });
      v.muted = true;
      v.preload = "metadata";
      v.src = this.app.vault.adapter.getResourcePath(it.path);
    } else if (it.type === "link") {
      const box = node.createDiv({ cls: "ghub-cnode-link" });
      const ic = box.createDiv({ cls: "ghub-linkbox-icon" });
      setIcon(ic, "link");
      box.createDiv({ text: it.title || it.url || "", cls: "ghub-cnode-link-t" });
    }

    // 标题条(悬停显示)
    node.createDiv({ cls: "ghub-cnode-title", text: it.title || "" });

    // ---- 拖拽移动 ----
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".ghub-cnode-resize")) return;
      if ((e.target as HTMLElement).tagName === "VIDEO") return; // 让视频控件可点
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const cur = it.layouts[this.boardId]!;
      ox = cur.x;
      oy = cur.y;
      node.addClass("is-dragging");
      node.setPointerCapture(e.pointerId);
      this.bringToFront(it, node);
      e.stopPropagation();
    });
    node.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const cur = it.layouts[this.boardId]!;
      cur.x = ox + (e.clientX - sx) / this.scale;
      cur.y = oy + (e.clientY - sy) / this.scale;
      node.style.left = `${cur.x}px`;
      node.style.top = `${cur.y}px`;
    });
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      node.removeClass("is-dragging");
      try {
        node.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const cur = it.layouts[this.boardId]!;
      this.store.setLayout(it.id, this.boardId, { ...cur }, true);
    };
    node.addEventListener("pointerup", endDrag);
    node.addEventListener("pointercancel", endDrag);

    // ---- 右下角缩放手柄 ----
    const handle = node.createDiv({ cls: "ghub-cnode-resize" });
    setIcon(handle, "move-diagonal-2");
    let resizing = false;
    let rw = 0;
    node.addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest(".ghub-cnode-resize")) return;
      resizing = true;
      sx = e.clientX;
      rw = it.layouts[this.boardId]!.w || DEFAULT_CARD_W;
      node.setPointerCapture(e.pointerId);
      e.stopPropagation();
      e.preventDefault();
    });
    node.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      const cur = it.layouts[this.boardId]!;
      cur.w = Math.max(60, rw + (e.clientX - sx) / this.scale);
      cur.h = null; // 保持宽高比
      node.style.width = `${cur.w}px`;
      node.style.height = `${cur.w * ratio}px`;
    });
    const endResize = (e: PointerEvent) => {
      if (!resizing) return;
      resizing = false;
      try {
        node.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const cur = it.layouts[this.boardId]!;
      this.store.setLayout(it.id, this.boardId, { ...cur }, true);
    };
    node.addEventListener("pointerup", endResize);
    node.addEventListener("pointercancel", endResize);

    // ---- 双击详情 ----
    node.addEventListener("dblclick", () => {
      new DetailModal(this.app, this.store, it, this.getTheme()).open();
    });

    // ---- 右键菜单 ----
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((mi) =>
        mi.setTitle("置顶").setIcon("arrow-up-to-line").onClick(() => {
          this.bringToFront(it, node);
        })
      );
      menu.addItem((mi) =>
        mi.setTitle("置底").setIcon("arrow-down-to-line").onClick(() => {
          const min = Math.min(
            0,
            ...this.store
              .itemsOnBoard(this.boardId)
              .map((x) => x.layouts[this.boardId]?.z ?? 0)
          );
          const cur = it.layouts[this.boardId]!;
          cur.z = min - 1;
          this.store.setLayout(it.id, this.boardId, { ...cur }, true);
          this.worldEl.insertBefore(node, this.worldEl.firstChild);
        })
      );
      menu.addItem((mi) =>
        mi.setTitle("打开详情").setIcon("info").onClick(() => {
          new DetailModal(this.app, this.store, it, this.getTheme()).open();
        })
      );
      menu.addSeparator();
      menu.addItem((mi) =>
        mi.setTitle("从画布移除(不影响库)").setIcon("x").onClick(() => {
          this.store.setLayout(it.id, this.boardId, null);
        })
      );
      menu.showAtMouseEvent(e);
    });
  }

  private bringToFront(it: GalleryItem, node: HTMLElement): void {
    const max = Math.max(
      0,
      ...this.store
        .itemsOnBoard(this.boardId)
        .map((x) => x.layouts[this.boardId]?.z ?? 0)
    );
    const cur = it.layouts[this.boardId]!;
    if (cur.z <= max && this.worldEl.lastChild !== node) {
      cur.z = max + 1;
      this.store.setLayout(it.id, this.boardId, { ...cur }, true);
      this.worldEl.appendChild(node);
    }
  }

  // ================= 视口 =================

  /** 视口中心对应的世界坐标(供"发送到画布"落点) */
  centerWorld(): { x: number; y: number } {
    const rect = this.hostEl.getBoundingClientRect();
    return {
      x: (rect.width / 2 - this.tx) / this.scale,
      y: (rect.height / 2 - this.ty) / this.scale,
    };
  }

  /** 缩放平移到能看到全部卡片 */
  fitAll(animated = true): void {
    const items = this.store.itemsOnBoard(this.boardId);
    if (!items.length) {
      this.tx = 40;
      this.ty = 40;
      this.scale = 1;
      this.applyTransform();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const it of items) {
      const p = it.layouts[this.boardId]!;
      const ratio = it.w && it.h ? it.h / it.w : 0.75;
      const w = p.w || DEFAULT_CARD_W;
      const h = p.h ?? w * ratio;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w);
      maxY = Math.max(maxY, p.y + h);
    }
    const rect = this.hostEl.getBoundingClientRect();
    const pad = 60;
    const sw = (rect.width - pad * 2) / (maxX - minX || 1);
    const sh = (rect.height - pad * 2) / (maxY - minY || 1);
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(sw, sh, 1.5)));
    this.tx = (rect.width - (maxX - minX) * this.scale) / 2 - minX * this.scale;
    this.ty = (rect.height - (maxY - minY) * this.scale) / 2 - minY * this.scale;
    if (animated) {
      this.worldEl.style.transition = "transform 0.25s ease";
      window.setTimeout(() => (this.worldEl.style.transition = ""), 260);
    }
    this.applyTransform();
  }

  /** 把条目放到画布(视口中心错开排列) */
  addItems(items: GalleryItem[]): number {
    const center = this.centerWorld();
    let added = 0;
    const maxZ = Math.max(
      0,
      ...this.store
        .itemsOnBoard(this.boardId)
        .map((x) => x.layouts[this.boardId]?.z ?? 0)
    );
    items.forEach((it, i) => {
      if (it.layouts[this.boardId]) return; // 已在画布上
      const pos: LayoutPos = {
        x: center.x - DEFAULT_CARD_W / 2 + (i % 4) * 40,
        y: center.y - 120 + Math.floor(i / 4) * 40 + i * 12,
        w: DEFAULT_CARD_W,
        h: null,
        z: maxZ + 1 + i,
      };
      this.store.setLayout(it.id, this.boardId, pos, i < items.length - 1);
      added++;
    });
    return added;
  }
}
