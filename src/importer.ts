import { App, Notice, TFile, normalizePath } from "obsidian";
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

  async importFiles(
    files: FileList | File[],
    folder?: string
  ): Promise<number> {
    const batch: GalleryItem[] = [];
    for (const file of Array.from(files)) {
      try {
        const item = await this.buildItem(file, folder);
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
  private async buildItem(
    file: File,
    folder?: string
  ): Promise<GalleryItem | null> {
    const ext = file.name.split(".").pop() ?? "";
    const type = typeFromExt(ext);
    if (!type) {
      new Notice(`跳过不支持的格式:${file.name}`);
      return null;
    }
    const id = newId();
    const bucket = folder ?? this.monthBucket();
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

  // ================= 文件夹管理(assets/ 子目录 ↔ Hub 文件夹) =================

  /** 列出 assets/ 下所有子文件夹名 */
  async listFolders(): Promise<string[]> {
    const ad = this.app.vault.adapter;
    try {
      const listing = await ad.list(normalizePath(ASSETS_DIR));
      return listing.folders
        .map((f) => f.split("/").pop() ?? "")
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "zh"));
    } catch {
      return [];
    }
  }

  /** 在 assets/ 下创建子文件夹 */
  async createFolder(name: string): Promise<boolean> {
    const clean = name.trim();
    if (!this.validFolderName(clean)) return false;
    const dir = normalizePath(`${ASSETS_DIR}/${clean}`);
    const ad = this.app.vault.adapter;
    if (await ad.exists(dir)) {
      new Notice("同名文件夹已存在");
      return false;
    }
    await ad.mkdir(dir);
    return true;
  }

  /** 确保文件夹存在(选择已有文件夹或新建均可走此入口) */
  async createFolderIfMissing(name: string): Promise<boolean> {
    const clean = name.trim();
    if (!this.validFolderName(clean)) return false;
    const dir = normalizePath(`${ASSETS_DIR}/${clean}`);
    const ad = this.app.vault.adapter;
    if (!(await ad.exists(dir))) await ad.mkdir(dir);
    return true;
  }

  private validFolderName(name: string): boolean {
    if (!name || /[\\/:*?"<>|]/.test(name)) {
      new Notice("文件夹名不能为空或包含 \\ / : * ? \" < > |");
      return false;
    }
    return true;
  }

  /** 条目所属文件夹(assets/<folder>/file → folder;库外文件/链接 → null) */
  folderOf(item: GalleryItem): string | null {
    if (!item.path) return null;
    const prefix = `${ASSETS_DIR}/`;
    if (!item.path.startsWith(prefix)) return null;
    const rest = item.path.slice(prefix.length);
    const idx = rest.indexOf("/");
    return idx > 0 ? rest.slice(0, idx) : null;
  }

  /**
   * 批量移动条目到 assets/<folder>/。
   * 移动物理文件(FileManager 保持链接)并更新条目 path,单次刷新。
   */
  async moveItems(items: GalleryItem[], folder: string): Promise<number> {
    const destDir = normalizePath(`${ASSETS_DIR}/${folder}`);
    const ad = this.app.vault.adapter;
    if (!(await ad.exists(destDir))) await ad.mkdir(destDir);

    let moved = 0;
    for (const it of items) {
      if (!it.path) continue; // 链接类型无文件
      const fileName = it.path.split("/").pop()!;
      const dest = normalizePath(`${destDir}/${fileName}`);
      if (dest === it.path) continue;
      const f = this.app.vault.getAbstractFileByPath(it.path);
      if (!(f instanceof TFile)) {
        new Notice(`找不到文件:${it.path}`, 5000);
        continue;
      }
      if (await ad.exists(dest)) {
        new Notice(`目标已存在同名文件,跳过:${fileName}`, 5000);
        continue;
      }
      try {
        await this.app.fileManager.renameFile(f, dest);
        this.store.updateItem(it.id, { path: dest });
        moved++;
      } catch (e) {
        new Notice(`移动 ${fileName} 失败:${(e as Error).message}`, 6000);
      }
    }
    if (moved) new Notice(`已移动 ${moved} 个资产到「${folder}」`);
    return moved;
  }

  /**
   * 批量删除:从库中移除,可选同时删除物理文件(进系统回收站)。
   */
  async deleteItems(items: GalleryItem[], alsoTrashFiles: boolean): Promise<void> {
    if (alsoTrashFiles) {
      for (const it of items) {
        if (!it.path) continue;
        const f = this.app.vault.getAbstractFileByPath(it.path);
        if (f instanceof TFile) {
          try {
            await this.app.vault.trash(f, true); // 系统回收站,可恢复
          } catch (e) {
            new Notice(`删除文件失败:${it.path}(${(e as Error).message})`, 6000);
          }
        }
      }
    }
    this.store.deleteItems(items.map((it) => it.id));
    new Notice(
      alsoTrashFiles
        ? `已删除 ${items.length} 项(文件已移入回收站)`
        : `已从库中移除 ${items.length} 项(原文件保留)`
    );
  }
}
