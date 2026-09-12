// 并发队列 + 失败重试（纯逻辑，可单测，按 PRD §4.3 链路 3）

export interface QueueTask<T> {
  id: string;
  run: () => Promise<T>;
}

export interface QueueResult<T> {
  id: string;
  success: boolean;
  value?: T;
  error?: unknown;
}

export interface QueueOptions {
  concurrency: number; // 1–10
  retry: number; // 0–3（每个任务独立重试次数，首次执行不计入 retry）
  onProgress?: (done: number, total: number, currentId: string) => void;
  onTaskDone?: (result: QueueResult<unknown>) => void;
}

/**
 * 并发队列：限制同时执行的任务数，每个任务失败后重试指定次数。
 * 返回所有结果（含成功/失败），不因单条失败中断整体。
 */
export async function runQueue<T>(
  tasks: QueueTask<T>[],
  options: QueueOptions
): Promise<QueueResult<T>[]> {
  const { concurrency, retry, onProgress, onTaskDone } = options;
  const cap = Math.max(1, Math.min(10, concurrency));
  const maxRetry = Math.max(0, Math.min(3, retry));

  const results: QueueResult<T>[] = [];
  let nextIndex = 0;
  let doneCount = 0;

  // 单个 worker：从队列取任务执行，直到所有任务完成
  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      const task = tasks[idx];
      let lastErr: unknown;
      let succeeded = false;

      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        try {
          const value = await task.run();
          const r: QueueResult<T> = { id: task.id, success: true, value };
          results.push(r);
          succeeded = true;
          doneCount++;
          onProgress?.(doneCount, tasks.length, task.id);
          onTaskDone?.(r as QueueResult<unknown>);
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < maxRetry) {
            // 线性退避：500ms, 1000ms, 1500ms
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }
      }

      // 全部重试用尽仍失败
      if (!succeeded) {
        const r: QueueResult<T> = { id: task.id, success: false, error: lastErr };
        results.push(r);
        doneCount++;
        onProgress?.(doneCount, tasks.length, task.id);
        onTaskDone?.(r as QueueResult<unknown>);
      }
    }
  }

  // 启动 cap 个 worker
  const workers = Array.from({ length: Math.min(cap, tasks.length) }, () => worker());
  await Promise.all(workers);

  // 按原始顺序排序结果
  const order = new Map(tasks.map((t, i) => [t.id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return results;
}
