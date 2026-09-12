// 第八轮修复：缓冲队列纯函数，用于页面桥在内容脚本就绪前暂存捕获的响应
// 纯函数，不依赖浏览器 API，可独立测试

export interface PendingQueue<T> {
  /** 提交一条数据：未就绪则入队（超限丢最旧），已就绪则直接通过回调发送 */
  emit(item: T): void;
  /** 标记就绪并回放缓冲队列（幂等：重复调用无副作用） */
  flush(): void;
  /** 当前是否已就绪 */
  isReady(): boolean;
  /** 当前缓冲队列长度（仅用于诊断/测试） */
  pendingCount(): number;
}

/**
 * 创建一个带容量上限的缓冲队列。
 * @param send  直接发送回调（就绪后或 flush 时调用）
 * @param limit 队列上限，超出丢弃最旧条目（默认 50）
 */
export function createPendingQueue<T>(send: (item: T) => void, limit = 50): PendingQueue<T> {
  const queue: T[] = [];
  let ready = false;

  return {
    emit(item: T) {
      if (ready) {
        // 已就绪，直接发送
        send(item);
      } else {
        // 未就绪，入队；超出上限丢弃最旧
        if (queue.length >= limit) {
          queue.shift();
        }
        queue.push(item);
      }
    },

    flush() {
      if (ready) return; // 幂等：重复 flush 无副作用
      ready = true;
      // 按序回放
      for (const item of queue) {
        send(item);
      }
      queue.length = 0;
    },

    isReady() {
      return ready;
    },

    pendingCount() {
      return queue.length;
    },
  };
}
