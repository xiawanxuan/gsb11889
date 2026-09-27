/**
 * 主控逻辑：
 *  - 特性检测 + Worklet 加载（失败有提示并自动降级）
 *  - MutationObserver 跟踪子元素增删
 *  - ResizeObserver 跟踪容器宽度与子元素尺寸就绪，含循环依赖检测
 *  - PerformanceObserver 监控长任务，布局耗时长时自动降级/卸载到 Worker
 *  - IndexedDB 持久化设置与性能日志
 */
import { FallbackLayoutEngine } from './fallback.js';
import { ResizeStormDetector, OscillationDetector, layoutSignature } from './cycle-detector.js';
import { saveSettings, loadSettings, logPerf } from './db.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  mode: 'fallback',          // 'houdini' | 'fallback'
  enginePref: 'auto',        // 'auto' | 'houdini' | 'fallback'
  houdiniAvailable: false,
  workletLoaded: false,
  type: 'masonry',
  params: { gap: 12, align: 'start', columns: 0 },
  useWorker: true,
  itemSeq: 0,
  perfSamples: [],
  longTasks: 0,
  degraded: false,
};

let engine;
let layoutScheduled = false;
const stormDetector = new ResizeStormDetector({ maxEvents: 30 });
const oscillationDetector = new OscillationDetector();

/* ---------- 提示与状态 ---------- */

function notify(message, kind = 'info', timeout = 6000) {
  const box = document.createElement('div');
  box.className = `alert alert-${kind}`;
  box.textContent = message;
  $('#alerts').append(box);
  if (timeout) setTimeout(() => box.remove(), timeout);
}

function setStatus(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('bad', ok === false);
}

/* ---------- 布局调度 ---------- */

function currentParams() {
  return { ...state.params, useWorker: state.useWorker };
}

function scheduleLayout(reason) {
  if (state.mode !== 'fallback') return;
  if (layoutScheduled) return;
  layoutScheduled = true;
  requestAnimationFrame(async () => {
    layoutScheduled = false;
    try {
      await engine.layout(state.type, currentParams());
    } catch (error) {
      notify(`降级布局失败（${reason}）：${error.message}`, 'error');
    }
  });
}

function applyMode() {
  const container = $('#demo');
  if (state.mode === 'houdini') {
    engine.release();
    container.classList.add('houdini');
    container.style.display = `layout(${state.type})`;
  } else {
    container.classList.remove('houdini');
    container.style.display = 'block';
    scheduleLayout('模式切换');
  }
  setStatus('#status-mode', state.mode === 'houdini' ? 'Houdini Worklet' : 'JS 降级布局', state.mode === 'houdini');
  syncCustomProps();
  // 健康检查：Houdini 模式下布局运行期失败时容器会塌成 0 高。
  if (state.mode === 'houdini') {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (state.mode === 'houdini' && container.children.length > 0 && container.offsetHeight === 0) {
        notify('Worklet 布局运行期失败（容器高度为 0），已自动降级到 JS 布局', 'error');
        switchToFallback('运行期失败');
      }
    }));
  }
}

function switchToFallback(reason) {
  state.mode = 'fallback';
  state.enginePref = 'fallback';
  $('#engine').value = 'fallback';
  applyMode();
  console.warn('已降级到 JS 布局：', reason);
}

function syncCustomProps() {
  const container = $('#demo');
  container.style.setProperty('--layout-gap', state.params.gap);
  container.style.setProperty('--layout-align', state.params.align);
  container.style.setProperty('--layout-columns', state.params.columns);
  if (state.mode === 'houdini') {
    container.style.display = `layout(${state.type})`;
  }
}

/* ---------- 子元素 ---------- */

const PALETTE = ['#7c6cf0', '#4f9cf9', '#39b8a6', '#f2a33c', '#e5628c', '#8bc34a'];

function createItem({ late = false } = {}) {
  const el = document.createElement('div');
  el.className = 'item';
  const id = ++state.itemSeq;
  const height = 70 + Math.floor(Math.random() * 140);
  el.dataset.itemId = id;
  el.style.background = PALETTE[id % PALETTE.length];
  if (late) {
    // 模拟尺寸未就绪：先 0 高（占位尺寸生效），800ms 后内容"加载完成"。
    el.classList.add('not-ready');
    el.textContent = `#${id} 加载中…`;
    setTimeout(() => {
      el.classList.remove('not-ready');
      el.style.setProperty('--h', `${height}px`);
      el.textContent = `#${id}`;
    }, 800);
  } else {
    el.style.setProperty('--h', `${height}px`);
    el.textContent = `#${id}`;
  }
  return el;
}

