import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";
import { loadEnv, resolvePluginDir } from "./scripts/vault-dir.mjs";

const prod = process.argv[2] === "production";

// 开发模式:直接输出到 Obsidian 仓库插件目录,配合 Hot-Reload 即改即生效。
// 目录来自环境变量(见 .env / .env.example),各平台各自配置,不写死路径。
let outfile = "dist/main.js";
if (!prod) {
  loadEnv();
  const vaultPluginDir = resolvePluginDir();
  fs.mkdirSync(vaultPluginDir, { recursive: true });
  fs.copyFileSync("manifest.json", path.join(vaultPluginDir, "manifest.json"));
  fs.copyFileSync("styles.css", path.join(vaultPluginDir, "styles.css"));
  outfile = path.join(vaultPluginDir, "main.js");
  console.log(`[dev] 输出到插件目录: ${vaultPluginDir}`);
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
