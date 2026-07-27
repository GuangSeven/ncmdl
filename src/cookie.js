/**
 * 自动打开浏览器 → 用户登录网易云 → 抓取 Cookie
 *
 * 原理：启动系统 Edge/Chrome 并开启 CDP 调试端口，
 *       通过 HTTP + WebSocket 控制浏览器、读取 Cookie。
 *       不需要 puppeteer/playwright，不需要下载 Chromium。
 */

const http = require("node:http");
const { execFileSync, spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const WebSocket = require("ws");

const DEFAULT_CDP_PORT = 9222;
const MUSIC_163_URL = "https://music.163.com";

/**
 * 找到系统里可用的 Edge / Chrome / Chromium 可执行文件路径
 */
function findBrowserExecutable() {
  const home = os.homedir();
  const candidatesByPlatform = {
    win32: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(home, "AppData", "Local", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(home, "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(home, "AppData", "Local", "Chromium", "Application", "chrome.exe"),
    ],
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ],
  };

  for (const executable of candidatesByPlatform[process.platform] || []) {
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      return executable;
    } catch {}
  }

  const command = process.platform === "win32" ? "where" : "which";
  const names = process.platform === "win32"
    ? ["msedge", "chrome", "chromium"]
    : ["google-chrome", "google-chrome-stable", "microsoft-edge", "chromium", "chromium-browser"];
  for (const name of names) {
    try {
      const output = execFileSync(command, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const executable = output.split(/\r?\n/).find(Boolean)?.trim();
      if (executable) return executable;
    } catch {}
  }
  return null;
}

/**
 * 用 CDP HTTP 接口获取 WebSocket Debugger URL
 */
function getWebSocketDebuggerUrl(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json.webSocketDebuggerUrl);
        } catch (e) {
          reject(new Error(`解析 CDP /json/version 失败: ${e.message}`));
        }
      });
    }).on("error", reject);
  });
}

/**
 * 通过浏览器级 CDP WebSocket 获取所有 Cookie（包括 HttpOnly Cookie）。
 */
async function getCookiesViaCdp(port, timeoutMs = 5000) {
  const debuggerUrl = await getWebSocketDebuggerUrl(port);
  if (!debuggerUrl) throw new Error("CDP 未返回 WebSocket 调试地址");

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(debuggerUrl);
    const timer = setTimeout(() => finish(new Error("CDP Cookie 请求超时")), timeoutMs);
    let finished = false;

    function finish(error, cookies) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(cookies);
    }

    socket.once("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
    });
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.id !== 1) return;
        if (message.error) throw new Error(message.error.message || "CDP 命令失败");
        finish(null, message.result?.cookies || []);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
  });
}

/**
 * 通过 CDP 获取所有页面信息（用来找 music.163.com 的页面）
 */
function getPages(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`获取页面列表失败: ${e.message}`));
        }
      });
    }).on("error", reject);
  });
}

/**
 * 等待用户登录：轮询检测 music.163.com 域下的 Cookie 是否包含 MUSIC_U
 */
async function waitForLogin(port, timeoutMs = 180000) {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollInterval));

    try {
      const cookies = await getCookiesViaCdp(port);
      const musicU = cookies.find(
        (c) => c.name === "MUSIC_U" && c.domain?.includes("music.163.com")
      );
      if (musicU && musicU.value) {
        // 把 cookies 拼成 Cookie 字符串
        const musicCookies = cookies.filter((c) =>
          c.domain?.includes("music.163.com") || c.domain?.includes(".163.com")
        );
        const cookieStr = musicCookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        return cookieStr;
      }
    } catch {
      // 轮询时可能 CDP 临时不可用，忽略
    }
  }

  throw new Error("等待登录超时（3 分钟），请重试。");
}