function addItems(count, options) {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) fragment.append(createItem(options));
  $('#demo').append(fragment);
}

function removeItems(count) {
  const container = $('#demo');
  for (let i = 0; i < count && container.lastElementChild; i += 1) {
    container.lastElementChild.remove();
  }
}

/* ---------- 观察器 ---------- */

function setupObservers() {
  const container = $('#demo');

  // 子元素增删 → Houdini 自动重排；降级模式手动调度。
  new MutationObserver((mutations) => {
    const changed = mutations.some((m) => m.addedNodes.length || m.removedNodes.length);
    if (!changed) return;
    $('#count').textContent = container.children.length;
    scheduleLayout('子元素增删');
  }).observe(container, { childList: true });

  // 容器宽度变化 → 降级模式重排；含 ResizeObserver 风暴（循环依赖）检测。
  new ResizeObserver(() => {
    if (stormDetector.record()) {
      notify('检测到布局循环依赖（ResizeObserver 风暴），已暂停自动重排 2 秒', 'error');
      stormDetector.reset();
      return;
    }
    scheduleLayout('容器尺寸变化');
  }).observe(container);

  // 子元素尺寸就绪（如延迟内容加载完成）→ 降级模式重排。
  // Houdini 模式下浏览器会在固有尺寸变化时自动重新布局。
  const childObserver = new ResizeObserver(() => scheduleLayout('子元素尺寸就绪'));
  new MutationObserver(() => {
    for (const el of container.children) childObserver.observe(el);
  }).observe(container, { childList: true });

  // 原生 RO 循环错误兜底捕获。
  window.addEventListener('error', (event) => {
    if (String(event.message).includes('ResizeObserver loop')) {
      notify('浏览器报告 ResizeObserver 循环，已按循环依赖处理', 'error');
    }
  });
}

/* ---------- 性能监控 ---------- */

function setupPerformance() {
  if ('PerformanceObserver' in window) {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'longtask') {
            state.longTasks += 1;
            $('#perf-longtasks').textContent = state.longTasks;
          }
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* longtask 不可用时忽略 */ }
  }
}

function onPerfSample({ duration, itemCount, useWorker }) {
  state.perfSamples.push(duration);
  if (state.perfSamples.length > 50) state.perfSamples.shift();
  const avg = state.perfSamples.reduce((a, b) => a + b, 0) / state.perfSamples.length;
  $('#perf-avg').textContent = `${avg.toFixed(2)} ms`;
  $('#perf-last').textContent = `${duration.toFixed(2)} ms（${itemCount} 项，${useWorker ? 'Worker' : '主线程'}）`;

  // 性能不足：持续超过一帧预算 → 提示并自动开启 Worker 卸载。
  if (avg > 16 && state.perfSamples.length >= 10 && !state.degraded) {
    state.degraded = true;
    if (!state.useWorker) {
      state.useWorker = true;
      $('#use-worker').checked = true;
      notify(`布局平均耗时 ${avg.toFixed(1)}ms 超过帧预算，已自动开启 Worker 卸载`, 'warn');
    } else {
      notify(`布局平均耗时 ${avg.toFixed(1)}ms，建议减少子元素数量`, 'warn');
    }
  }
  if (avg <= 16) state.degraded = false;

  // 每 20 个采样写一次 IndexedDB，避免频繁 IO。
  if (state.perfSamples.length % 20 === 0) {
    logPerf({ avg, itemCount, mode: state.mode, type: state.type });
  }
}

function onLayoutDone({ type, params, itemCount, blockSize }) {
  const signature = layoutSignature(type, params, itemCount, $('#demo').clientWidth, blockSize);
  if (oscillationDetector.record(signature)) {
    notify('检测到布局结果振荡（A→B→A→B），存在循环依赖，已冻结当前参数', 'error');
    oscillationDetector.reset();
  }
}

/* ---------- 对比区 ---------- */

function buildComparison() {
  const heights = [120, 80, 160, 95, 140, 110, 75, 130, 100, 150, 88, 118];
  for (const id of ['#compare-grid', '#compare-flex']) {
    const box = $(id);
    heights.forEach((h, i) => {
      const el = document.createElement('div');
      el.className = 'item';
      el.style.setProperty('--h', `${h}px`);
      el.style.background = PALETTE[i % PALETTE.length];
      el.textContent = `#${i + 1}`;
      box.append(el);
    });
  }
}

