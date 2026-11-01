#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
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
  QUALITY_ORDER,
  buildSongOutputPath,
  downloadFile,
  getAlbumDetail,
  getAlbumSongs,
  getSongDetails,
  normalizeQuality,
  parseTarget,
  requestPublicApi,
  resolveDownloadUrl,
  splitTargetList
} = require("./netease");
const { autoCaptureCookie } = require("./cookie");
const { collectSongMetadata, writeMusicTags } = require("./tagger");
const {
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  normalizeConcurrency,
  runWithConcurrency
} = require("./downloader");

const MAIN_MENU_OPTIONS = [
  { number: "1", value: "1", label: "抓取 Cookie" },
  { number: "2", value: "2", label: "手动输入配置" },
  { number: "3", value: "3", label: "下载歌曲/专辑" },
  { number: "4", value: "4", label: "查看配置" },
  { number: "5", value: "5", label: "重置配置" },
  { number: "0", value: "0", label: "退出" }
];

const QUALITY_LABELS = {
  jymaster: "旗舰音质",
  dolby: "杜比全景声",
  sky: "天空声效",
  jyeffect: "环绕声",
  hires: "高解析度",
  lossless: "无损",
  exhigh: "极高",
  higher: "较高",
  standard: "标准"
};

const QUALITY_OPTIONS = QUALITY_ORDER.map((q, i) => ({
  number: String(i),
  value: q,
  label: `${q}${QUALITY_LABELS[q] ? `（${QUALITY_LABELS[q]}）` : ""}`
}));

const PATTERN_OPTIONS = [
  { number: "0", value: "artist-title", label: "歌手 - 歌名（默认）" },
  { number: "1", value: "title-artist", label: "歌名 - 歌手" },
  { number: "2", value: "title", label: "仅歌名" }
];

const CUSTOM_USER_AGENT = Symbol("custom-user-agent");
const UA_FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0";
const USER_AGENT_OPTIONS = [
  { number: "0", value: DEFAULT_USER_AGENT, label: "默认（Chrome 126）" },
  { number: "1", value: UA_FIREFOX, label: "Firefox 126" },
  { number: "2", value: CUSTOM_USER_AGENT, label: "自定义输入…" }
];

function printHelp() {
  stdout.write(`ncmdl - 网易云音乐终端版下载脚本

用法:
  node src/cli.js setup
  node src/cli.js cookie          ← 自动打开浏览器抓取 Cookie
  node src/cli.js download <歌曲ID或链接> [更多 ID/链接...]
  node src/cli.js download <专辑链接>
  node src/cli.js config show
  node src/cli.js config concurrency <4-12>   ← 调整最大并发下载数
  node src/cli.js tag <文件.mp3|.flac> --song <歌曲ID>   ← 给本地文件补写网易云标签（含封面）

可用参数:
  --cookie         覆盖配置里的 Cookie
  --user-agent     覆盖配置里的 User-Agent
  --quality        覆盖默认音质
  --out            覆盖下载目录
  --pattern        文件名模式: artist-title | title-artist | title
  --concurrency    同时下载数量，4-12（默认 4）
  -h, --help       显示帮助

批量下载:
  可一次传入多首歌（空格或逗号分隔）或整张专辑链接，例如
  node src/cli.js download 123 456   789
  node src/cli.js download https://music.163.com/#/album?id=123456
  也可用 album:123456 形式按专辑 ID 下载

本地文件补标签:
  适用于从别处下载、或网易云拿不到播放地址的歌：按歌曲 ID 把
  标题/歌手/专辑/曲目/碟号/年份/专辑艺人/发行公司/流派/歌词/封面/备注写进文件
  node src/cli.js tag "D:\\music\\某歌.mp3" --song 123456
  支持 .mp3（ID3v2.3）与 .flac（Vorbis Comment + PICTURE），可一次传多个文件，
  歌词/封面等元数据只请求一次；歌曲 ID 取自歌曲页地址里的 id 参数

交互模式:
  直接运行 node src/cli.js 进入交互式菜单
  菜单用 ←/→（或 ↑/↓）移动、回车确认，或直接输入数字即时进入对应选项
`);
}

