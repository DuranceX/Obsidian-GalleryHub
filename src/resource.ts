import { App, FileSystemAdapter, Notice, Platform, TFile } from "obsidian";
import { t } from "./i18n";
import { GalleryItem } from "./types";

/** 链接目标的三种来源 */
export type TargetKind = "url" | "vault" | "system";

type ElectronShell = typeof import("electron").shell;

/** Electron 仅在桌面端按需加载，避免移动端启动时解析桌面模块。 */
async function loadElectronShell(): Promise<ElectronShell | null> {
  if (!Platform.isDesktopApp) return null;
  try {
    return (await import("electron")).shell;
  } catch {
    return null;
  }
}

async function revealSystemPath(path: string, errorMessage: string): Promise<void> {
  const shell = await loadElectronShell();
  if (!shell) {
    new Notice(errorMessage, 5000);
    return;
  }
  shell.showItemInFolder(path);
}

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
 * - system → 在系统文件管理器中显示
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

  // system:在 Windows Explorer / macOS Finder 中定位文件。
  await revealSystemPath(s, t("fileNotFound", { path: s }));
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
    void revealSystemPath(origin, t("cannotOpenPath"));
    return;
  }
  if (it.path) {
    const adapter = app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice(t("cannotLocateFile"), 5000);
      return;
    }
    const full = adapter.getFullPath(it.path);
    void revealSystemPath(full, t("cannotOpenLocation"));
  }
}

/** 该条目是否有可"打开源文件位置"的目标 */
export function canRevealOrigin(it: GalleryItem): boolean {
  return !!(it.path || it.originPath);
}

/** 可在详情舞台预览的纯文本类扩展名 → 渲染方式 */
const PREVIEW_EXTS: Record<string, "markdown" | "text"> = {
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  json: "text",
  yaml: "text",
  yml: "text",
};

/**
 * 该 link 目标是否可在舞台做只读预览:仅限仓库内的文本类文件
 * (系统路径不走 vault API,不预览)。返回渲染方式,不可预览则 null。
 */
export function previewKind(target: string): "markdown" | "text" | null {
  if (classifyTarget(target) !== "vault") return null;
  const ext = target.split(".").pop()?.toLowerCase() ?? "";
  return PREVIEW_EXTS[ext] ?? null;
}
