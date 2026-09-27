/**
 * Web Worker：子元素数量较大时，把布局计算从主线程卸载到这里。
 * 与 Worklet / 降级路径共用 layout-algorithms.js，保证结果一致。
 */
import { computeLayout } from './layout-algorithms.js';

self.onmessage = (event) => {
  const { id, type, items, params } = event.data;
  try {
    const result = computeLayout(type, items, params);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message || error) });
  }
};