// 终端清屏：仅在真正的 TTY 上执行；管道/文件重定向时保持纯文本输出，
// 避免向脚本结果注入转义序列
function clearScreen() {
  if (!stdout.isTTY) return;
  stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

function printMenu() {
  stdout.write(`ncmdl v${APP_VERSION}\n\n`);
  MAIN_MENU_OPTIONS.forEach((option) => {
    stdout.write(`${option.number}. ${option.label}\n`);
  });
  stdout.write("\n");
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
      const configBeforeCookie = config.cookie;
      let targetInput = await askVisible("请输入歌曲 ID 或链接（多个用空格/逗号分隔，支持专辑）");
      while (targetInput === PASTE_FALLOUT) {
        // 多行粘贴残留行：守卫已提示，重新询问
        targetInput = await askVisible("请输入歌曲 ID 或链接（多个用空格/逗号分隔，支持专辑）");
      }
      if (!targetInput) {
        stdout.write("未输入歌曲 ID 或链接，返回菜单。\n");
        return { continue: true, config };
      }
      if (config.cookie) {
        stdout.write(`当前 Cookie: ${maskSecret(config.cookie)}\n`);
        // 非交互模式下不询问 y/n（无法交互应答，且会劫持脚本管道的下一行输入），直接使用当前 Cookie
        if (stdin.isTTY) {
          let keepCookie = await askVisible("是否使用当前 Cookie？(y/n)", "y");
          while (keepCookie === PASTE_FALLOUT) {
            keepCookie = await askVisible("是否使用当前 Cookie？(y/n)", "y");
          }
          if (keepCookie.toLowerCase() !== "y") {
            const newCookie = await askHidden("请粘贴新的网易云网页 Cookie（粘贴后按回车确认）");
            if (newCookie) {
              config.cookie = newCookie;
              await saveConfig(config);
              return { continue: true, config, pendingCookieRestore: { oldValue: configBeforeCookie } };
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
          return { continue: true, config, pendingCookieRestore: { oldValue: configBeforeCookie } };
        }
      }
      if (!config.cookie) {
        stdout.write("缺少 Cookie，无法下载。请先抓取或手动输入 Cookie。\n");
        return { continue: true, config };
      }
      try {
        await downloadSongsFlow(targetInput, config);
      } catch (err) {
        console.error(`下载失败: ${err.message}`);
      }
      return { continue: true, config };

    case "4":
      showConfig(config);
      return { continue: true, config };

    case "5":
      let confirm = await askVisible("确认重置所有配置？(y/n)", "n");
      while (confirm === PASTE_FALLOUT) {
        confirm = await askVisible("确认重置所有配置？(y/n)", "n");
      }
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

  clearScreen();
  while (true) {
    let choice;
    if (stdin.isTTY) {
      choice = await askMenu(MAIN_MENU_OPTIONS, {
        title: `ncmdl v${APP_VERSION}`,
        prompt: "请选择功能",
        defaultIndex: null
      });
    } else {
      printMenu();
      choice = await askVisible("请选择功能 (0-5)");
    }
    if (choice === PASTE_FALLOUT) {
      // 多行粘贴残留行（如 case 3 刚写入的新 Cookie 被截断）：恢复旧 Cookie，
      // 提示已由守卫打印，重新显示菜单
      if (falloutRestore) {
        config.cookie = falloutRestore.oldValue;
        await saveConfig(config);
      }
      falloutRestore = null;
      continue;
    }
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
    // 每次执行操作前清屏，让本次操作的输出从干净屏幕开始
    clearScreen();
    const result = await handleMenuChoice(choice, config);
    config = result.config;
    if (result.pendingCookieRestore) {
      falloutRestore = result.pendingCookieRestore;
    } else {
      // 本轮未写入新 Cookie：上一个 case 3 的恢复状态已无残留行风险，解除
      falloutRestore = null;
    }
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
// 不支持 bracketed paste 的终端不会返回标记，自动退回"回车确认"行为。此时终结换行
// 即立即确认，不做任何时间窗口判定（行间停顿多久都不能靠窗口区分"粘贴续行"与
// "用户下一条输入"，任何固定窗口都会被更快的停顿击穿）。多行粘贴的识别改为：
//   - 同一 chunk 内终结换行后仍带内容字节 => 整段拒绝（见 onInputData 换行分支）；
//   - 拆成多次 read 到达的续行 => 进入可见路径后，若该行形如 Cookie（key=value），
//     由"残留行守卫"在下一提示消费时识别为多行粘贴并拒绝（见 readLine/askMenu），
//     与停顿时长无关；非 Cookie 形态的续行与用户正常键入在字节上不可区分，
//     按用户输入处理。
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const PASTE_FALLOUT = Symbol("paste-fallout");
const COOKIE_LINE_RE = /^[^\s=]+=[^\s=]+$/;
// hidden 输入 resolve 后，下一行可见输入若形如 Cookie（多行粘贴拆分为多次 read 的
// 续行）则在消费处拒绝。空行不清除标记（晚到的续行不得漏入后续字段）。
let guardNextVisibleLine = false;
// 菜单 case 3 从 hidden 输入写入了新 Cookie：若随即发现多行粘贴残留行，恢复旧值。
let falloutRestore = null;
// 交互选择器（raw mode）会话；数字即时激活后同一 chunk 紧随的换行需要吞并
let menuRead = null;
let menuResolveSwallow = false;

// 残留行守卫：返回 true 表示该行被判定为多行粘贴残留行（已打印拒绝提示）。
// 空行不清除标记；非 Cookie 形态的续行与用户正常键入无法区分，按用户输入放行。
function guardVisibleLine(line) {
  if (!guardNextVisibleLine) {
    return false;
  }
  const trimmed = String(line || "").trim();
  if (trimmed === "") {
    return false;
  }
  guardNextVisibleLine = false;
  if (COOKIE_LINE_RE.test(trimmed)) {
    stdout.write("检测到多行粘贴：Cookie 应为单行文本，本次输入已忽略，请重新粘贴。\n");
    return true;
  }
  return false;
}

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
  guardNextVisibleLine = true;
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
      // fallback 终端无粘贴标记：终结换行即立即确认（不做时间窗口判定），
      // 吸收本 chunk 尾随换行（\r\n / \n / \r 结尾不留幽灵空行）；若粘贴被拆成
      // 多次 read 到达，续行会走可见路径，由残留行守卫（COOKIE_LINE_RE）识别拒绝
      resolveHidden(hiddenRead.buffer.join(""));
      break;
    }
    hiddenRead.buffer.push(char);
    continue;
    }
    if (menuRead) {
      // 交互选择器（raw mode）按键处理
      if (char === "\x1b") {
        menuRead.escSeq = "\x1b";
        continue;
      }
      if (menuRead.escSeq !== "") {
        menuRead.escSeq += char;
        const seq = menuRead.escSeq;
        if (seq === "\x1b[A" || seq === "\x1b[B" || seq === "\x1b[C" || seq === "\x1b[D") {
          menuRead.escSeq = "";
          const dir = seq === "\x1b[A" || seq === "\x1b[D" ? -1 : 1;
          menuRead.selected =
            (menuRead.selected + dir + menuRead.options.length) % menuRead.options.length;
          menuRead.moved = true;
          stdout.write(`\x1b[${menuRead.rows}A`);
          renderMenu(menuRead);
        } else if (seq === PASTE_START || seq === PASTE_END) {
          // 粘贴标记：忽略，内容字节照常累积（bracketed paste 落在选择器上）
          menuRead.escSeq = "";
        } else if (!isPasteSeqPrefix(seq)) {
          menuRead.escSeq = "";
        }
        continue;
      }
      if (char === "\u0003") {
        exit(130);
        return;
      }
      if (char === "\u0004") {
        stdinEof = true;
        finishMenu(menuRead, "");
        return;
      }
      if (char === "\r" || char === "\n") {
        const line = menuRead.buffer.trim();
        if (line !== "") {
          if (guardVisibleLine(line)) {
            // 多行粘贴残留行落在选择器上：拒绝并交给调用方（菜单恢复 Cookie / 向导重问）
            finishMenu(menuRead, PASTE_FALLOUT);
            return;
          }
          finishMenu(menuRead, mapMenuValue(line, menuRead.options, menuRead.defaultValue));
          return;
        }
        if (!menuRead.moved && menuRead.defaultIndex !== null) {
          // 未移动高亮直接回车：接受默认值（与行输入默认值语义一致）
          finishMenu(menuRead, menuRead.defaultValue);
          return;
        }
        if (!menuRead.moved) {
          // 主菜单裸回车（无默认项）：忽略，防止粘贴后的习惯性回车产生幽灵选择
          continue;
        }
        finishMenu(menuRead, menuRead.options[menuRead.selected].value);
        return;
      }
      if (char >= "0" && char <= "9") {
        if (menuRead.buffer === "") {
          // 数字即时激活（仅限尚未输入内容的会话首个字符），无需再按回车
          const hit = menuRead.options.find((option) => String(option.number) === char);
          if (hit) {
            menuResolveSwallow = true;
            finishMenu(menuRead, hit.value);
            return;
          }
          stdout.write("无效的选择，请重新输入。\n");
          continue;
        }
        menuRead.buffer += char;
        continue;
      }
      menuRead.buffer += char;
      continue;
    }
    if (menuResolveSwallow && (char === "\r" || char === "\n")) {
      // 数字即时激活后同 chunk 紧随的换行：吸收，避免漏成下一个提示的空行
      menuResolveSwallow = false;
      prevChar = char;
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
  menuResolveSwallow = false;
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
  } else if (menuRead) {
    finishMenu(menuRead, "");
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
  if (guardVisibleLine(raw)) {
    return PASTE_FALLOUT;
  }
  return raw.trim() || defaultValue;
}

async function askVisible(question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  ensureInputReader();
  stdout.write(`${question}${suffix}: `);
  return readLine(defaultValue);
}

function mapMenuValue(raw, options, defaultValue) {
  const line = String(raw).trim();
  if (line === "") {
    return defaultValue;
  }
  const hit = options.find((option) => String(option.number) === line || option.value === line);
  return hit ? hit.value : line;
}

function renderMenu(menu) {
  if (menu.title !== "") {
    stdout.write(`${menu.title}\n`);
  }
  stdout.write("\n");
  menu.options.forEach((option, i) => {
    const line = `${option.number}. ${option.label}`;
    if (i === menu.selected) {
      // 当前选择项：红字 + 白底
      stdout.write(`\x1b[31;47m${line}\x1b[0m\n`);
    } else {
      stdout.write(`${line}\n`);
    }
  });
  stdout.write("\n");
  stdout.write(`${menu.prompt}（←/→ 或 ↑/↓ 选择，回车确认，或直接输入数字）: \n`);
  menu.rows = (menu.title !== "" ? 1 : 0) + 1 + menu.options.length + 1 + 1;
}

function finishMenu(menu, value) {
  menuRead = null;
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(false);
    } catch {
      // 流已关闭时 setRawMode 可能抛错，忽略
    }
    stdout.write("\n");
  }
  menu.resolve(value);
}

function askMenu(options, { title = "", prompt = "请选择", defaultIndex = null, defaultValue = "" } = {}) {
  ensureInputReader();
  if (!stdin.isTTY) {
    // 非交互模式（管道/文件重定向）：退回行输入，数字或选项值均可
    stdout.write(`${prompt}${defaultValue ? ` [${defaultValue}]` : ""}: `);
    return readLine(defaultValue).then((line) =>
      line === PASTE_FALLOUT ? PASTE_FALLOUT : mapMenuValue(line, options, defaultValue)
    );
  }
  if (lineQueue.length > 0) {
    // 队列先占：同一次输入 chunk 的后续选择（如 "4\n0\n"）与残留行守卫都走这里
    const line = lineQueue.shift();
    if (guardVisibleLine(line)) {
      return Promise.resolve(PASTE_FALLOUT);
    }
    return Promise.resolve(mapMenuValue(line, options, defaultValue));
  }
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    menuRead = {
      options,
      title,
      prompt,
      defaultIndex,
      defaultValue,
      selected: defaultIndex !== null && defaultIndex >= 0 ? defaultIndex : 0,
      moved: false,
      buffer: "",
      escSeq: "",
      resolve
    };
    renderMenu(menuRead);
  });
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
    filenamePattern: values.pattern || baseConfig.filenamePattern || DEFAULT_CONFIG.filenamePattern,
    concurrency: normalizeConcurrency(
      values.concurrency || baseConfig.concurrency || DEFAULT_CONFIG.concurrency
    )
  });
}

