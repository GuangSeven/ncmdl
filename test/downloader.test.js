const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  normalizeConcurrency,
  runWithConcurrency
} = require("../src/downloader");

test("normalizeConcurrency: 非法值回落到默认并发", () => {
  assert.equal(normalizeConcurrency(undefined), DEFAULT_CONCURRENCY);
  assert.equal(normalizeConcurrency(""), DEFAULT_CONCURRENCY);
  assert.equal(normalizeConcurrency("abc"), DEFAULT_CONCURRENCY);
  assert.equal(normalizeConcurrency(null, 6), 6);
});

test("normalizeConcurrency: 收敛到 4-12 范围", () => {
  assert.equal(normalizeConcurrency(1), MIN_CONCURRENCY);
  assert.equal(normalizeConcurrency("2"), MIN_CONCURRENCY);
  assert.equal(normalizeConcurrency(99), MAX_CONCURRENCY);
  assert.equal(normalizeConcurrency("6"), 6);
  assert.equal(normalizeConcurrency(12), 12);
});

test("runWithConcurrency: 并发数不超过上限且结果按输入顺序排列", async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  let active = 0;
  let peak = 0;
  const results = await runWithConcurrency(items, 4, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, (10 - item) * 2));
    active -= 1;
    return item * 2;
  });

  assert.equal(peak, 4, `并发峰值应为 4，实际 ${peak}`);
  assert.deepEqual(
    results.map((r) => r.value),
    items.map((item) => item * 2),
    "结果顺序应与输入一致"
  );
});

test("runWithConcurrency: 单个任务失败不中断其余任务", async () => {
  const items = ["ok1", "bad", "ok2"];
  const results = await runWithConcurrency(items, 4, async (item) => {
    if (item === "bad") throw new Error("boom");
    return item;
  });

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value, "ok1");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /boom/);
  assert.equal(results[2].status, "fulfilled");
  assert.equal(results[2].value, "ok2");
});

test("runWithConcurrency: 空列表返回空数组", async () => {
  const results = await runWithConcurrency([], 4, async () => 1);
  assert.deepEqual(results, []);
});
