#!/usr/bin/env node

const fs = require("node:fs");
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
        // 非交互模式下不询问 y/n（无法交互应答，且会劫持脚本管道的下一行输入），直接使用当前 Cookie
        if (stdin.isTTY) {
          const keepCookie = await askVisible("是否使用当前 Cookie？(y/n)", "y");
          if (keepCookie.toLowerCase() !== "y") {
            const newCookie = await askHidden("请粘贴新的网易云网页 Cookie（粘贴后按回车确认）");
            if (newCookie) {
              config.cookie = newCookie;
              await saveConfig(config);
            } else {
              stdout.write("未获取到新 Cookie，本次不下载，返回菜单。\n");
              return { continue: true, config };
            }
          }
        }
      } else {
        const pastedCookie = await resolveCookie(config, { cookie: "" });
        if (pastedCookie) {
          config.cookie = pastedCookie;
          await saveConfig(config);
        }
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

function hasMenuInput() {
  if (stdin.isTTY) {
    return true;
  }
  try {
    const stat = fs.fstatSync(stdin.fd);
    // 管道/FIFO/套接字与普通文件均可脚本化驱动菜单（node src/cli.js < menu.txt）；
    // 仅字符设备（如 /dev/null）与目录视为无输入，保持打印帮助的旧行为
    return !(stat.isCharacterDevice() || stat.isDirectory());
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
    if (!choice) {
      if (stdinEof && lineQueue.length === 0) {
        // 队列已空且流已关闭才是真正的 EOF；队列里还有残留行时不能误报，
        // 否则会丢掉后面的退出选项（如向导流程尾部残留的空行 + "0"）
        stdout.write("输入已结束，退出。\n");
        break;
      }
      // 空行（常见于粘贴 Cookie 后习惯性回车、或粘贴尾随换行漏入可见队列）不是有效选择，
      // 直接忽略并重新显示菜单，绝不误判为"无效的选择"制造幽灵行
      continue;
    }
    const result = await handleMenuChoice(choice, config);
    config = result.config;
    if (!result.continue) break;
    stdout.write("\n");
  }
  stopInputReader();
}

function stopInputReader() {
  if (!inputStarted) {
    return;
  }
  stdin.off("data", onInputData);
  stdin.off("close", onInputClose);
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(false);
    } catch {
      // 流已关闭（如 EOF）时 setRawMode 可能抛错，忽略
    }
    stdout.write("\x1b[?2004l");
  }
  stdin.pause();
  inputStarted = false;
}

let inputStarted = false;
let stdinEof = false;
let lineWaiter = null;
const lineQueue = [];
let visibleBuffer = "";
let hiddenRead = null;
let prevChar = "";
// hidden 输入（TTY raw mode）的终结与粘贴识别：
// - 普通键入：回车（\r/\n）显式终结，立即返回已累积内容。不做任何"静默超时"判定，
//   因此输入中途停顿多久都不会被截断，剩余字节也不可能漏入下一个提示。
// - 粘贴：进入 hidden 时启用终端 bracketed paste（\x1b[?2004h，主流终端均支持），
//   终端会把整个粘贴内容包在 \x1b[200~ ... \x1b[201~ 之间。因此粘贴无论被终端按什么
//   字节边界拆成多少次 read、行间停顿多久，都会在结束标记处完整累积，不受时间窗口
//   影响：
//   - 多行粘贴（去掉自带尾随换行后仍含换行）整段拒绝（resolve null），绝不截断落盘、
//     不漏入可见队列；
//   - 粘贴自带的尾随换行（\r\n/\r/\n，含单行后常见的尾部空行）全部被吸收，粘贴结束
//     即自动确认，无需刻意回车；
//   - 粘贴结束后用户的下一条输入走正常可见路径，绝不因任何窗口被吞。
// 不支持 bracketed paste 的终端不会返回标记，自动退回"回车确认"行为。此时没有结束
// 标记可依赖，只能靠短窗口兜底：终结换行后若同一 chunk 还有内容字节，或者短时间内
// 又有非换行字节到达（粘贴被拆成多次 read 的真实形态），一律按多行粘贴整段拒绝，
// 绝不把截断后的首行落盘、也不让剩余行漏入可见队列；窗口内只有换行则吸收。
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const FALLBACK_TAIL_MS = 200;

