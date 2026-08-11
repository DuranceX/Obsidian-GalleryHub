import { App, Notice, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { GalleryStore, ASSETS_DIR } from "./store";
import {
  GalleryItem,
  emptyGen,
  newId,
  typeFromExt,
} from "./types";
import { t } from "./i18n";
import { ThumbCache } from "./thumbs";

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

/** 批量导入进度回调 */
export type ImportProgressFn = (
  current: number,
  total: number,
  fileName: string
) => void;

/** 导入外部文件(File 对象,来自 <input type=file> 或拖拽)到 assets/ 并入库 */
export class Importer {
  constructor(private app: App, private store: GalleryStore) {}

  /** 缩略图缓存(main 注入;删除条目时清理缓存) */
  thumbs: ThumbCache | null = null;

  /** 视图注册的进度监听(页面内进度条);未注册时静默导入 */
  onProgress: ImportProgressFn | null = null;
  /** 导入结束(无论成败)回调,用于收起进度条 */
  onProgressDone: (() => void) | null = null;

  async importFiles(
    files: FileList | File[],
    folder?: string
  ): Promise<number> {
    const list = Array.from(files);
    const batch: GalleryItem[] = [];
    const showProgress = list.length > 3;
    try {
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        if (showProgress) this.onProgress?.(i + 1, list.length, file.name);
        try {
          const item = await this.buildItem(file, folder);
          if (item) batch.push(item);
        } catch (e) {
          new Notice(t("importFailed", { name: file.name, msg: (e as Error).message }), 6000);
        }
      }
    } finally {
      if (showProgress) this.onProgressDone?.();
    }
    // 整批一次性入库:单次刷新、单次保存
    this.store.addItems(batch);
    if (batch.length) new Notice(t("importedN", { n: batch.length }));
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
      // 非视觉资产(pdf/psd/canvas/md…):不复制,做成 link 卡片引用原系统路径。
      // Electron 下 File.path 是系统绝对路径;取不到则跳过。
      const sysPath = (file as File & { path?: string }).path;
      if (!sysPath) {
        new Notice(t("unsupportedFormat", { name: file.name }));
        return null;
      }
      const now = new Date().toISOString();
      return {
        id: newId(),
        type: "link",
        createdAt: now,
        modifiedAt: now,
        url: sysPath,
        // 导入时若正浏览某文件夹,link 卡片逻辑归属到该文件夹
        folder: folder || undefined,
        title: file.name.replace(/\.[^.]+$/, ""),
        fileName: file.name,
        note: "",
        tags: [],
        rating: 0,
        source: "",
        gen: emptyGen(),
        layouts: {},
      };
    }
    const id = newId();
    // 目标目录:调用方传入的文件夹(通常为用户当前选中目录),否则 assets 根
    const dir = normalizePath(folder ? `${ASSETS_DIR}/${folder}` : ASSETS_DIR);
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
      new Notice(t("unsupportedFormatPath", { path: vaultPath }));
      return false;
    }
    const exists = this.store
      .getItems()
      .some((it) => it.path === vaultPath);
    if (exists) {
      new Notice(t("alreadyInLibrary"));
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

  /** 新建链接卡片。target 可为 http(s) 网址 / 仓库相对路径 / 系统绝对路径 */
  addLink(target: string, title: string): boolean {
    const url = target.trim();
    if (!url) {
      new Notice(t("enterUrlOrPath"));
      return false;
    }
    const now = new Date().toISOString();
    // 自动标题:网址取域名,路径取文件名
    const autoTitle = /^https?:\/\//i.test(url)
      ? url.replace(/^https?:\/\//, "").split("/")[0]
      : (url.split(/[\\/]/).pop() || url).replace(/\.[^.]+$/, "");
    this.store.addItem({
      id: newId(),
      type: "link",
      createdAt: now,
      modifiedAt: now,
      url,
      title: title || autoTitle,
      note: "",
      tags: [],
      rating: 0,
      source: "",
      gen: emptyGen(),
      layouts: {},
    });
    return true;
  }

  /** 新建笔记条目(正文存 note 字段,无文件),返回新条目 id */
  addNote(): string {
    const now = new Date().toISOString();
    const id = newId();
    this.store.addItem({
      id,
      type: "note",
      createdAt: now,
      modifiedAt: now,
      title: "",
      note: "",
      tags: [],
      rating: 0,
      source: "",
      gen: emptyGen(),
      layouts: {},
    });
    return id;
  }

  // ================= 文件夹管理(assets/ 目录树 ↔ Hub 文件树) =================
  // 全部使用 assets/ 相对路径("角色/机甲"),"" 表示 assets 根

  /** 递归列出 assets/ 下全部子文件夹(相对路径,含嵌套),按路径排序 */
  async listFolders(): Promise<string[]> {
    const result: string[] = [];
    const root = this.app.vault.getAbstractFileByPath(normalizePath(ASSETS_DIR));
    const walk = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          result.push(child.path.slice(ASSETS_DIR.length + 1));
          walk(child);
        }
      }
    };
    if (root instanceof TFolder) walk(root);
    return result.sort((a, b) => a.localeCompare(b, "zh"));
  }

  /**
   * 在 parent(assets 相对路径,"" 为根)下创建"新建文件夹"式的唯一名子目录。
   * 返回新文件夹的相对路径,失败返回 null。
   */
  async createFolderIn(parent: string): Promise<string | null> {
    const ad = this.app.vault.adapter;
    const base = parent ? `${parent}/` : "";
    let name = t("newFolderDefault");
    let rel = `${base}${name}`;
    let i = 2;
    while (await ad.exists(normalizePath(`${ASSETS_DIR}/${rel}`))) {
      name = `${t("newFolderDefault")} ${i++}`;
      rel = `${base}${name}`;
      if (i > 99) return null;
    }
    try {
      await ad.mkdir(normalizePath(`${ASSETS_DIR}/${rel}`));
      return rel;
    } catch (e) {
      new Notice(t("createFailed", { msg: (e as Error).message }));
      return null;
    }
  }

  /** 确保文件夹存在(rel 为 assets 相对路径,支持多级) */
  async createFolderIfMissing(rel: string): Promise<boolean> {
    const clean = rel.trim().replace(/^\/+|\/+$/g, "");
    if (!clean) return true;
    if (clean.split("/").some((seg) => !this.validFolderName(seg))) return false;
    const dir = normalizePath(`${ASSETS_DIR}/${clean}`);
    const ad = this.app.vault.adapter;
    if (!(await ad.exists(dir))) {
      // 逐级创建
      const parts = clean.split("/");
      let cur = ASSETS_DIR;
      for (const p of parts) {
        cur = `${cur}/${p}`;
        if (!(await ad.exists(normalizePath(cur))))
          await ad.mkdir(normalizePath(cur));
      }
    }
    return true;
  }

  private validFolderName(name: string): boolean {
    if (!name || /[\\/:*?"<>|]/.test(name)) {
      new Notice(t("invalidFolderName"));
      return false;
    }
    return true;
  }

  /** 重命名文件夹(rel → 同级 newName),同步更新库内所有条目 path */
  async renameFolder(rel: string, newName: string): Promise<string | null> {
    const clean = newName.trim();
    if (!this.validFolderName(clean)) return null;
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const newRel = parent ? `${parent}/${clean}` : clean;
    if (newRel === rel) return rel;
    return this.moveFolderTo(rel, newRel);
  }

  /** 移动文件夹到另一文件夹之下(dstParent 为 assets 相对路径或 "") */
  async moveFolder(rel: string, dstParent: string): Promise<string | null> {
    const name = rel.split("/").pop()!;
    const newRel = dstParent ? `${dstParent}/${name}` : name;
    if (newRel === rel) return rel;
    // 禁止移动到自己内部
    if (dstParent === rel || dstParent.startsWith(`${rel}/`)) {
      new Notice(t("folderIntoSelf"));
      return null;
    }
    return this.moveFolderTo(rel, newRel);
  }

  private async moveFolderTo(rel: string, newRel: string): Promise<string | null> {
    const oldPath = normalizePath(`${ASSETS_DIR}/${rel}`);
    const newPath = normalizePath(`${ASSETS_DIR}/${newRel}`);
    const f = this.app.vault.getAbstractFileByPath(oldPath);
    if (!(f instanceof TFolder)) {
      new Notice(t("folderNotFound", { path: rel }));
      return null;
    }
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      new Notice(t("folderExists"));
      return null;
    }
    try {
      await this.app.fileManager.renameFile(f as TAbstractFile, newPath);
    } catch (e) {
      new Notice(t("operationFailed", { msg: (e as Error).message }));
      return null;
    }
    // 同步库内路径前缀(物理文件),以及 link 卡片的逻辑归属字段
    const oldPrefix = `${oldPath}/`;
    for (const it of this.store.getItems()) {
      if (it.path?.startsWith(oldPrefix)) {
        this.store.updateItem(it.id, {
          path: `${newPath}/${it.path.slice(oldPrefix.length)}`,
        });
      } else if (!it.path && it.folder) {
        // link 卡片:folder 用 assets 相对路径形式,按 rel → newRel 前缀重映射
        if (it.folder === rel) {
          this.store.updateItem(it.id, { folder: newRel });
        } else if (it.folder.startsWith(`${rel}/`)) {
          this.store.updateItem(it.id, {
            folder: `${newRel}${it.folder.slice(rel.length)}`,
          });
        }
      }
    }
    return newRel;
  }

  /**
   * 删除文件夹(递归,进系统回收站),库内该目录下条目一并移除。
   * 返回受影响条目数,失败返回 null。
   */
  async deleteFolder(rel: string): Promise<number | null> {
    const path = normalizePath(`${ASSETS_DIR}/${rel}`);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFolder)) {
      new Notice(t("folderNotFound", { path: rel }));
      return null;
    }
    const prefix = `${path}/`;
    // 物理文件在该目录下的条目,以及逻辑归属在该文件夹(含子树)的 link 卡片
    const inSubtree = (folder: string) =>
      folder === rel || folder.startsWith(`${rel}/`);
    const doomed = this.store
      .getItems()
      .filter(
        (it) =>
          it.path?.startsWith(prefix) ||
          (!it.path && it.folder && inSubtree(it.folder))
      )
      .map((it) => it.id);
    try {
      await this.app.vault.trash(f, true);
    } catch (e) {
      new Notice(t("deleteFailed", { msg: (e as Error).message }));
      return null;
    }
    this.store.deleteItems(doomed);
    return doomed.length;
  }

  /** 条目所属文件夹:assets 相对路径("角色/机甲"),根下直存文件与库外/链接 → null */
  folderOf(item: GalleryItem): string | null {
    // link 卡片无物理文件,用逻辑归属字段
    if (!item.path) return item.folder?.trim() ? item.folder.trim() : null;
    const prefix = `${ASSETS_DIR}/`;
    if (!item.path.startsWith(prefix)) return null;
    const rest = item.path.slice(prefix.length);
    const idx = rest.lastIndexOf("/");
    return idx > 0 ? rest.slice(0, idx) : null;
  }

  /**
   * 批量移动条目到 assets/<folder>/(folder 为相对路径,"" 表示根)。
   * 移动物理文件(FileManager 保持链接)并更新条目 path,单次刷新。
   */
  async moveItems(items: GalleryItem[], folder: string): Promise<number> {
    const destDir = normalizePath(
      folder ? `${ASSETS_DIR}/${folder}` : ASSETS_DIR
    );
    const ad = this.app.vault.adapter;
    if (!(await ad.exists(destDir))) await this.createFolderIfMissing(folder);

    let moved = 0;
    for (const it of items) {
      if (!it.path) {
        // link 卡片:无物理文件,只更新逻辑归属字段,不动任何文件
        const cur = it.folder?.trim() ?? "";
        if (cur !== folder) {
          this.store.updateItem(it.id, { folder: folder || undefined });
          moved++;
        }
        continue;
      }
      const fileName = it.path.split("/").pop()!;
      const dest = normalizePath(`${destDir}/${fileName}`);
      if (dest === it.path) continue;
      const f = this.app.vault.getAbstractFileByPath(it.path);
      if (!(f instanceof TFile)) {
        new Notice(t("fileNotFound", { path: it.path }), 5000);
        continue;
      }
      if (await ad.exists(dest)) {
        new Notice(t("destExists", { name: fileName }), 5000);
        continue;
      }
      try {
        await this.app.fileManager.renameFile(f, dest);
        this.store.updateItem(it.id, { path: dest });
        moved++;
      } catch (e) {
        new Notice(t("moveFailed", { name: fileName, msg: (e as Error).message }), 6000);
      }
    }
    if (moved)
      new Notice(t("movedNTo", { n: moved, folder: folder || t("rootDir") }));
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
            new Notice(t("deleteFileFailed", { path: it.path, msg: (e as Error).message }), 6000);
          }
        }
      }
    }
    this.store.deleteItems(items.map((it) => it.id));
    // 清理对应缩略图缓存
    if (this.thumbs) {
      for (const it of items) void this.thumbs.remove(it.id);
    }
    new Notice(
      alsoTrashFiles
        ? t("deletedNTrash", { n: items.length })
        : t("removedNKeep", { n: items.length })
    );
  }
}
