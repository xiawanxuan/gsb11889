/*
 * fallback.js
 * 降级引擎：当浏览器不支持 Layout Worklet 或 worklet 加载失败时，
 * 在主线程用绝对定位手动实现完全相同的布局（共享 layout-algorithms.js）。
 *
 * 职责：
 *  - ResizeObserver 监听容器与子元素尺寸变化 -> 重新布局
 *  - MutationObserver 监听子元素增删 -> 重新布局
 *  - 子元素尺寸未就绪（data-pending / 高度为 0）-> 使用预估高度占位
 *  - 循环依赖检测：布局->测量迭代不收敛或内容高度爆炸时冻结并上报
 *  - performance.mark/measure 记录每次布局耗时（供 PerformanceObserver）
 */
(function (global) {
  'use strict';

  var MAX_ITERATIONS = 6;      // 测量-布局迭代上限，超过即判定为循环依赖
  var MAX_CONTENT_HEIGHT = 20000; // 内容高度爆炸保护
  var STABLE_EPSILON = 0.5;

  var container = null;
  var enabled = false;
  var scheduled = false;
  var containerRO = null;
  var childRO = null;
  var mutationObserver = null;
  var onEvent = function () {};
  var cycleActive = false;

  function readParams(el) {
    var cs = getComputedStyle(el);
    function num(name, dft) {
      var v = parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? v : dft;
    }
    function str(name, dft) {
      var v = cs.getPropertyValue(name).trim();
      return v || dft;
    }
    return {
      mode: str('--layout-mode', 'masonry'),
      gap: num('--gap', 12),
      align: str('--align', 'start'),
      columns: num('--columns', 0),
      rowHeight: num('--row-height', 120),
      itemSize: num('--item-size', 160),
      estimatedHeight: num('--estimated-height', 140),
      width: el.clientWidth
    };
  }

  function measureChild(el, params) {
    var pending = el.dataset.pending === 'true';
    var w = el.offsetWidth;
    var h = el.offsetHeight;
    var estimated = false;
    if (pending || h === 0) {
      h = params.estimatedHeight;
      estimated = true;
    }
    if (w === 0) w = params.itemSize;
    el.classList.toggle('estimated', estimated);
    return { width: w, height: h, estimated: estimated };
  }

  function applyPositions(kids, result, params) {
    for (var i = 0; i < kids.length; i++) {
      kids[i].style.transform =
        'translate(' + result.positions[i].x + 'px,' + result.positions[i].y + 'px)';
    }
    container.style.height = Math.min(result.contentHeight, MAX_CONTENT_HEIGHT) + 'px';
  }

  function performLayout() {
    if (!container) return;
    var params = readParams(container);
    var kids = Array.prototype.slice.call(container.children);
    if (kids.length === 0) {
      container.style.height = '0px';
      return;
    }

    // 与 worklet 一致的 inline 约束。
    var inlineW = global.LayoutAlgorithms.itemInlineSize(params.mode, params);
    for (var k = 0; k < kids.length; k++) kids[k].style.width = inlineW + 'px';

    performance.mark('fb-layout-start');
    var result = null;
    var stable = false;
    var iterations = 0;

    // 测量 -> 布局 -> 再测量：若应用位置后子元素尺寸持续变化
    // （例如子元素高度依赖容器高度，而容器高度又依赖子元素），
    // 则存在循环依赖。迭代不收敛即冻结并上报。
    while (iterations < MAX_ITERATIONS) {
      var sizes = kids.map(function (el) { return measureChild(el, params); });
      result = global.LayoutAlgorithms.compute(params.mode, sizes, params);
      if (result.contentHeight > MAX_CONTENT_HEIGHT) { stable = false; break; }
      applyPositions(kids, result, params);
      iterations++;

      stable = sizes.every(function (s, i) {
        if (s.estimated) return true; // 占位尺寸不参与收敛判断
        return Math.abs(kids[i].offsetWidth - s.width) < STABLE_EPSILON &&
               Math.abs(kids[i].offsetHeight - s.height) < STABLE_EPSILON;
      });
      if (stable) break;
    }

    performance.mark('fb-layout-end');
    performance.measure('fallback-layout', 'fb-layout-start', 'fb-layout-end');

    if (!stable) {
      if (!cycleActive) {
        cycleActive = true;
        onEvent({
          type: 'cycle',
          message: '检测到循环依赖：布局迭代 ' + iterations + ' 次仍不收敛，已冻结在最后结果。' +
                   '（子元素尺寸不应依赖由内容决定的容器尺寸）'
        });
      }
    } else if (cycleActive) {
      cycleActive = false;
      onEvent({ type: 'cycle-recovered', message: '循环依赖已解除，布局恢复收敛。' });
    }
    onEvent({ type: 'layout', iterations: iterations, itemCount: kids.length });
  }

  function schedule() {
    if (scheduled || !enabled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      if (enabled) performLayout();
    });
  }

  function syncChildObserver() {
    if (!childRO || !container) return;
    childRO.disconnect();
    Array.prototype.forEach.call(container.children, function (el) {
      childRO.observe(el);
    });
  }

  global.FallbackEngine = {
    readParams: readParams,
    init: function (el, eventHandler) {
      container = el;
      onEvent = eventHandler || onEvent;
      containerRO = new ResizeObserver(function () { schedule(); });
      containerRO.observe(el);
      childRO = new ResizeObserver(function () { schedule(); });
      mutationObserver = new MutationObserver(function () {
        syncChildObserver();
        schedule();
      });
      mutationObserver.observe(el, { childList: true });
      syncChildObserver();
    },
    setEnabled: function (v) {
      enabled = !!v;
      if (enabled) schedule();
    },
    isEnabled: function () { return enabled; },
    relayout: schedule,
    flush: function () { if (enabled) performLayout(); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
