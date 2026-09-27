/** IndexedDB 封装：持久化 UI 设置与性能采样日志。 */

const DB_NAME = 'houdini-layout-demo';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('perf')) {
        db.createObjectStore('perf', { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db, store, mode, run) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const result = run(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(result && result._value);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function saveSettings(settings) {
  try {
    const db = await openDB();
    await tx(db, 'settings', 'readwrite', (store) => store.put({ key: 'ui', ...settings }));
  } catch (error) {
    console.warn('设置持久化失败（IndexedDB 不可用？）', error);
  }
}

export async function loadSettings() {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const request = db.transaction('settings', 'readonly').objectStore('settings').get('ui');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('设置读取失败', error);
    return null;
  }
}

export async function logPerf(entry) {
  try {
    const db = await openDB();
    await tx(db, 'perf', 'readwrite', (store) => store.add({ ...entry, time: Date.now() }));
  } catch (error) {
    console.warn('性能日志写入失败', error);
  }
}

export async function recentPerf(limit = 20) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const request = db.transaction('perf', 'readonly').objectStore('perf').getAll();
      request.onsuccess = () => resolve((request.result || []).slice(-limit));
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}
