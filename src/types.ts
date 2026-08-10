/** 与 docs/03-数据设计.md 对应的类型契约 */

export type ItemType = "image" | "video" | "audio" | "link";

/** 插件颜色模式 */
export type ColorMode = "light" | "dark" | "follow";

/** 画廊排序方式(页面内选择,非设置项) */
export type SortMode =
  | "created-desc"
  | "created-asc"
  | "title-asc"
  | "rating-desc"
  | "type";

export interface GalleryHubSettings {
  colorMode: ColorMode;
  /** 数据文件夹(仓库相对路径):在此目录下初始化 gallery.json 与 assets/,默认 "GalleryHub" */
  dataFolder: string;
  /** 侧边栏模块开关 */
  showFolders: boolean;
  showBoards: boolean;
  showTypes: boolean;
  showRatings: boolean;
  showTags: boolean;
  /** 物理删除时跳过二次确认 */
  skipDeleteConfirm: boolean;
}

export const DEFAULT_SETTINGS: GalleryHubSettings = {
  colorMode: "dark",
  dataFolder: "GalleryHub",
  showFolders: true,
  showBoards: true,
  showTypes: true,
  showRatings: true,
  showTags: true,
  skipDeleteConfirm: false,
};

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
  /** 自定义源文件位置(系统绝对路径或 URL);空 = 默认用库内文件位置 */
  originPath?: string;
  gen: GenMeta;
  layouts: Record<string, LayoutPos>;
}

export interface BoardMeta {
  name: string;
  createdAt: string;
  /** 画布元素(文字/画框),可选字段向后兼容 */
  elements?: BoardElement[];
}

/** 画布上的注释元素 */
export interface BoardElement {
  id: string;
  kind: "text" | "frame";
  x: number;
  y: number;
  w: number;
  h: number;
  /** text: 文字内容;frame: 框标题 */
  text: string;
  /** 颜色(色板 key 或 CSS 颜色),空 = 默认(文字随主题/框用琥珀) */
  color?: string;
}

/** 画布元素预设色板 */
export const ELEMENT_COLORS: Array<[string, string]> = [
  ["", "默认"],
  ["#e8b04b", "琥珀"],
  ["#e06c5b", "绯红"],
  ["#6fbf73", "松绿"],
  ["#5b9dd9", "湖蓝"],
  ["#a06cd5", "紫藤"],
  ["#d95b9a", "桃粉"],
  ["#9a9791", "石灰"],
];

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
const AUDIO_EXTS = ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"];

export function typeFromExt(ext: string): ItemType | null {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.includes(e)) return "image";
  if (VIDEO_EXTS.includes(e)) return "video";
  if (AUDIO_EXTS.includes(e)) return "audio";
  return null;
}

export function newId(): string {
  // 8 位 base36,无第三方依赖
  let s = "";
  while (s.length < 8) s += Math.random().toString(36).slice(2);
  return s.slice(0, 8);
}
