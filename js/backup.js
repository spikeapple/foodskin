// 備份檔：所有紀錄（含照片）打包成一個 JSON；不包含 API Key 與 Dropbox 登入資訊
import { db, DATA_STORES } from './db.js';

const pad = (n) => String(n).padStart(2, '0');

export function backupFilename(d = new Date()) {
  return `foodskin-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
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