function isPasteSeqPrefix(seq) {
  return PASTE_START.startsWith(seq) || PASTE_END.startsWith(seq);
}

function wakeLineWaiter() {
  if (lineWaiter) {
    const wake = lineWaiter;
    lineWaiter = null;
    wake();
  }
}

function resolveHidden(content) {
  const read = hiddenRead;
  if (!read) {
    return;
  }
  hiddenRead = null;
  if (read.pendingTimer) {
    clearTimeout(read.pendingTimer);
    read.pendingTimer = null;
  }
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(false);
    } catch {
      // 流已关闭（如 EOF 触发终结）时 setRawMode 可能抛错，忽略
    }
    stdout.write("\x1b[?2004l\n");
  }
  read.resolve(content);
}

function rejectMultiLinePaste() {
  stdout.write("检测到多行粘贴：Cookie 应为单行文本，本次输入已忽略，请重新粘贴。\n");
  resolveHidden(null);
}

function finalizeHiddenInput(read) {
  // 定时器可能在 hiddenRead 已被替换（向导重询）后才触发，必须核对引用
  if (!read || hiddenRead !== read) {
    return;
  }
  clearTimeout(read.pendingTimer);
  read.pendingTimer = null;
  read.pending = false;
  resolveHidden(read.buffer.join(""));
}

function startFallbackTailWindow(read) {
  // fallback 终端无粘贴标记：终结换行后开启短观察窗口（每收到换行重置），
  // 窗口内出现内容字节即按多行粘贴整段拒绝，窗口到期才以已累积内容终结
  clearTimeout(read.pendingTimer);
  read.pending = true;
  read.pendingTimer = setTimeout(() => finalizeHiddenInput(read), FALLBACK_TAIL_MS);
}

function finishPaste() {
  const read = hiddenRead;
  if (!read) {
    return;
  }
  // 吸收粘贴自带的全部尾随换行序列（\r\n / \r / \n，含单行后剪贴板常见的尾部空行）
  const content = read.buffer
    .join("")
    .replace(/(?:\r\n|\r|\n)+$/, "");
  if (/[\r\n]/.test(content)) {
    // 去掉全部尾随换行后仍含换行 => 多行粘贴。Cookie 必须单行：整段拒绝，
    // 绝不把截断后的首行落盘，也不让剩余行漏入可见队列
    rejectMultiLinePaste();
    return;
  }
  resolveHidden(content.trim());
}

