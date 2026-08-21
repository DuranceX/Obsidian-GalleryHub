import { App, normalizePath } from "obsidian";
import { GalleryItem } from "./types";
import { ROOT_DIR } from "./store";

/** 缩略图最长边(卡片 220px 宽,2x 屏冗余) */
const THUMB_MAX = 512;
/** WebP 质量 */
const QUALITY = 0.8;
/** 并发生成上限(避免批量补生成时卡 UI) */
const CONCURRENCY = 2;

/** 可生成缩略图的图片扩展名(gif 保留动画、svg 本身小,均直接用原图) */
const THUMBABLE = ["png", "jpg", "jpeg", "webp", "avif", "bmp"];

export function thumbsDir(): string {
  return `${ROOT_DIR}/.thumbs`;
}

/**
 * 缩略图缓存:.thumbs/{id}.webp,可随时整目录删除重建。
 * - has():同步查询(init 时索引一次目录)
 * - ensure():缺失时排队后台生成,完成后回调(视图借此原位换图)
 */
export class ThumbCache {
  private app: App;
  /** 已存在缩略图的条目 id */
  private ready = new Set<string>();
  /** 生成中/排队中的 id(防重复入队) */
  private pending = new Set<string>();
  private queue: Array<{ item: GalleryItem; onDone: (path: string) => void }> =
    [];
  private running = 0;

  constructor(app: App) {
    this.app = app;
  }

  async init(): Promise<void> {
    const ad = this.app.vault.adapter;
    const dir = normalizePath(thumbsDir());
    if (!(await ad.exists(dir))) {
      await ad.mkdir(dir);
      return;
    }
    try {
      const listing = await ad.list(dir);
      this.ready.clear();
      for (const f of listing.files) {
        const name = f.split("/").pop() ?? "";
        if (name.endsWith(".webp")) this.ready.add(name.slice(0, -5));
      }
    } catch {
      /* 索引失败按空缓存处理 */
    }
  }

  /** 该条目是否适用缩略图(仅静态图片类型) */
  supports(item: GalleryItem): boolean {
    if (item.type !== "image" || !item.path) return false;
    const ext = item.path.split(".").pop()?.toLowerCase() ?? "";
    return THUMBABLE.includes(ext);
  }

  has(id: string): boolean {
    return this.ready.has(id);
  }

  path(id: string): string {
    return normalizePath(`${thumbsDir()}/${id}.webp`);
  }

  /** 缺失时排队生成;完成后回调缩略图 vault 路径 */
  ensure(item: GalleryItem, onDone: (path: string) => void): void {
    if (!this.supports(item) || this.ready.has(item.id)) return;
    if (this.pending.has(item.id)) return;
    this.pending.add(item.id);
    this.queue.push({ item, onDone });
    this.pump();
  }

  /** 删除条目时清理其缩略图 */
  async remove(id: string): Promise<void> {
    this.ready.delete(id);
    const p = this.path(id);
    const ad = this.app.vault.adapter;
    try {
      if (await ad.exists(p)) await ad.remove(p);
    } catch {
      /* ignore */
    }
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void this.generate(job.item)
        .then((ok) => {
          if (ok) {
            this.ready.add(job.item.id);
            job.onDone(this.path(job.item.id));
          }
        })
        .finally(() => {
          this.pending.delete(job.item.id);
          this.running--;
          this.pump();
        });
    }
  }

  /** 读取原图 → 等比缩放 → WebP 写入 .thumbs/ */
  private async generate(item: GalleryItem): Promise<boolean> {
    if (!item.path) return false;
    const ad = this.app.vault.adapter;
    try {
      const buf = await ad.readBinary(normalizePath(item.path));
      const bmp = await createImageBitmap(new Blob([buf]));
      try {
        // 原图本就不大时无需缩略图,直接用原图
        if (Math.max(bmp.width, bmp.height) <= THUMB_MAX) return false;
        const scale = THUMB_MAX / Math.max(bmp.width, bmp.height);
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = createEl("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;
        ctx.drawImage(bmp, 0, 0, w, h);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/webp", QUALITY)
        );
        if (!blob) return false;
        await ad.writeBinary(this.path(item.id), await blob.arrayBuffer());
        return true;
      } finally {
        bmp.close();
      }
    } catch {
      return false;
    }
  }
}
