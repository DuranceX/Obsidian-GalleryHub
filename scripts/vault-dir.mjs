// 跨平台解析 Obsidian 插件输出目录,供 esbuild.config.mjs 与 deploy.mjs 共用。
// 目录不写死在代码里,而是各机器通过 .env 指定,兼容 Windows / macOS / Linux。
import fs from "fs";
import os from "os";
import path from "path";

const PLUGIN_ID = "gallery-hub";

/**
 * 极简 .env 解析:把仓库根目录 .env 里的键值读进 process.env(不覆盖已存在的)。
 * 不引第三方依赖,足够本项目使用。
 */
export function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // 去掉可选的成对引号
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

/** 展开开头的 ~ 为用户主目录 */
function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * 解析最终的插件目录(.../.obsidian/plugins/gallery-hub)。
 * 支持两种环境变量:
 *   OBSIDIAN_PLUGIN_DIR —— 直接指向插件目录本身
 *   OBSIDIAN_PLUGINS_DIR —— 指向 plugins 父目录,自动拼上插件 id
 */
export function resolvePluginDir() {
  const dir = process.env.OBSIDIAN_PLUGIN_DIR?.trim();
  const pluginsDir = process.env.OBSIDIAN_PLUGINS_DIR?.trim();

  let resolved;
  if (dir) {
    resolved = expandHome(dir);
  } else if (pluginsDir) {
    resolved = path.join(expandHome(pluginsDir), PLUGIN_ID);
  } else {
    console.error(
      [
        "✗ 未配置 Obsidian 插件目录。",
        "  请在仓库根目录创建 .env(可复制 .env.example),并设置其一:",
        "    OBSIDIAN_PLUGIN_DIR=<...>/.obsidian/plugins/gallery-hub",
        "    OBSIDIAN_PLUGINS_DIR=<...>/.obsidian/plugins",
      ].join("\n")
    );
    process.exit(1);
  }

  return path.resolve(resolved);
}
