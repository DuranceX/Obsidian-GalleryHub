import { App, Notice, TFile } from "obsidian";
import { t } from "./i18n";

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
