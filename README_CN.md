# GalleryHub

[English](README.md) | **中文**

> Obsidian 美术资产画廊插件 —— 统一管理图片、视频、音频、链接与 AI 生图 prompt 元数据,瀑布流画廊 + 无限画布策展,数据 100% 留在本地仓库。

![version](https://img.shields.io/badge/version-0.11.2-e8b04b) ![obsidian](https://img.shields.io/badge/Obsidian-%E2%89%A51.5.0-8b6cef) ![license](https://img.shields.io/badge/license-MIT-green)

## 预览

**画廊** —— 瀑布流浏览 + 侧边栏筛选(暗色 / 浅色):

![画廊预览](docs/screenshot/Gallery-split.png)

**画布** —— PureRef 式策展板,支持文字与画框标注:

![画布预览](docs/screenshot/Canvas-split.png)

## 为什么做这个

美术资产散落各处:AI 生图的产物和 prompt、摄影照片、参考图、视频音频素材、灵感链接……现成工具各管一段——Eagle/Billfish 是素材库但无画布、数据格式封闭;PureRef 是画布但不管理长期库;Firefly Boards/Figma Weave 能挂 prompt 但资产在云端。**没有一个工具能同时覆盖四类资产 + prompt 元数据 + 本地数据主权。**

GalleryHub 把这些整合进 Obsidian:数据(JSON + 原始文件)存在仓库里随你的云盘同步,展示与知识库同处一个应用,永远可迁移。

## 功能

### 画廊(瀑布流)
- **四类资产**:图片 / 视频(悬停播放)/ 音频(内嵌播放器)/ 链接
- **JS 最矮列瀑布流**:保持宽高比、导入时记录尺寸防布局跳动、列数随面板宽度自适应
- **筛选**:文件树 / 画布 / 类型 / 评分多选 / 标签云,模块可在设置中开关
- **搜索**:标题、prompt、备注、文件名全文匹配;**排序**:导入时间、标题、评分、类型
- **多选与批量**:Ctrl+点击/圆钮/空格多选,批量移动、删除(可选进回收站)、编辑标签(追加/替换/移除)与星级、发送到画布

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

```bash
npm install
npm run dev      # watch 构建,产物直接输出到 Obsidian 仓库插件目录(路径见 esbuild.config.mjs)
npm run build    # 生产构建 → dist/main.js
npm run deploy   # 复制 manifest / main.js / styles.css 到插件目录
```

工程与数据彻底分离:本仓库只有源码,资产与数据库存在 Obsidian 仓库内。

### 架构

```
src/
├── main.ts       插件入口:视图注册、命令、设置页、主题/语言
├── view.ts       GalleryView:瀑布流、侧边栏(文件树/画布/筛选)、多选、模式切换
├── canvas.ts     CanvasBoard:无限画布(平移缩放/卡片/文字/画框/色板)
├── store.ts      数据层:gallery.json 读写、防抖保存、备份、画布与元素 CRUD
├── importer.ts   导入与文件管理:入库、文件夹树操作、批量移动/删除
├── detail.ts     详情 Lightbox 与全部弹窗(链接/选文件夹/确认/批量编辑)
├── i18n.ts       轻量词典(中/英,类型化 key)
└── types.ts      数据契约与默认值
```

## License

MIT © [DuranceX](https://github.com/DuranceX)
