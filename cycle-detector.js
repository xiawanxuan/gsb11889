/**
 * 布局循环依赖检测：
 *  1. ResizeObserver 风暴 —— 布局改动触发尺寸变化，尺寸变化又触发布局，
 *     单位时间内回调次数超过阈值即判定为循环。
 *  2. 约束振荡 —— 相同的布局输入签名反复产生 A→B→A→B 的输出，
 *     说明布局结果在两种状态间振荡（典型的循环依赖）。
 */

export class ResizeStormDetector {
  constructor({ windowMs = 1000, maxEvents = 30, now = () => performance.now() } = {}) {
    this.windowMs = windowMs;
    this.maxEvents = maxEvents;
    this.now = now;
    this.timestamps = [];
  }

  /** 每次 RO 回调调用；返回 true 表示检测到循环。 */
  record() {
    const now = this.now();
    this.timestamps.push(now);
    const cutoff = now - this.windowMs;
    while (this.timestamps.length && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
    return this.timestamps.length > this.maxEvents;
  }

  reset() {
    this.timestamps = [];
  }
}

export class OscillationDetector {
  constructor({ historyLength = 8 } = {}) {
    this.historyLength = historyLength;
    this.history = [];
  }

  /**
   * 每次布局完成调用，signature 为 (输入摘要 + 输出摘要) 的字符串。
   * 若最近历史出现 ABAB 交替模式，返回 true。
   */
  record(signature) {
    this.history.push(signature);
    if (this.history.length > this.historyLength) this.history.shift();
    const h = this.history;
    if (h.length < 4) return false;
    const a = h[h.length - 1];
    const b = h[h.length - 2];
    return a !== b
      && h[h.length - 3] === a
      && h[h.length - 4] === b;
  }

  reset() {
    this.history = [];
  }
}

/** 生成布局签名：输入（类型/参数/数量/容器宽）+ 输出（总高度）。 */
export function layoutSignature(type, params, itemCount, containerInline, blockSize) {
  return [
    type,
    params.gap,
    params.align,
    params.columns,
    itemCount,
    Math.round(containerInline),
    Math.round(blockSize),
  ].join('|');
}
