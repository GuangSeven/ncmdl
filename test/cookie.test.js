const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { checkPortInUse, cleanupSession, findBrowserExecutable, waitForCdpReady } = require("../src/cookie");

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

test("findBrowserExecutable returns null or an executable path", () => {
  const executable = findBrowserExecutable();
  assert.ok(executable === null || (typeof executable === "string" && executable.length > 0));
});

test("waitForCdpReady throws when browser process already exited", async () => {
  const fakeProcess = { exitCode: 1, killed: false };
  await assert.rejects(
    waitForCdpReady(9, fakeProcess, 1000),
    /exit code 1/
  );
});

test("waitForCdpReady throws timeout when no CDP server responds", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const freePort = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const fakeProcess = { exitCode: null, killed: false };
  await assert.rejects(
    waitForCdpReady(freePort, fakeProcess, 500),
    /超时/
  );
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

test("cleanupSession does not throw when rmSync fails", async () => {
  const original = fs.rmSync;
  fs.rmSync = () => {
    throw new Error("EBUSY");
  };
  try {
    await cleanupSession(null, "/nonexistent/ncmdl-test-dir");
  } finally {
    fs.rmSync = original;
  }
});
