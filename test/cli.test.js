const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const CLI_PATH = path.join(__dirname, "..", "src", "cli.js");
const { processHiddenInput } = require("../src/cli");

const WINDOWS_SKIP =
  "Windows 匿名管道经 fs.fstatSync 无法识别为可交互输入，脚本化菜单测试不适用";

function makeTempHome(cookie = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncmdl-cli-test-"));
  fs.mkdirSync(path.join(dir, ".ncmdl"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".ncmdl", "config.json"),
    JSON.stringify({
      cookie,
      userAgent: "UA-test",
      downloadDir: "/tmp/dl",
      quality: "standard",
      filenamePattern: "artist-title",
    })
  );
  return dir;
}

function runCli(args, { input = null, home = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: input === null ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      env: home ? { ...process.env, HOME: home } : process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`子进程超时\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (child.stdin) {
      child.stdin.end(input === null ? undefined : input);
    }
  });
}

test("无参数 + 非交互 stdin 打印帮助而非进入菜单（回归：修复前悬空退出）", async () => {
  const { code, stdout } = await runCli([], { input: null });
  assert.equal(code, 0);
  assert.match(stdout, /用法:/, "应输出帮助文本");
  assert.doesNotMatch(stdout, /请选择功能/, "不应进入交互式菜单");
});

test("交互菜单在管道输入下依次消费多行选择（修复前第二个选择被吞）", { skip: process.platform === "win32" ? WINDOWS_SKIP : false }, async (t) => {
  const home = makeTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { code, stdout } = await runCli([], { input: "4\n0\n", home });
  assert.equal(code, 0);
  assert.match(stdout, /配置文件:/, "选项 4（查看配置）应被执行");
  assert.match(stdout, /再见！/, "选项 0（退出）应被执行");
});

test("交互菜单对无效选择提示后继续", { skip: process.platform === "win32" ? WINDOWS_SKIP : false }, async (t) => {
  const home = makeTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { code, stdout } = await runCli([], { input: "9\n0\n", home });
  assert.equal(code, 0);
  assert.match(stdout, /无效的选择，请重新输入。/);
  assert.match(stdout, /再见！/);
});

test("交互菜单直接输入 0 立即退出", { skip: process.platform === "win32" ? WINDOWS_SKIP : false }, async (t) => {
  const home = makeTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { code, stdout } = await runCli([], { input: "0\n", home });
  assert.equal(code, 0);
  assert.match(stdout, /再见！/);
});

test("下载选项缺少 Cookie 时中止且不发起网络请求", { skip: process.platform === "win32" ? WINDOWS_SKIP : false }, async (t) => {
  const home = makeTempHome("");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { code, stdout } = await runCli([], { input: "3\n12345\n0\n", home });
  assert.equal(code, 0);
  assert.match(stdout, /缺少 Cookie，无法下载。/);
  assert.doesNotMatch(stdout, /下载失败/, "不应尝试真实下载");
  assert.match(stdout, /再见！/);
});

test("askHidden 粘贴内容与换行符同 chunk 到达时应正确终止（修复死锁）", () => {
  const buffer = [];
  const result = processHiddenInput(buffer, "MUSIC_U=PASTE\n");
  assert.equal(result, "finish");
  assert.equal(buffer.join(""), "MUSIC_U=PASTE");
});

test("askHidden 多 chunk 累积输入后由独立换行终止", () => {
  const buffer = [];
  assert.equal(processHiddenInput(buffer, "MUSIC_U=PA"), "continue");
  assert.equal(processHiddenInput(buffer, "STE"), "continue");
  assert.equal(processHiddenInput(buffer, "\r"), "finish");
  assert.equal(buffer.join(""), "MUSIC_U=PASTE");
});

test("askHidden 处理退格删除前一字符", () => {
  const buffer = [];
  assert.equal(processHiddenInput(buffer, "MUSIC_U=abcd\u007f"), "continue");
  assert.equal(processHiddenInput(buffer, "\r"), "finish");
  assert.equal(buffer.join(""), "MUSIC_U=abc");
});

test("askHidden 检测到 Ctrl+C 应退出", () => {
  const buffer = [];
  assert.equal(processHiddenInput(buffer, "MUSIC_U=ab\u0003"), "exit");
});

test("非 TTY 下放弃当前 Cookie 时明确提示且不静默继续下载", { skip: process.platform === "win32" ? WINDOWS_SKIP : false }, async (t) => {
  const home = makeTempHome("MUSIC_U=old-cookie");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { code, stdout } = await runCli([], { input: "3\n12345\nn\n0\n", home });
  assert.equal(code, 0);
  assert.match(stdout, /非交互模式.*无法输入隐藏文本/, "应提示非交互模式无法输入 Cookie");
  assert.match(stdout, /未获取到新 Cookie，本次不下载/, "应明确放弃下载而非用旧 Cookie 静默继续");
  assert.doesNotMatch(stdout, /下载失败/, "不应尝试真实下载");
  assert.match(stdout, /再见！/);
});
