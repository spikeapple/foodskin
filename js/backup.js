// 備份檔：所有紀錄（含照片）打包成一個 JSON；不包含 API Key 與 Dropbox 登入資訊
import { db, DATA_STORES } from './db.js';

const pad = (n) => String(n).padStart(2, '0');

/** 使用者名稱轉成可以當檔名／資料夾名的字串 */
export const safeName = (s) => (s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 30);

/** 檔名前面加上使用者名稱，例：小明_備份_20261101-0851.json */
export const withUser = (user, name) => (safeName(user) ? `${safeName(user)}_${name}` : name);

export function backupFilename(user, d = new Date()) {
  return withUser(user, `備份_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`);
}

export async function makeBackup() {
  const data = { app: 'foodskin', version: 1, exportedAt: new Date().toISOString() };
  for (const store of DATA_STORES) data[store] = await db.all(store);
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export async function restoreBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('這不是有效的備份檔。'); }
  if (data?.app !== 'foodskin') throw new Error('這不是食膚日記的備份檔。');
  for (const store of DATA_STORES) await db.replaceAll(store, Array.isArray(data[store]) ? data[store] : []);
  return data.exportedAt;
}

export async function markBackedUp() {
  await db.setSetting('lastBackup', new Date().toISOString());
}
