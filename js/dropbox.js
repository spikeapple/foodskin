/*
 * Dropbox 一鍵備份（OAuth PKCE，不需要密碼或後端伺服器）
 *
 * 連結流程不使用自動導回網址，而是讓使用者在 Dropbox 頁面按「允許」後複製授權碼貼回 App。
 * 這樣在 iPhone 主畫面 App（全螢幕模式）中也能穩定運作。
 * App 使用「App 資料夾」權限，只能讀寫 Dropbox/應用程式/<你的 App 名稱>/，看不到其他檔案。
 * 檔案依使用者分資料夾：/<使用者>/備份/、/<使用者>/報告/（共用同一個 Dropbox 帳號也不會混在一起）。
 */
import { db } from './db.js';

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function isLinked() {
  return Boolean(await db.getSetting('dropboxRefresh'));
}

/**
 * 第 1 步：產生 Dropbox 授權頁網址。
 * iPhone 主畫面 App 會擋掉 await 之後才呼叫的 window.open，所以事先算好網址、做成一般連結讓使用者點。
 * 驗證碼沿用已存的那一組，App 被系統重新載入後，之前拿到的授權碼仍然有效。
 */
export async function authUrl(appKey) {
  let verifier = await db.getSetting('dropboxVerifier');
  if (!verifier) {
    verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    await db.setSetting('dropboxVerifier', verifier);
  }
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return `${AUTH_URL}?client_id=${encodeURIComponent(appKey)}&response_type=code`
    + `&code_challenge=${challenge}&code_challenge_method=S256&token_access_type=offline`;
}

/** 第 2 步：用貼回來的授權碼換取權杖 */
export async function finishLink(appKey, code) {
  const verifier = await db.getSetting('dropboxVerifier');
  if (!verifier) throw new Error('請先按「連結 Dropbox」。');
  // 授權碼約 40 多個字元；開發者網站上的 App key／App secret 只有 15 個字元，常被誤貼
  if (code.replace(/\s+/g, '').length < 25) {
    throw new Error('這不是授權碼（看起來像 App key 或 App 密碼）。請按①，在 Dropbox 頁面按「允許」後，複製畫面上顯示的那一長串授權碼。');
  }
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      // 複製時常夾帶空白或換行，全部去掉
      body: new URLSearchParams({ code: code.replace(/\s+/g, ''), grant_type: 'authorization_code', code_verifier: verifier, client_id: appKey }),
    });
  } catch {
    throw new Error('無法連線到 Dropbox，請確認網路。');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    if (data.error === 'invalid_grant') {
      await db.setSetting('dropboxVerifier', null);  // 換一組新的驗證碼重來
      throw new Error('授權碼無效或已過期（每個授權碼只能用一次）。請重新按①，取得新的授權碼再貼上。');
    }
    if (data.error === 'invalid_client') throw new Error('Dropbox App Key 不正確，請確認設定。');
    throw new Error(`Dropbox 連結失敗（${res.status}）：${data.error_description || data.error || '未知錯誤'}`);
  }
  await saveToken(data);
  await db.setSetting('dropboxRefresh', data.refresh_token);
  await db.setSetting('dropboxVerifier', null);
}

export async function unlink() {
  const token = await db.getSetting('dropboxAccess');
  if (token) fetch(`${API}/auth/token/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  for (const k of ['dropboxRefresh', 'dropboxAccess', 'dropboxExpires']) await db.setSetting(k, null);
}

async function saveToken(data) {
  await db.setSetting('dropboxAccess', data.access_token);
  await db.setSetting('dropboxExpires', Date.now() + (data.expires_in - 60) * 1000);
}

async function accessToken(appKey) {
  const token = await db.getSetting('dropboxAccess');
  if (token && Date.now() < (await db.getSetting('dropboxExpires', 0))) return token;
  const refresh = await db.getSetting('dropboxRefresh');
  if (!refresh) throw new Error('尚未連結 Dropbox。');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: appKey }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Dropbox 連結已失效，請重新連結。');
  await saveToken(data);
  return data.access_token;
}

// HTTP 標頭只能放 ASCII，中文路徑要依 Dropbox 規定轉成 \uXXXX
const headerJson = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function call(appKey, url, { arg, body, json } = {}) {
  const headers = { Authorization: `Bearer ${await accessToken(appKey)}` };
  if (arg) headers['Dropbox-API-Arg'] = headerJson(arg);
  if (json) headers['Content-Type'] = 'application/json';
  else if (body) headers['Content-Type'] = 'application/octet-stream';
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: json ? JSON.stringify(json) : body });
  } catch {
    throw new Error('無法連線到 Dropbox，請確認網路。');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (text.includes('missing_scope')) {
      throw new Error('Dropbox App 的權限沒有設定完成：請到開發者網站 Permissions 勾選 files.metadata.read、files.content.write、files.content.read 並按 Submit，再到 App 中斷連結後重新連結。');
    }
    if (res.status === 401) throw new Error('Dropbox 連結已失效，請中斷連結後重新連結。');
    throw new Error(`Dropbox 錯誤（${res.status}）${text.slice(0, 120)}`);
  }
  return res;
}

/** 上傳到 App 資料夾內的路徑（例：/小明/報告/xxx.pdf），資料夾不存在會自動建立；回傳實際路徑 */
export async function upload(appKey, path, blob) {
  const res = await call(appKey, `${CONTENT}/files/upload`, { arg: { path, mode: 'overwrite', mute: true }, body: blob });
  return (await res.json().catch(() => ({}))).path_display || path;
}

/** 列出 App 資料夾裡（含每個使用者的子資料夾）的備份檔，新的在前 */
export async function listBackups(appKey) {
  let res = await call(appKey, `${API}/files/list_folder`, { json: { path: '', recursive: true } });
  let data = await res.json();
  const entries = [...(data.entries || [])];
  while (data.has_more) {
    res = await call(appKey, `${API}/files/list_folder/continue`, { json: { cursor: data.cursor } });
    data = await res.json();
    entries.push(...(data.entries || []));
  }
  return entries
    .filter((e) => e['.tag'] === 'file' && e.name.endsWith('.json'))
    .sort((a, b) => b.server_modified.localeCompare(a.server_modified));
}

export async function download(appKey, path) {
  const res = await call(appKey, `${CONTENT}/files/download`, { arg: { path } });
  return res.text();
}
