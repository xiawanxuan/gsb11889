/**
 * JS 手动布局降级引擎：
 *  - 不支持 Layout Worklet / Worklet 加载失败 / 运行期失败时使用。
 *  - 与 Worklet 共用 layout-algorithms.js，保证降级结果一致。
 *  - 子元素数量超过阈值时可切换到 Web Worker 计算，避免阻塞主线程。
 *  - 子元素尺寸未就绪（0 高）时使用占位尺寸，ResizeObserver 就绪后自动重排。
 */
import { computeLayout, normalizeParams } from './layout-algorithms.js';

const WORKER_THRESHOLD = 150;

export class FallbackLayoutEngine {
  constructor(container, { onLayout, onPerf } = {}) {
    this.container = container;
    this.onLayout = onLayout || (() => {});
    this.onPerf = onPerf || (() => {});
    this.worker = null;
    this.workerEnabled = true;
    this.layoutSeq = 0;   // 布局请求令牌（过期请求丢弃）
    this.messageSeq = 0;  // Worker 消息 id
    this.pendingResolve = new Map();
  }

  getWorker() {
    if (!this.worker) {
      this.worker = new Worker('worker.js', { type: 'module' });
      this.worker.onmessage = (event) => {
        const { id, ok, result, error } = event.data;
        const entry = this.pendingResolve.get(id);
        if (!entry) return;
        this.pendingResolve.delete(id);
        if (ok) entry.resolve(result);
        else entry.reject(new Error(error));
      };
      this.worker.onerror = (error) => {
        console.warn('Worker 出错，回退到主线程计算', error);
        this.worker.terminate();
        this.worker = null;
        this.workerEnabled = false;
      };
    }
    return this.worker;
  }

  computeInWorker(type, items, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.messageSeq;
      this.pendingResolve.set(id, { resolve, reject });
      this.getWorker().postMessage({ id, type, items, params });
    });
  }

  /** 测量子元素当前尺寸；尺寸未就绪的项标记 notReady，由算法层替换占位尺寸。 */
  measure(children, params, type) {
    const fixedInline = type === 'brick'
      ? Math.max(1, params.brickInlineSize)
      : null;
    return children.map((el) => {
      if (type === 'masonry') {
        const columns = params.columns > 0
          ? params.columns
          : Math.max(1, Math.floor((params.containerInlineSize + params.gap)
              / (params.minColumnInlineSize + params.gap)));
        const stretched = (params.containerInlineSize - params.gap * (columns - 1)) / columns;
        const width = params.columnInlineSize > 0
          ? Math.min(params.columnInlineSize, Math.max(stretched, 1))
          : Math.max(stretched, 1);
        el.style.width = `${width}px`;
      } else if (fixedInline != null) {
        el.style.width = `${fixedInline}px`;
      } else {
        el.style.width = '';
      }
      return { inlineSize: el.offsetWidth, blockSize: el.offsetHeight };
    });
  }

  /**
   * 执行一次完整布局。返回 true 表示应用了最新结果。
   * 过期请求（布局期间又触发了新布局）会被丢弃，避免错位。
   */
  async layout(type, rawParams) {
    const token = ++this.layoutSeq;
    const params = normalizeParams({
      ...rawParams,
      containerInlineSize: this.container.clientWidth,
    });
    const children = Array.from(this.container.children);
    if (children.length === 0) {
      this.container.style.height = '0px';
      this.onLayout({ type, params, itemCount: 0, blockSize: 0 });
      return true;
    }

    const items = this.measure(children, params, type);
    const useWorker = this.workerEnabled
      && rawParams.useWorker !== false
      && items.length >= WORKER_THRESHOLD;

    performance.mark('fallback-layout-start');
    let result;
    try {
      result = useWorker
        ? await this.computeInWorker(type, items, params)
        : computeLayout(type, items, params);
    } catch (error) {
      if (useWorker) {
        // Worker 失败时回退主线程同步计算，保证布局不中断。
        result = computeLayout(type, items, params);
      } else {
        throw error;
      }
    }
    if (token !== this.layoutSeq) return false; // 已有更新的布局请求

    this.apply(children, result);
    performance.mark('fallback-layout-end');
    const measure = performance.measure('fallback-layout', 'fallback-layout-start', 'fallback-layout-end');
    this.onPerf({ duration: measure.duration, itemCount: items.length, useWorker });
    this.onLayout({ type, params, itemCount: items.length, blockSize: result.blockSize });
    return true;
  }

  apply(children, { positions, blockSize }) {
    this.container.style.position = 'relative';
    this.container.style.height = `${Math.max(0, blockSize)}px`;
    children.forEach((el, i) => {
      const position = positions[i];
      if (!position) return;
      el.style.position = 'absolute';
      el.style.left = `${position.inlineOffset}px`;
      el.style.top = `${position.blockOffset}px`;
      if (position.inlineSize) el.style.width = `${position.inlineSize}px`;
    });
  }

  /** 退出降级模式时清理内联样式，交还给 Houdini。 */
  release() {
    this.container.style.height = '';
    this.container.style.position = '';
    for (const el of this.container.children) {
      el.style.position = '';
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
    }
  }

  destroy() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}
