import {
  App,
  FileSystemAdapter,
  Platform,
  normalizePath,
} from "obsidian";
import {
  SystemFileId,
  SystemFileIds,
  SystemFilePlatform,
} from "./types";

export interface SystemFileObservation {
  platform: SystemFilePlatform;
  value: SystemFileId;
}

export function currentSystemFilePlatform(): SystemFilePlatform | null {
  if (!Platform.isDesktopApp) return null;
  if (Platform.isWin) return "windows";
  if (Platform.isMacOS) return "macos";
  if (Platform.isLinux) return "linux";
  return null;
}

/** 桌面本地仓库读取文件系统身份；移动端和非文件系统仓库自动降级。 */
export async function readSystemFileObservation(
  app: App,
  vaultPath: string
): Promise<SystemFileObservation | null> {
  const platform = currentSystemFilePlatform();
  const adapter = app.vault.adapter;
  if (!platform || !(adapter instanceof FileSystemAdapter)) return null;
  try {
    // Obsidian 插件加载器提供 CommonJS require；浏览器原生 dynamic import
    // 无法解析 node: 协议。放在桌面判断之后，移动端不会执行该分支。
    const { stat } = require("node:fs/promises") as typeof import("node:fs/promises");
    const stats = await stat(adapter.getFullPath(normalizePath(vaultPath)), {
      bigint: true,
    });
    if (!stats.isFile() || stats.ino === 0n) return null;
    return {
      platform,
      value: {
        volumeId: stats.dev.toString(),
        fileId: stats.ino.toString(),
      },
    };
  } catch {
    return null;
  }
}

export function sameSystemFileId(
  left: SystemFileId | undefined,
  right: SystemFileId | undefined
): boolean {
  return (
    !!left &&
    !!right &&
    left.volumeId === right.volumeId &&
    left.fileId === right.fileId
  );
}

/** 当前平台只保留一份身份，其余平台记录原样保留。 */
export function withSystemFileObservation(
  existing: SystemFileIds | undefined,
  observation: SystemFileObservation
): SystemFileIds {
  return {
    ...existing,
    [observation.platform]: observation.value,
  };
}

export function systemFileObservationKey(
  observation: SystemFileObservation
): string {
  return `${observation.platform}:${observation.value.volumeId}:${observation.value.fileId}`;
}
