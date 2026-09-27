/**
 * 纯布局算法模块 —— 同一份代码运行在四个环境：
 *   1. CSS Houdini Layout Worklet (layout-worklet.js)
 *   2. 主线程 JS 降级布局 (fallback.js)
 *   3. Web Worker 离线计算 (worker.js)
 *   4. Node.js 单元测试 (tests/)
 * 因为降级路径与 Worklet 路径共用同一实现，所以"降级布局结果一致"由构造保证。
 *
 * 坐标系约定：inline = 水平方向(x)，block = 垂直方向(y)，horizontal-tb 书写模式。
 * 所有算法输入 items: [{inlineSize, blockSize}]，
 * 输出 { positions: [{inlineOffset, blockOffset, inlineSize}], blockSize }。
 */

export const DEFAULTS = Object.freeze({
  gap: 12,
  align: 'start',            // 'start' | 'center' | 'end'
  columns: 0,                // 0 = 自动列数（瀑布流）
  minColumnInlineSize: 200,  // 自动列数时的最小列宽
  columnInlineSize: 0,       // >0 时固定列宽（不再拉伸，align 生效）
  brickInlineSize: 160,      // 砖墙单块宽度
  rowHeight: 0,              // 0 = 按行内最高项自适应
  radius: 0,                 // 环形半径，0 = 自动
  placeholderBlockSize: 100, // 子元素尺寸未就绪时的占位高度
});