/**
 * 启动浏览器并打开网易云，等待用户登录后抓取 Cookie
 *
 * @param {object} options
 * @param {number}  [options.port=9222]         CDP 调试端口
 * @param {boolean} [options.headless=false]    是否无头模式（默认 false，用户需要看到界面去登录）
 * @param {number}  [options.timeout=180000]    等待登录超时（毫秒）
 * @returns {Promise<string>} cookie 字符串
 */
async function autoCaptureCookie(options = {}) {
  const port = options.port ?? DEFAULT_CDP_PORT;
  const headless = options.headless ?? false;
  const timeout = options.timeout ?? 180000;

  const browserPath = findBrowserExecutable();
  if (!browserPath) {
    throw new Error(
      "未找到 Edge/Chrome 浏览器。如果你已安装，请手动复制 Cookie 后运行 `node src/cli.js config show` 确认。"
    );
  }

  console.log(`使用浏览器: ${browserPath}`);
  console.log(`启动调试端口: ${port}`);
  if (!headless) {
    console.log("浏览器窗口已打开，请在页面中登录网易云音乐...");
  }

  // 先检查端口是否已被占用（可能已有浏览器调试实例在运行）
  const existingPort = await checkPortInUse(port);
  let browserProcess = null;
  // 每次运行生成唯一临时目录，避免并发运行时 SingletonLock 冲突，也避免脏数据残留。
  let userDataDir = null;

  if (!existingPort) {
    // 启动浏览器，开启调试端口
    // 必须使用独立的 user-data-dir，否则系统里已有 Edge/Chrome 实例时，
    // 新进程会把 URL 转交给旧实例后立即退出，导致调试端口无效、进程退出报错。
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncmdl-cdp-"));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      MUSIC_163_URL, // 启动后直接打开网易云
    ];

    if (headless) {
      args.push("--headless=new");
    }

    browserProcess = spawn(browserPath, args, {
      stdio: "ignore",
      detached: false,
    });

    await waitForCdpReady(port, browserProcess, Math.min(timeout, 15000));
  } else {
    console.log("检测到已有浏览器调试实例，复用中...");
  }

  try {
    // 等待用户登录并获取 Cookie
    const cookieStr = await waitForLogin(port, timeout);

    return cookieStr;
  } finally {
    // 如果是复用的已有实例，browserProcess/userDataDir 均为 null，cleanupSession 会跳过。
    // 清理用 try/catch 包裹，避免吞掉 try 块里 waitForLogin 抛出的原始错误。
    await cleanupSession(browserProcess, userDataDir);
  }
}

/**
 * 关闭本次启动的浏览器进程并清理临时 user-data-dir。
 * 清理失败不会抛出，以免替换 try 块中的原始错误（如登录超时）。
 */
async function cleanupSession(browserProcess, userDataDir) {
  if (browserProcess && browserProcess.exitCode === null && !browserProcess.killed) {
    const exited = new Promise((resolve) => browserProcess.once("exit", resolve));
    browserProcess.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  if (userDataDir) {
    try {
      fs.rmSync(userDataDir, { force: true, recursive: true });
    } catch {
      // 清理失败不应影响原始错误传播
    }
  }
}

/**
 * 等待 CDP HTTP 服务真正可用，而不是依赖固定延时。
 */
async function waitForCdpReady(port, browserProcess, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (browserProcess?.exitCode !== null) {
      throw new Error(
        `浏览器进程已退出（exit code ${browserProcess?.exitCode}），可能是启动失败或存在实例冲突，请检查后重试。`
      );
    }
    try {
      const debuggerUrl = await getWebSocketDebuggerUrl(port);
      if (debuggerUrl) return debuggerUrl;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `等待浏览器调试端口就绪超时${lastError ? `: ${lastError.message}` : ""}，可能已有实例占用了端口。`
  );
}

/**
 * 检查端口是否已被占用
 */
function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

module.exports = {
  autoCaptureCookie,
  checkPortInUse,
  cleanupSession,
  findBrowserExecutable,
  getCookiesViaCdp,
  getPages,
  getWebSocketDebuggerUrl,
  waitForCdpReady,
  waitForLogin,
};
