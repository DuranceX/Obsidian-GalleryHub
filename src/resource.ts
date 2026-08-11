import { App, Notice, TFile } from "obsidian";
import { t } from "./i18n";
import { GalleryItem } from "./types";

/** 链接目标的三种来源 */
export type TargetKind = "url" | "vault" | "system";

/**
 * 判定一个链接目标属于哪种来源:
 * - url:http(s) 网址
 * - system:系统绝对路径(Unix 以 / 开头,Windows 形如 C:\ 或 \\ 网络路径)
 * - vault:其余按仓库相对路径处理
 */
export function classifyTarget(target: string): TargetKind {
  const s = (target || "").trim();
  if (/^https?:\/\//i.test(s)) return "url";
  if (/^\//.test(s) || /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s)) return "system";
  return "vault";
}

/** 该目标应使用的线形图标(Lucide) */
export function targetIcon(target: string): string {
  switch (classifyTarget(target)) {
    case "url":
      return "link";
    case "vault":
      return "file-symlink";
    case "system":
      return "hard-drive";
  }
}

/**
 * 智能打开链接目标:
 * - url → 浏览器
 * - vault → Obsidian 原生打开(md 可编辑、canvas 跳 Canvas、pdf/图片走对应查看器)
 * - system → 交给操作系统默认程序
 * 找不到文件时给出错误提示(换设备后系统路径失效等)。
 */
export async function openResource(app: App, target: string): Promise<void> {
  const s = (target || "").trim();
  if (!s) return;
  const kind = classifyTarget(s);

  if (kind === "url") {
    window.open(s);
    return;
  }

  if (kind === "vault") {
    const f = app.vault.getAbstractFileByPath(s);
    if (f instanceof TFile) {
      void app.workspace.getLeaf(true).openFile(f);
    } else {
      new Notice(t("fileNotFound", { path: s }), 5000);
    }
    return;
  }

  // system:用系统默认程序打开,失败(路径不存在等)则提示
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { shell } = require("electron");
    const err: string = await shell.openPath(s);
    if (err) new Notice(t("fileNotFound", { path: s }), 5000);
  } catch {
    new Notice(t("fileNotFound", { path: s }), 5000);
  }
}

/**
 * 打开条目本体:等效详情面板的打开按钮。
 * link → 智能分发(openResource);其余在 Obsidian 打开库内文件。
 */
export function openItem(app: App, it: GalleryItem): void {
  if (it.type === "link") {
    if (it.url) void openResource(app, it.url);
    return;
  }
  if (it.path) {
    const f = app.vault.getAbstractFileByPath(it.path);
    if (f instanceof TFile) void app.workspace.getLeaf(true).openFile(f);
    else new Notice(t("fileNotFound", { path: it.path }), 5000);
  }
}

/** 该条目是否有可"打开"的目标(用于决定是否显示打开菜单项) */
export function canOpen(it: GalleryItem): boolean {
  return it.type === "link" ? !!it.url : !!it.path;
}

/**
 * 打开源文件位置:自定义 originPath 优先(URL 开浏览器 / 路径在资源管理器中显示),
 * 否则把库内文件在资源管理器中显示。
 */
export function revealOrigin(app: App, it: GalleryItem): void {
  const origin = it.originPath?.trim();
  if (origin) {
    if (/^https?:\/\//i.test(origin)) {
      window.open(origin);
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { shell } = require("electron");
      void shell.showItemInFolder(origin);
    } catch {
      new Notice(t("cannotOpenPath"), 5000);
    }
    return;
  }
  if (it.path) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { shell } = require("electron");
      const adapter = app.vault.adapter as { getFullPath?: (p: string) => string };
      const full = adapter.getFullPath?.(it.path);
      if (full) void shell.showItemInFolder(full);
      else new Notice(t("cannotLocateFile"), 5000);
    } catch {
      new Notice(t("cannotOpenLocation"), 5000);
    }
  }
}

/** 该条目是否有可"打开源文件位置"的目标 */
export function canRevealOrigin(it: GalleryItem): boolean {
  return !!(it.path || it.originPath);
}
