// 将构建成品复制到 Obsidian 仓库的插件目录
// 用法: npm run build && npm run deploy
import fs from "fs";
import path from "path";

const VAULT_PLUGIN_DIR =
  "C:/Users/Cardy/OneDrive/Mine/Obsidian/.obsidian/plugins/gallery-hub";

const files = [
  ["manifest.json", "manifest.json"],
  ["styles.css", "styles.css"],
  ["dist/main.js", "main.js"],
];

fs.mkdirSync(VAULT_PLUGIN_DIR, { recursive: true });

for (const [src, dst] of files) {
  if (!fs.existsSync(src)) {
    console.error(`✗ 缺少 ${src},请先运行 npm run build`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(VAULT_PLUGIN_DIR, dst));
  console.log(`✓ ${src} -> ${path.join(VAULT_PLUGIN_DIR, dst)}`);
}
console.log("部署完成。在 Obsidian 中启用/重载 GalleryHub 插件即可。");
