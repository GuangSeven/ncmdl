const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

const {
  checkPortInUse,
  cleanupSession,
  findBrowserExecutable,
  getCookiesViaCdp,
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

test("cleanupSession removes the temp user-data-dir", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncmdl-test-"));
  assert.equal(fs.existsSync(dir), true);
  await cleanupSession(null, dir);
  assert.equal(fs.existsSync(dir), false);
});

test("cleanupSession does not throw when rmSync fails", async (t) => {
  t.mock.method(fs, "rmSync", () => {
    throw new Error("EBUSY");
  });
  await cleanupSession(null, "/nonexistent/ncmdl-test-dir");
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
