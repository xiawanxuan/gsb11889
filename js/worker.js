/*
 * worker.js
 * Web Worker：承担 IndexedDB 读写与性能统计计算，避免阻塞主线程布局。
 *  - metrics store：布局耗时 / longtask 等性能记录
 *  - config  store：用户界面配置（布局模式、间距、对齐等）持久化
 *  - 统计最近布局耗时，超过 16ms 预算时向主线程发出性能不足警告
 */
'use strict';

var DB_NAME = 'houdini-layout-demo';
var DB_VERSION = 1;
var PERF_BUDGET_MS = 16;
var STATS_WINDOW = 30;

var db = null;
var writeQueue = [];
var flushTimer = null;

function openDB() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      var d = req.result;
      if (!d.objectStoreNames.contains('metrics')) {
        d.createObjectStore('metrics', { keyPath: 'id', autoIncrement: true })
          .createIndex('ts', 'ts');
      }
      if (!d.objectStoreNames.contains('config')) {
        d.createObjectStore('config', { keyPath: 'key' });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function flushQueue() {
  if (!db || writeQueue.length === 0) return;
  var batch = writeQueue.splice(0, writeQueue.length);
  try {
    var tx = db.transaction('metrics', 'readwrite');
    var store = tx.objectStore('metrics');
    batch.forEach(function (m) { store.add(m); });
  } catch (e) {
    postMessage({ type: 'error', message: 'IndexedDB 写入失败: ' + e.message });
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(function () {
    flushTimer = null;
    flushQueue();
  }, 500);
}

function readAllMetrics() {
  return new Promise(function (resolve, reject) {
    var tx = db.transaction('metrics', 'readonly');
    var req = tx.objectStore('metrics').getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { reject(req.error); };
  });
}

function computeStats() {
  return readAllMetrics().then(function (all) {
    var layouts = all.filter(function (m) { return m.kind === 'layout'; });
    var longtasks = all.filter(function (m) { return m.kind === 'longtask'; });
    var recent = layouts.slice(-STATS_WINDOW);
    var avg = recent.length
      ? recent.reduce(function (s, m) { return s + m.duration; }, 0) / recent.length
      : 0;
    var max = recent.reduce(function (s, m) { return Math.max(s, m.duration); }, 0);
    return {
      totalMetrics: all.length,
      layoutCount: layouts.length,
      longtaskCount: longtasks.length,
      avgLayoutMs: Math.round(avg * 100) / 100,
      maxLayoutMs: Math.round(max * 100) / 100,
      perfWarning: recent.length >= 5 && avg > PERF_BUDGET_MS,
      budgetMs: PERF_BUDGET_MS
    };
  });
}

function getConfig() {
  return new Promise(function (resolve) {
    var tx = db.transaction('config', 'readonly');
    var req = tx.objectStore('config').get('ui');
    req.onsuccess = function () { resolve(req.result ? req.result.value : null); };
    req.onerror = function () { resolve(null); };
  });
}

onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type === 'init') {
    openDB().then(function (d) {
      db = d;
      postMessage({ type: 'ready' });
      return getConfig();
    }).then(function (cfg) {
      postMessage({ type: 'config', config: cfg });
    }).catch(function (err) {
      postMessage({ type: 'error', message: 'IndexedDB 打开失败: ' + (err && err.message) });
    });
    return;
  }
  if (!db) return;

  if (msg.type === 'metric') {
    writeQueue.push(msg.metric);
    if (writeQueue.length >= 10) flushQueue(); else scheduleFlush();
  } else if (msg.type === 'getStats') {
    flushQueue();
    computeStats().then(function (stats) {
      postMessage({ type: 'stats', stats: stats });
    });
  } else if (msg.type === 'saveConfig') {
    try {
      db.transaction('config', 'readwrite').objectStore('config')
        .put({ key: 'ui', value: msg.config });
    } catch (err) { /* 配置保存失败不阻塞主流程 */ }
  } else if (msg.type === 'clearMetrics') {
    try {
      db.transaction('metrics', 'readwrite').objectStore('metrics').clear();
    } catch (err) { /* ignore */ }
  }
};
