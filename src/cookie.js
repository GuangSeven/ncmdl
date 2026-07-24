/**
 * 自动打开浏览器 → 用户登录网易云 → 抓取 Cookie
 *
 * 原理：启动系统 Edge/Chrome 并开启 CDP 调试端口，
 *       通过 HTTP + WebSocket 控制浏览器、读取 Cookie。
 *       不需要 puppeteer/playwright，不需要下载 Chromium。
 */

const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { readFile, unlink } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const DEFAULT_CDP_PORT = 9222;
const MUSIC_163_URL = "https://music.163.com";

/**
 * 找到系统里可用的 Edge / Chrome / Chromium 可执行文件路径
 */
function findBrowserExecutable() {
  // Windows 上 Edge 的常见安装路径
  const candidates = [
    // Edge (稳定版)
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    // Chrome
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    // 用户目录下的 Edge (系统级安装)
    path.join(os.homedir(), "AppData", "Local", "Microsoft", "Edge", "Application", "msedge.exe"),
    // Chromium (用户手动安装)
    path.join(os.homedir(), "AppData", "Local", "Chromium", "Application", "chrome.exe"),
  ];

  for (const exe of candidates) {
    try {
      fs.accessSync(exe, fs.constants.X_OK);
      return exe;
    } catch {
      continue;
    }
  }

  // 最后尝试从 PATH 里找
  const names = ["msedge", "chrome", "chromium", "edge"];
  for (const name of names) {
    try {
      const which = require("child_process").execSync(`where ${name}`, { encoding: "utf8", stdio: "pipe" });
      const exe = which.split("\n")[0].trim();
      if (exe) return exe;
    } catch {
      continue;
    }
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
 * 通过 CDP HTTP 接口获取当前所有页面的 Cookie
 * Returns: { name: string, value: string }[]
 */
function getCookiesViaCdp(port) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      method: "Network.getAllCookies",
      id: 1,
    });

    const options = {
      hostname: "127.0.0.1",
      port,
      path: "/json/cdp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          // CDP POST /json/cdp 返回的结果可能包在 result 里
          const cookies = json.result?.cookies || json.cookies || [];
          resolve(cookies);
        } catch (e) {
          reject(new Error(`解析 CDP cookie 响应失败: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

/**
 * 通过 CDP 执行 JavaScript 来获取所有 Cookie（备用方案）
 * 某些情况下 POST /json/cdp 不可用，可以用这种方法
 */
function getCookiesViaJS(port, pageId) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      method: "Runtime.evaluate",
      id: 1,
      params: {
        expression: "document.cookie",
      },
    });

    const options = {
      hostname: "127.0.0.1",
      port,
      path: `/json/cdp/${pageId}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const cookieStr = json.result?.result?.value || "";
          resolve(cookieStr);
        } catch (e) {
          reject(new Error(`CDP Runtime.evaluate 失败: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    req.write(postData);
    req.end();
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
  const port = options.port || DEFAULT_CDP_PORT;
  const headless = options.headless || false;
  const timeout = options.timeout || 180000;

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

  if (!existingPort) {
    // 启动浏览器，开启调试端口
    const args = [
      `--remote-debugging-port=${port}`,
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

    // 等浏览器启动
    await new Promise((r) => setTimeout(r, 3000));

    // 检查进程是否还活着
    if (browserProcess.exitCode !== null) {
      throw new Error("浏览器启动失败，请检查是否有其他实例已在运行。");
    }
  } else {
    console.log("检测到已有浏览器调试实例，复用中...");
  }

  try {
    // 等待用户登录并获取 Cookie
    const cookieStr = await waitForLogin(port, timeout);

    return cookieStr;
  } finally {
    // 关闭浏览器（只关我们自己启动的）
    if (browserProcess && !browserProcess.killed) {
      browserProcess.kill();
      // 等进程退出
      await once(browserProcess, "exit").catch(() => {});
    }
    // 注意：如果是复用的已有实例，我们不关它
  }
}

/**
 * 检查端口是否已被占用
 */
function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = require("net").createServer();
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
  findBrowserExecutable,
  getCookiesViaCdp,
  getPages,
  waitForLogin,
};
