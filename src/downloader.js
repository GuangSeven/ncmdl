/**
 * 并发下载调度：把一批歌曲分成最多 limit 条并发通道执行。
 *
 * 说明：Node.js 的 fetch / 文件写入本身是异步 I/O，多个任务在同一事件循环里
 * 重叠等待网络即可实现"同时下载多首歌"的效果，无需额外线程。
 */

const MIN_CONCURRENCY = 4;
const MAX_CONCURRENCY = 12;
const DEFAULT_CONCURRENCY = 4;

/**
 * 归一化并发数：非法值回落到默认值，超出 4-12 范围时收敛到边界。
 * @param {*} value
 * @param {number} [fallback]
 * @returns {number}
 */
function normalizeConcurrency(value, fallback = DEFAULT_CONCURRENCY) {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < MIN_CONCURRENCY) return MIN_CONCURRENCY;
  if (parsed > MAX_CONCURRENCY) return MAX_CONCURRENCY;
  return parsed;
}

/**
 * 以固定并发上限执行 worker，返回与 items 等长、按原顺序排列的结果数组。
 * worker 抛错不会中断整体：对应项记为 rejected，其余任务继续执行。
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit 并发上限（<=0 时视为 1）
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<{status: "fulfilled", value: R} | {status: "rejected", reason: unknown}>>}
 */
async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  if (list.length === 0) return results;
  const laneCount = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  let nextIndex = 0;
  const lane = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) return;
      try {
        const value = await worker(list[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: laneCount }, () => lane()));
  return results;
}

module.exports = {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  normalizeConcurrency,
  runWithConcurrency
};
