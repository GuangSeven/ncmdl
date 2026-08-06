#!/usr/bin/env node

const fs = require("node:fs");
const readline = require("node:readline/promises");
const { stdin, stdout, exit } = require("node:process");
const { parseArgs } = require("node:util");

const {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  maskSecret,
  saveConfig
} = require("./config");
const { version: APP_VERSION } = require("../package.json");
const {
  DEFAULT_USER_AGENT,
  buildSongOutputPath,
  downloadFile,
  getSongDetail,
  normalizeQuality,
  parseSongId,
  resolveDownloadUrl
} = require("./netease");
const { autoCaptureCookie } = require("./cookie");

function printHelp() {
  stdout.write(`ncmdl - 网易云音乐终端版下载脚本

用法:
  node src/cli.js setup
  node src/cli.js cookie          ← 自动打开浏览器抓取 Cookie
  node src/cli.js download <歌曲ID或链接>
  node src/cli.js config show

可用参数:
  --cookie         覆盖配置里的 Cookie
  --user-agent     覆盖配置里的 User-Agent
  --quality        覆盖默认音质
  --out            覆盖下载目录
  --pattern        文件名模式: artist-title | title-artist | title
  -h, --help       显示帮助

交互模式:
  直接运行 node src/cli.js 进入交互式菜单
`);
}

function printMenu() {
  stdout.write(`
╔══════════════════════════════════════════════╗
║       网易云音乐终端版下载工具 v${APP_VERSION}       ║
╠══════════════════════════════════════════════╣
║  1. 抓取 Cookie (自动打开浏览器登录)        ║
║  2. 手动输入配置                             ║
║  3. 下载歌曲                                 ║
║  4. 查看配置                                 ║
║  5. 重置配置                                 ║
║  0. 退出                                     ║
╚══════════════════════════════════════════════╝
`);
}

async function handleMenuChoice(choice, config) {
  switch (choice) {
    case "1":
      stdout.write("\n正在启动浏览器抓取 Cookie...\n");
      try {
        const cookieStr = await autoCaptureCookie({ headless: false });
        if (!cookieStr) {
          throw new Error("未能获取到 Cookie，请重试。");
        }
        config.cookie = cookieStr;
        await saveConfig(config);
        stdout.write("\nCookie 已保存到本地配置。\n");
        stdout.write(`Cookie: ${maskSecret(cookieStr)}\n`);
      } catch (err) {
        console.error(`抓取 Cookie 失败: ${err.message}`);
      }
      return { continue: true, config };

    case "2":
      config = await setupWizard(config);
      return { continue: true, config };

    case "3":
      const targetInput = await askVisible("请输入歌曲 ID 或链接");
      if (!targetInput) {
        stdout.write("未输入歌曲 ID 或链接，返回菜单。\n");
        return { continue: true, config };
      }
      if (config.cookie) {
        stdout.write(`当前 Cookie: ${maskSecret(config.cookie)}\n`);
        const keepCookie = await askVisible("是否使用当前 Cookie？(y/n)", "y");
        if (keepCookie.toLowerCase() !== "y") {
          const newCookie = await askHidden("请粘贴新的网易云网页 Cookie");
          if (newCookie) {
            config.cookie = newCookie;
            await saveConfig(config);
          } else {
            stdout.write("未获取到新 Cookie，本次不下载，返回菜单。\n");
            return { continue: true, config };
          }
        }
      } else {
        config.cookie = await resolveCookie(config, { cookie: "" });
      }
      if (!config.cookie) {
        stdout.write("缺少 Cookie，无法下载。请先抓取或手动输入 Cookie。\n");
        return { continue: true, config };
      }
      try {
        await downloadSongFlow(targetInput, config);
      } catch (err) {
        console.error(`下载失败: ${err.message}`);
      }
      return { continue: true, config };

    case "4":
      showConfig(config);
      return { continue: true, config };

    case "5":
      const confirm = await askVisible("确认重置所有配置？(y/n)", "n");
      if (confirm.toLowerCase() === "y") {
        await saveConfig(DEFAULT_CONFIG);
        config = Object.assign({}, DEFAULT_CONFIG);
        stdout.write("配置已重置。\n");
      } else {
        stdout.write("已取消重置。\n");
      }
      return { continue: true, config };

    case "0":
      stdout.write("再见！\n");
      return { continue: false, config };

    default:
      stdout.write("无效的选择，请重新输入。\n");
      return { continue: true, config };
  }
}

function hasInteractiveStdin() {
  if (stdin.isTTY) {
    return true;
  }
  try {
    const stat = fs.fstatSync(stdin.fd);
    return !(stat.isCharacterDevice() || stat.isFile() || stat.isDirectory());
  } catch {
    return false;
  }
}

