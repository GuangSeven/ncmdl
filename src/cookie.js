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
function getWebSocketDebuggerUrl(port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      // 响应体传输中途断开时 res 会发射 error，缺监听会变成未捕获异常
      res.on("error", reject);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json.webSocketDebuggerUrl);
        } catch (e) {
          reject(new Error(`解析 CDP /json/version 失败: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    // 防止 CDP 服务器接受连接但不响应（半打开）导致 Promise 永久挂起
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`CDP /json/version 请求超时（${timeoutMs}ms）`));
    });
  });
}

/**
 * 通过页面级 CDP WebSocket 获取所有 Cookie（包括 HttpOnly Cookie）。
 * Storage.getCookies 是 page/target-level 方法，必须连接页面 target 的 WS，
 * 而非 /json/version 返回的 browser-level WS（后者不支持该方法）。
 */
async function getCookiesViaCdp(port, timeoutMs = 5000) {
  const pages = await getPages(port);
  const page = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
  if (!page) throw new Error("CDP 未找到可用的页面 target，请确认浏览器已打开页面");

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
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
        if (message.error) {
          // CDP 命令级错误（如方法不存在/协议不兼容）是确定性失败，重试无意义
          const cdpError = new Error(message.error.message || "CDP 命令失败");
          cdpError.nonRetryable = true;
          throw cdpError;
        }
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
function getPages(port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      // 响应体传输中途断开时 res 会发射 error，缺监听会变成未捕获异常
      res.on("error", reject);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`获取页面列表失败: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    // 防止 CDP 服务器接受连接但不响应（半打开）导致 Promise 永久挂起
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`CDP /json 请求超时（${timeoutMs}ms）`));
    });
  });
}

/**
 * 等待用户登录：轮询检测 music.163.com 域下的 Cookie 是否包含 MUSIC_U
 */
async function waitForLogin(port, timeoutMs = 180000) {
  const startTime = Date.now();
  const pollInterval = 2000;
  let lastError;

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
    } catch (error) {
      // 确定性错误（CDP 协议不兼容等）立即抛出，避免无意义重试 3 分钟
      if (error.nonRetryable) throw error;
      // 轮询时 CDP 可能临时不可用，记录最后一次错误用于超时诊断
      lastError = error;
    }
  }

  throw new Error(
    `等待登录超时（3 分钟），请重试。${lastError ? ` 最后一次错误: ${lastError.message}` : ""}`
  );
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

  // 依赖注入点：仅供测试替换底层实现，正常调用无需传入。
  const deps = options.deps ?? {};
  const findBrowser = deps.findBrowserExecutable ?? findBrowserExecutable;
  const checkPort = deps.checkPortInUse ?? checkPortInUse;
  const spawnBrowser = deps.spawn ?? spawn;
  const waitReady = deps.waitForCdpReady ?? waitForCdpReady;
  const waitLogin = deps.waitForLogin ?? waitForLogin;
  const cleanup = deps.cleanupSession ?? cleanupSession;
  const makeTempDir =
    deps.makeTempDir ?? (() => fs.mkdtempSync(path.join(os.tmpdir(), "ncmdl-cdp-")));

  const browserPath = findBrowser();
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
  const existingPort = await checkPort(port);
  let browserProcess = null;
  // 每次运行生成唯一临时目录，避免并发运行时 SingletonLock 冲突，也避免脏数据残留。
  let userDataDir = null;

  // 整个启动+登录流程都在 try 内：spawnBrowser 同步抛出或 waitReady 失败时，
  // finally 仍能清理已创建的 userDataDir 与子进程，避免泄露。
  try {
    if (!existingPort) {
      // 启动浏览器，开启调试端口
      // 必须使用独立的 user-data-dir，否则系统里已有 Edge/Chrome 实例时，
      // 新进程会把 URL 转交给旧实例后立即退出，导致调试端口无效、进程退出报错。
      userDataDir = makeTempDir();
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

      browserProcess = spawnBrowser(browserPath, args, {
        stdio: "ignore",
        detached: false,
      });
      // spawn 可能异步失败（ENOENT/EACCES 等），必须挂 error 监听，否则变成未捕获异常；
      // 同时把错误传给 waitForCdpReady，以便快速报出"启动失败/端口被占用"而非干等超时。
      let spawnError = null;
      browserProcess.on("error", (err) => {
        spawnError = err;
      });

      await waitReady(port, browserProcess, Math.min(timeout, 15000), () => spawnError);
    } else {
      console.log("检测到已有浏览器调试实例，复用中...");
    }

    // 等待用户登录并获取 Cookie
    return await waitLogin(port, timeout);
  } finally {
    // 如果是复用的已有实例，browserProcess/userDataDir 均为 null，cleanupSession 会跳过。
    // 清理用 try/catch 包裹，避免吞掉 try 块里 waitForLogin 抛出的原始错误。
    // 传入 port 让 cleanupSession 能识别"进程退出码 0 但浏览器仍存活"的实例交接，
    // 避免误删仍在使用的临时 profile 目录。
    await cleanup(browserProcess, userDataDir, port);
  }
}

