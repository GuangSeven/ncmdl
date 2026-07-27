const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");

const { checkPortInUse, findBrowserExecutable } = require("../src/cookie");

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
