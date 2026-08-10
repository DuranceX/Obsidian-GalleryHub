# GalleryHub

> An art asset gallery plugin for Obsidian — manage images, videos, audio and links together with AI generation prompts. Waterfall gallery + infinite canvas for curation, with 100% of your data staying in your local vault.
>
> Obsidian 美术资产画廊插件 —— 统一管理图片、视频、音频、链接与 AI 生图 prompt 元数据,瀑布流画廊 + 无限画布策展,数据 100% 留在本地仓库。[跳转中文说明 ↓](#galleryhub-中文)

![version](https://img.shields.io/badge/version-0.9.3-e8b04b) ![obsidian](https://img.shields.io/badge/Obsidian-%E2%89%A51.5.0-8b6cef) ![license](https://img.shields.io/badge/license-MIT-green)

## Why

Art assets end up scattered everywhere: AI-generated images and their prompts, photography, reference images, video/audio clips, inspiration links… Existing tools each cover only a slice — Eagle/Billfish are asset libraries with no canvas and closed data formats; PureRef is a canvas that doesn't manage a long-term library; Firefly Boards / Figma Weave attach prompts but keep your assets in the cloud. **Nothing covers four asset types + prompt metadata + local data ownership at once.**

GalleryHub brings it all into Obsidian: data (JSON + original files) lives inside your vault and syncs with whatever you already use, browsing lives next to your notes, and everything stays portable forever.

## Features

### Gallery (waterfall/masonry)
- **Four asset types**: images / videos (hover to play) / audio (inline player) / links
- **True masonry layout**: aspect ratios preserved, dimensions captured at import to prevent layout shift, column count adapts to pane width
- **Filtering**: folder tree / boards / type / multi-select star rating / tag cloud — each module can be toggled in settings
- **Search** across title, prompt, note and file name; **sorting** by import time, title, rating or type
- **Multi-select & batch ops**: Ctrl+click / checkmark / Space to select; batch move, delete (optionally to system trash), edit tags (append/replace/remove) and rating, send to board

### Folder tree
- Full mapping of the `assets/` directory tree with nested expand/collapse
- Context menu: new subfolder (inline rename), rename (F2), delete (to trash)
- Drag & drop: move folders, drop cards into folders (whole selection), drop OS files onto a folder for targeted import
- Library paths stay in sync after rename/move — nothing breaks

### Infinite canvas (PureRef-style curation)
- Pan (Space/middle-click), zoom at pointer (0.05x–8x), marquee selection with group drag
- Cards: drag, proportional resize, bring to front / send to back, double-click for details
- **The same asset can live on multiple boards with independent layouts**
- Text and frame annotations: inline editing, font size & bold, 8-color palette
- Drop files straight onto the canvas — they're imported and placed where you dropped them
- Multiple boards: create / rename / delete, quick access from the sidebar

### Detail lightbox
- Large viewer: click to zoom to native size, drag to pan; prev/next navigation (buttons or ←/→)
- Inline title editing, star rating, tag chips editor, source link, custom source file location
- **AI generation section** (collapsible): prompt / negative (one-click copy), model / seed
- Actions: open original in Obsidian, open in browser, reveal in system explorer, remove from library

### Themes & language
- **Dark** (charcoal + amber) / **Light** (warm white + gold) / follow Obsidian
- UI in **English and 中文**, defaults to following Obsidian's language

## Data design

```
Your vault/
└── GalleryHub/            # location configurable in settings
    ├── gallery.json        # the single database (open schema, versioned)
    ├── gallery.json.bak    # automatic per-session backup
    └── assets/             # original files, organized in folders
```

- Plain text + original files — readable without the plugin, portable forever
- Debounced saves, write-ahead backup, read-only guard on corruption, auto-reload on external (cloud-sync) changes
- Each item records: path, title, tags, rating, source, note, `gen` (prompt/negative/model/seed…), `layouts` (per-board positions)

## Installation

Not yet in the community store — manual install:

1. Grab `manifest.json` / `main.js` / `styles.css` from a release (or build them yourself)
2. Put them in `<vault>/.obsidian/plugins/gallery-hub/`
3. Settings → Community plugins → enable **GalleryHub**
4. Click the ribbon icon; the data folder is created automatically on first run

## Development

```bash
npm install
npm run dev      # watch build, outputs straight into your vault's plugin folder (path in esbuild.config.mjs)
npm run build    # production build → dist/main.js
npm run deploy   # copy manifest / main.js / styles.css into the plugin folder
```

Code and data are fully separated: this repo holds only source; assets and the database live in your vault.

### Architecture

```
src/
├── main.ts       plugin entry: view registration, commands, settings, theme/locale
├── view.ts       GalleryView: masonry, sidebar (tree/boards/filters), multi-select, mode switch
├── canvas.ts     CanvasBoard: infinite canvas (pan/zoom/cards/text/frames/palette)
├── store.ts      data layer: gallery.json I/O, debounced saves, backups, boards & elements CRUD
├── importer.ts   import & file ops: ingest, folder tree operations, batch move/delete
├── detail.ts     detail lightbox and all dialogs (link/folder/confirm/batch edit)
├── i18n.ts       lightweight dictionary (en/zh) with typed keys
└── types.ts      data contracts and defaults
```

## Roadmap

- [x] **V1** Gallery MVP: masonry, filter & search, detail editing, import
- [x] **V2** Infinite canvas: multi-board, text/frame annotations, send-to-board
- [ ] **V3** Automation: auto-extract embedded generation params from PNGs (A1111/ComfyUI), hash dedupe, Markdown gallery export
- [ ] **V4+** Mobile polish, JPEG/XMP metadata, note linking, community store release

## License

MIT © [DuranceX](https://github.com/DuranceX)

---

# GalleryHub(中文)

## 为什么做这个

美术资产散落各处:AI 生图的产物和 prompt、摄影照片、参考图、视频音频素材、灵感链接……现成工具各管一段——Eagle/Billfish 是素材库但无画布、数据格式封闭;PureRef 是画布但不管理长期库;Firefly Boards/Figma Weave 能挂 prompt 但资产在云端。**没有一个工具能同时覆盖四类资产 + prompt 元数据 + 本地数据主权。**

GalleryHub 把这些整合进 Obsidian:数据(JSON + 原始文件)存在仓库里随你的云盘同步,展示与知识库同处一个应用,永远可迁移。

## 功能

### 画廊(瀑布流)
- **四类资产**:图片 / 视频(悬停播放)/ 音频(内嵌播放器)/ 链接
- **JS 最矮列瀑布流**:保持宽高比、导入时记录尺寸防布局跳动、列数随面板宽度自适应
- **筛选**:文件树 / 画布 / 类型 / 评分多选 / 标签云,模块可在设置中开关
- **搜索**:标题、prompt、备注、文件名全文匹配;**排序**:导入时间、标题、评分、类型
- **多选与批量**:Ctrl+点击/圆钮/空格多选,批量移动、删除(可选进回收站)、编辑标签与星级、发送到画布

### 文件树
- `assets/` 目录树完整映射,嵌套展开/折叠
- 右键:新建子文件夹(原地内联重命名)/ 重命名(F2)/ 删除(进回收站)
- 拖拽:文件夹移动、卡片拖入文件夹(多选整批)、系统文件拖到文件夹定向导入
- 重命名/移动后库内路径自动同步,不断链

### 无限画布(PureRef 式策展)
- 平移(空格/中键)、以指针为中心缩放(0.05x–8x)、框选与群体拖动
- 卡片拖拽/等比缩放/置顶置底,双击开详情
- **同一资产可上多个画布,位置尺寸各自独立**
- 文字与画框标注:双击编辑、字号与加粗、8 色色板
- 文件直接拖入画布即导入并落在放置点;多画布管理,侧边栏一键直达

### 详情 Lightbox
- 大图查看:点击放大到原始尺寸、拖动平移;左右切换(按钮或 ←/→)
- 标题内联编辑、星级点选、标签 chips、来源链接、自定义源文件位置
- **AI 生成参数分区**(可折叠):Prompt / Negative(一键复制)、模型 / Seed
- 操作:在 Obsidian 打开、浏览器打开、资源管理器定位、从库移除

### 主题与语言
- **暗色**(深炭+琥珀)/ **浅色**(暖白+金)/ 跟随 Obsidian
- 界面支持**中文与英文**,默认跟随 Obsidian 语言

## 数据设计

```
Obsidian 仓库/
└── GalleryHub/            # 位置可在设置中修改
    ├── gallery.json        # 唯一数据库(公开 schema,带版本号)
    ├── gallery.json.bak    # 每会话自动备份
    └── assets/             # 资产原件,可按文件夹组织
```

- 纯文本 + 原始文件,不依赖插件即可读取,永远可迁移
- 防抖保存、写前备份、损坏时只读保护、外部修改(云同步)自动重载
- 条目记录:路径、标题、标签、评分、来源、备注、`gen`(prompt 等)、`layouts`(每画布独立布局)

## 安装

尚未上架社区市场,手动安装:

1. 下载 Release(或自行构建)得到 `manifest.json` / `main.js` / `styles.css`
2. 放入仓库 `.obsidian/plugins/gallery-hub/`
3. 设置 → 第三方插件 → 启用 **GalleryHub**
4. 点击左侧 ribbon 图标打开;首次启动自动创建数据目录

## 开发

见上方英文 [Development](#development) 一节,命令与架构相同。

## License

MIT © [DuranceX](https://github.com/DuranceX)
