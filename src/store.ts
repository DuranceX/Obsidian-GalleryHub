import { App, Notice, normalizePath } from "obsidian";
import {
  GalleryData,
  GalleryItem,
  BoardMeta,
  BoardElement,
  LayoutPos,
  SCHEMA_VERSION,
  emptyData,
  newId,
} from "./types";
import { t } from "./i18n";

/**
 * 数据根目录(仓库相对路径),默认 "GalleryHub"。
 * 可在设置中改为任意路径(如 "xxx/yyy"),插件将在该目录下初始化
 * gallery.json 与 assets/。通过 setDataRoot 在 store.init 前设置。
 */
export let ROOT_DIR = "GalleryHub";
export let DB_PATH = `${ROOT_DIR}/gallery.json`;
export let BAK_PATH = `${ROOT_DIR}/gallery.json.bak`;
export let ASSETS_DIR = `${ROOT_DIR}/assets`;

export function setDataRoot(root: string): void {
  const clean = normalizePath(root.trim().replace(/^\/+|\/+$/g, "")) || "GalleryHub";
  ROOT_DIR = clean;
  DB_PATH = `${ROOT_DIR}/gallery.json`;
  BAK_PATH = `${ROOT_DIR}/gallery.json.bak`;
  ASSETS_DIR = `${ROOT_DIR}/assets`;
}

const SAVE_DEBOUNCE_MS = 500;

/**
 * 数据层:gallery.json 的唯一读写入口。
 * - 防抖保存,写前每会话备份一次 .bak
 * - JSON 损坏时进入只读模式,绝不覆盖
 * - 变更通过订阅回调通知 UI
 */
export class GalleryStore {
  private app: App;
  private data: GalleryData = emptyData();
  private listeners = new Set<() => void>();
  private itemListeners = new Set<(id: string) => void>();
  private saveTimer: number | null = null;
  private backedUpThisSession = false;
  /** 本插件自己写文件时置位,用于区分外部修改 */
  private selfWriting = false;
  readOnly = false;
  loaded = false;

  constructor(app: App) {
    this.app = app;
  }

  // ---------- 生命周期 ----------

