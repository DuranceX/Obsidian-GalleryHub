import { App, Notice, normalizePath } from "obsidian";
import { GalleryStore, ASSETS_DIR } from "./store";
import {
  GalleryItem,
  emptyGen,
  newId,
  typeFromExt,
} from "./types";

/** 从二进制数据读取图片像素尺寸(失败返回 null,不阻塞导入) */
async function probeImageSize(
  buf: ArrayBuffer
): Promise<{ w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(new Blob([buf]));
    const size = { w: bmp.width, h: bmp.height };
    bmp.close();
    return size;
  } catch {
    return null;
  }
}

/** 导入外部文件(File 对象,来自 <input type=file> 或拖拽)到 assets/ 并入库 */
export class Importer {
  constructor(private app: App, private store: GalleryStore) {}

  private monthBucket(): string {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${d.getFullYear()}-${mm}`;
  }

  async importFiles(files: FileList | File[]): Promise<number> {
    const batch: GalleryItem[] = [];
    for (const file of Array.from(files)) {
      try {
        const item = await this.buildItem(file);
        if (item) batch.push(item);
      } catch (e) {
        new Notice(`导入 ${file.name} 失败:${(e as Error).message}`, 6000);
      }
    }
    // 整批一次性入库:单次刷新、单次保存
    this.store.addItems(batch);
    if (batch.length) new Notice(`已导入 ${batch.length} 个资产`);
    return batch.length;
  }

  /** 落盘并构造条目,不直接入库(由 importFiles 批量提交) */
  private async buildItem(file: File): Promise<GalleryItem | null> {
    const ext = file.name.split(".").pop() ?? "";
    const type = typeFromExt(ext);
    if (!type) {
      new Notice(`跳过不支持的格式:${file.name}`);
      return null;
    }
    const id = newId();
    const bucket = this.monthBucket();
    const dir = normalizePath(`${ASSETS_DIR}/${bucket}`);
    const ad = this.app.vault.adapter;
    if (!(await ad.exists(dir))) await ad.mkdir(dir);
    const dest = normalizePath(`${dir}/${id}.${ext.toLowerCase()}`);
    const buf = await file.arrayBuffer();
    await ad.writeBinary(dest, buf);
    const size = type === "image" ? await probeImageSize(buf) : null;

    const now = new Date().toISOString();
    return {
      id,
      type,
      createdAt: now,
      modifiedAt: now,
      path: dest,
      fileName: file.name,
      hash: null,
      w: size?.w,
      h: size?.h,
      title: file.name.replace(/\.[^.]+$/, ""),
      note: "",
      tags: [],
      rating: 0,
      source: "",
      gen: emptyGen(),
      layouts: {},
    };
  }

  /** 登记仓库内已有文件(不复制,原地登记) */
  async registerVaultFile(vaultPath: string): Promise<boolean> {
    const ext = vaultPath.split(".").pop() ?? "";
    const type = typeFromExt(ext);
    if (!type) {
      new Notice(`不支持的格式:${vaultPath}`);
      return false;
    }
    const exists = this.store
      .getItems()
      .some((it) => it.path === vaultPath);
    if (exists) {
      new Notice("该文件已在库中");
      return false;
    }
    const now = new Date().toISOString();
    const name = vaultPath.split("/").pop() ?? vaultPath;
    let size: { w: number; h: number } | null = null;
    if (type === "image") {
      try {
        const buf = await this.app.vault.adapter.readBinary(vaultPath);
        size = await probeImageSize(buf);
      } catch {
        /* ignore */
      }
    }
    this.store.addItem({
      id: newId(),
      type,
      createdAt: now,
      modifiedAt: now,
      path: vaultPath,
      fileName: name,
      hash: null,
      w: size?.w,
      h: size?.h,
      title: name.replace(/\.[^.]+$/, ""),
      note: "",
      tags: [],
      rating: 0,
      source: "",
      gen: emptyGen(),
      layouts: {},
    });
    return true;
  }

  addLink(url: string, title: string): boolean {
    if (!/^https?:\/\//i.test(url)) {
      new Notice("请输入 http(s) 链接");
      return false;
    }
    const now = new Date().toISOString();
    this.store.addItem({
      id: newId(),
      type: "link",
      createdAt: now,
      modifiedAt: now,
      url,
      title: title || url.replace(/^https?:\/\//, "").split("/")[0],
      note: "",
      tags: [],
      rating: 0,
      source: "",
      gen: emptyGen(),
      layouts: {},
    });
    return true;
  }
}