/**
 * 关闭本次启动的浏览器进程并清理临时 user-data-dir。
 * 清理失败不会抛出，以免替换 try 块中的原始错误（如登录超时）。
 *
 * @param {object|null} browserProcess   本次启动的浏览器子进程（复用已有实例时为 null）
 * @param {string|null} userDataDir      本次创建的临时 profile 目录（复用时为 null）
 * @param {number|null} [port]           调试端口：用于检测退出码 0 时浏览器是否仍存活
 */
async function cleanupSession(browserProcess, userDataDir, port = null) {
  if (browserProcess && !browserProcess.killed) {
    // 启动进程以退出码 0 自行退出，但调试端口上仍有浏览器在服务 CDP：
    // 说明实例已转交给新进程继续运行（如 Edge 更新后自动重启）。
    // 此时不能删除临时 user-data-dir——遗留浏览器正持有它，删掉后登录 Cookie
    // 无法持久化，后续"复用"会话将永远抓取不到 Cookie。
    if (browserProcess.exitCode === 0 && port != null) {
      const debuggerUrl = await getWebSocketDebuggerUrl(port, 1500).catch(() => null);
      if (debuggerUrl) return;
    }
    // 先注册 exit 监听，再检查 exitCode：若进程在注册前已退出，exit 事件不会重放，
    // 需手动 resolve，避免 exited 永久 pending（修复检查与注册之间的 TOCTOU 竞态）。
    let resolveExited;
    const exited = new Promise((resolve) => {
      resolveExited = resolve;
    });
    browserProcess.once("exit", resolveExited);
    // 被信号杀死（OOM/SIGSEGV）时 exitCode 为 null 而 signalCode 有值，
    // 同样视为已退出，避免对死进程发 SIGTERM 后白等 5 秒超时。
    if (browserProcess.exitCode !== null || browserProcess.signalCode != null) {
      resolveExited();
    } else {
      browserProcess.kill("SIGTERM");
      const didExit = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      // SIGTERM 后进程仍存活（如 crash reporter 弹窗），用 SIGKILL 强制终止，
      // 避免孤儿进程持有文件锁导致临时目录无法删除（Windows 常见）。
      if (!didExit && browserProcess.exitCode === null) {
        browserProcess.kill("SIGKILL");
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
    }
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
 *
 * @param {number} port
 * @param {object|null} browserProcess   浏览器子进程（复用已有实例时为 null）
 * @param {number} [timeoutMs]
 * @param {() => (Error|null)} [getSpawnError]  返回异步 spawn 错误的取值器（可选）
 */
async function waitForCdpReady(port, browserProcess, timeoutMs = 15000, getSpawnError = null) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  // 进程以退出码 0 自行退出时浏览器可能已把实例转交给新进程继续运行
  //（如 Edge 更新后重启），此时不应立即报"启动失败"，继续等 CDP 就绪。
  let exitedWithZero = false;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError?.();
    if (spawnError) {
      throw new Error(
        `浏览器启动失败: ${spawnError.message}（可能是浏览器路径无效或调试端口被占用）`
      );
    }
    // 被信号杀死（SIGKILL/OOM/SIGSEGV）时 exitCode 为 null 而 signalCode 有值，需一并检测。
    if (browserProcess && browserProcess.signalCode != null) {
      throw new Error(
        `浏览器进程已退出（被信号 ${browserProcess.signalCode} 终止），可能是启动失败或存在实例冲突，请检查后重试。`
      );
    }
    // 用 != null 同时排除 null 与 undefined：browserProcess 为 null（复用实例）
    // 或进程尚未退出时都不应误报 "exit code undefined"。
    // 仅退出码非 0 视为确定失败；退出码为 0 时可能是实例交接（见上文注释），
    // 窗口与调试端口会照常就绪，若 CDP 始终不就绪再由最终超时错误兜底。
    if (
      browserProcess &&
      browserProcess.exitCode != null &&
      browserProcess.exitCode !== 0
    ) {
      throw new Error(
        `浏览器进程已退出（exit code ${browserProcess.exitCode}），可能是启动失败或存在实例冲突，请检查后重试。`
      );
    }
    if (browserProcess && browserProcess.exitCode === 0) {
      exitedWithZero = true;
    }
    try {
      const debuggerUrl = await getWebSocketDebuggerUrl(port);
      if (debuggerUrl) return debuggerUrl;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // 超时后再确认一次端口状态，区分"端口被其他实例占用"（TOCTOU：检查后被抢）
  // 与"单纯启动慢"，给出更明确的错误。
  if (await checkPortInUse(port)) {
    throw new Error(
      `浏览器调试端口 ${port} 已被其他实例占用，无法建立 CDP 连接。请关闭占用该端口的浏览器实例后重试。`
    );
  }
  throw new Error(
    `等待浏览器调试端口就绪超时${lastError ? `: ${lastError.message}` : ""}。` +
      (exitedWithZero
        ? "（浏览器进程已退出，退出码 0，调试端口未就绪，可能未成功启动）"
        : "")
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
