# Obsidian-GalleryHub

Obsidian 美术资产画廊插件:统一管理图片、视频、链接与 AI 生图 prompt 元数据,支持筛选、搜索,规划中的画布策展模式。

## 状态

**V1(画廊 MVP)已实现**,详见 [docs/04-ROADMAP.md](docs/04-ROADMAP.md)。

## 文档

| 编号 | 文档 |
|---|---|
| 01 | [需求文档](docs/01-需求文档.md) |
| 02 | [技术方案](docs/02-技术方案.md) |
| 03 | [数据设计](docs/03-数据设计.md) |
| 04 | [ROADMAP](docs/04-ROADMAP.md) |

## 开发

```bash
npm install
npm run dev      # watch 模式,产物直接输出到 Obsidian 仓库插件目录(路径见 esbuild.config.mjs)
npm run build    # 生产构建 → dist/main.js
npm run deploy   # 复制 manifest/main.js/styles.css 到 Obsidian 插件目录
```

数据层(`GalleryHub/gallery.json` + `assets/`)存放于 Obsidian 仓库内,随云同步;本工程仅存源码。

## 架构一览

```
src/
├── main.ts       插件入口:视图注册、命令、外部修改检测
├── view.ts       GalleryView:网格画廊、筛选、搜索、拖拽导入
├── store.ts      数据层:gallery.json 读写、防抖保存、备份与只读保护
├── importer.ts   导入:复制入 assets/、仓库文件登记、链接添加
├── detail.ts     详情/编辑弹窗、添加链接弹窗
└── types.ts      数据契约(与 docs/03-数据设计.md 对应)
```