function onInputData(chunk) {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (hiddenRead) {
      if (char === "\x1b") {
        hiddenRead.escSeq = "\x1b";
        continue;
      }
      if (hiddenRead.escSeq !== "") {
        hiddenRead.escSeq += char;
        if (hiddenRead.escSeq === PASTE_START) {
          hiddenRead.escSeq = "";
          hiddenRead.pasteMode = true;
          if (hiddenRead.pending) {
            // fallback 窗口内新粘贴开始：窗口作废，交给 bracketed paste 标记路径处理
            clearTimeout(hiddenRead.pendingTimer);
            hiddenRead.pendingTimer = null;
            hiddenRead.pending = false;
          }
        } else if (hiddenRead.escSeq === PASTE_END) {
          hiddenRead.escSeq = "";
          hiddenRead.pasteMode = false;
          finishPaste();
        } else if (!isPasteSeqPrefix(hiddenRead.escSeq)) {
          // 非粘贴标记（如方向键）的其它转义序列：丢弃，不进入输入内容
          hiddenRead.escSeq = "";
        }
        continue;
      }
    if (char === "\u0003") {
      exit(130);
      return;
    }
    if (hiddenRead.pending) {
      // fallback 终结换行后的观察窗口：吸收换行/退格并重置窗口；
      // 任何内容字节都说明是拆成多次 read 到达的多行粘贴，整段拒绝
      if (char === "\u0004") {
        finalizeHiddenInput(hiddenRead);
        return;
      }
      if (char === "\r" || char === "\n" || char === "\u007f" || char === "\b") {
        startFallbackTailWindow(hiddenRead);
        continue;
      }
      rejectMultiLinePaste();
      return;
    }
    if (char === "\u0004") {
      resolveHidden(hiddenRead.buffer.join(""));
      return;
    }
    if (char === "\u007f" || char === "\b") {
      hiddenRead.buffer.pop();
      continue;
    }
    if (!hiddenRead.pasteMode && (char === "\r" || char === "\n")) {
      const rest = text.slice(i + 1);
      if (rest.replace(/[\r\n]/g, "") !== "") {
        // 终结换行后同一 chunk 仍有内容字节 => fallback 终端多行粘贴：
        // 整段拒绝，剩余字节直接丢弃，绝不落盘截断值、不漏入可见队列
        rejectMultiLinePaste();
        return;
      }
      // 吸收本 chunk 尾随换行（\r\n / \n / \r 结尾不留幽灵空行），
      // 并开启短窗口等待可能拆成多次 read 到达的粘贴后续行
      startFallbackTailWindow(hiddenRead);
      break;
    }
    hiddenRead.buffer.push(char);
    continue;
    }
    if (char === "\r" || char === "\n" || char === "\u0004") {
      if (char === "\n" && prevChar === "\r") {
        prevChar = char;
        continue;
      }
      lineQueue.push(visibleBuffer);
      visibleBuffer = "";
      prevChar = char;
      wakeLineWaiter();
      continue;
    }
    if (char === "\u007f" || char === "\b") {
      visibleBuffer = visibleBuffer.slice(0, -1);
      prevChar = "";
      continue;
    }
    visibleBuffer += char;
    prevChar = "";
  }
}

function ensureInputReader() {
  if (inputStarted) {
    return;
  }
  inputStarted = true;
  stdin.setEncoding("utf8");
  stdin.resume();
  stdin.on("data", onInputData);
  stdin.on("close", onInputClose);
}

function onInputClose() {
  stdinEof = true;
  wakeLineWaiter();
  if (hiddenRead) {
    resolveHidden(hiddenRead.buffer.join(""));
  }
}

async function readLine(defaultValue = "") {
  while (lineQueue.length === 0 && !stdinEof) {
    await new Promise((resolve) => {
      lineWaiter = resolve;
    });
  }
  if (stdinEof && lineQueue.length === 0) {
    return "";
  }
  const raw = lineQueue.shift();
  return raw.trim() || defaultValue;
}

async function askVisible(question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  ensureInputReader();
  stdout.write(`${question}${suffix}: `);
  return readLine(defaultValue);
}

function askHidden(question) {
  ensureInputReader();
  stdout.write(`${question}: `);
  if (!stdin.isTTY) {
    // 非交互模式（管道/文件重定向）：像可见输入一样逐行消费队列，
    // Cookie 行不会泄漏到下一个字段；EOF 时返回空串走"沿用旧值"分支
    return readLine("");
  }
  if (lineQueue.length > 0) {
    const value = lineQueue.shift();
    stdout.write("\n");
    return Promise.resolve(value.trim());
  }
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdout.write("\x1b[?2004h");
    hiddenRead = { buffer: [], escSeq: "", pasteMode: false, resolve };
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
  let cookie = await askHidden("请输入网易云网页 Cookie（输入后按回车确认）");
  while (cookie === null) {
    // 多行粘贴被拒绝（resolve null）时重新提示，不得静默沿用旧 Cookie
    cookie = await askHidden("请输入网易云网页 Cookie（输入后按回车确认）");
  }
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
  return askHidden("请粘贴网易云网页 Cookie（粘贴后按回车确认）");
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
  try {
    await runMain();
  } finally {
    stopInputReader();
  }
}

async function runMain() {
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

  // 无参数时：TTY、管道或文件重定向（脚本化驱动菜单）才进入交互菜单，
  // 否则保持旧行为打印帮助，避免在 CI / cron 等非交互环境悬空退出
  if (positionals.length === 0 && !parsed.values.cookie && !parsed.values["user-agent"] && !parsed.values.quality && !parsed.values.out && !parsed.values.pattern) {
    if (hasMenuInput()) {
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

module.exports = { main };