async function setupWizard(currentConfig) {
  stdout.write("本地配置向导会把信息保存到 ~/.ncmdl/config.json\n");
  let cookie = await askHidden("请输入网易云网页 Cookie（输入后按回车确认）");
  while (cookie === null) {
    // 多行粘贴被拒绝（resolve null）时重新提示，不得静默沿用旧 Cookie
    cookie = await askHidden("请输入网易云网页 Cookie（输入后按回车确认）");
  }
  // 字段取到多行粘贴残留行（PASTE_FALLOUT）时：重新询问 Cookie 后再问本字段，
  // 截断的首行 Cookie 不会在向导末尾落盘
  const retryField = async (prompt) => {
    for (;;) {
      const value = await prompt();
      if (value === PASTE_FALLOUT) {
        cookie = await askHidden("请输入网易云网页 Cookie（输入后按回车确认）");
        while (cookie === null) {
          cookie = await askHidden("请输入网易云网页 Cookie（输入后按回车确认）");
        }
        continue;
      }
      return value;
    }
  };
  const userAgent = await retryField(async () => {
    const uaDefault = currentConfig.userAgent || DEFAULT_USER_AGENT;
    const presetIndex = USER_AGENT_OPTIONS.findIndex((option) => option.value === uaDefault);
    const picked = await askMenu(USER_AGENT_OPTIONS, {
      title: "请输入 User-Agent",
      prompt: "请选择 User-Agent",
      defaultIndex: presetIndex >= 0 ? presetIndex : USER_AGENT_OPTIONS.length - 1,
      defaultValue: uaDefault
    });
    if (picked === CUSTOM_USER_AGENT) {
      return askVisible("请输入 User-Agent", uaDefault);
    }
    return picked;
  });
  const downloadDir = await retryField(() => askVisible("请输入下载目录", currentConfig.downloadDir || DEFAULT_CONFIG.downloadDir));
  const qualityDefault = currentConfig.quality || DEFAULT_CONFIG.quality;
  const qualityDefaultIndex = Math.max(
    0,
    QUALITY_ORDER.indexOf(normalizeQuality(qualityDefault))
  );
  const quality = await retryField(() =>
    askMenu(QUALITY_OPTIONS, {
      title: "请输入默认音质",
      prompt: "请选择默认音质",
      defaultIndex: qualityDefaultIndex,
      defaultValue: qualityDefault
    })
  );
  const patternDefault = currentConfig.filenamePattern || DEFAULT_CONFIG.filenamePattern;
  const patternDefaultIndex = Math.max(
    0,
    PATTERN_OPTIONS.findIndex((option) => option.value === patternDefault)
  );
  const filenamePattern = await retryField(() =>
    askMenu(PATTERN_OPTIONS, {
      title: "请输入文件名模式",
      prompt: "请选择文件名模式",
      defaultIndex: patternDefaultIndex,
      defaultValue: patternDefault
    })
  );
  const concurrencyDefault = normalizeConcurrency(
    currentConfig.concurrency || DEFAULT_CONFIG.concurrency
  );
  const concurrency = await retryField(() =>
    askVisible(
      `请输入最大并发下载数（${MIN_CONCURRENCY}-${MAX_CONCURRENCY}）`,
      String(concurrencyDefault)
    )
  );
  const nextConfig = Object.assign({}, currentConfig, {
    cookie: cookie || currentConfig.cookie || "",
    userAgent: userAgent || currentConfig.userAgent || DEFAULT_USER_AGENT,
    downloadDir: downloadDir || currentConfig.downloadDir || DEFAULT_CONFIG.downloadDir,
    quality: normalizeQuality(quality || currentConfig.quality || DEFAULT_CONFIG.quality),
    filenamePattern: filenamePattern || currentConfig.filenamePattern || DEFAULT_CONFIG.filenamePattern,
    concurrency: normalizeConcurrency(concurrency || concurrencyDefault, concurrencyDefault)
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
  stdout.write(`并发下载数: ${config.concurrency || ""}\n`);
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

function songDisplayName(song) {
  const artists = Array.isArray(song?.ar)
    ? song.ar
    : Array.isArray(song?.artists)
      ? song.artists
      : [];
  const artist = artists.map((item) => item.name).filter(Boolean).join(" / ");
  const title = song?.name || `ID ${song?.id ?? "unknown"}`;
  return artist ? `${artist} - ${title}` : title;
}

/**
 * 并发下载时同名歌曲（如同名曲目）可能落到同一路径，这里为冲突项追加 " (n)" 后缀。
 */
function reserveUniquePath(basePath, usedPaths) {
  if (!usedPaths.has(basePath)) {
    usedPaths.add(basePath);
    return basePath;
  }
  const ext = path.extname(basePath);
  const stem = ext ? basePath.slice(0, -ext.length) : basePath;
  let index = 2;
  let candidate = `${stem} (${index})${ext}`;
  while (usedPaths.has(candidate)) {
    index += 1;
    candidate = `${stem} (${index})${ext}`;
  }
  usedPaths.add(candidate);
  return candidate;
}

/**
 * 解析歌曲所在专辑的详情（用于按专辑所属歌手建文件夹），按专辑 ID 缓存，
 * 整张专辑下载时所有曲目只请求一次。拿不到详情时返回 null，由调用方回退单曲歌手。
 */
async function resolveAlbumInfo(song, config, albumCache) {
  const album = song?.al || song?.album || null;
  if (!album?.id) return album || null;
  const hasDetail = album.company || album.publishTime || Array.isArray(album.artists);
  // 专辑简介一般不随歌曲详情下发（公开接口 song.album 的 description 为空串），
  // 已有详情但缺简介时同样需要补请求，否则写不进备注(COMMENT)标签
  if (hasDetail && album.description) return album;
  if (!albumCache.has(album.id)) {
    // 缓存 Promise：并发的同专辑歌曲只发起一次请求
    albumCache.set(album.id, (async () => {
      try {
        const result = await getAlbumDetail(album.id, config);
        const detail = result?.album || result || null;
        return detail && detail.name ? detail : Object.assign({}, album, detail || {});
      } catch {
        // 专辑详情获取失败不阻断下载：歌手文件夹退回单曲歌手
        return album;
      }
    })());
  }
  return albumCache.get(album.id);
}

/**
 * 把用户输入（多首歌 / 整张专辑 / 混合）展开为可下载的歌曲详情列表。
 */
async function resolveSongsFromTargets(rawInputs, config, albumCache) {
  const targets = [];
  const invalid = [];
  for (const token of splitTargetList(rawInputs)) {
    const target = parseTarget(token);
    if (target) {
      targets.push(target);
    } else {
      invalid.push(token);
    }
  }

  const songs = [];
  const seen = new Set();
  const pushSong = (song) => {
    if (song && song.id && !seen.has(song.id)) {
      seen.add(song.id);
      songs.push(song);
    }
  };

  for (const target of targets) {
    if (target.type !== "album") continue;
    const { album, songs: albumSongs } = await getAlbumSongs(target.id, config);
    if (album?.id) albumCache.set(album.id, Promise.resolve(album));
    const albumName = album?.name || `ID ${target.id}`;
    stdout.write(`专辑《${albumName}》共 ${albumSongs.length} 首，正在获取歌曲信息...\n`);
    const detailed = albumSongs.length > 0
      ? await getSongDetails(albumSongs.map((song) => song.id), config)
      : [];
    const byId = new Map(detailed.map((song) => [song.id, song]));
    for (const song of albumSongs) {
      pushSong(byId.get(song.id) || song);
    }
  }

  const songTargets = targets.filter((target) => target.type === "song");
  if (songTargets.length > 0) {
    const detailed = await getSongDetails(songTargets.map((target) => target.id), config);
    const byId = new Map(detailed.map((song) => [song.id, song]));
    for (const target of songTargets) {
      const song = byId.get(target.id);
      if (!song) {
        throw new Error(`没有找到歌曲信息，ID: ${target.id}`);
      }
      pushSong(song);
    }
  }

  return { songs, invalid };
}

async function downloadSong(song, config, { index, total, usedPaths, progress, albumCache }) {
  const label = `[${index + 1}/${total}]`;
  const display = songDisplayName(song);
  const downloadRes = await resolveDownloadUrl(song.id, config.quality, config);
  // 歌手文件夹以「专辑所属歌手」为准，下载前先解析专辑详情
  const albumInfo = await resolveAlbumInfo(song, config, albumCache);
  const outputPath = reserveUniquePath(
    buildSongOutputPath(song, config, downloadRes.url, "", albumInfo),
    usedPaths
  );
  stdout.write(`${label} 开始下载 ${display}（${downloadRes.level}）\n`);
  await downloadFile(downloadRes.url, outputPath, {
    Cookie: config.cookie || "",
    "User-Agent": config.userAgent || DEFAULT_USER_AGENT
  });
  // 写入音乐元数据（歌词/专辑/发售日期/封面等），失败不影响已下载文件
  let tagSummary = "";
  try {
    const meta = await collectSongMetadata(song, config, albumInfo);
    tagSummary = writeMusicTags(outputPath, song, meta);
  } catch (tagError) {
    stdout.write(`${label} 标签写入失败（不影响文件）: ${tagError.message}\n`);
  }
  progress.completed += 1;
  stdout.write(
    `${label} 完成（${progress.completed}/${total}）: ${outputPath}${tagSummary ? `，标签: ${tagSummary}` : ""}\n`
  );
  return outputPath;
}

async function downloadSongsFlow(rawInputs, config) {
  const albumCache = new Map();
  const { songs, invalid } = await resolveSongsFromTargets(rawInputs, config, albumCache);
  if (invalid.length > 0) {
    stdout.write(`忽略无法识别的输入: ${invalid.join(" ")}\n`);
  }
  if (songs.length === 0) {
    throw new Error("请输入有效的歌曲 ID、专辑或链接。");
  }

  const requested = Number.parseInt(String(config.concurrency == null ? "" : config.concurrency), 10);
  const concurrency = normalizeConcurrency(config.concurrency);
  if (Number.isFinite(requested) && (requested < MIN_CONCURRENCY || requested > MAX_CONCURRENCY)) {
    stdout.write(`并发数 ${requested} 超出 ${MIN_CONCURRENCY}-${MAX_CONCURRENCY} 范围，已调整为 ${concurrency}。\n`);
  }

  const total = songs.length;
  const usedPaths = new Set();
  const progress = { completed: 0 };
  stdout.write(`开始下载 ${total} 首歌曲，并发 ${Math.min(concurrency, total)}。\n`);

  const results = await runWithConcurrency(songs, concurrency, (song, index) =>
    downloadSong(song, config, { index, total, usedPaths, progress, albumCache })
  );

  const failures = [];
  results.forEach((result, index) => {
    if (result && result.status === "rejected") {
      failures.push({
        song: songs[index],
        reason: result.reason?.message || String(result.reason)
      });
    }
  });

  if (failures.length === 0) {
    stdout.write(`全部完成：成功 ${total} 首。\n`);
  } else {
    stdout.write(`下载结束：成功 ${total - failures.length} 首，失败 ${failures.length} 首。\n`);
    for (const failure of failures) {
      stdout.write(`失败: ${songDisplayName(failure.song)} - ${failure.reason}\n`);
    }
  }
  return { total, failures };
}

/**
 * 按歌曲 ID 取详情：批量接口优先，拿不到时直接请求公开接口兜底
 *（weapi 被风控或对某些下架歌曲返回空时使用）。
 */
async function resolveSongById(songId, config) {
  let songs = [];
  try {
    songs = await getSongDetails([songId], config);
  } catch (error) {
    if (!error.blockedByWaf) throw error;
  }
  if (Array.isArray(songs) && songs.length > 0 && songs[0]) return songs[0];
  const result = await requestPublicApi("/api/song/detail/", { id: songId, ids: `[${songId}]` }, config);
  const song = Array.isArray(result?.songs) && result.songs.length > 0 ? result.songs[0] : null;
  if (!song) throw new Error(`没有找到歌曲信息，ID: ${songId}`);
  return song;
}

/**
 * 给本地音乐文件（外部下载/无法从网易云拿到地址的歌）写入网易云源信息标签。
 * 元数据只拉取一次，多文件复用；单个文件失败不影响其余文件。
 *
 * @param {string[]} files   .mp3 / .flac 文件路径
 * @param {string} songId    来源歌曲 ID
 * @param {object} config
 */
async function tagFilesFlow(files, songId, config) {
  const targets = (Array.isArray(files) ? files : []).filter((file) => String(file || "").trim() !== "");
  if (targets.length === 0) {
    throw new Error("请指定要写入标签的文件，例如: node src/cli.js tag 歌.mp3 --song 123456");
  }
  for (const file of targets) {
    if (!fs.existsSync(file)) {
      throw new Error(`文件不存在: ${file}`);
    }
    const ext = path.extname(file).toLowerCase();
    if (ext !== ".mp3" && ext !== ".flac") {
      throw new Error(`不支持的文件类型: ${file}（仅支持 .mp3 / .flac）`);
    }
  }

  const song = await resolveSongById(songId, config);
  stdout.write(`来源歌曲: ${songDisplayName(song)}（ID ${song.id}）\n`);
  const meta = await collectSongMetadata(song, config);

  const failures = [];
  for (const file of targets) {
    try {
      const summary = writeMusicTags(file, song, meta);
      stdout.write(`已写入: ${file}${summary ? `，标签: ${summary}` : ""}\n`);
    } catch (error) {
      failures.push({ file, reason: error.message });
      stdout.write(`写入失败: ${file}（${error.message}）\n`);
    }
  }
  if (failures.length > 0) process.exitCode = 1;
  return { total: targets.length, failures };
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
      pattern: { type: "string" },
      concurrency: { type: "string" },
      song: { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  const positionals = parsed.positionals || [];
  const command = positionals[0] || "download";
  const subcommand = positionals[1] || "";
  const targetArgs = command === "config" ? [] : positionals.slice(1);

  if (parsed.values.help || command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  // 无参数时：TTY、管道或文件重定向（脚本化驱动菜单）才进入交互菜单，
  // 否则保持旧行为打印帮助，避免在 CI / cron 等非交互环境悬空退出
  if (positionals.length === 0 && !parsed.values.cookie && !parsed.values["user-agent"] && !parsed.values.quality && !parsed.values.out && !parsed.values.pattern && !parsed.values.concurrency) {
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
    pattern: parsed.values.pattern || process.env.NCM_FILENAME_PATTERN || "",
    concurrency: parsed.values.concurrency || process.env.NCM_CONCURRENCY || ""
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

  if (command === "config" && subcommand === "concurrency") {
    const raw = positionals[2];
    if (raw === undefined || raw === "") {
      stdout.write(`当前最大并发下载数: ${config.concurrency}\n`);
      stdout.write(`用法: node src/cli.js config concurrency <${MIN_CONCURRENCY}-${MAX_CONCURRENCY}>\n`);
      return;
    }
    const value = normalizeConcurrency(raw);
    config.concurrency = value;
    await saveConfig(config);
    stdout.write(`最大并发下载数已设置为 ${value}。\n`);
    return;
  }

  if (command === "tag") {
    const songId = String(parsed.values.song || "").trim();
    if (!/^\d+$/.test(songId)) {
      throw new Error("tag 需要 --song <歌曲ID>，例如: node src/cli.js tag 歌.mp3 --song 123456");
    }
    await tagFilesFlow(targetArgs, songId, config);
    return;
  }

  if (targetArgs.length === 0) {
    if (stdin.isTTY) {
      const manualTarget = await askVisible("请输入歌曲 ID 或链接（多个用空格/逗号分隔，支持专辑）");
      config.cookie = await resolveCookie(config, parsed.values);
      if (!config.cookie) {
        throw new Error("缺少 Cookie，无法继续。请先运行 setup 或通过 --cookie / NCM_COOKIE 提供。");
      }
      await downloadSongsFlow(manualTarget, config);
      return;
    }
    printHelp();
    return;
  }

  config.cookie = await resolveCookie(config, parsed.values);
  if (!config.cookie) {
    throw new Error("缺少 Cookie，无法继续。请先运行 setup 或通过 --cookie / NCM_COOKIE 提供。");
  }
  await downloadSongsFlow(targetArgs, config);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };