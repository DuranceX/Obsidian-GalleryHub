import { App, Menu, setIcon } from "obsidian";
import { GalleryStore } from "./store";
import { GalleryItem, LayoutPos, BoardElement, ELEMENT_COLORS } from "./types";
import { t } from "./i18n";
import { DetailModal } from "./detail";
import { Importer } from "./importer";
import { ThumbCache } from "./thumbs";
import { targetIcon } from "./resource";

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
  private importer: Importer;
  private thumbs: ThumbCache | null;

  private hostEl: HTMLElement;
  private worldEl!: HTMLElement;
  /** 视口变换 */
  private tx = 0;
  private ty = 0;
  private scale = 1;
  /** 卡片 DOM 索引 */
  private cardEls = new Map<string, HTMLElement>();
  /** 画布元素(文字/画框)DOM 索引 */
  private elEls = new Map<string, HTMLElement>();
  /** 框选中的卡片 id */
  private selectedIds = new Set<string>();
  /** 框选中的画布元素 id */
  private selectedElIds = new Set<string>();
  private detachFns: Array<() => void> = [];

  constructor(
    app: App,
    store: GalleryStore,
    boardId: string,
    hostEl: HTMLElement,
    getTheme: () => string,
    importer: Importer,
    thumbs?: ThumbCache
  ) {
    this.app = app;
    this.store = store;
    this.boardId = boardId;
    this.hostEl = hostEl;
    this.getTheme = getTheme;
    this.importer = importer;
    this.thumbs = thumbs ?? null;
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
    this.buildToolbar();

    // ---- 系统文件拖入:直接落画布(同时入库) ----
    host.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    host.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      const rect = host.getBoundingClientRect();
      const wx = (e.clientX - rect.left - this.tx) / this.scale;
      const wy = (e.clientY - rect.top - this.ty) / this.scale;
      void this.importer.importFiles(files).then((n) => {
        if (!n) return;
        // 最新导入的 n 个条目落到放置点
        const all = [...this.store.getItems()].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt)
        );
        const maxZ = Math.max(
          0,
          ...this.store
            .itemsOnBoard(this.boardId)
            .map((x) => x.layouts[this.boardId]?.z ?? 0)
        );
        all.slice(0, n).forEach((it, i) => {
          this.store.setLayout(
            it.id,
            this.boardId,
            {
              x: wx + i * 36,
              y: wy + i * 36,
              w: DEFAULT_CARD_W,
              h: null,
              z: maxZ + 1 + i,
            },
            i < n - 1
          );
        });
      });
    });

    // ---- 平移:中键 / 空格+左键;左键空白改为框选 ----
    let panning = false;
    let spaceHeld = false;
    let lastX = 0;
    let lastY = 0;

    const keydown = (e: KeyboardEvent) => {
      if (this.isEditableTarget(e)) return;
      if (e.code === "Space") {
        spaceHeld = true;
        host.addClass("is-pan-ready");
        e.preventDefault();
      }
      if (e.key === "Escape") this.clearSelection();
      if (e.key === "Delete" || e.key === "Backspace") {
        if (this.selectionSize()) this.deleteSelection();
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

    // 框选状态
    let marquee: HTMLElement | null = null;
    let mx0 = 0;
    let my0 = 0;
    let marqueeMoved = false;

    host.addEventListener("pointerdown", (e) => {
      const onNode = (e.target as HTMLElement).closest(
        ".ghub-cnode, .ghub-cel, .ghub-cbar"
      );
      // 平移:中键任意处 / 空格+左键
      if (e.button === 1 || (e.button === 0 && spaceHeld)) {
        panning = true;
        lastX = e.clientX;
        lastY = e.clientY;
        host.addClass("is-panning");
        host.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      // 框选:左键按在空白处
      if (e.button === 0 && !onNode) {
        const rect = host.getBoundingClientRect();
        mx0 = e.clientX - rect.left;
        my0 = e.clientY - rect.top;
        marqueeMoved = false;
        marquee = host.createDiv({ cls: "ghub-marquee" });
        marquee.style.left = `${mx0}px`;
        marquee.style.top = `${my0}px`;
        host.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    host.addEventListener("pointermove", (e) => {
      if (panning) {
        this.tx += e.clientX - lastX;
        this.ty += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        this.applyTransform();
        return;
      }
      if (marquee) {
        const rect = host.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        if (Math.abs(mx - mx0) + Math.abs(my - my0) > 4) marqueeMoved = true;
        const x = Math.min(mx0, mx);
        const y = Math.min(my0, my);
        const w = Math.abs(mx - mx0);
        const h = Math.abs(my - my0);
        marquee.style.left = `${x}px`;
        marquee.style.top = `${y}px`;
        marquee.style.width = `${w}px`;
        marquee.style.height = `${h}px`;
        this.updateMarqueeSelection(x, y, w, h, e.ctrlKey || e.metaKey || e.shiftKey);
      }
    });
    const endPointer = (e: PointerEvent) => {
      if (panning) {
        panning = false;
        host.removeClass("is-panning");
      }
      if (marquee) {
        marquee.remove();
        marquee = null;
        // 原地单击空白(没拖出框)= 清除选择
        if (!marqueeMoved) this.clearSelection();
      }
      try {
        host.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    host.addEventListener("pointerup", endPointer);
    host.addEventListener("pointercancel", endPointer);

    // ---- 滚轮 / 触摸板 ----
    // 三种意图:鼠标滚轮→缩放(行为不变);触摸板捏合→缩放;触摸板双指移动→平移。
    //
    // 设备识别(参考 Figma/tldraw 等做法):鼠标滚轮每个物理刻度的 wheelDeltaY 恒为
    // 120 的整数倍(WHEEL_DELTA 标准),触摸板则是任意细碎值。故 wheelDeltaY 非 120
    // 倍数即判为触摸板。
    //
    // 抖动来自"逐事件判定":垂直滚动时 deltaX 会间歇为 0、deltaY 会间歇为整数,
    // 同一次连续手势会在平移/缩放间反复横跳。
    // 但捏合缩放带 ctrlKey=true、平移带 ctrlKey=false,ctrlKey 是每事件可靠的即时信号,
    // 故捏合无需锁存;锁存只用于无法即时区分的 non-ctrl 场景(触摸板平移 vs 鼠标滚轮缩放)。
    // 这样"捏合缩放后立刻平移"能凭 ctrlKey 立即切换,不会残留缩放模式。
    let panLatch: boolean | null = null; // null=未判定;true=平移;false=缩放
    let wheelIdleTimer: number | null = null;
    const WHEEL_GESTURE_IDLE = 120; // ms:超过此静默期视为新手势,允许重新判定
    this.detachFns.push(() => {
      if (wheelIdleTimer !== null) window.clearTimeout(wheelIdleTimer);
    });

    host.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();

        let doPan: boolean;
        if (e.ctrlKey || e.metaKey) {
          // 捏合手势 / Ctrl+滚轮:即时缩放,并清除平移锁存,
          // 使紧接其后的平移手势能立即重新判定
          doPan = false;
          panLatch = null;
          if (wheelIdleTimer !== null) {
            window.clearTimeout(wheelIdleTimer);
            wheelIdleTimer = null;
          }
        } else {
          // non-ctrl:手势起始判定一次并锁存,手势中途不改判
          if (panLatch === null) {
            // wheelDeltaY 存在且非 120 倍数 → 触摸板(平移);否则鼠标滚轮(缩放)
            const wdy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
            panLatch =
              e.deltaMode === 0 &&
              wdy !== undefined &&
              wdy !== 0 &&
              Math.abs(wdy) % 120 !== 0;
          }
          doPan = panLatch;
          // 静默一段时间后结束当前手势,下次重新判定
          if (wheelIdleTimer !== null) window.clearTimeout(wheelIdleTimer);
          wheelIdleTimer = window.setTimeout(() => {
            panLatch = null;
            wheelIdleTimer = null;
          }, WHEEL_GESTURE_IDLE);
        }

        if (doPan) {
          this.tx -= e.deltaX;
          this.ty -= e.deltaY;
        } else {
          // 以指针为中心缩放
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
        }
        this.applyTransform();
      },
      { passive: false }
    );

    // ---- 空白右键:添加元素 / 视图 ----
    host.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest(".ghub-cnode, .ghub-cel")) return;
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      const wx = (e.clientX - rect.left - this.tx) / this.scale;
      const wy = (e.clientY - rect.top - this.ty) / this.scale;
      const menu = new Menu();
      menu.addItem((mi) =>
        mi.setTitle(t("addText")).setIcon("type").onClick(() => this.addText(wx, wy))
      );
      menu.addItem((mi) =>
        mi.setTitle(t("addFrame")).setIcon("square").onClick(() => this.addFrame(wx, wy))
      );
      menu.addSeparator();
      menu.addItem((mi) =>
        mi.setTitle(t("fitAll")).setIcon("maximize").onClick(() => this.fitAll())
      );
      menu.addItem((mi) =>
        mi.setTitle(t("resetZoom")).setIcon("search").onClick(() => {
          this.scale = 1;
          this.applyTransform();
        })
      );
      menu.showAtMouseEvent(e);
    });
  }

  // ================= 悬浮工具栏 =================

  private buildToolbar(): void {
    const bar = this.hostEl.createDiv({ cls: "ghub-cbar" });
    const tool = (icon: string, label: string, onClick: () => void) => {
      const btn = bar.createEl("button", {
        cls: "ghub-cbar-btn",
        attr: { "aria-label": label, title: label },
      });
      setIcon(btn, icon);
      btn.addEventListener("click", onClick);
      return btn;
    };
    tool("type", t("addTextCenter"), () => {
      const c = this.centerWorld();
      this.addText(c.x, c.y);
    });
    tool("square", t("addFrameCenter"), () => {
      const c = this.centerWorld();
      this.addFrame(c.x - 240, c.y - 160);
    });
    bar.createDiv({ cls: "ghub-cbar-sep" });
    tool("maximize", t("fitAll"), () => this.fitAll());
    tool("search", t("resetZoom"), () => {
      this.scale = 1;
      this.applyTransform();
    });
  }

  private addText(x: number, y: number): void {
    const id = this.store.addBoardElement(this.boardId, {
      kind: "text",
      x,
      y,
      w: 260,
      h: 0,
      text: "",
    });
    if (id) window.setTimeout(() => this.focusElementEditor(id), 50);
  }

  private addFrame(x: number, y: number): void {
    this.store.addBoardElement(this.boardId, {
      kind: "frame",
      x,
      y,
      w: 480,
      h: 320,
      text: t("frameDefaultLabel"),
    });
  }

  private focusElementEditor(elId: string): void {
    const node = this.worldEl.querySelector<HTMLElement>(
      `.ghub-cel[data-id="${elId}"]`
    );
    // 触发元素自身的双击编辑逻辑
    node?.dispatchEvent(new MouseEvent("dblclick", { bubbles: false }));
  }

  /** 应用元素颜色(CSS 变量供样式取用) */
  private applyElementColor(node: HTMLElement, el: BoardElement): void {
    if (el.color) node.style.setProperty("--cel-color", el.color);
    else node.style.removeProperty("--cel-color");
  }

  private isEditableTarget(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable);
  }

  // ================= 框选 =================

  private clearSelection(): void {
    this.selectedIds.clear();
    this.selectedElIds.clear();
    for (const el of this.cardEls.values()) el.removeClass("is-selected");
    for (const el of this.elEls.values()) el.removeClass("is-selected");
  }

  /** 选中集总数(卡片+元素) */
  private selectionSize(): number {
    return this.selectedIds.size + this.selectedElIds.size;
  }

  /** 删除选中:卡片移出画布,元素删除 */
  private deleteSelection(): void {
    for (const id of this.selectedIds)
      this.store.setLayout(id, this.boardId, null, true);
    for (const id of this.selectedElIds)
      this.store.deleteBoardElement(this.boardId, id);
    this.selectedIds.clear();
    this.selectedElIds.clear();
    this.renderAll();
  }

  /** 屏幕矩形与卡片/元素求交,更新选中集(additive=按住 Ctrl/Shift 保留已有选择) */
  private updateMarqueeSelection(
    x: number,
    y: number,
    w: number,
    h: number,
    additive: boolean
  ): void {
    // 屏幕框 → 世界坐标
    const wx0 = (x - this.tx) / this.scale;
    const wy0 = (y - this.ty) / this.scale;
    const wx1 = (x + w - this.tx) / this.scale;
    const wy1 = (y + h - this.ty) / this.scale;
    const keep = additive ? new Set(this.selectedIds) : new Set<string>();
    const keepEl = additive ? new Set(this.selectedElIds) : new Set<string>();
    this.selectedIds = keep;
    this.selectedElIds = keepEl;
    for (const it of this.store.itemsOnBoard(this.boardId)) {
      const p = it.layouts[this.boardId]!;
      const cw = p.w || DEFAULT_CARD_W;
      // 实际渲染高度优先(音频/链接等 h=null 的旧数据按比例估会偏大,导致下方误选)
      const dom = this.cardEls.get(it.id);
      const ratio = it.w && it.h ? it.h / it.w : 0.75;
      const ch = p.h ?? dom?.offsetHeight ?? cw * ratio;
      const hit = p.x < wx1 && p.x + cw > wx0 && p.y < wy1 && p.y + ch > wy0;
      if (hit) this.selectedIds.add(it.id);
    }
    for (const el of this.store.boardElements(this.boardId)) {
      const dom = this.elEls.get(el.id);
      const ew = el.w || dom?.offsetWidth || 100;
      const eh = el.kind === "frame" ? el.h : (dom?.offsetHeight ?? 40);
      const hit = el.x < wx1 && el.x + ew > wx0 && el.y < wy1 && el.y + eh > wy0;
      if (hit) this.selectedElIds.add(el.id);
    }
    for (const [id, el] of this.cardEls)
      el.toggleClass("is-selected", this.selectedIds.has(id));
    for (const [id, el] of this.elEls)
      el.toggleClass("is-selected", this.selectedElIds.has(id));
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
    this.elEls.clear();
    // 画框元素垫底
    for (const el of this.store.boardElements(this.boardId)) {
      if (el.kind === "frame") this.renderElement(el);
    }
    const items = this.store.itemsOnBoard(this.boardId);
    // 按 z 排序渲染,DOM 顺序即叠放次序
    items.sort(
      (a, b) => (a.layouts[this.boardId]?.z ?? 0) - (b.layouts[this.boardId]?.z ?? 0)
    );
    for (const it of items) this.renderCard(it);
    // 文字元素置顶
    for (const el of this.store.boardElements(this.boardId)) {
      if (el.kind === "text") this.renderElement(el);
    }

    if (!items.length && !this.store.boardElements(this.boardId).length) {
      const empty = this.worldEl.createDiv({ cls: "ghub-canvas-empty" });
      empty.setText(
        t("canvasEmpty")
      );
    }
  }

  // ================= 画布元素(文字/画框) =================

  private renderElement(el: BoardElement): void {
    const node = this.worldEl.createDiv({
      cls: `ghub-cel ghub-cel-${el.kind}`,
      attr: { "data-id": el.id },
    });
    this.elEls.set(el.id, node);
    if (this.selectedElIds.has(el.id)) node.addClass("is-selected");
    node.style.left = `${el.x}px`;
    node.style.top = `${el.y}px`;
    node.style.width = `${el.w}px`;
    if (el.kind === "frame") node.style.height = `${el.h}px`;
    if (el.kind === "text" && el.fontSize)
      node.style.setProperty("--cel-fs", `${el.fontSize}px`);
    if (el.kind === "text" && el.bold) node.addClass("is-bold");
    this.applyElementColor(node, el);

    // 可编辑文本(text:正文;frame:左上角标题)
    // 默认不可编辑(保证单击可拖动),双击进入编辑
    const textEl = node.createDiv({
      cls: "ghub-cel-text",
      attr: { contenteditable: "false", spellcheck: "false" },
    });
    textEl.setText(el.text);
    if (el.kind === "text" && !el.text) {
      textEl.dataset.placeholder = t("textPlaceholder");
    }
    const startEdit = () => {
      textEl.setAttribute("contenteditable", "true");
      node.addClass("is-editing");
      textEl.focus();
      // 光标移到末尾
      const range = document.createRange();
      range.selectNodeContents(textEl);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    };
    textEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startEdit();
    });
    node.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startEdit();
    });
    textEl.addEventListener("blur", () => {
      textEl.setAttribute("contenteditable", "false");
      node.removeClass("is-editing");
      const v = textEl.textContent ?? "";
      if (v !== el.text)
        this.store.updateBoardElement(this.boardId, el.id, { text: v }, true);
      el.text = v;
    });
    textEl.addEventListener("keydown", (e) => {
      e.stopPropagation(); // 空格等按键不触发画布平移
      if (e.key === "Escape") textEl.blur();
    });
    // 编辑中阻止拖拽;非编辑状态让事件冒泡给 node 以支持拖动
    textEl.addEventListener("pointerdown", (e) => {
      if (textEl.getAttribute("contenteditable") === "true") e.stopPropagation();
    });

    // 拖拽移动(编辑中除外;选中集内则群体移动,含卡片)
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let elOrigin: Map<string, { x: number; y: number }> = new Map();
    let cardOrigin: Map<string, { x: number; y: number }> = new Map();
    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (node.hasClass("is-editing")) return;
      if ((e.target as HTMLElement).closest(".ghub-cel-resize")) return;
      // 点击未选中元素:清除框选(Ctrl 加选)
      if (!this.selectedElIds.has(el.id)) {
        if (e.ctrlKey || e.metaKey) {
          this.selectedElIds.add(el.id);
          node.addClass("is-selected");
        } else {
          this.clearSelection();
        }
      }
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      elOrigin = new Map();
      cardOrigin = new Map();
      if (this.selectedElIds.has(el.id)) {
        // 群体:选中的元素 + 选中的卡片一起动
        for (const id of this.selectedElIds) {
          const be = this.store
            .boardElements(this.boardId)
            .find((x) => x.id === id);
          if (be) elOrigin.set(id, { x: be.x, y: be.y });
        }
        for (const id of this.selectedIds) {
          const p = this.store.getItem(id)?.layouts[this.boardId];
          if (p) cardOrigin.set(id, { x: p.x, y: p.y });
        }
      } else {
        elOrigin.set(el.id, { x: el.x, y: el.y });
      }
      node.addClass("is-dragging");
      node.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    node.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = (e.clientX - sx) / this.scale;
      const dy = (e.clientY - sy) / this.scale;
      for (const [id, o] of elOrigin) {
        const be = this.store
          .boardElements(this.boardId)
          .find((x) => x.id === id);
        const dom = this.elEls.get(id);
        if (!be || !dom) continue;
        be.x = o.x + dx;
        be.y = o.y + dy;
        dom.style.left = `${be.x}px`;
        dom.style.top = `${be.y}px`;
      }
      for (const [id, o] of cardOrigin) {
        const p = this.store.getItem(id)?.layouts[this.boardId];
        const dom = this.cardEls.get(id);
        if (!p || !dom) continue;
        p.x = o.x + dx;
        p.y = o.y + dy;
        dom.style.left = `${p.x}px`;
        dom.style.top = `${p.y}px`;
      }
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
      for (const id of elOrigin.keys()) {
        const be = this.store
          .boardElements(this.boardId)
          .find((x) => x.id === id);
        if (be)
          this.store.updateBoardElement(this.boardId, id, { x: be.x, y: be.y }, true);
      }
      // 同上:位置变更 quiet 落库,不触发画布重建
      for (const id of cardOrigin.keys()) {
        const p = this.store.getItem(id)?.layouts[this.boardId];
        if (p) this.store.setLayout(id, this.boardId, { ...p }, true);
      }
    };
    node.addEventListener("pointerup", endDrag);
    node.addEventListener("pointercancel", endDrag);

    // 缩放手柄
    const handle = node.createDiv({ cls: "ghub-cel-resize ghub-cnode-resize" });
    setIcon(handle, "move-diagonal-2");
    let resizing = false;
    let rw = 0;
    let rh = 0;
    node.addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest(".ghub-cel-resize")) return;
      resizing = true;
      sx = e.clientX;
      sy = e.clientY;
      rw = el.w;
      rh = el.h;
      node.setPointerCapture(e.pointerId);
      e.stopPropagation();
      e.preventDefault();
    });
    node.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      el.w = Math.max(80, rw + (e.clientX - sx) / this.scale);
      node.style.width = `${el.w}px`;
      if (el.kind === "frame") {
        el.h = Math.max(60, rh + (e.clientY - sy) / this.scale);
        node.style.height = `${el.h}px`;
      }
    });
    const endResize = (e: PointerEvent) => {
      if (!resizing) return;
      resizing = false;
      try {
        node.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.store.updateBoardElement(
        this.boardId,
        el.id,
        { w: el.w, h: el.h },
        true
      );
    };
    node.addEventListener("pointerup", endResize);
    node.addEventListener("pointercancel", endResize);

    // 右键菜单(选中集内右键 = 作用于整个选中集)
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const inSelection =
        this.selectedElIds.has(el.id) && this.selectionSize() > 1;
      const menu = new Menu();
      if (inSelection) {
        // 群体操作
        menu.addItem((mi) =>
          mi.setTitle(t("colorMenu")).setIcon("palette").onClick(() => {
            this.showColorPicker(e.clientX, e.clientY, undefined, (color) => {
              for (const id of this.selectedElIds) {
                const be = this.store
                  .boardElements(this.boardId)
                  .find((x) => x.id === id);
                if (!be) continue;
                be.color = color || undefined;
                this.store.updateBoardElement(this.boardId, id, { color: be.color }, true);
                const dom = this.elEls.get(id);
                if (dom) this.applyElementColor(dom, be);
              }
            });
          })
        );
        menu.addSeparator();
        menu.addItem((mi) =>
          mi
            .setTitle(t("deleteSelection", { n: this.selectionSize() }))
            .setIcon("trash-2")
            .onClick(() => this.deleteSelection())
        );
        menu.showAtMouseEvent(e);
        return;
      }
      menu.addItem((mi) =>
        mi.setTitle(t("editText")).setIcon("pencil").onClick(() => startEdit())
      );
      if (el.kind === "text") {
        // 加粗
        menu.addItem((mi) =>
          mi
            .setTitle(t("boldText"))
            .setIcon(el.bold ? "check" : "bold")
            .onClick(() => {
              el.bold = !el.bold;
              this.store.updateBoardElement(this.boardId, el.id, { bold: el.bold }, true);
              node.toggleClass("is-bold", !!el.bold);
            })
        );
        // 字号子菜单
        for (const size of [14, 18, 24, 32, 48, 64]) {
          menu.addItem((mi) =>
            mi
              .setTitle(t("fontSizeN", { n: size }))
              .setIcon((el.fontSize ?? 18) === size ? "check" : "type")
              .onClick(() => {
                el.fontSize = size;
                this.store.updateBoardElement(this.boardId, el.id, { fontSize: size }, true);
                node.style.setProperty("--cel-fs", `${size}px`);
              })
          );
        }
      }
      menu.addItem((mi) =>
        mi.setTitle(t("colorMenu")).setIcon("palette").onClick(() => {
          this.showColorPicker(e.clientX, e.clientY, el.color, (color) => {
            el.color = color || undefined;
            this.store.updateBoardElement(
              this.boardId,
              el.id,
              { color: el.color },
              true
            );
            this.applyElementColor(node, el);
          });
        })
      );
      menu.addSeparator();
      menu.addItem((mi) =>
        mi.setTitle(t("del")).setIcon("trash-2").onClick(() => {
          this.store.deleteBoardElement(this.boardId, el.id);
        })
      );
      menu.showAtMouseEvent(e);
    });
  }

  /** 色点弹出面板:直观色块,点击即选 */
  private showColorPicker(
    x: number,
    y: number,
    current: string | undefined,
    onPick: (color: string) => void
  ): void {
    const pop = document.body.createDiv({ cls: "ghub-colorpop" });
    pop.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
    pop.style.top = `${Math.min(y, window.innerHeight - 60)}px`;
    for (const [color, labelKey] of ELEMENT_COLORS) {
      const label = t(labelKey);
      const dot = pop.createDiv({
        cls: "ghub-colordot" + ((current ?? "") === color ? " is-current" : ""),
        attr: { "aria-label": label, title: label },
      });
      if (color) dot.style.setProperty("--dot", color);
      else dot.addClass("is-default");
      dot.addEventListener("click", () => {
        onPick(color);
        close();
      });
    }
    const close = () => {
      pop.remove();
      document.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("keydown", onKey, true);
    };
    const onOutside = (ev: PointerEvent) => {
      if (!pop.contains(ev.target as Node)) close();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };
    // 延迟注册,避免当前这次右键的收尾事件立刻触发关闭
    window.setTimeout(() => {
      document.addEventListener("pointerdown", onOutside, true);
      window.addEventListener("keydown", onKey, true);
    }, 0);
  }

  private renderCard(it: GalleryItem): void {
    const pos = it.layouts[this.boardId];
    if (!pos) return;
    const node = this.worldEl.createDiv({ cls: "ghub-cnode" });
    if (it.type === "audio" || it.type === "link" || it.type === "note")
      node.addClass("ghub-cnode-flat");
    this.cardEls.set(it.id, node);
    if (this.selectedIds.has(it.id)) node.addClass("is-selected");
    const freeform = it.type === "audio" || it.type === "link" || it.type === "note";
    const ratio = it.w && it.h ? it.h / it.w : 0.75;
    const width = pos.w || DEFAULT_CARD_W;
    const height =
      pos.h ?? (freeform ? (it.type === "audio" ? 96 : it.type === "note" ? 140 : 56) : width * ratio);
    node.style.left = `${pos.x}px`;
    node.style.top = `${pos.y}px`;
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;

    // 内容
    if (it.type === "image" && it.path) {
      // 画布卡片同样走缩略图缓存(有则用,无则原图+后台生成)
      const img = node.createEl("img", {
        attr: {
          src: this.app.vault.adapter.getResourcePath(
            this.thumbs?.has(it.id) ? this.thumbs.path(it.id) : it.path
          ),
          alt: it.title || "",
          draggable: "false",
        },
      });
      if (this.thumbs && !this.thumbs.has(it.id)) {
        this.thumbs.ensure(it, (p) => {
          if (img.isConnected)
            img.src = this.app.vault.adapter.getResourcePath(p);
        });
      }
    } else if (it.type === "video" && it.path) {
      const v = node.createEl("video", {
        attr: { loop: "true", playsinline: "true", controls: "true" },
      });
      v.muted = true;
      v.preload = "metadata";
      v.src = this.app.vault.adapter.getResourcePath(it.path);
    } else if (it.type === "audio" && it.path) {
      const box = node.createDiv({ cls: "ghub-cnode-link ghub-cnode-audio" });
      const ic = box.createDiv({ cls: "ghub-linkbox-icon" });
      setIcon(ic, "music");
      box.createDiv({ text: it.title || "", cls: "ghub-cnode-link-t" });
      const audio = box.createEl("audio", {
        attr: { controls: "true", preload: "none" },
      });
      audio.src = this.app.vault.adapter.getResourcePath(it.path);
      audio.addEventListener("pointerdown", (e) => e.stopPropagation());
    } else if (it.type === "note") {
      const box = node.createDiv({ cls: "ghub-cnode-link ghub-cnode-note" });
      const ic = box.createDiv({ cls: "ghub-linkbox-icon" });
      setIcon(ic, "type");
      box.createDiv({ text: it.title || "", cls: "ghub-cnode-link-t" });
      if (it.note)
        box.createDiv({ text: it.note, cls: "ghub-cnode-note-body" });
    } else if (it.type === "link") {
      const box = node.createDiv({ cls: "ghub-cnode-link" });
      const ic = box.createDiv({ cls: "ghub-linkbox-icon" });
      setIcon(ic, targetIcon(it.url ?? ""));
      box.createDiv({ text: it.title || it.url || "", cls: "ghub-cnode-link-t" });
    }

    // 标题条(悬停显示)
    node.createDiv({ cls: "ghub-cnode-title", text: it.title || "" });

    // ---- 拖拽移动(选中集内群体移动,含文字/画框元素) ----
    let dragging = false;
    let sx = 0;
    let sy = 0;
    /** 拖动开始时各参与卡片/元素的原始位置 */
    let dragOrigin: Map<string, { x: number; y: number }> = new Map();
    let dragElOrigin: Map<string, { x: number; y: number }> = new Map();
    let lastMoveX = 0;
    let lastMoveY = 0;
    let moveRaf: number | null = null;
    node.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".ghub-cnode-resize")) return;
      if ((e.target as HTMLElement).tagName === "VIDEO") return; // 让视频控件可点
      if ((e.target as HTMLElement).tagName === "AUDIO") return;
      // 点击未选中的卡片:清除框选(拖它自己);Ctrl 点击加选
      if (!this.selectedIds.has(it.id)) {
        if (e.ctrlKey || e.metaKey) {
          this.selectedIds.add(it.id);
          node.addClass("is-selected");
        } else {
          this.clearSelection();
        }
      }
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      dragOrigin = new Map();
      dragElOrigin = new Map();
      if (this.selectedIds.has(it.id)) {
        // 群体:选中的卡片 + 选中的元素一起动
        for (const id of this.selectedIds) {
          const p = this.store.getItem(id)?.layouts[this.boardId];
          if (p) dragOrigin.set(id, { x: p.x, y: p.y });
        }
        for (const id of this.selectedElIds) {
          const be = this.store
            .boardElements(this.boardId)
            .find((x) => x.id === id);
          if (be) dragElOrigin.set(id, { x: be.x, y: be.y });
        }
      } else {
        dragOrigin.set(it.id, {
          x: it.layouts[this.boardId]!.x,
          y: it.layouts[this.boardId]!.y,
        });
      }
      node.addClass("is-dragging");
      node.setPointerCapture(e.pointerId);
      // 不在此处 bringToFront:拖动中 appendChild 会移动 DOM 节点,
      // 浏览器随即丢弃 pointer capture,导致鼠标移出卡片后拖动中断。
      // 先用 z-index 视觉置顶,松手后再真正调整 DOM/z 序。
      node.style.zIndex = "9999";
      e.stopPropagation();
    });
    node.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      // 用最新指针坐标在 rAF 中合帧渲染,减少同帧多次布局,更跟手
      lastMoveX = e.clientX;
      lastMoveY = e.clientY;
      if (moveRaf !== null) return;
      moveRaf = window.requestAnimationFrame(() => {
        moveRaf = null;
        const dx = (lastMoveX - sx) / this.scale;
        const dy = (lastMoveY - sy) / this.scale;
        for (const [id, o] of dragOrigin) {
          const item = this.store.getItem(id);
          const p = item?.layouts[this.boardId];
          const el = this.cardEls.get(id);
          if (!p || !el) continue;
          p.x = o.x + dx;
          p.y = o.y + dy;
          el.style.left = `${p.x}px`;
          el.style.top = `${p.y}px`;
        }
        for (const [id, o] of dragElOrigin) {
          const be = this.store
            .boardElements(this.boardId)
            .find((x) => x.id === id);
          const dom = this.elEls.get(id);
          if (!be || !dom) continue;
          be.x = o.x + dx;
          be.y = o.y + dy;
          dom.style.left = `${be.x}px`;
          dom.style.top = `${be.y}px`;
        }
      });
    });
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (moveRaf !== null) {
        window.cancelAnimationFrame(moveRaf);
        moveRaf = null;
      }
      node.removeClass("is-dragging");
      node.style.zIndex = "";
      try {
        node.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      // 拖动结束后再真正置顶(DOM 移动 + z 序落库)
      this.bringToFront(it, node);
      // 位置全部 quiet 落库:拖动过程中 DOM 已就位,
      // 触发全量通知会导致画布 renderAll 重建(整屏闪一下),纯浪费
      const ids = [...dragOrigin.keys()];
      for (const id of ids) {
        const p = this.store.getItem(id)?.layouts[this.boardId];
        if (p) this.store.setLayout(id, this.boardId, { ...p }, true);
      }
      for (const id of dragElOrigin.keys()) {
        const be = this.store
          .boardElements(this.boardId)
          .find((x) => x.id === id);
        if (be)
          this.store.updateBoardElement(this.boardId, id, { x: be.x, y: be.y }, true);
      }
    };
    node.addEventListener("pointerup", endDrag);
    node.addEventListener("pointercancel", endDrag);

    // ---- 右下角缩放手柄(图片/视频等比;音频/链接自由缩放) ----
    const handle = node.createDiv({ cls: "ghub-cnode-resize" });
    setIcon(handle, "move-diagonal-2");
    let resizing = false;
    let rw = 0;
    let rh = 0;
    let rsy = 0;
    node.addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest(".ghub-cnode-resize")) return;
      resizing = true;
      sx = e.clientX;
      rsy = e.clientY;
      const cur = it.layouts[this.boardId]!;
      rw = cur.w || DEFAULT_CARD_W;
      rh = cur.h ?? node.offsetHeight;
      node.setPointerCapture(e.pointerId);
      e.stopPropagation();
      e.preventDefault();
    });
    node.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      const cur = it.layouts[this.boardId]!;
      cur.w = Math.max(60, rw + (e.clientX - sx) / this.scale);
      if (freeform) {
        // 音频/链接:宽高独立
        cur.h = Math.max(40, rh + (e.clientY - rsy) / this.scale);
        node.style.width = `${cur.w}px`;
        node.style.height = `${cur.h}px`;
      } else {
        cur.h = null; // 保持宽高比
        node.style.width = `${cur.w}px`;
        node.style.height = `${cur.w * ratio}px`;
      }
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

    // ---- 右键菜单(在选中集内右键 = 作用于整个选中集) ----
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const inSelection =
        this.selectedIds.has(it.id) && this.selectionSize() > 1;
      const menu = new Menu();
      if (inSelection) {
        menu.addItem((mi) =>
          mi
            .setTitle(t("deleteSelection", { n: this.selectionSize() }))
            .setIcon("trash-2")
            .onClick(() => this.deleteSelection())
        );
        menu.showAtMouseEvent(e);
        return;
      }
      menu.addItem((mi) =>
        mi.setTitle(t("bringToFront")).setIcon("arrow-up-to-line").onClick(() => {
          this.bringToFront(it, node);
        })
      );
      menu.addItem((mi) =>
        mi.setTitle(t("sendToBack")).setIcon("arrow-down-to-line").onClick(() => {
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
        mi.setTitle(t("openDetail")).setIcon("info").onClick(() => {
          new DetailModal(this.app, this.store, it, this.getTheme()).open();
        })
      );
      menu.addSeparator();
      menu.addItem((mi) =>
        mi.setTitle(t("removeFromBoard")).setIcon("x").onClick(() => {
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
      const flat = it.type === "audio" || it.type === "link" || it.type === "note";
      const pos: LayoutPos = {
        x: center.x - DEFAULT_CARD_W / 2 + (i % 4) * 40,
        y: center.y - 120 + Math.floor(i / 4) * 40 + i * 12,
        w: flat ? 240 : DEFAULT_CARD_W,
        h: flat ? (it.type === "audio" ? 96 : it.type === "note" ? 140 : 56) : null,
        z: maxZ + 1 + i,
      };
      this.store.setLayout(it.id, this.boardId, pos, i < items.length - 1);
      added++;
    });
    return added;
  }
}