  async init(): Promise<void> {
    const ad = this.app.vault.adapter;
    // 支持多级路径逐级创建(如 xxx/yyy/GalleryHub)
    const parts = normalizePath(ROOT_DIR).split("/");
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await ad.exists(normalizePath(cur)))) {
        await ad.mkdir(normalizePath(cur));
      }
    }
    if (!(await ad.exists(normalizePath(ASSETS_DIR)))) {
      await ad.mkdir(normalizePath(ASSETS_DIR));
    }
    if (!(await ad.exists(normalizePath(DB_PATH)))) {
      this.data = emptyData();
      await this.writeNow();
      this.loaded = true;
      return;
    }
    await this.load();
  }

  async load(): Promise<void> {
    const ad = this.app.vault.adapter;
    try {
      const raw = await ad.read(normalizePath(DB_PATH));
      const parsed = JSON.parse(raw) as GalleryData;
      if (typeof parsed.version !== "number" || !Array.isArray(parsed.items)) {
        throw new Error(t("dataCorrupt"));
      }
      if (parsed.version > SCHEMA_VERSION) {
        this.readOnly = true;
        new Notice(
          t("versionTooNew", { v: parsed.version, s: SCHEMA_VERSION }),
          8000
        );
      }
      // 跳过损坏条目
      parsed.items = parsed.items.filter(
        (it) => it && it.id && it.type && it.createdAt
      );
      this.data = parsed;
      this.loaded = true;
      this.readOnly = this.readOnly || false;
      this.emit();
    } catch (e) {
      this.readOnly = true;
      this.loaded = false;
      new Notice(t("loadFailed", { msg: (e as Error).message }), 0);
    }
  }

  /** 外部(如 OneDrive 同步)修改了 db 文件时调用 */
  isSelfWriting(): boolean {
    return this.selfWriting;
  }

  // ---------- 订阅 ----------

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 单条目元数据变更(编辑标题/标签/评分/prompt 等)的细粒度订阅。
   * 有订阅者时 updateItem 不再触发全量 onChange,避免详情页每敲一个字
   * 整个画廊重建(所有卡片闪一下)。
   */
  onItemChange(fn: (id: string) => void): () => void {
    this.itemListeners.add(fn);
    return () => this.itemListeners.delete(fn);
  }

  private emitItem(id: string): void {
    if (this.itemListeners.size === 0) {
      this.emit(); // 无细粒度订阅者时退回全量通知
      return;
    }
    for (const fn of this.itemListeners) fn(id);
  }

  private emitItems(ids: string[]): void {
    if (!ids.length) return;
    if (this.itemListeners.size === 0) {
      this.emit();
      return;
    }
    for (const id of ids) {
      for (const fn of this.itemListeners) fn(id);
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ---------- 读 ----------

  getItems(): readonly GalleryItem[] {
    return this.data.items;
  }

  getItem(id: string): GalleryItem | undefined {
    return this.data.items.find((it) => it.id === id);
  }

  getAssetHashIndexVersion(): number {
    return this.data.assetHashIndexVersion ?? 0;
  }

  allTags(): string[] {
    const set = new Set<string>();
    for (const it of this.data.items) for (const t of it.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b, "zh"));
  }

  /** 从库内所有条目移除某标签,返回受影响条目数(单次通知与保存) */
  removeTagEverywhere(tag: string): number {
    if (this.guardReadOnly()) return 0;
    let changed = 0;
    const now = new Date().toISOString();
    for (const it of this.data.items) {
      const idx = it.tags.indexOf(tag);
      if (idx >= 0) {
        it.tags.splice(idx, 1);
        it.modifiedAt = now;
        changed++;
      }
    }
    if (changed) {
      this.emit();
      this.scheduleSave();
    }
    return changed;
  }

  // ---------- 画布(boards) ----------

  getBoards(): Record<string, BoardMeta> {
    return this.data.boards;
  }

  createBoard(name: string): string | null {
    if (this.guardReadOnly()) return null;
    const id = "b-" + newId();
    this.data.boards[id] = {
      name: name.trim() || t("unnamedBoard"),
      createdAt: new Date().toISOString(),
    };
    this.emit();
    this.scheduleSave();
    return id;
  }

  renameBoard(id: string, name: string): void {
    if (this.guardReadOnly()) return;
    const b = this.data.boards[id];
    if (!b || !name.trim()) return;
    b.name = name.trim();
    this.emit();
    this.scheduleSave();
  }

  /** 删除画布:条目 layouts 中该画布的位置一并清除 */
  deleteBoard(id: string): void {
    if (this.guardReadOnly()) return;
    if (!this.data.boards[id]) return;
    if (Object.keys(this.data.boards).length <= 1) return; // 至少保留一个
    delete this.data.boards[id];
    for (const it of this.data.items) {
      if (it.layouts[id]) delete it.layouts[id];
    }
    this.emit();
    this.scheduleSave();
  }

  /** 画布上条目(带布局) */
  itemsOnBoard(boardId: string): GalleryItem[] {
    return this.data.items.filter((it) => it.layouts[boardId]);
  }

  // ---------- 画布元素(文字/画框) ----------

  boardElements(boardId: string): BoardElement[] {
    return this.data.boards[boardId]?.elements ?? [];
  }

  addBoardElement(boardId: string, el: Omit<BoardElement, "id">): string | null {
    if (this.guardReadOnly()) return null;
    const b = this.data.boards[boardId];
    if (!b) return null;
    const id = "e-" + newId();
    (b.elements ??= []).push({ ...el, id });
    this.emit();
    this.scheduleSave();
    return id;
  }

  updateBoardElement(
    boardId: string,
    elId: string,
    patch: Partial<BoardElement>,
    quiet = false
  ): void {
    if (this.guardReadOnly()) return;
    const el = this.data.boards[boardId]?.elements?.find((e) => e.id === elId);
    if (!el) return;
    Object.assign(el, patch);
    if (!quiet) this.emit();
    this.scheduleSave();
  }

  deleteBoardElement(boardId: string, elId: string): void {
    if (this.guardReadOnly()) return;
    const b = this.data.boards[boardId];
    if (!b?.elements) return;
    const idx = b.elements.findIndex((e) => e.id === elId);
    if (idx < 0) return;
    b.elements.splice(idx, 1);
    this.emit();
    this.scheduleSave();
  }

  /**
   * 写入布局。quiet=true 时不触发订阅刷新(拖拽过程 DOM 已就位,
   * 全量重渲染反而闪烁),仅防抖落盘。
   */
  setLayout(
    itemId: string,
    boardId: string,
    pos: LayoutPos | null,
    quiet = false
  ): void {
    if (this.guardReadOnly()) return;
    const it = this.getItem(itemId);
    if (!it) return;
    if (pos === null) delete it.layouts[boardId];
    else it.layouts[boardId] = pos;
    it.modifiedAt = new Date().toISOString();
    if (!quiet) this.emit();
    this.scheduleSave();
  }

  // ---------- 写 ----------

  addItem(item: GalleryItem): void {
    if (this.guardReadOnly()) return;
    this.data.items.push(item); // 文件内保持插入(时间)顺序,展示排序由视图决定
    this.emit();
    this.scheduleSave();
  }

  /** 批量入库:单次通知与单次保存,避免导入多文件时逐条全量刷新 */
  addItems(items: GalleryItem[]): void {
    if (this.guardReadOnly()) return;
    if (!items.length) return;
    this.data.items.push(...items);
    this.emit();
    this.scheduleSave();
  }

  updateItem(id: string, patch: Partial<GalleryItem>): void {
    if (this.guardReadOnly()) return;
    const it = this.getItem(id);
    if (!it) return;
    Object.assign(it, patch, { modifiedAt: new Date().toISOString() });
    this.emitItem(id);
    this.scheduleSave();
  }

  /** 批量更新条目并只保存一次；索引元数据可选择不改 modifiedAt、不刷新 UI。 */
  updateItems(
    patches: Array<{ id: string; patch: Partial<GalleryItem> }>,
    options: { touchModifiedAt?: boolean; notify?: boolean } = {}
  ): number {
    if (!patches.length) return 0;
    if (this.guardReadOnly()) return 0;
    const touchModifiedAt = options.touchModifiedAt ?? true;
    const notify = options.notify ?? true;
    const changed: string[] = [];
    const now = new Date().toISOString();
    for (const { id, patch } of patches) {
      const item = this.getItem(id);
      if (!item) continue;
      Object.assign(item, patch);
      if (touchModifiedAt) item.modifiedAt = now;
      changed.push(id);
    }
    if (!changed.length) return 0;
    if (notify) this.emitItems(changed);
    this.scheduleSave();
    return changed.length;
  }

  setAssetHashIndexVersion(version: number): void {
    if (this.guardReadOnly()) return;
    if (this.data.assetHashIndexVersion === version) return;
    this.data.assetHashIndexVersion = version;
    this.scheduleSave();
  }

  deleteItem(id: string): void {
    if (this.guardReadOnly()) return;
    const idx = this.data.items.findIndex((it) => it.id === id);
    if (idx < 0) return;
    this.data.items.splice(idx, 1);
    this.emit();
    this.scheduleSave();
  }

  /** 批量移除:单次通知与单次保存 */
  deleteItems(ids: string[]): void {
    if (this.guardReadOnly()) return;
    const set = new Set(ids);
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((it) => !set.has(it.id));
    if (this.data.items.length === before) return;
    this.emit();
    this.scheduleSave();
  }

  private guardReadOnly(): boolean {
    if (this.readOnly) {
      new Notice(t("readOnlyNotice"));
      return true;
    }
    return false;
  }

  // ---------- 持久化 ----------

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.writeNow();
    }, SAVE_DEBOUNCE_MS);
  }

  /** 供插件卸载时强制落盘 */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.writeNow();
    }
  }

  private async writeNow(): Promise<void> {
    if (this.readOnly) return;
    const ad = this.app.vault.adapter;
    this.selfWriting = true;
    try {
      // 每会话首写前备份
      if (
        !this.backedUpThisSession &&
        (await ad.exists(normalizePath(DB_PATH)))
      ) {
        const old = await ad.read(normalizePath(DB_PATH));
        await ad.write(normalizePath(BAK_PATH), old);
        this.backedUpThisSession = true;
      }
      const json = JSON.stringify(this.data, null, 2);
      await ad.write(normalizePath(DB_PATH), json);
    } catch (e) {
      new Notice(t("saveFailed", { msg: (e as Error).message }), 8000);
    } finally {
      // 延迟复位,躲过 vault modify 事件的回调时序
      window.setTimeout(() => (this.selfWriting = false), 200);
    }
  }
}
