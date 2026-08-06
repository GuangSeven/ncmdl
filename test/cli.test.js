const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const CLI_PATH = path.join(__dirname, "..", "src", "cli.js");

const WINDOWS_SKIP =
  "Windows 匿名管道经 fs.fstatSync 无法识别为可交互输入，脚本化菜单测试不适用";

const PTY_DRIVER = path.join(__dirname, "pty_driver.py");
const PTY_SKIP = "PTY 驱动不可用（缺 python3 或 pty_driver.py），跳过 TTY/raw-mode 测试";

function hasPython() {
  try {
    const { spawnSync } = require("node:child_process");
    const r = spawnSync("python3", ["--version"], { timeout: 5000 });
    return r.status === 0 && fs.existsSync(PTY_DRIVER);
  } catch {
    return false;
  }
}

const PTY_AVAILABLE = hasPython();

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

function runPty(spec, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const specFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ncmdl-pty-spec-")),
      "spec.json"
    );
    fs.writeFileSync(specFile, JSON.stringify(spec));
    const child = spawn(
      "python3",
      [PTY_DRIVER, specFile, String(timeoutMs / 1000)],
      { env: process.env }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`PTY 子进程超时\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs + 8000);
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
      const m = stdout.match(/EXIT:(-?\d+)\s*$/);
      resolve({ code, stdout, stderr, exitCode: m ? Number(m[1]) : null });
    });
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

test("管道驱动：已配置 Cookie 时选项 3 不询问 y/n，退出选项不被劫持（修复前被 keep-cookie 提示吞掉）", { skip: process.platform === "win32" ? WINDOWS_SKIP : false }, async (t) => {
  const home = makeTempHome("MUSIC_U=old-cookie");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { code, stdout, stderr } = await runCli([], { input: "3\nabc\n0\n", home });
  assert.equal(code, 0);
  assert.match(stdout, /当前 Cookie:/, "应展示当前 Cookie");
  assert.match(stderr, /下载失败: 请输入有效的歌曲 ID/, "应使用现有 Cookie 直接进入下载流程（网络前的确定性失败）");
  assert.match(stdout, /再见！/, "选项 0（退出）不应被 y/n 提示劫持");
  assert.doesNotMatch(stdout + stderr, /非交互模式|未获取到新 Cookie/, "非 TTY 下不应出现 keep-cookie 询问");
});

test("TTY：连续选择在同一次输入 chunk 中逐条消费（修复 burst 死锁）", { skip: !PTY_AVAILABLE ? PTY_SKIP : false }, async (t) => {
  const home = makeTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { exitCode, stdout } = await runPty({
    cmd: ["node", CLI_PATH],
    env: { HOME: home },
    steps: [{ trigger: "请选择功能", send: "4\n0\n" }],
    done: "再见",
  });
  assert.equal(exitCode, 0, `应正常退出，实际 exitCode=${exitCode}\n${stdout}`);
  assert.match(stdout, /配置文件:/, "选项 4（查看配置）应被执行");
  assert.match(stdout, /再见！/, "选项 0（退出）应被执行");
});

test("TTY：hidden 粘贴（含 CR）与换行同 chunk 到达时正确保存并退出", { skip: !PTY_AVAILABLE ? PTY_SKIP : false }, async (t) => {
  const home = makeTempHome("MUSIC_U=old-cookie");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { exitCode, stdout } = await runPty({
    cmd: ["node", CLI_PATH],
    env: { HOME: home },
    steps: [
      { trigger: "请选择功能", send: "3\n" },
      { trigger: "请输入歌曲 ID", send: "abc\n" },
      { trigger: "是否使用当前 Cookie", send: "n\n" },
      { trigger: "请粘贴新的网易云网页 Cookie", send: "MUSIC_U=PASTE\r" },
      { trigger: "下载失败", send: "0\n" },
    ],
    done: "再见",
  });
  assert.equal(exitCode, 0, `应正常退出，实际 exitCode=${exitCode}\n${stdout}`);
  const config = JSON.parse(
    fs.readFileSync(path.join(home, ".ncmdl", "config.json"), "utf8")
  );
  assert.equal(config.cookie, "MUSIC_U=PASTE", "config.json 应写入粘贴的 Cookie");
  assert.match(stdout, /再见！/);
});

test("TTY：hidden 粘贴以 LF 结尾时正确终止", { skip: !PTY_AVAILABLE ? PTY_SKIP : false }, async (t) => {
  const home = makeTempHome("MUSIC_U=old-cookie");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { exitCode, stdout } = await runPty({
    cmd: ["node", CLI_PATH],
    env: { HOME: home },
    steps: [
      { trigger: "请选择功能", send: "3\n" },
      { trigger: "请输入歌曲 ID", send: "abc\n" },
      { trigger: "是否使用当前 Cookie", send: "n\n" },
      { trigger: "请粘贴新的网易云网页 Cookie", send: "MUSIC_U=PASTE\n" },
      { trigger: "下载失败", send: "0\n" },
    ],
    done: "再见",
  });
  assert.equal(exitCode, 0, `应正常退出，实际 exitCode=${exitCode}\n${stdout}`);
  const config = JSON.parse(
    fs.readFileSync(path.join(home, ".ncmdl", "config.json"), "utf8")
  );
  assert.equal(config.cookie, "MUSIC_U=PASTE");
  assert.match(stdout, /再见！/);
});

test("TTY：hidden 粘贴以 CRLF 结尾时不产生幽灵空行（修复前菜单多跳一次无效选择）", { skip: !PTY_AVAILABLE ? PTY_SKIP : false }, async (t) => {
  const home = makeTempHome("MUSIC_U=old-cookie");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { exitCode, stdout } = await runPty({
    cmd: ["node", CLI_PATH],
    env: { HOME: home },
    steps: [
      { trigger: "请选择功能", send: "3\n" },
      { trigger: "请输入歌曲 ID", send: "abc\n" },
      { trigger: "是否使用当前 Cookie", send: "n\n" },
      { trigger: "请粘贴新的网易云网页 Cookie", send: "MUSIC_U=PASTE\r\n" },
      { trigger: "下载失败", send: "0\n" },
    ],
    done: "再见",
  });
  assert.equal(exitCode, 0, `应正常退出，实际 exitCode=${exitCode}\n${stdout}`);
  const config = JSON.parse(
    fs.readFileSync(path.join(home, ".ncmdl", "config.json"), "utf8")
  );
  assert.equal(config.cookie, "MUSIC_U=PASTE", "config.json 应写入粘贴的 Cookie");
  assert.doesNotMatch(stdout, /无效的选择/, "CRLF 粘贴不应产生幽灵空行");
  assert.match(stdout, /再见！/);
});

test("TTY：hidden 输入多 chunk 累积后正确终止", { skip: !PTY_AVAILABLE ? PTY_SKIP : false }, async (t) => {
  const home = makeTempHome("MUSIC_U=old-cookie");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { exitCode, stdout } = await runPty({
    cmd: ["node", CLI_PATH],
    env: { HOME: home },
    steps: [
      { trigger: "请选择功能", send: "3\n" },
      { trigger: "请输入歌曲 ID", send: "abc\n" },
      { trigger: "是否使用当前 Cookie", send: "n\n" },
      { trigger: "请粘贴新的网易云网页 Cookie", send: "MUSIC_U=PA" },
      { trigger: "请粘贴新的网易云网页 Cookie", send: "STE\r" },
      { trigger: "下载失败", send: "0\n" },
    ],
    done: "再见",
  });
  assert.equal(exitCode, 0, `应正常退出，实际 exitCode=${exitCode}\n${stdout}`);
  const config = JSON.parse(
    fs.readFileSync(path.join(home, ".ncmdl", "config.json"), "utf8")
  );
  assert.equal(config.cookie, "MUSIC_U=PASTE", "多 chunk 累积输入应完整保存");
  assert.match(stdout, /再见！/);
});

test("TTY：hidden 输入支持退格删除", { skip: !PTY_AVAILABLE ? PTY_SKIP : false }, async (t) => {
  const home = makeTempHome("MUSIC_U=old-cookie");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { exitCode, stdout } = await runPty({
    cmd: ["node", CLI_PATH],
    env: { HOME: home },
    steps: [
      { trigger: "请选择功能", send: "3\n" },
      { trigger: "请输入歌曲 ID", send: "abc\n" },
      { trigger: "是否使用当前 Cookie", send: "n\n" },
      { trigger: "请粘贴新的网易云网页 Cookie", send: "MUSIC_U=PASTEX\x7f\r" },
      { trigger: "下载失败", send: "0\n" },
    ],
    done: "再见",
  });
  assert.equal(exitCode, 0, `应正常退出，实际 exitCode=${exitCode}\n${stdout}`);
  const config = JSON.parse(
    fs.readFileSync(path.join(home, ".ncmdl", "config.json"), "utf8")
  );
  assert.equal(config.cookie, "MUSIC_U=PASTE", "退格应删除最后一个字符");
  assert.match(stdout, /再见！/);
});

test("TTY：raw-mode hidden 输入中 Ctrl+C 退出并返回 130", { skip: !PTY_AVAILABLE ? PTY_SKIP : false }, async (t) => {
  const home = makeTempHome("MUSIC_U=old-cookie");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { exitCode, stdout } = await runPty({
    cmd: ["node", CLI_PATH],
    env: { HOME: home },
    steps: [
      { trigger: "请选择功能", send: "3\n" },
      { trigger: "请输入歌曲 ID", send: "abc\n" },
      { trigger: "是否使用当前 Cookie", send: "n\n" },
      { trigger: "请粘贴新的网易云网页 Cookie", send: "MUSIC_U=AB\u0003" },
    ],
    done: "再见",
  });
  assert.equal(exitCode, 130, `应返回 130，实际 exitCode=${exitCode}\n${stdout}`);
});

test("TTY：EOF 时提示输入已结束并退出", { skip: !PTY_AVAILABLE ? PTY_SKIP : false }, async (t) => {
  const home = makeTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { exitCode, stdout } = await runPty({
    cmd: ["node", CLI_PATH],
    env: { HOME: home },
    steps: [{ trigger: "请选择功能", send: "\u0004" }],
    done: "输入已结束",
  });
  assert.equal(exitCode, 0, `应正常退出，实际 exitCode=${exitCode}\n${stdout}`);
  assert.match(stdout, /输入已结束，退出。/);
});

test("TTY：菜单 2 向导粘贴 CRLF Cookie 后纯 Enter 逐项接受默认值（回归：suppressNextLine 粘滞吞行死锁）", { skip: !PTY_AVAILABLE ? PTY_SKIP : false }, async (t) => {
  const home = makeTempHome("MUSIC_U=old-cookie");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { exitCode, stdout } = await runPty({
    cmd: ["node", CLI_PATH],
    env: { HOME: home },
    steps: [
      { trigger: "请选择功能", send: "2\n" },
      { trigger: "请输入网易云网页 Cookie", send: "MUSIC_U=SETUP\r\n" },
      { trigger: "请输入 User-Agent", send: "\n" },
      { trigger: "请输入下载目录", send: "\n" },
      { trigger: "请输入默认音质", send: "\n" },
      { trigger: "请输入文件名模式", send: "\n" },
      { trigger: "请选择功能", send: "0\n" },
    ],
    done: "再见",
  });
  assert.equal(exitCode, 0, `向导应完成并正常退出，实际 exitCode=${exitCode}\n${stdout}`);
  const config = JSON.parse(
    fs.readFileSync(path.join(home, ".ncmdl", "config.json"), "utf8")
  );
  assert.equal(config.cookie, "MUSIC_U=SETUP", "粘贴的 Cookie 应写入配置");
  assert.equal(config.userAgent, "UA-test", "纯 Enter 应接受默认 User-Agent");
  assert.match(stdout, /配置已保存。/);
});

test("TTY：download 无 ID 手动输入后失败并正常退出（回归：stdin 常驻导致进程永不退出）", { skip: !PTY_AVAILABLE ? PTY_SKIP : false }, async (t) => {
  const home = makeTempHome("MUSIC_U=old-cookie");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { exitCode, stdout } = await runPty({
    cmd: ["node", CLI_PATH, "download"],
    env: { HOME: home },
    steps: [
      { trigger: "请输入歌曲 ID 或链接", send: "abc\n" },
    ],
    done: "错误: 请输入有效的歌曲",
  });
  assert.equal(exitCode, 1, `失败后应退出（修复前挂死需 SIGKILL），实际 exitCode=${exitCode}\n${stdout}`);
});

test("TTY：download 无 Cookie 时粘贴 Cookie 后失败并正常退出（回归：askHidden 出口不清理 stdin）", { skip: !PTY_AVAILABLE ? PTY_SKIP : false }, async (t) => {
  const home = makeTempHome("");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { exitCode, stdout } = await runPty({
    cmd: ["node", CLI_PATH, "download", "abc"],
    env: { HOME: home },
    steps: [
      { trigger: "请粘贴网易云网页 Cookie", send: "MUSIC_U=NEW\r\n" },
    ],
    done: "错误: 请输入有效的歌曲",
  });
  assert.equal(exitCode, 1, `失败后应退出（修复前挂死需 SIGKILL），实际 exitCode=${exitCode}\n${stdout}`);
});
