import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";

const prod = process.argv[2] === "production";

// 开发模式:直接输出到 Obsidian 仓库插件目录,配合 Hot-Reload 即改即生效
const VAULT_PLUGIN_DIR =
  "C:/Users/Cardy/OneDrive/Mine/Obsidian/.obsidian/plugins/gallery-hub";

const outfile = prod ? "dist/main.js" : path.join(VAULT_PLUGIN_DIR, "main.js");

// 开发模式下确保插件目录存在,并同步 manifest / styles
if (!prod) {
  fs.mkdirSync(VAULT_PLUGIN_DIR, { recursive: true });
  fs.copyFileSync("manifest.json", path.join(VAULT_PLUGIN_DIR, "manifest.json"));
  fs.copyFileSync("styles.css", path.join(VAULT_PLUGIN_DIR, "styles.css"));
}

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
