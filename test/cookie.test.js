const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

const {
  autoCaptureCookie,
  checkPortInUse,
  cleanupSession,
  findBrowserExecutable,
  getCookiesViaCdp,
  getPages,
  getWebSocketDebuggerUrl,
  waitForCdpReady,
  waitForLogin,
} = require("../src/cookie");

/**
 * 创建一个模拟 CDP 服务器：HTTP /json 返回一个 page target，
 * WebSocket 对 Storage.getCookies 返回指定 cookies。
 */
function createMockCdpServer(cookies) {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/json") {
      const port = httpServer.address().port;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify([
          { type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/mock` },
        ])
      );
    } else {
      res.statusCode = 404;
      res.end();
    }
  });

  const wss = new WebSocket.Server({ server: httpServer });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === "Storage.getCookies") {
        ws.send(JSON.stringify({ id: msg.id, result: { cookies } }));
      }
    });
  });

  return {
    listen: () => new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve)),
    get port() {
      return httpServer.address().port;
    },
    close: () => {
      wss.close();
      httpServer.close();
    },
  };
}

test("checkPortInUse reports a listening port", async (t) => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());

  assert.equal(await checkPortInUse(server.address().port), true);
});

test("checkPortInUse reports a free port", async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));

  assert.equal(await checkPortInUse(port), false);
});

test("findBrowserExecutable returns null or a valid executable path", () => {
  const executable = findBrowserExecutable();
  if (executable !== null) {
    assert.ok(fs.existsSync(executable), `Browser path does not exist: ${executable}`);
    if (process.platform !== "win32") {
      fs.accessSync(executable, fs.constants.X_OK);
    }
  }
});

test("waitForCdpReady throws when browser process already exited", async () => {
  const fakeProcess = { exitCode: 1, killed: false };
  await assert.rejects(waitForCdpReady(9, fakeProcess, 1000), /exit code 1/);
});

test("waitForCdpReady throws when browser process was killed by a signal", async () => {
  // 被信号杀死时 exitCode 为 null、signalCode 有值，应立即报错而非空等超时
  const fakeProcess = { exitCode: null, signalCode: "SIGKILL", killed: true };
  const start = Date.now();
  await assert.rejects(waitForCdpReady(9, fakeProcess, 15000), /被信号 SIGKILL 终止/);
  assert.ok(Date.now() - start < 1000, "Should fail fast, not wait for timeout");
});

test("waitForCdpReady throws timeout when no CDP server responds", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const freePort = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const fakeProcess = { exitCode: null, killed: false };
  await assert.rejects(waitForCdpReady(freePort, fakeProcess, 500), /超时/);
});

test("waitForCdpReady resolves debuggerUrl when CDP server responds", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/test" }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const fakeProcess = { exitCode: null, killed: false };
  try {
    const url = await waitForCdpReady(port, fakeProcess, 2000);
    assert.equal(url, "ws://127.0.0.1/test");
  } finally {
    server.close();
  }
});

test("waitForCdpReady reports port conflict when a non-CDP server holds the port", async () => {
  // 端口被占用但不是 CDP 服务：超时后的复检应报"端口被占用"而非普通超时
  const server = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end("<html>not cdp</html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const fakeProcess = { exitCode: null, killed: false };
  try {
    await assert.rejects(waitForCdpReady(port, fakeProcess, 500), /已被其他实例占用/);
  } finally {
    server.close();
  }
});

test("getWebSocketDebuggerUrl resolves the debugger url", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/direct" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = await getWebSocketDebuggerUrl(server.address().port, 1000);
    assert.equal(url, "ws://127.0.0.1/direct");
  } finally {
    server.close();
  }
});

test("getWebSocketDebuggerUrl rejects on non-JSON response", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<html><body>error page</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      getWebSocketDebuggerUrl(server.address().port, 1000),
      /解析 CDP \/json\/version 失败/
    );
  } finally {
    server.close();
  }
});

test("getWebSocketDebuggerUrl rejects on HTTP 500 with HTML body", async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 500;
    res.end("<html>Internal Server Error</html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      getWebSocketDebuggerUrl(server.address().port, 1000),
      /解析 CDP \/json\/version 失败/
    );
  } finally {
    server.close();
  }
});

test("getWebSocketDebuggerUrl rejects when the server accepts but never responds", async () => {
  const server = net.createServer(() => {
    // 接受 TCP 连接但不返回任何 HTTP 响应（模拟半打开连接）
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(getWebSocketDebuggerUrl(server.address().port, 300), /超时/);
  } finally {
    server.close();
  }
});

test("getWebSocketDebuggerUrl rejects when the connection drops mid-response", async () => {
  // 发送响应头 + 部分响应体后强制断开，触发 res 流的 error 路径
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Length", "1000");
    res.write('{"webSocketDebugger');
    setTimeout(() => res.destroy(), 50);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(getWebSocketDebuggerUrl(server.address().port, 2000));
  } finally {
    server.close();
  }
});

test("cleanupSession removes the temp user-data-dir", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncmdl-test-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  assert.equal(fs.existsSync(dir), true);
  await cleanupSession(null, dir);
  assert.equal(fs.existsSync(dir), false);
});

test("cleanupSession resolves immediately for a signal-killed process", async () => {
  // 外部信号杀死：exitCode 为 null、signalCode 有值、killed 为 false，
  // exit 事件已发射不会重放，应立即返回而非发 SIGTERM 后空等 5 秒
  let killCalled = false;
  const fake = {
    exitCode: null,
    signalCode: "SIGKILL",
    killed: false,
    once() {
      return this;
    },
    kill() {
      killCalled = true;
      return true;
    },
  };
  const start = Date.now();
  await cleanupSession(fake, null);
  assert.ok(Date.now() - start < 1000, "Should not wait for SIGTERM/SIGKILL timeouts");
  assert.equal(killCalled, false, "Should not signal an already-dead process");
});

test("cleanupSession does not throw when rmSync fails", async (t) => {
  const rmSyncMock = t.mock.method(fs, "rmSync", () => {
    throw new Error("EBUSY");
  });
  await cleanupSession(null, "/nonexistent/ncmdl-test-dir");
  assert.ok(rmSyncMock.mock.calls.length > 0, "rmSync should have been called");
});

test("getCookiesViaCdp returns cookies from page target", async () => {
  const mockCookies = [
    { name: "MUSIC_U", value: "test-token", domain: ".music.163.com" },
    { name: "__csrf", value: "csrf-val", domain: ".163.com" },
  ];
  const mock = createMockCdpServer(mockCookies);
  await mock.listen();
  try {
    const cookies = await getCookiesViaCdp(mock.port, 3000);
    assert.deepEqual(cookies, mockCookies);
  } finally {
    mock.close();
  }
});

test("getCookiesViaCdp throws when no page target available", async () => {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/json") {
      res.end(JSON.stringify([]));
    }
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  try {
    await assert.rejects(getCookiesViaCdp(port, 1000), /未找到可用的页面 target/);
  } finally {
    httpServer.close();
  }
});

test("getCookiesViaCdp rejects when the WebSocket connection fails", async () => {
  // 占一个空闲端口作为不可达的 WS 地址（无监听 → 连接拒绝 → error 事件）
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/json") {
      res.end(
        JSON.stringify([
          { type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${deadPort}/devtools/page/dead` },
        ])
      );
    }
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  try {
    await assert.rejects(getCookiesViaCdp(port, 2000), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("请求超时"), "Should fail via WS error, not timeout");
      return true;
    });
  } finally {
    httpServer.close();
  }
});