async function interactiveMenu() {
  let config = await loadConfig();
  config = mergeRuntimeConfig(config, {
    cookie: process.env.NCM_COOKIE || "",
    userAgent: process.env.NCM_USER_AGENT || "",
    quality: process.env.NCM_QUALITY || "",
    out: process.env.NCM_DOWNLOAD_DIR || "",
    pattern: process.env.NCM_FILENAME_PATTERN || ""
  });

  while (true) {
    printMenu();
    const choice = await askVisible("请选择功能 (0-5)");
    if (stdinEof && !choice) {
      stdout.write("输入已结束，退出。\n");
      break;
    }
    const result = await handleMenuChoice(choice, config);
    config = result.config;
    if (!result.continue) break;
    stdout.write("\n");
  }
}

let persistentRl = null;
let stdinEof = false;
let lineWaiter = null;
const lineQueue = [];

function ensurePersistentRl() {
  if (persistentRl) {
    return;
  }
  persistentRl = readline.createInterface({ input: stdin });
  persistentRl.on("line", (line) => {
    lineQueue.push(line);
    if (lineWaiter) {
      const wake = lineWaiter;
      lineWaiter = null;
      wake();
    }
  });
  persistentRl.on("close", () => {
    stdinEof = true;
    if (lineWaiter) {
      const wake = lineWaiter;
      lineWaiter = null;
      wake();
    }
  });
}

async function askVisible(question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  if (stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(`${question}${suffix}: `);
    rl.close();
    return answer.trim() || defaultValue;
  }
  ensurePersistentRl();
  if (stdinEof && lineQueue.length === 0) {
    return "";
  }
  stdout.write(`${question}${suffix}: `);
  while (lineQueue.length === 0 && !stdinEof) {
    await new Promise((resolve) => {
      lineWaiter = resolve;
    });
  }
  const raw = lineQueue.length ? lineQueue.shift() : "";
  return raw.trim() || defaultValue;
}

function processHiddenInput(buffer, text) {
  for (const char of text) {
    if (char === "\u0003") {
      return "exit";
    }
    if (char === "\r" || char === "\n" || char === "\u0004") {
      return "finish";
    }
    if (char === "\u007f") {
      buffer.pop();
      continue;
    }
    buffer.push(char);
  }
  return "continue";
}

