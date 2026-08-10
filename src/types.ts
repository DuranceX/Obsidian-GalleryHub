/** 与 docs/03-数据设计.md 对应的类型契约 */

export type ItemType = "image" | "video" | "link";

export interface GenMeta {
  prompt: string;
  negativePrompt: string;
  model: string;
  seed: string;
  steps: number | null;
  cfg: number | null;
  sampler: string;
  size: string;
  extra: Record<string, unknown>;
}

export interface LayoutPos {
  x: number;
  y: number;
  w: number;
  h: number | null;
  z: number;
}

export interface GalleryItem {
  id: string;
  type: ItemType;
  createdAt: string;
  modifiedAt: string;
  /** image/video:仓库相对路径 */
  path?: string;
  /** link:外部 URL */
  url?: string;
  /** 导入前原始文件名 */
  fileName?: string;
  hash?: string | null;
  /** 原始像素尺寸(导入时捕获,用于瀑布流预留空间防 CLS) */
  w?: number;
  h?: number;
  title: string;
  note: string;
  tags: string[];
  rating: number;
  source: string;
  gen: GenMeta;
  layouts: Record<string, LayoutPos>;
}

export interface BoardMeta {
  name: string;
  createdAt: string;
}

export interface GalleryData {
  version: number;
  boards: Record<string, BoardMeta>;
  items: GalleryItem[];
}

export const SCHEMA_VERSION = 1;

export function emptyGen(): GenMeta {
  return {
    prompt: "",
    negativePrompt: "",
    model: "",
    seed: "",
    steps: null,
    cfg: null,
    sampler: "",
    size: "",
    extra: {},
  };
}

export function emptyData(): GalleryData {
  return {
    version: SCHEMA_VERSION,
    boards: {
      "b-default": { name: "默认画布", createdAt: new Date().toISOString() },
    },
    items: [],
  };
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];
const VIDEO_EXTS = ["mp4", "webm", "mov", "m4v", "ogv"];

export function typeFromExt(ext: string): ItemType | null {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.includes(e)) return "image";
  if (VIDEO_EXTS.includes(e)) return "video";
  return null;
}

export function newId(): string {
  // 8 位 base36,无第三方依赖
  let s = "";
  while (s.length < 8) s += Math.random().toString(36).slice(2);
  return s.slice(0, 8);
}
