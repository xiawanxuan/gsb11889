/*
 * main.js
 * 主线程编排：
 *  - 特性检测 + 加载 Layout Worklet（失败/超时 -> 提示 + 降级）
 *  - 引擎切换（houdini / fallback），控制项映射到 CSS 自定义属性
 *  - 子元素动态增删（含模拟异步尺寸就绪）
 *  - PerformanceObserver -> Web Worker -> IndexedDB 性能管线
 *  - 一致性校验：对比 DOM 实际位置与共享算法的理论位置
 */
(function () {
  'use strict';

  var WORKLET_URL = 'js/layout-worklet.js';
  var WORKLET_TIMEOUT_MS = 8000;
  var MAX_NOTICES = 6;

  var container = document.getElementById('container');
  var statusList = document.getElementById('status-list');
  var noticesEl = document.getElementById('notices');
  var perfEl = document.getElementById('perf-stats');

  var state = {
    supported: false,
    workletLoaded: false,
    engine: 'none',          // houdini | fallback
    enginePref: 'auto',      // auto | houdini | fallback
    degradeReason: '',
    itemCount: 24,
    autoChurn: false,
    uid: 0
  };

  /* ---------------- 通知 ---------------- */
  function addNotice(text, level) {
    var li = document.createElement('li');
    li.className = 'notice ' + (level || 'info');
    li.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
    noticesEl.prepend(li);
    while (noticesEl.children.length > MAX_NOTICES) noticesEl.lastChild.remove();
  }

  /* ---------------- 状态面板 ---------------- */
  function renderStatus() {
    var rows = [
      ['Layout Worklet 支持', state.supported ? '是' : '否'],
      ['Worklet 加载', state.workletLoaded ? '成功' : (state.supported ? '失败/未加载' : '不可用')],
      ['当前引擎', state.engine === 'houdini' ? 'CSS Houdini Layout Worklet' : 'JS 手动布局（降级）'],
      ['降级原因', state.degradeReason || '—'],
      ['子元素数量', String(container.children.length)],
      ['未就绪子元素', String(container.querySelectorAll('[data-pending="true"]').length)]
    ];
    statusList.innerHTML = rows.map(function (r) {
      return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>';
    }).join('');
  }

  /* ---------------- 性能管线 ---------------- */
  var worker = null;
  function initWorker() {
    try {
      worker = new Worker('js/worker.js');
    } catch (e) {
      addNotice('Web Worker 创建失败，性能持久化不可用: ' + e.message, 'warn');
      return;
    }
    worker.onmessage = function (e) {
      var msg = e.data || {};
      if (msg.type === 'config' && msg.config) applyConfig(msg.config);
      else if (msg.type === 'stats') renderPerf(msg.stats);
      else if (msg.type === 'error') addNotice(msg.message, 'warn');
    };
    worker.postMessage({ type: 'init' });
    setInterval(function () {
      if (worker) worker.postMessage({ type: 'getStats' });
    }, 2000);
  }

  function sendMetric(kind, duration) {
    if (!worker) return;
    worker.postMessage({
      type: 'metric',
      metric: {
        kind: kind,
        duration: duration,
        engine: state.engine,
        mode: readControlValues().mode,
        itemCount: container.children.length,
        ts: Date.now()
      }
    });
  }

  function initPerfObserver() {
    if (!('PerformanceObserver' in window)) {
      addNotice('PerformanceObserver 不可用，性能监控关闭。', 'warn');
      return;
    }
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          if (entry.name === 'fallback-layout') sendMetric('layout', entry.duration);
        });
      }).observe({ entryTypes: ['measure'] });
    } catch (e) { /* measure 不被支持时忽略 */ }
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          sendMetric('longtask', entry.duration);
          addNotice('检测到长任务（' + Math.round(entry.duration) +
            'ms），主线程布局可能存在性能问题或布局抖动。', 'warn');
        });
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) { /* longtask 不被支持时忽略 */ }
  }

  function renderPerf(stats) {
    perfEl.innerHTML =
      '<div>布局次数：<b>' + stats.layoutCount + '</b>（共 ' + stats.totalMetrics + ' 条指标）</div>' +
      '<div>最近平均耗时：<b>' + stats.avgLayoutMs + 'ms</b> / 峰值 ' + stats.maxLayoutMs + 'ms</div>' +
      '<div>长任务次数：<b>' + stats.longtaskCount + '</b></div>' +
      (stats.perfWarning
        ? '<div class="perf-warning">性能不足：平均布局耗时超过 ' + stats.budgetMs +
          'ms 帧预算，建议减少子元素或改用更简单的布局。</div>'
        : '<div class="perf-ok">性能在帧预算（' + stats.budgetMs + 'ms）内。</div>');
  }

  /* ---------------- 引擎管理 ---------------- */
  function setEngine(engine, reason) {
    state.engine = engine;
    state.degradeReason = engine === 'fallback' ? (reason || state.degradeReason) : '';
    if (engine === 'houdini') {
      container.classList.add('worklet');
      FallbackEngine.setEnabled(false);
      container.style.height = '';
      Array.prototype.forEach.call(container.children, function (el) {
        el.style.transform = '';
        el.style.width = '';
      });
    } else {
      container.classList.remove('worklet');
      FallbackEngine.setEnabled(true);
      FallbackEngine.relayout();
    }
    renderStatus();
  }

  function resolveEngine() {
    if (state.enginePref === 'fallback') return ['fallback', '用户手动选择 JS 降级引擎'];
    if (state.enginePref === 'houdini' && !state.workletLoaded) {
      return ['fallback', '强制 Houdini 但 worklet 不可用，自动降级'];
    }
    if (state.workletLoaded) return ['houdini', ''];
    return ['fallback', state.degradeReason || 'Layout Worklet 不可用'];
  }

  function applyEnginePref() {
    var r = resolveEngine();
    setEngine(r[0], r[1]);
  }

  function loadWorklet() {
    if (!('layoutWorklet' in CSS)) {
      state.supported = false;
      state.degradeReason = '浏览器不支持 CSS.layoutWorklet（Layout API 需要 Chrome/Edge 并开启实验标志）';
      addNotice(state.degradeReason + '，已降级为 JS 手动布局。', 'warn');
      return Promise.resolve();
    }
    state.supported = true;
    var timeout = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('加载超时（>' + WORKLET_TIMEOUT_MS + 'ms）')); },
        WORKLET_TIMEOUT_MS);
    });
    return Promise.race([CSS.layoutWorklet.addModule(WORKLET_URL), timeout])
      .then(function () {
        state.workletLoaded = true;
        addNotice('Layout Worklet 加载成功，自定义布局 layout(houdini) 已注册。', 'ok');
      })
      .catch(function (err) {
        state.workletLoaded = false;
        state.degradeReason = 'Worklet 加载失败：' + (err && err.message ? err.message : err);
        addNotice(state.degradeReason + '，已降级为 JS 手动布局。', 'error');
      });
  }

  /* ---------------- 子元素 ---------------- */
  var PALETTE = ['#5b8def', '#7c5cbf', '#2ea87e', '#d97706', '#dc4c64', '#0e9aa7'];

  function fillContent(el, id) {
    var lines = 1 + (id % 4);
    var text = '';
    for (var i = 0; i < lines; i++) text += '<p>子元素 #' + id + ' 的内容行 ' + (i + 1) + '</p>';
    el.innerHTML =
      '<div class="item-banner" style="height:' + (24 + (id * 13) % 60) + 'px"></div>' + text;
  }

  function makeItem() {
    var id = ++state.uid;
    var el = document.createElement('div');
    el.className = 'item';
    el.style.setProperty('--hue-accent', PALETTE[id % PALETTE.length]);
    if (Math.random() < 0.25) {
      // 模拟异步内容：尺寸未就绪，先以预估高度占位，稍后填充真实内容。
      el.dataset.pending = 'true';
      el.innerHTML = '<span class="pending-label">尺寸未就绪…</span>';
      setTimeout(function () {
        el.dataset.pending = 'false';
        fillContent(el, id);
      }, 400 + Math.random() * 1400);
    } else {
      el.dataset.pending = 'false';
      fillContent(el, id);
    }
    return el;
  }

  function addItems(n) {
    for (var i = 0; i < n; i++) container.appendChild(makeItem());
    afterChildrenChanged();
  }

  function removeItems(n) {
    for (var i = 0; i < n && container.lastElementChild; i++) {
      container.lastElementChild.remove();
    }
    afterChildrenChanged();
  }

  function afterChildrenChanged() {
    if (state.engine === 'fallback') FallbackEngine.relayout();
    renderStatus();
    saveConfig();
  }

  /* ---------------- 控制项 ---------------- */
  var controls = {
    mode: document.getElementById('ctl-mode'),
    gap: document.getElementById('ctl-gap'),
    gapValue: document.getElementById('ctl-gap-value'),
    align: document.getElementById('ctl-align'),
    columns: document.getElementById('ctl-columns'),
    engine: document.getElementById('ctl-engine'),
    cycle: document.getElementById('ctl-cycle')
  };

  function readControlValues() {
    return {
      mode: controls.mode.value,
      gap: parseFloat(controls.gap.value),
      align: controls.align.value,
      columns: parseInt(controls.columns.value, 10) || 0
    };
  }

  function applyControls() {
    var v = readControlValues();
    container.style.setProperty('--layout-mode', v.mode);
    container.style.setProperty('--gap', v.gap);
    container.style.setProperty('--align', v.align);
    container.style.setProperty('--columns', v.columns);
    controls.gapValue.textContent = v.gap + 'px';
    if (state.engine === 'fallback') FallbackEngine.relayout();
    saveConfig();
  }

  var saveTimer = null;
  function saveConfig() {
    if (!worker) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var v = readControlValues();
      worker.postMessage({
        type: 'saveConfig',
        config: {
          mode: v.mode, gap: v.gap, align: v.align, columns: v.columns,
          enginePref: state.enginePref, itemCount: container.children.length
        }
      });
    }, 300);
  }

  function applyConfig(cfg) {
    controls.mode.value = cfg.mode || 'masonry';
    controls.gap.value = cfg.gap != null ? cfg.gap : 12;
    controls.align.value = cfg.align || 'start';
    controls.columns.value = cfg.columns != null ? cfg.columns : 0;
    controls.engine.value = cfg.enginePref || 'auto';
    state.enginePref = controls.engine.value;
    state.itemCount = cfg.itemCount != null ? cfg.itemCount : state.itemCount;
  }

  /* ---------------- 一致性校验 ---------------- */
  function verifyConsistency() {
    return new Promise(function (resolve) {
      if (state.engine === 'fallback') FallbackEngine.flush();
      requestAnimationFrame(function () {
        var params = FallbackEngine.readParams(container);
        var kids = Array.prototype.slice.call(container.children);
        if (kids.length === 0) { resolve({ pass: true, maxDev: 0, count: 0 }); return; }
        var containerRect = container.getBoundingClientRect();
        var originX = containerRect.left + container.clientLeft;
        var originY = containerRect.top + container.clientTop;
        var sizes = kids.map(function (el) {
          var r = el.getBoundingClientRect();
          return {
            width: r.width,
            height: el.dataset.pending === 'true' ? params.estimatedHeight : r.height
          };
        });
        var expected = LayoutAlgorithms.compute(params.mode, sizes, params);
        var maxDev = 0;
        kids.forEach(function (el, i) {
          var r = el.getBoundingClientRect();
          var dx = Math.abs((r.left - originX) - expected.positions[i].x);
          var dy = Math.abs((r.top - originY) - expected.positions[i].y);
          maxDev = Math.max(maxDev, dx, dy);
        });
        resolve({ pass: maxDev < 2, maxDev: maxDev, count: kids.length });
      });
    });
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindUI() {
    ['mode', 'align', 'columns'].forEach(function (k) {
      controls[k].addEventListener('change', applyControls);
    });
    controls.gap.addEventListener('input', applyControls);
    controls.engine.addEventListener('change', function () {
      state.enginePref = controls.engine.value;
      applyEnginePref();
      saveConfig();
    });
    controls.cycle.addEventListener('change', function () {
      container.classList.toggle('cycle-sim', controls.cycle.checked);
      if (state.engine === 'fallback') FallbackEngine.relayout();
      addNotice(controls.cycle.checked
        ? '已注入循环依赖（子元素高度 = 120% 容器高度），观察检测结果。'
        : '已移除循环依赖。', 'info');
    });

    document.getElementById('btn-add').addEventListener('click', function () { addItems(1); });
    document.getElementById('btn-add10').addEventListener('click', function () { addItems(10); });
    document.getElementById('btn-remove').addEventListener('click', function () { removeItems(1); });
    document.getElementById('btn-churn').addEventListener('click', function () {
      state.autoChurn = !state.autoChurn;
      this.textContent = state.autoChurn ? '停止随机增删' : '随机增删（演示）';
      if (state.autoChurn) {
        var timer = setInterval(function () {
          if (!state.autoChurn) { clearInterval(timer); return; }
          if (Math.random() < 0.5) addItems(1 + Math.floor(Math.random() * 3));
          else removeItems(1 + Math.floor(Math.random() * 3));
        }, 700);
      }
    });
    document.getElementById('btn-verify').addEventListener('click', function () {
      verifyConsistency().then(function (r) {
        addNotice('一致性校验（' + state.engine + ' 引擎，' + r.count + ' 项）：' +
          (r.pass ? '通过' : '失败') + '，最大偏差 ' + r.maxDev.toFixed(2) + 'px',
          r.pass ? 'ok' : 'error');
      });
    });
    document.getElementById('btn-clear-metrics').addEventListener('click', function () {
      if (worker) worker.postMessage({ type: 'clearMetrics' });
      addNotice('性能日志已清空。', 'info');
    });
  }

  /* ---------------- 启动 ---------------- */
  function start() {
    FallbackEngine.init(container, function (evt) {
      if (evt.type === 'cycle') addNotice(evt.message, 'error');
      else if (evt.type === 'cycle-recovered') addNotice(evt.message, 'ok');
      renderStatus();
    });
    initWorker();
    initPerfObserver();
    bindUI();

    loadWorklet().then(function () {
      // 等 worker 返回持久化配置（若有）后再创建子元素；最多等 300ms。
      var waited = 0;
      var poll = setInterval(function () {
        waited += 50;
        if (waited >= 300) {
          clearInterval(poll);
          addItems(state.itemCount);
          applyControls();
          applyEnginePref();
          renderStatus();
          setTimeout(function () {
            verifyConsistency().then(function (r) {
              addNotice('初始一致性校验：' + (r.pass ? '通过' : '失败') +
                '（最大偏差 ' + r.maxDev.toFixed(2) + 'px）', r.pass ? 'ok' : 'error');
            });
          }, 800);
        }
      }, 50);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
