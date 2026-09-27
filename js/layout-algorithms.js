/*
 * layout-algorithms.js
 * 共享布局算法核心：同时被 Layout Worklet（js/layout-worklet.js）
 * 和主线程降级引擎（js/fallback.js）使用，保证两种引擎结果一致。
 *
 * 该文件既是合法的 ES 模块（可被 worklet 静态 import），
 * 也是合法的经典脚本（可通过 <script> 加载），通过 globalThis 导出。
 *
 * 所有算法均为纯函数：输入子元素尺寸数组 + 参数，输出每个子元素的
 * 位置 {x, y} 以及内容总高度 contentHeight。坐标系原点为容器内容盒左上角。
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    gap: 12,
    align: 'start',       // start | center |end（内容块在容器 inline 方向上的对齐）
    columns: 0,           // 0 = 自动
    rowHeight: 120,
    itemSize: 160,        // ring / spiral 模式下子元素的约束宽度
    targetColumnWidth: 180
  };

  function withDefaults(params) {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    if (params) for (var k2 in params) if (params[k2] !== undefined) out[k2] = params[k2];
    out.gap = Math.max(0, Number(out.gap) || 0);
    out.width = Math.max(0, Number(out.width) || 0);
    out.columns = Math.max(0, Math.floor(Number(out.columns) || 0));
    return out;
  }

  function resolveColumns(width, gap, columns) {
    if (columns > 0) return columns;
    var target = DEFAULTS.targetColumnWidth;
    return Math.max(1, Math.round((width + gap) / (target + gap)));
  }

  /* 引擎在测量子元素前需要施加的 inline 约束宽度（两种引擎共用，保证一致） */
  function itemInlineSize(mode, params) {
    var p = withDefaults(params);
    if (mode === 'masonry' || mode === 'brick') {
      var cols = resolveColumns(p.width, p.gap, p.columns);
      return Math.max(1, (p.width - p.gap * (cols - 1)) / cols);
    }
    return Math.max(1, Math.min(p.itemSize, p.width || p.itemSize));
  }

  function alignOffset(align, containerWidth, contentWidth) {
    var free = containerWidth - contentWidth;
    if (free <= 0) return 0;
    if (align === 'center') return free / 2;
    if (align === 'end') return free;
    return 0;
  }

  /* 瀑布流：每个子元素放入当前最短的列 */
  function masonry(sizes, params) {
    var p = withDefaults(params);
    var cols = resolveColumns(p.width, p.gap, p.columns);
    var colW = Math.max(1, (p.width - p.gap * (cols - 1)) / cols);
    var totalW = cols * colW + (cols - 1) * p.gap;
    var offX = alignOffset(p.align, p.width, totalW);
    var heights = new Array(cols).fill(0);
    var positions = new Array(sizes.length);
    for (var i = 0; i < sizes.length; i++) {
      var col = 0;
      for (var c = 1; c < cols; c++) if (heights[c] < heights[col]) col = c;
      positions[i] = { x: offX + col * (colW + p.gap), y: heights[col] };
      heights[col] += sizes[i].height + p.gap;
    }
    var contentHeight = cols ? Math.max(0, Math.max.apply(null, heights) - p.gap) : 0;
    return { positions: positions, contentHeight: contentHeight, contentWidth: totalW };
  }

  /* 砖墙：偶数行 cols 个、奇数行 cols-1 个并右移半格，行高取行内最大高度 */
  function brick(sizes, params) {
    var p = withDefaults(params);
    var cols = resolveColumns(p.width, p.gap, p.columns);
    var colW = Math.max(1, (p.width - p.gap * (cols - 1)) / cols);
    var positions = new Array(sizes.length);
    var y = 0, i = 0, row = 0;
    while (i < sizes.length) {
      var odd = row % 2 === 1;
      var count = odd ? Math.max(1, cols - 1) : cols;
      var indent = odd ? (colW + p.gap) / 2 : 0;
      var rowW = count * colW + (count - 1) * p.gap;
      var offX = alignOffset(p.align, p.width, indent + rowW);
      var rowH = 0;
      for (var j = 0; j < count && i < sizes.length; j++, i++) {
        positions[i] = { x: offX + indent + j * (colW + p.gap), y: y };
        if (sizes[i].height > rowH) rowH = sizes[i].height;
      }
      y += rowH + p.gap;
      row++;
    }
    return { positions: positions, contentHeight: Math.max(0, y - p.gap), contentWidth: p.width };
  }

  /* 环形：子元素均匀分布在圆周上 */
  function ring(sizes, params) {
    var p = withDefaults(params);
    var n = sizes.length;
    if (n === 0) return { positions: [], contentHeight: 0, contentWidth: 0 };
    var maxW = 0, maxH = 0;
    for (var i = 0; i < n; i++) {
      if (sizes[i].width > maxW) maxW = sizes[i].width;
      if (sizes[i].height > maxH) maxH = sizes[i].height;
    }
    var radius = Math.max(80, (n * (maxW + p.gap)) / (2 * Math.PI));
    var cx;
    if (p.align === 'start') cx = radius + maxW / 2 + p.gap;
    else if (p.align === 'end') cx = Math.max(radius + maxW / 2 + p.gap, p.width - radius - maxW / 2 - p.gap);
    else cx = Math.max(radius + maxW / 2 + p.gap, p.width / 2);
    var cy = radius + maxH / 2 + p.gap;
    var positions = new Array(n);
    for (var k = 0; k < n; k++) {
      var theta = (2 * Math.PI * k) / n - Math.PI / 2;
      positions[k] = {
        x: cx + radius * Math.cos(theta) - sizes[k].width / 2,
        y: cy + radius * Math.sin(theta) - sizes[k].height / 2
      };
    }
    return { positions: positions, contentHeight: 2 * cy, contentWidth: 2 * cx };
  }

  /* 螺旋：沿阿基米德螺线按弧长间距排布，整体平移使最小 y 对齐顶部 */
  function spiral(sizes, params) {
    var p = withDefaults(params);
    var n = sizes.length;
    if (n === 0) return { positions: [], contentHeight: 0, contentWidth: 0 };
    var maxW = 0, maxH = 0;
    for (var i = 0; i < n; i++) {
      if (sizes[i].width > maxW) maxW = sizes[i].width;
      if (sizes[i].height > maxH) maxH = sizes[i].height;
    }
    var raw = new Array(n);
    var theta = 0, r = 30, minY = Infinity, maxY = -Infinity, maxR = 0;
    for (var k = 0; k < n; k++) {
      raw[k] = { x: r * Math.cos(theta), y: r * Math.sin(theta) };
      if (r > maxR) maxR = r;
      var spacing = (Math.max(sizes[k].width, sizes[k].height) + maxW + maxH) / 2 + p.gap;
      theta += spacing / Math.max(r, 30);
      r = 30 + 14 * theta;
    }
    var cx;
    var half = maxR + maxW / 2 + p.gap;
    if (p.align === 'start') cx = half;
    else if (p.align === 'end') cx = Math.max(half, p.width - half);
    else cx = Math.max(half, p.width / 2);
    var positions = new Array(n);
    for (var m = 0; m < n; m++) {
      var top = raw[m].y - sizes[m].height / 2;
      var bottom = raw[m].y + sizes[m].height / 2;
      if (top < minY) minY = top;
      if (bottom > maxY) maxY = bottom;
      positions[m] = { x: cx + raw[m].x - sizes[m].width / 2, y: top };
    }
    var shift = p.gap - minY;
    for (var q = 0; q < n; q++) positions[q].y += shift;
    return { positions: positions, contentHeight: maxY - minY + 2 * p.gap, contentWidth: 2 * cx };
  }

  var MODES = { masonry: masonry, brick: brick, ring: ring, spiral: spiral };

  function compute(mode, sizes, params) {
    var fn = MODES[mode] || masonry;
    return fn(sizes, params);
  }

  global.LayoutAlgorithms = {
    compute: compute,
    itemInlineSize: itemInlineSize,
    resolveColumns: resolveColumns,
    modes: Object.keys(MODES)
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
