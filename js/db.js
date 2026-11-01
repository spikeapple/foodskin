// IndexedDB：所有紀錄都存在這支手機的瀏覽器裡
const DB_NAME = 'foodskin';
const VERSION = 3;
const STORES = {
  meals: 'id',        // { id, day, time, type, thumb, hasPhoto, items[], notes, summary }
  photos: 'id',       // { id(=meal id 或 face id), data }  原尺寸照片另外存，列表只讀縮圖
  faces: 'id',        // { id, day, time, thumb, notes, ai }  臉部自拍
  products: 'id',     // { id, name, brand, category, ingredients, useMorning, useEvening, isActive, createdAt }
  supplements: 'id',  // { id, name, brand, dosage, ingredients, daily, isActive, thumb, hasPhoto, ai, createdAt }
  suppLogs: 'day',    // { day, names[] }  每天吃了哪些保健食品
  careLogs: 'id',     // { id: 'day|period', day, period, productNames[] }
  skinChecks: 'day',  // { day, severity, areas[], kinds[], notes }
  settings: 'key',    // { key, value }
};
export const DATA_STORES = ['meals', 'photos', 'faces', 'products', 'careLogs', 'skinChecks', 'supplements', 'suppLogs'];

let opening;
function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const [name, keyPath] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return opening;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value) => run(store, 'readwrite', (s) => s.put(value)),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  async replaceAll(store, values) {
    await run(store, 'readwrite', (s) => {
      s.clear();
      for (const v of values) s.put(v);
    });
  },
  async getSetting(key, fallback = null) {
    const row = await this.get('settings', key);
    return row ? row.value : fallback;
  },
  setSetting: (key, value) => run('settings', 'readwrite', (s) => s.put({ key, value })),
};