export function normalizeParams(params = {}) {
  const merged = { ...DEFAULTS, ...params };
  merged.gap = finiteOr(merged.gap, DEFAULTS.gap);
  merged.columns = Math.max(0, Math.floor(finiteOr(merged.columns, 0)));
  merged.containerInlineSize = Math.max(0, finiteOr(merged.containerInlineSize, 0));
  if (!['start', 'center', 'end'].includes(merged.align)) merged.align = 'start';
  return merged;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** 尺寸未就绪（0 / NaN / 负数）时替换为占位尺寸。 */
export function sanitizeItems(items, params = DEFAULTS) {
  const placeholder = params.placeholderBlockSize || DEFAULTS.placeholderBlockSize;
  return items.map((item) => {
    const inlineSize = Number.isFinite(item.inlineSize) && item.inlineSize > 0
      ? item.inlineSize : placeholder;
    const blockSize = Number.isFinite(item.blockSize) && item.blockSize > 0
      ? item.blockSize : placeholder;
    return { inlineSize, blockSize, notReady: item.blockSize !== blockSize || item.inlineSize !== inlineSize };
  });
}

function alignShift(align, container, content) {
  const free = container - content;
  if (free <= 0) return 0;
  if (align === 'center') return free / 2;
  if (align === 'end') return free;
  return 0;
}

/** 瀑布流：每项放入当前最矮的列。 */
export function masonryLayout(rawItems, rawParams) {
  const params = normalizeParams(rawParams);
  const items = sanitizeItems(rawItems, params);
  if (items.length === 0) return { positions: [], blockSize: 0 };

  const { gap, containerInlineSize } = params;
  const columns = params.columns > 0
    ? params.columns
    : Math.max(1, Math.floor((containerInlineSize + gap) / (params.minColumnInlineSize + gap)));
  const stretched = (containerInlineSize - gap * (columns - 1)) / columns;
  const columnInline = params.columnInlineSize > 0
    ? Math.min(params.columnInlineSize, Math.max(stretched, 1))
    : Math.max(stretched, 1);
  const contentInline = columns * columnInline + (columns - 1) * gap;
  const shift = alignShift(params.align, containerInlineSize, contentInline);

  const columnHeights = new Array(columns).fill(0);
  const positions = items.map((item) => {
    let column = 0;
    for (let i = 1; i < columns; i += 1) {
      if (columnHeights[i] < columnHeights[column]) column = i;
    }
    const position = {
      inlineOffset: shift + column * (columnInline + gap),
      blockOffset: columnHeights[column],
      inlineSize: columnInline,
    };
    columnHeights[column] += item.blockSize + gap;
    return position;
  });
  const blockSize = Math.max(0, ...columnHeights) - (items.length ? gap : 0);
  return { positions, blockSize };
}

/** 砖墙：固定块宽逐行排列，奇数行右移半块，行间错位咬合。 */
export function brickLayout(rawItems, rawParams) {
  const params = normalizeParams(rawParams);
  const items = sanitizeItems(rawItems, params);
  if (items.length === 0) return { positions: [], blockSize: 0 };

  const { gap, containerInlineSize } = params;
  const brickInline = Math.max(1, params.brickInlineSize);
  const rowOffset = (brickInline + gap) / 2;

  const rows = [[]];
  let cursor = 0;
  for (const item of items) {
    let rowIndex = rows.length - 1;
    const offset = rowIndex % 2 === 1 ? rowOffset : 0;
    if (rows[rowIndex].length > 0 && cursor + brickInline > containerInlineSize) {
      rows.push([]);
      rowIndex += 1;
      cursor = rowIndex % 2 === 1 ? rowOffset : 0;
    } else if (rows[rowIndex].length === 0) {
      cursor = offset;
    }
    rows[rowIndex].push({ item, inlineOffset: cursor });
    cursor += brickInline + gap;
  }

  const positions = new Array(items.length);
  let index = 0;
  let blockCursor = 0;
  for (const row of rows) {
    const rowBlock = params.rowHeight > 0
      ? params.rowHeight
      : Math.max(...row.map((entry) => entry.item.blockSize));
    const last = row[row.length - 1];
    const rowInline = last.inlineOffset + brickInline;
    const shift = alignShift(params.align, containerInlineSize, rowInline);
    for (const entry of row) {
      positions[index] = {
        inlineOffset: shift + entry.inlineOffset,
        blockOffset: blockCursor,
        inlineSize: brickInline,
      };
      index += 1;
    }
    blockCursor += rowBlock + gap;
  }
  return { positions, blockSize: blockCursor - gap };
}

/** 环形：子元素均匀分布在圆周上，半径自动或指定。 */
export function ringLayout(rawItems, rawParams) {
  const params = normalizeParams(rawParams);
  const items = sanitizeItems(rawItems, params);
  if (items.length === 0) return { positions: [], blockSize: 0 };

  const { gap } = params;
  const n = items.length;
  const maxItem = Math.max(...items.map((i) => Math.max(i.inlineSize, i.blockSize)));
  const avgItem = items.reduce((sum, i) => sum + Math.max(i.inlineSize, i.blockSize), 0) / n;
  const needed = n <= 1 ? 0 : (n * (avgItem + gap)) / (2 * Math.PI);
  const radius = Math.max(params.radius || 0, needed, n > 1 ? maxItem / 2 : 0);

  const half = radius + maxItem / 2 + gap;
  const effectiveInline = Math.max(params.containerInlineSize, 2 * half);
  const centerInline = params.align === 'start'
    ? half
    : params.align === 'end'
      ? effectiveInline - half
      : effectiveInline / 2;
  const centerBlock = half;

  const positions = items.map((item, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return {
      inlineOffset: centerInline + radius * Math.cos(angle) - item.inlineSize / 2,
      blockOffset: centerBlock + radius * Math.sin(angle) - item.blockSize / 2,
      inlineSize: item.inlineSize,
    };
  });
  return { positions, blockSize: 2 * half };
}

/** 螺旋：阿基米德螺线 r = b·θ，弧长间距 ≈ 项尺寸 + gap。 */
export function spiralLayout(rawItems, rawParams) {
  const params = normalizeParams(rawParams);
  const items = sanitizeItems(rawItems, params);
  if (items.length === 0) return { positions: [], blockSize: 0 };

  const { gap } = params;
  const maxItem = Math.max(...items.map((i) => Math.max(i.inlineSize, i.blockSize)));
  const avgItem = items.reduce((sum, i) => sum + Math.max(i.inlineSize, i.blockSize), 0) / items.length;
  const step = avgItem + gap;
  const pitch = step / (2 * Math.PI); // 每旋转一周半径增量 = step

  const points = [];
  let theta = 0;
  let radius = 0;
  for (const item of items) {
    points.push({ radius, theta, item });
    theta += step / Math.max(radius, step * 0.75);
    radius = pitch * theta;
  }

  const half = radius + maxItem / 2 + gap;
  const effectiveInline = Math.max(params.containerInlineSize, 2 * half);
  const centerInline = params.align === 'start'
    ? half
    : params.align === 'end'
      ? effectiveInline - half
      : effectiveInline / 2;
  const centerBlock = half;

  const positions = points.map(({ radius: r, theta: t, item }) => ({
    inlineOffset: centerInline + r * Math.cos(t) - item.inlineSize / 2,
    blockOffset: centerBlock + r * Math.sin(t) - item.blockSize / 2,
    inlineSize: item.inlineSize,
  }));
  return { positions, blockSize: 2 * half };
}

export const LAYOUTS = Object.freeze({
  masonry: masonryLayout,
  brick: brickLayout,
  ring: ringLayout,
  spiral: spiralLayout,
});

export function computeLayout(type, items, params) {
  const fn = LAYOUTS[type];
  if (!fn) throw new Error(`未知布局类型: ${type}`);
  return fn(items, params);
}