/**
 * 创建一个 WS 对 Storage.getCookies 返回 CDP 命令级错误的模拟服务器。
 */
function createCdpErrorServer(errorMessage) {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/json") {
      const port = httpServer.address().port;
      res.end(
        JSON.stringify([
          { type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/mock` },
        ])
      );
    }
  });
  const wss = new WebSocket.Server({ server: httpServer });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      ws.send(JSON.stringify({ id: msg.id, error: { message: errorMessage } }));
    });
  });
  return {
    listen: () => new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve)),
    get port() {
      return httpServer.address().port;
    },
    close: () => {
      wss.close();
      httpServer.close();
    },
  };
}

test("getCookiesViaCdp marks CDP command errors as nonRetryable", async () => {
  const mock = createCdpErrorServer("'Storage.getCookies' wasn't found");
  await mock.listen();
  try {
    await assert.rejects(getCookiesViaCdp(mock.port, 2000), (error) => {
      assert.match(error.message, /Storage\.getCookies/);
      assert.equal(error.nonRetryable, true);
      return true;
    });
  } finally {
    mock.close();
  }
});

test("waitForLogin fails fast on a non-retryable CDP command error", async () => {
  const mock = createCdpErrorServer("'Storage.getCookies' wasn't found");
  await mock.listen();
  try {
    const start = Date.now();
    await assert.rejects(waitForLogin(mock.port, 60000), /Storage\.getCookies/);
    assert.ok(Date.now() - start < 10000, "Should throw immediately, not retry until timeout");
  } finally {
    mock.close();
  }
});

test("waitForLogin returns cookie string when MUSIC_U is present", async () => {
  const mockCookies = [
    { name: "MUSIC_U", value: "test-token", domain: ".music.163.com" },
    { name: "__csrf", value: "csrf-val", domain: ".163.com" },
    { name: "unrelated", value: "x", domain: ".example.com" },
  ];
  const mock = createMockCdpServer(mockCookies);
  await mock.listen();
  try {
    const cookieStr = await waitForLogin(mock.port, 5000);
    assert.ok(cookieStr.includes("MUSIC_U=test-token"));
    assert.ok(cookieStr.includes("__csrf=csrf-val"));
    assert.ok(!cookieStr.includes("unrelated"));
  } finally {
    mock.close();
  }
});

test("waitForLogin includes last error in timeout message", async () => {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/json") {
      res.end(JSON.stringify([]));
    }
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  try {
    await assert.rejects(
      waitForLogin(port, 100),
      /等待登录超时.*最后一次错误.*未找到可用的页面 target/
    );
  } finally {
    httpServer.close();
  }
});

/**
 * 模拟一个 ChildProcess：kill(SIGTERM/SIGKILL) 时按配置触发或不触发 exit 事件。
 */
function createFakeProcess({ ignoreSigterm = false } = {}) {
  let exitListener = null;
  let currentExitCode = null;
  let killedFlag = false;
  return {
    get exitCode() {
      return currentExitCode;
    },
    get killed() {
      return killedFlag;
    },
    once(event, cb) {
      if (event === "exit") exitListener = cb;
      return this;
    },
    kill(signal) {
      killedFlag = true;
      if (signal === "SIGKILL" || !ignoreSigterm) {
        currentExitCode = 0;
        if (exitListener) exitListener();
      }
      return true;
    },
  };
}

test("cleanupSession terminates a running process via SIGTERM", async () => {
  const fake = createFakeProcess({ ignoreSigterm: false });
  const start = Date.now();
  await cleanupSession(fake, null);
  assert.ok(Date.now() - start < 1000, "SIGTERM graceful exit should be fast");
  assert.equal(fake.killed, true);
  assert.equal(fake.exitCode, 0);
});

test("cleanupSession falls back to SIGKILL when SIGTERM is ignored", async () => {
  const fake = createFakeProcess({ ignoreSigterm: true });
  const start = Date.now();
  await cleanupSession(fake, null);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 3000, `Should wait ~3s before SIGKILL, took ${elapsed}ms`);
  assert.equal(fake.exitCode, 0);
});

test("cleanupSession resolves immediately for an already-exited process", async () => {
  // exitCode 已非 null 且 exit 事件不会重放：验证手动 resolve 路径，不会卡 3s 超时
  const fake = {
    exitCode: 0,
    killed: false,
    once() {
      return this;
    },
    kill() {
      return true;
    },
  };
  const start = Date.now();
  await cleanupSession(fake, null);
  assert.ok(Date.now() - start < 1000, "Should not wait for exit timeout");
});

test("cleanupSession keeps the profile dir when a handoff browser still serves CDP", async (t) => {
  // 启动进程以退出码 0 退出，但调试端口上仍有浏览器实例（转交新进程后继续运行）：
  // 不能删除 user-data-dir，否则遗留实例的登录 Cookie 无法持久化，
  // 后续"复用"会话将永远抓取不到 Cookie
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/live" }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncmdl-test-"));
  t.after(() => {
    server.close();
    fs.rmSync(dir, { force: true, recursive: true });
  });

  let killCalled = false;
  const fake = {
    exitCode: 0,
    killed: false,
    once() {
      return this;
    },
    kill() {
      killCalled = true;
      return true;
    },
  };
  await cleanupSession(fake, dir, port);
  assert.equal(fs.existsSync(dir), true, "profile dir must be kept for the surviving browser");
  assert.equal(killCalled, false, "must not signal the handed-off browser");
});

test("cleanupSession removes the profile dir when the exit-0 process is truly gone", async () => {
  // 退出码 0 且端口上已无 CDP 服务：浏览器确实退出了，应正常清理临时目录
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const freePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncmdl-test-"));
  const fake = {
    exitCode: 0,
    killed: false,
    once() {
      return this;
    },
    kill() {
      return true;
    },
  };
  await cleanupSession(fake, dir, freePort);
  assert.equal(fs.existsSync(dir), false, "profile dir should be removed");
});

test("getPages rejects when the server accepts but never responds", async () => {
  const server = net.createServer(() => {
    // 接受 TCP 连接但不返回任何 HTTP 响应（模拟半打开连接）
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await assert.rejects(getPages(port, 300), /超时/);
  } finally {
    server.close();
  }
});

test("waitForCdpReady does not treat a null browserProcess as exited", async () => {
  // browserProcess 为 null（复用实例）时应走超时路径，而非误报 "exit code undefined"
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const freePort = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(waitForCdpReady(freePort, null, 500), /超时/);
});

test("waitForCdpReady throws when spawn fails asynchronously", async () => {
  const fakeProcess = { exitCode: null, killed: false };
  await assert.rejects(
    waitForCdpReady(9, fakeProcess, 1000, () => new Error("spawn ENOENT")),
    /浏览器启动失败.*ENOENT/
  );
});

test("waitForCdpReady succeeds when the process exited 0 but CDP is up", async () => {
  // Windows 上 Edge/Chrome 可能把启动的实例转交给新进程（原进程以退出码 0 退出），
  // 但浏览器窗口与调试端口照常就绪 —— 此时不应误报"进程已退出"
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/handoff" }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const fakeProcess = { exitCode: 0, killed: false };
  try {
    const url = await waitForCdpReady(port, fakeProcess, 2000);
    assert.equal(url, "ws://127.0.0.1/handoff");
  } finally {
    server.close();
  }
});

test("waitForCdpReady reports timeout with exit-0 note when CDP never comes up", async () => {
  // 进程退出码 0 但 CDP 始终不就绪：应等到超时并给出退出码提示，而非立即误报失败
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const freePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const fakeProcess = { exitCode: 0, killed: false };
  await assert.rejects(waitForCdpReady(freePort, fakeProcess, 500), /超时.*退出码 0/);
});

test("autoCaptureCookie throws when no browser executable is found", async () => {
  await assert.rejects(
    autoCaptureCookie({ deps: { findBrowserExecutable: () => null } }),
    /未找到 Edge\/Chrome 浏览器/
  );
});

test("autoCaptureCookie reuses an existing debug instance without spawning", async () => {
  let spawnCalled = false;
  let cleanupArgs = null;
  const cookieStr = await autoCaptureCookie({
    deps: {
      findBrowserExecutable: () => "/fake/browser",
      checkPortInUse: async () => true, // 端口已被占用 → 复用
      spawn: () => {
        spawnCalled = true;
        return {};
      },
      waitForLogin: async () => "MUSIC_U=test-token",
      cleanupSession: async (proc, dir) => {
        cleanupArgs = { proc, dir };
      },
    },
  });
  assert.equal(cookieStr, "MUSIC_U=test-token");
  assert.equal(spawnCalled, false);
  assert.deepEqual(cleanupArgs, { proc: null, dir: null });
});

test("autoCaptureCookie spawns a browser with an isolated profile and cleans up", async () => {
  let spawnArgs = null;
  let readyCalled = false;
  let cleanupArgs = null;
  const fakeProcess = {
    exitCode: null,
    killed: false,
    on() {
      return this;
    },
    once() {
      return this;
    },
    kill() {
      return true;
    },
  };
  const cookieStr = await autoCaptureCookie({
    deps: {
      findBrowserExecutable: () => "/fake/browser",
      checkPortInUse: async () => false, // 端口空闲 → 启动新实例
      makeTempDir: () => "/fake/temp/dir",
      spawn: (exePath, args) => {
        spawnArgs = { exePath, args };
        return fakeProcess;
      },
      waitForCdpReady: async () => {
        readyCalled = true;
        return "ws://fake";
      },
      waitForLogin: async () => "MUSIC_U=test-token",
      cleanupSession: async (proc, dir) => {
        cleanupArgs = { proc, dir };
      },
    },
  });
  assert.equal(cookieStr, "MUSIC_U=test-token");
  assert.equal(spawnArgs.exePath, "/fake/browser");
  assert.ok(spawnArgs.args.includes("--user-data-dir=/fake/temp/dir"));
  assert.ok(spawnArgs.args.some((a) => a.startsWith("--remote-debugging-port=")));
  assert.equal(readyCalled, true);
  assert.deepEqual(cleanupArgs, { proc: fakeProcess, dir: "/fake/temp/dir" });
});

test("autoCaptureCookie cleans up even when login fails", async () => {
  let cleanupCalled = false;
  const fakeProcess = {
    exitCode: null,
    killed: false,
    on() {
      return this;
    },
    once() {
      return this;
    },
    kill() {
      return true;
    },
  };
  await assert.rejects(
    autoCaptureCookie({
      deps: {
        findBrowserExecutable: () => "/fake/browser",
        checkPortInUse: async () => false,
        makeTempDir: () => "/fake/temp/dir",
        spawn: () => fakeProcess,
        waitForCdpReady: async () => "ws://fake",
        waitForLogin: async () => {
          throw new Error("登录超时");
        },
        cleanupSession: async () => {
          cleanupCalled = true;
        },
      },
    }),
    /登录超时/
  );
  assert.equal(cleanupCalled, true);
});

test("autoCaptureCookie cleans up the temp dir when spawn throws synchronously", async () => {
  let cleanupArgs = null;
  await assert.rejects(
    autoCaptureCookie({
      deps: {
        findBrowserExecutable: () => "/fake/browser",
        checkPortInUse: async () => false,
        makeTempDir: () => "/fake/temp/dir",
        spawn: () => {
          throw new Error("spawn EACCES");
        },
        cleanupSession: async (proc, dir) => {
          cleanupArgs = { proc, dir };
        },
      },
    }),
    /spawn EACCES/
  );
  assert.deepEqual(cleanupArgs, { proc: null, dir: "/fake/temp/dir" });
});

test("autoCaptureCookie surfaces async spawn errors via waitForCdpReady", async () => {
  // 取一个空闲端口，避免 getWebSocketDebuggerUrl 意外成功
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const freePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const fakeProcess = new EventEmitter();
  fakeProcess.exitCode = null;
  fakeProcess.killed = false;
  fakeProcess.kill = () => true;

  await assert.rejects(
    autoCaptureCookie({
      port: freePort,
      deps: {
        findBrowserExecutable: () => "/fake/browser",
        checkPortInUse: async () => false,
        makeTempDir: () => "/fake/temp/dir",
        spawn: () => {
          process.nextTick(() => fakeProcess.emit("error", new Error("spawn ENOENT")));
          return fakeProcess;
        },
        // 不注入 waitForCdpReady，走真实逻辑以验证 spawn error 接线
        waitForLogin: async () => "x",
        cleanupSession: async () => {},
      },
    }),
    /浏览器启动失败.*ENOENT/
  );
});