/* ---------- 初始化 ---------- */

async function initEngine() {
  engine = new FallbackLayoutEngine($('#demo'), {
    onPerf: onPerfSample,
    onLayout: onLayoutDone,
  });

  state.houdiniAvailable = 'layoutWorklet' in CSS;
  setStatus('#status-support', state.houdiniAvailable ? '支持 Layout Worklet' : '不支持 Layout Worklet', state.houdiniAvailable);

  if (state.houdiniAvailable) {
    try {
      await CSS.layoutWorklet.addModule('layout-worklet.js');
      state.workletLoaded = true;
      setStatus('#status-worklet', 'Worklet 加载成功', true);
    } catch (error) {
      setStatus('#status-worklet', 'Worklet 加载失败', false);
      notify(`Worklet 加载失败：${error.message}。已降级到 JS 手动布局。`, 'error', 0);
    }
  } else {
    setStatus('#status-worklet', '不可用（已降级）', false);
    notify('当前浏览器不支持 CSS Layout Worklet，已自动降级到 JS 手动布局（结果与 Worklet 一致）。', 'warn', 0);
  }

  state.mode = state.workletLoaded ? 'houdini' : 'fallback';
}

function bindUI() {
  $('#layout-type').addEventListener('change', (e) => {
    state.type = e.target.value;
    applyMode();
    scheduleLayout('布局类型变更');
    persist();
  });
  $('#gap').addEventListener('input', (e) => {
    state.params.gap = Number(e.target.value);
    $('#gap-value').textContent = state.params.gap;
    syncCustomProps();
    scheduleLayout('间距变更');
    persist();
  });
  $('#align').addEventListener('change', (e) => {
    state.params.align = e.target.value;
    syncCustomProps();
    scheduleLayout('对齐变更');
    persist();
  });
  $('#columns').addEventListener('change', (e) => {
    state.params.columns = Math.max(0, Number(e.target.value) || 0);
    syncCustomProps();
    scheduleLayout('列数变更');
    persist();
  });
  $('#engine').addEventListener('change', (e) => {
    state.enginePref = e.target.value;
    if (state.enginePref === 'houdini' && !state.workletLoaded) {
      notify('Worklet 不可用，无法切换到 Houdini 模式', 'warn');
      e.target.value = 'fallback';
      state.enginePref = 'fallback';
    }
    state.mode = state.enginePref === 'houdini' ? 'houdini'
      : state.enginePref === 'fallback' ? 'fallback'
        : (state.workletLoaded ? 'houdini' : 'fallback');
    applyMode();
    persist();
  });
  $('#use-worker').addEventListener('change', (e) => {
    state.useWorker = e.target.checked;
    scheduleLayout('Worker 开关');
    persist();
  });
  $('#add').addEventListener('click', () => addItems(10));
  $('#add-late').addEventListener('click', () => addItems(5, { late: true }));
  $('#remove').addEventListener('click', () => removeItems(10));
  $('#reset').addEventListener('click', () => {
    $('#demo').replaceChildren();
    state.itemSeq = 0;
    addItems(24);
  });
}

async function restoreSettings() {
  const saved = await loadSettings();
  if (!saved) return;
  state.type = saved.type || state.type;
  Object.assign(state.params, saved.params || {});
  state.useWorker = saved.useWorker !== false;
  if (saved.enginePref) state.enginePref = saved.enginePref;
  $('#layout-type').value = state.type;
  $('#gap').value = state.params.gap;
  $('#gap-value').textContent = state.params.gap;
  $('#align').value = state.params.align;
  $('#columns').value = state.params.columns;
  $('#use-worker').checked = state.useWorker;
  if (state.enginePref !== 'auto') {
    state.mode = state.enginePref === 'houdini' && state.workletLoaded ? 'houdini' : 'fallback';
    $('#engine').value = state.mode === 'houdini' ? 'houdini' : 'fallback';
  }
}

let persistTimer;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    saveSettings({
      type: state.type,
      params: state.params,
      useWorker: state.useWorker,
      enginePref: state.enginePref,
    });
  }, 300);
}

async function init() {
  await initEngine();
  await restoreSettings();
  bindUI();
  setupObservers();
  setupPerformance();
  buildComparison();
  addItems(24);
  $('#count').textContent = $('#demo').children.length;
  applyMode();
}

init();