async function askHidden(question) {
  if (!stdin.isTTY) {
    stdout.write("提示：当前为非交互模式（stdin 非 TTY），无法输入隐藏文本（Cookie）。\n");
    return "";
  }
  return new Promise((resolve) => {
    stdout.write(`${question}: `);
    const buffer = [];
    const onData = (chunk) => {
      const result = processHiddenInput(buffer, chunk.toString("utf8"));
      if (result === "exit") {
        exit(130);
        return;
      }
      if (result === "finish") {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdout.write("\n");
        resolve(buffer.join("").trim());
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

function mergeRuntimeConfig(baseConfig, values) {
  return Object.assign({}, baseConfig, {
    cookie: values.cookie || baseConfig.cookie || "",
    userAgent: values.userAgent || baseConfig.userAgent || DEFAULT_USER_AGENT,
    quality: normalizeQuality(values.quality || baseConfig.quality || DEFAULT_CONFIG.quality),
    downloadDir: values.out || baseConfig.downloadDir || DEFAULT_CONFIG.downloadDir,
    filenamePattern: values.pattern || baseConfig.filenamePattern || DEFAULT_CONFIG.filenamePattern
  });
}

async function setupWizard(currentConfig) {
  stdout.write("本地配置向导会把信息保存到 ~/.ncmdl/config.json\n");
  const cookie = await askHidden("请输入网易云网页 Cookie");
  const userAgent = await askVisible("请输入 User-Agent", currentConfig.userAgent || DEFAULT_USER_AGENT);
  const downloadDir = await askVisible("请输入下载目录", currentConfig.downloadDir || DEFAULT_CONFIG.downloadDir);
  const quality = await askVisible("请输入默认音质", currentConfig.quality || DEFAULT_CONFIG.quality);
  const filenamePattern = await askVisible("请输入文件名模式", currentConfig.filenamePattern || DEFAULT_CONFIG.filenamePattern);
  const nextConfig = Object.assign({}, currentConfig, {
    cookie: cookie || currentConfig.cookie || "",
    userAgent: userAgent || currentConfig.userAgent || DEFAULT_USER_AGENT,
    downloadDir: downloadDir || currentConfig.downloadDir || DEFAULT_CONFIG.downloadDir,
    quality: normalizeQuality(quality || currentConfig.quality || DEFAULT_CONFIG.quality),
    filenamePattern: filenamePattern || currentConfig.filenamePattern || DEFAULT_CONFIG.filenamePattern
  });
  await saveConfig(nextConfig);
  stdout.write("配置已保存。\n");
  return nextConfig;
}

function showConfig(config) {
  stdout.write(`配置文件: ${CONFIG_PATH}\n`);
  stdout.write(`Cookie: ${maskSecret(config.cookie)}\n`);
  stdout.write(`User-Agent: ${config.userAgent || ""}\n`);
  stdout.write(`下载目录: ${config.downloadDir || ""}\n`);
  stdout.write(`默认音质: ${config.quality || ""}\n`);
  stdout.write(`文件名模式: ${config.filenamePattern || ""}\n`);
}

async function resolveCookie(config, values) {
  const cookie = values.cookie || config.cookie || "";
  if (cookie) {
    return cookie;
  }
  if (!stdin.isTTY) {
    return "";
  }
  stdout.write("未检测到 Cookie，需要登录态才能请求网易云接口。\n");
  return askHidden("请粘贴网易云网页 Cookie");
}

async function downloadSongFlow(targetInput, config) {
  const songId = parseSongId(targetInput);
  if (!songId) {
    throw new Error("请输入有效的歌曲 ID 或网易云歌曲链接。");
  }
  const detailRes = await getSongDetail(songId, config);
  const song = detailRes?.songs?.[0];
  if (!song) {
    throw new Error(`没有找到歌曲信息，ID: ${songId}`);
  }
  stdout.write(`歌曲: ${song.name || "unknown"}\n`);
  stdout.write(`歌手: ${Array.isArray(song.ar) ? song.ar.map((item) => item.name).join(" / ") : "unknown"}\n`);
  const downloadRes = await resolveDownloadUrl(songId, config.quality, config);
  const outputPath = buildSongOutputPath(song, config, downloadRes.url, "");
  stdout.write(`音质: ${downloadRes.level}\n`);
  stdout.write(`下载地址已获取，开始保存到: ${outputPath}\n`);
  const fileMeta = await downloadFile(downloadRes.url, outputPath, {
    Cookie: config.cookie || "",
    "User-Agent": config.userAgent || DEFAULT_USER_AGENT
  });
  stdout.write(`下载完成: ${outputPath}\n`);
  if (fileMeta.contentType) {
    stdout.write(`文件类型: ${fileMeta.contentType}\n`);
  }
}

async function main() {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      cookie: { type: "string" },
      "user-agent": { type: "string" },
      quality: { type: "string" },
      out: { type: "string" },
      pattern: { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  const positionals = parsed.positionals || [];
  const command = positionals[0] || "download";
  const subcommand = positionals[1] || "";
  const target = command === "config" ? positionals[2] || "" : positionals[1] || "";

  if (parsed.values.help || command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  // 无参数时：TTY 或管道输入（脚本化驱动菜单）才进入交互菜单，
  // 否则保持旧行为打印帮助，避免在 CI / cron 等非交互环境悬空退出
  if (positionals.length === 0 && !parsed.values.cookie && !parsed.values["user-agent"] && !parsed.values.quality && !parsed.values.out && !parsed.values.pattern) {
    if (hasInteractiveStdin()) {
      await interactiveMenu();
    } else {
      printHelp();
    }
    return;
  }

  let config = await loadConfig();
  config = mergeRuntimeConfig(config, {
    cookie: parsed.values.cookie || process.env.NCM_COOKIE || "",
    userAgent: parsed.values["user-agent"] || process.env.NCM_USER_AGENT || "",
    quality: parsed.values.quality || process.env.NCM_QUALITY || "",
    out: parsed.values.out || process.env.NCM_DOWNLOAD_DIR || "",
    pattern: parsed.values.pattern || process.env.NCM_FILENAME_PATTERN || ""
  });

  if (command === "cookie") {
    stdout.write("自动抓取 Cookie — 将打开浏览器窗口，请在页面中登录网易云音乐。\n");
    stdout.write("登录完成后脚本会自动提取 Cookie 并保存到本地配置。\n\n");
    try {
      const cookieStr = await autoCaptureCookie({ headless: false });
      if (!cookieStr) {
        throw new Error("未能获取到 Cookie，请重试。");
      }
      config.cookie = cookieStr;
      await saveConfig(config);
      stdout.write("\nCookie 已保存到本地配置。\n");
      stdout.write(`Cookie: ${maskSecret(cookieStr)}\n`);
    } catch (err) {
      console.error(`抓取 Cookie 失败: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "setup") {
    await setupWizard(config);
    return;
  }

  if (command === "config" && subcommand === "show") {
    showConfig(config);
    return;
  }

  if (command === "config" && subcommand === "setup") {
    await setupWizard(config);
    return;
  }

  if (command === "config" && subcommand === "clear") {
    await saveConfig(DEFAULT_CONFIG);
    stdout.write("配置已重置。\n");
    return;
  }

  const resolvedTarget = target;
  if (!resolvedTarget) {
    if (stdin.isTTY) {
      const manualTarget = await askVisible("请输入歌曲 ID 或链接");
      config.cookie = await resolveCookie(config, parsed.values);
      if (!config.cookie) {
        throw new Error("缺少 Cookie，无法继续。请先运行 setup 或通过 --cookie / NCM_COOKIE 提供。");
      }
      await downloadSongFlow(manualTarget, config);
      return;
    }
    printHelp();
    return;
  }

  config.cookie = await resolveCookie(config, parsed.values);
  if (!config.cookie) {
    throw new Error("缺少 Cookie，无法继续。请先运行 setup 或通过 --cookie / NCM_COOKIE 提供。");
  }
  await downloadSongFlow(resolvedTarget, config);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, processHiddenInput };