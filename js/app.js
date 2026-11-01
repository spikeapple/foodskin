import { db } from './db.js';
import { CONFIG } from './config.js';
import {
  todayKey, nowTime, addDays, daysBetween, fmtDay, fmtMd, fmtYmd, compactDay,
  esc, uid, groupBy, sum, uniqSorted, resizeImage, shareOrDownload,
} from './util.js';
import { ALLERGENS, ACNE_TAGS, FACE_AREAS, ACNE_KINDS, SEVERITIES, MEAL_TYPES, PERIODS, CATEGORIES, guessMealType } from './vocab.js';
import { analyzeMeal, analyzeTriggers, analyzeFace, analyzeItem } from './claude.js';
import {
  analyzeMealGemini, analyzeTriggersGemini, analyzeFaceGemini, analyzeItemGemini, listGeminiModels, GEMINI_DEFAULT_MODEL,
} from './gemini.js';
import { analyze, aiPrompt, levelOf } from './analyzer.js';
import { buildRecords, mealCalories, mealAllergens, mealNames } from './records.js';
import { buildExcel } from './excel.js';
import { buildPDF } from './pdf.js';
import { makeBackup, restoreBackup, markBackedUp, backupFilename } from './backup.js';
import * as dropbox from './dropbox.js';

const $ = (sel) => document.querySelector(sel);

// ---------- 狀態 ----------
const S = {
  tab: 'today',
  day: todayKey(),
  meals: [], products: [], careLogs: [], skinChecks: [], faces: [], hiddenFoods: [], supplements: [], suppLogs: [],
  provider: 'gemini', apiKey: '', geminiKey: '', geminiModel: '', lastBackup: null, dropboxKey: '', dropboxLinked: false, dropboxPending: false,
  range: 60, aiText: '', aiTextRange: 0, aiBusy: false, triggerBusy: false,
  exportStart: addDays(todayKey(), -29), exportEnd: todayKey(),
  includePhotos: true, includeAnalysis: true, exporting: false,
};
let sheet = null;          // 目前開啟的抽屜 { kind, ... }
let editor = null;         // 餐點編輯中的暫存
let productEditor = null;  // 保養品編輯中的暫存
let faceEditor = null;     // 自拍編輯中的暫存
let suppEditor = null;     // 保健食品編輯中的暫存

async function loadAll() {
  const stores = ['meals', 'products', 'careLogs', 'skinChecks', 'faces', 'supplements', 'suppLogs'];
  const [meals, products, careLogs, skinChecks, faces, supplements, suppLogs] = await Promise.all(stores.map((s) => db.all(s)));
  Object.assign(S, { meals, products, careLogs, skinChecks, faces, supplements, suppLogs });
  S.hiddenFoods = await db.getSetting('hiddenFoods', []);
  S.apiKey = await db.getSetting('apiKey', '');
  S.geminiKey = await db.getSetting('geminiKey', '');
  S.geminiModel = await db.getSetting('geminiModel', '');
  S.provider = await db.getSetting('aiProvider', S.apiKey ? 'claude' : 'gemini');
  S.lastBackup = await db.getSetting('lastBackup', null);
  S.dropboxKey = CONFIG.dropboxAppKey || (await db.getSetting('dropboxAppKey', ''));
  S.dropboxLinked = await dropbox.isLinked();
}

const upsert = (list, item, key = 'id') => {
  const i = list.findIndex((x) => x[key] === item[key]);
  if (i >= 0) list[i] = item; else list.push(item);
};
const removeWhere = (list, fn) => { const i = list.findIndex(fn); if (i >= 0) list.splice(i, 1); };

const mealsOn = (day) => S.meals.filter((m) => m.day === day).sort((a, b) => a.time.localeCompare(b.time));
const careLogOf = (day, period) => S.careLogs.find((l) => l.id === `${day}|${period}`);
const checkOf = (day) => S.skinChecks.find((c) => c.day === day);
const isRoutine = (p, period) => (period === '早上' ? p.useMorning : p.useEvening);
const facesOn = (day) => S.faces.filter((f) => f.day === day).sort((a, b) => a.time.localeCompare(b.time));

// 「同前一天」：找出某天之前、最近一次有紀錄的那一天（中間漏記幾天也找得到）
function lastDayBefore(day, days) {
  let best = null;
  for (const d of days) if (d < day && (!best || d > best)) best = d;
  return best;
}
const prevMealDay = (day) => lastDayBefore(day, S.meals.map((m) => m.day));
const prevMealOfType = (day, type) => {
  const d = lastDayBefore(day, S.meals.filter((m) => m.type === type && m.items.length).map((m) => m.day));
  return d ? mealsOn(d).filter((m) => m.type === type && m.items.length).pop() : null;
};
const suppLogOf = (day) => S.suppLogs.find((l) => l.day === day);
const prevSuppLog = (day) => {
  const d = lastDayBefore(day, S.suppLogs.filter((l) => l.names.length).map((l) => l.day));
  return d ? suppLogOf(d) : null;
};
const prevCareLog = (day, period) => {
  const d = lastDayBefore(day, S.careLogs.filter((l) => l.period === period && l.productNames.length).map((l) => l.day));
  return d ? careLogOf(d, period) : null;
};

// 常吃的食物：從過去所有餐點自動整理，同名食物取最近一次的份量與熱量
function foodLibrary() {
  const map = new Map();
  const sorted = [...S.meals].sort((a, b) => `${a.day} ${a.time}`.localeCompare(`${b.day} ${b.time}`));
  for (const m of sorted) {
    for (const it of m.items) {
      const name = it.name.trim();
      if (!name || S.hiddenFoods.includes(name)) continue;
      const prev = map.get(name);
      map.set(name, { ...structuredClone(it), name, count: (prev?.count || 0) + 1, last: m.day });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}
const cloneItem = (it) => ({ name: it.name, portion: it.portion || '', calories: Number(it.calories) || 0, allergens: [...it.allergens], acneTags: [...it.acneTags] });

// ---------- 共用 UI ----------
let toastTimer;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
const fail = (err) => toast(err?.message || String(err), 4500);

// ---------- AI 服務（Gemini 或 Claude，依設定切換） ----------
const PROVIDERS = { gemini: 'Google Gemini', claude: 'Claude' };
const aiKey = () => (S.provider === 'gemini' ? S.geminiKey : S.apiKey);
const needKey = () => { toast(`請先在設定輸入 ${PROVIDERS[S.provider]} API Key`, 3500); };
const aiMeal = (photo, hint) => (S.provider === 'gemini'
  ? analyzeMealGemini(S.geminiKey, S.geminiModel, photo, hint)
  : analyzeMeal(S.apiKey, photo, hint));
const aiFace = (photo) => (S.provider === 'gemini'
  ? analyzeFaceGemini(S.geminiKey, S.geminiModel, photo)
  : analyzeFace(S.apiKey, photo));
const aiItem = (kind, photo) => (S.provider === 'gemini'
  ? analyzeItemGemini(S.geminiKey, S.geminiModel, kind, photo)
  : analyzeItem(S.apiKey, kind, photo));
const aiTriggers = (prompt) => (S.provider === 'gemini'
  ? analyzeTriggersGemini(S.geminiKey, S.geminiModel, prompt)
  : analyzeTriggers(S.apiKey, prompt));

const chips = (options, selected, action, cls = '') =>
  options.map((o) => `<button class="chip ${cls} ${selected.includes(o) ? 'on' : ''}" data-action="${action}" data-value="${esc(o)}">${esc(o)}</button>`).join('');

const seg = (options, current, action, attr = 'value') =>
  `<div class="seg">${options.map((o) => `<button class="${o === current ? 'on' : ''}" data-action="${action}" data-${attr}="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;

const toggle = (bind, field, checked, label) =>
  `<label class="row"><span class="grow">${label}</span><span class="switch"><input type="checkbox" data-bind="${bind}" data-field="${field}" ${checked ? 'checked' : ''}><span></span></span></label>`;

const spinnerLabel = (busy, idle, working) => (busy ? `<span class="spinner"></span> ${working}` : idle);

// ---------- 畫面 ----------
const TITLES = { today: '今日紀錄', meals: '飲食紀錄', products: '保養品', supps: '保健食品', faces: '臉部自拍', analysis: '誘因分析', export: '匯出報告' };

function render() {
  $('#title').textContent = S.tab === 'today' && S.day !== todayKey() ? `${fmtMd(S.day)} 紀錄` : TITLES[S.tab];
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('#view').innerHTML = VIEWS[S.tab]();
}

function renderSheet(first = false) {
  const el = $('#sheet');
  if (!sheet) {
    el.hidden = true;
    el.innerHTML = '';
    document.body.style.overflow = '';
    return;
  }
  const scroll = first ? 0 : el.querySelector('.sheet-body')?.scrollTop || 0;
  el.hidden = false;
  el.innerHTML = `<div class="backdrop ${first ? 'anim' : ''}" data-action="close-sheet"></div><div class="sheet ${first ? 'anim' : ''}">${SHEETS[sheet.kind]()}</div>`;
  const body = el.querySelector('.sheet-body');
  if (body) body.scrollTop = scroll;
  document.body.style.overflow = 'hidden';
}

function openSheet(kind, extra = {}) { sheet = { kind, ...extra }; renderSheet(true); }
function closeSheet() { sheet = null; editor = null; productEditor = null; faceEditor = null; suppEditor = null; renderSheet(); }

function mealRow(m) {
  const allergens = mealAllergens(m);
  const thumb = m.thumb ? `<img class="thumb" src="${m.thumb}" alt="">` : `<span class="thumb">🍽️</span>`;
  return `<button class="row meal" data-action="edit-meal" data-id="${m.id}">
    ${thumb}
    <span class="grow">
      <span class="meal-top"><b>${m.type}</b><small class="muted">${m.time}</small><span class="kcal">${mealCalories(m)} kcal</span></span>
      <span class="meal-foods">${esc(mealNames(m) || '（未填寫食物）')}</span>
      ${allergens.length ? `<span class="tagline orange">⚠︎ ${esc(allergens.join('、'))}</span>` : ''}
    </span>
  </button>`;
}

function backupBanner() {
  const hasData = S.meals.length || S.skinChecks.length || S.careLogs.length || S.faces.length || S.suppLogs.length;
  if (!hasData) return '';
  const days = S.lastBackup ? Math.floor((Date.now() - new Date(S.lastBackup)) / 86400000) : null;
  if (days !== null && days < 7) return '';
  return `<div class="banner">💾 ${days === null ? '還沒有備份過資料' : `已經 ${days} 天沒有備份`}<button class="btn" data-action="open-settings">去備份</button></div>`;
}

const VIEWS = {
  today() {
    const day = S.day;
    const meals = mealsOn(day);
    const allergens = uniqSorted(meals.flatMap(mealAllergens));
    const prevDay = prevMealDay(day);
    return `
      ${backupBanner()}
      <div class="daynav">
        <button data-action="day-prev" aria-label="前一天">‹</button>
        <input type="date" data-bind="day-input" value="${day}" max="${todayKey()}">
        <button data-action="day-next" aria-label="後一天" ${day >= todayKey() ? 'disabled' : ''}>›</button>
      </div>

      <section class="group">
        <div class="group-head"><span>🍱 飲食</span><span>${sum(meals, mealCalories)} kcal</span></div>
        ${meals.map(mealRow).join('')}
        <button class="row action" data-action="new-meal">📷 拍照記錄一餐</button>
        ${prevDay ? `<button class="row action small" data-action="copy-prev-meals" data-from="${prevDay}">📋 同前一天（${fmtMd(prevDay)}，${mealsOn(prevDay).length} 餐）</button>` : ''}
      </section>
      ${allergens.length ? `<p class="foot">今日可能過敏原：${esc(allergens.join('、'))}</p>` : ''}

      ${PERIODS.map(careSection).join('')}
      ${suppSection(day)}
      ${skinSection(day)}
    `;
  },

  meals() {
    const groups = [...groupBy(S.meals, (m) => m.day)].sort((a, b) => b[0].localeCompare(a[0]));
    const libCount = foodLibrary().length;
    return `
      <section class="group">
        <button class="row action" data-action="new-meal">📷 新增餐點</button>
        <button class="row action small" data-action="open-foods">📚 常吃的食物（${libCount} 項）</button>
      </section>
      ${groups.length ? '' : `<div class="empty"><div class="big">🍱</div>還沒有飲食紀錄<br>拍下這一餐開始記錄吧</div>`}
      ${groups.map(([day, meals]) => `
        <section class="group">
          <div class="group-head"><span>${fmtDay(day)}</span><span>${sum(meals, mealCalories)} kcal</span></div>
          ${meals.sort((a, b) => a.time.localeCompare(b.time)).map(mealRow).join('')}
        </section>`).join('')}
    `;
  },

  products() {
    const row = (p) => `<button class="row" data-action="edit-product" data-id="${p.id}">
        ${itemThumb(p, '🧴')}
        <span class="grow"><b>${esc(p.name)}</b><small>${esc([p.brand, p.category].filter(Boolean).join('・'))}</small>${riskLine(p.ai)}</span>
        ${p.useMorning ? '<span title="早上">☀️</span>' : ''}${p.useEvening ? '<span title="晚上">🌙</span>' : ''}
      </button>`;
    const active = S.products.filter((p) => p.isActive), inactive = S.products.filter((p) => !p.isActive);
    return `
      <section class="group"><button class="row action" data-action="new-product">＋ 新增保養品</button></section>
      ${S.products.length ? '' : `<div class="empty"><div class="big">🧴</div>新增目前早晚使用的保養品<br>之後每天在「今日」勾選即可</div>`}
      ${active.length ? `<section class="group"><div class="group-head">使用中</div>${active.map(row).join('')}</section>` : ''}
      ${inactive.length ? `<section class="group"><div class="group-head">已停用</div>${inactive.map(row).join('')}</section>` : ''}
      <p class="foot">填寫全成分，分析時會檢查是否含有常見可能致粉刺的成分。</p>
    `;
  },

  supps() {
    const row = (s) => `<button class="row" data-action="edit-supp" data-id="${s.id}">
        ${itemThumb(s, '💊')}
        <span class="grow"><b>${esc(s.name)}</b><small>${esc([s.brand, s.dosage].filter(Boolean).join('・'))}</small>${riskLine(s.ai)}</span>
        ${s.daily ? '<small class="muted">每天</small>' : ''}
      </button>`;
    const active = S.supplements.filter((s) => s.isActive), inactive = S.supplements.filter((s) => !s.isActive);
    return `
      <section class="group"><button class="row action" data-action="new-supp">📷 新增保健食品</button></section>
      ${S.supplements.length ? '' : `<div class="empty"><div class="big">💊</div>拍下保健食品的包裝，AI 會幫你填好名稱與成分<br>之後每天在「今日」勾選即可</div>`}
      ${active.length ? `<section class="group"><div class="group-head">服用中</div>${active.map(row).join('')}</section>` : ''}
      ${inactive.length ? `<section class="group"><div class="group-head">已停用</div>${inactive.map(row).join('')}</section>` : ''}
      <p class="foot">誘因分析會比較長痘前 0–7 天吃過的保健食品，並提醒乳清蛋白、維生素 B12、碘等常被討論的成分。</p>
    `;
  },

  faces() {
    const groups = [...groupBy(S.faces, (f) => f.day)].sort((a, b) => b[0].localeCompare(a[0]));
    const sevText = (day) => {
      const c = checkOf(day);
      return c ? (c.severity > 0 ? `<span style="color:var(--pink)">長痘・${SEVERITIES[c.severity]}</span>` : '沒有長痘') : '';
    };
    return `
      <section class="group">
        <div class="row btn-row">
          ${faceButtons()}
        </div>
      </section>
      <p class="foot">建議每天固定時間、同樣光線與角度、素顏拍攝，前後比較才準。照片只存在這支手機。</p>
      ${groups.length ? '' : `<div class="empty"><div class="big">🤳</div>還沒有臉部自拍<br>每天拍一張，之後可以比較變化，<br>也可以請 AI 判讀痘痘狀況</div>`}
      ${groups.map(([day, faces]) => `
        <section class="group">
          <div class="group-head"><span>${fmtDay(day)}</span><span>${sevText(day)}</span></div>
          <div class="row face-grid">
            ${faces.sort((a, b) => a.time.localeCompare(b.time)).map((f) => `<button class="face-cell" data-action="edit-face" data-id="${f.id}"><img src="${f.thumb}" alt=""><small>${f.time}${f.ai ? ' ✨' : ''}</small></button>`).join('')}
          </div>
        </section>`).join('')}
    `;
  },

  analysis() {
    const end = todayKey(), start = addDays(end, -(S.range - 1));
    const r = analyze({ start, end, ...S });
    const suspectRow = (s) => {
      const lv = levelOf(s.score);
      const pct = (x) => `${Math.round(x * 100)}%`;
      return `<div class="row suspect">
        <div class="suspect-top"><span class="badge">${s.kind}</span><b>${esc(s.name)}</b><span class="level ${lv.cls}">${lv.text}</span></div>
        <div class="bar"><i style="width:${Math.min(100, (s.score / 2.5) * 100)}%;background:${lv.color}"></i></div>
        <small class="muted">長痘前出現 ${s.breakoutHits}/${s.breakoutTotal} 次（${pct(s.breakoutHits / s.breakoutTotal)}）・無痘日前 ${s.cleanHits}/${s.cleanTotal} 次（${pct(s.cleanTotal ? s.cleanHits / s.cleanTotal : 0)}）</small>
      </div>`;
    };
    return `
      <section class="group"><div class="row">${seg(['30', '60', '90', '180'], String(S.range), 'range', 'days').replace(/>(\d+)</g, '>$1 天<')}</div></section>

      <section class="group">
        <div class="group-head">概況</div>
        <div class="row kv"><span>有記錄肌膚的天數</span><b>${r.checkedDays} 天</b></div>
        <div class="row kv"><span>長痘天數</span><b>${r.breakoutDays} 天</b></div>
        <div class="row kv"><span>開始長痘次數</span><b>${r.onsets.length} 次</b></div>
        <div class="row kv"><span>推論可信度</span><b>${r.confidence}</b></div>
      </section>

      ${!r.onsets.length ? `<div class="empty"><div class="big">🙂</div>這段期間沒有長痘紀錄<br>持續記錄飲食、保養與肌膚狀況，<br>出現痘痘時這裡會推算可能的誘因</div>` : `
        <section class="group">
          <div class="group-head">可能的飲食誘因</div>
          ${r.diet.length ? r.diet.map(suspectRow).join('') : '<div class="row muted">沒有明顯可疑的飲食</div>'}
        </section>
        <p class="foot">比較「開始長痘前 1–3 天」與「沒長痘的日子前 1–3 天」吃過的東西。</p>

        <section class="group">
          <div class="group-head">可能的保養品問題</div>
          ${r.products.length ? r.products.map(suspectRow).join('') : '<div class="row muted">沒有明顯可疑的保養品</div>'}
          ${r.newProductAlerts.map((a) => `<div class="row small">✨ ${esc(a)}</div>`).join('')}
          ${r.comedogenicHits.map((a) => `<div class="row small" style="color:var(--orange)">⚠︎ ${esc(a)}</div>`).join('')}
        </section>
        <p class="foot">比較長痘前 0–7 天使用的產品，並檢查新產品與可能致粉刺成分。</p>

        ${S.suppLogs.length ? `<section class="group">
          <div class="group-head">可能的保健食品因素</div>
          ${r.supplements.length ? r.supplements.map(suspectRow).join('') : '<div class="row muted">沒有明顯可疑的保健食品</div>'}
          ${r.newSuppAlerts.map((a) => `<div class="row small">✨ ${esc(a)}</div>`).join('')}
          ${r.suppHits.map((a) => `<div class="row small" style="color:var(--orange)">⚠︎ ${esc(a)}</div>`).join('')}
        </section>
        <p class="foot">比較長痘前 0–7 天吃過的保健食品。</p>` : ''}

        <section class="group">
          <div class="group-head">AI 綜合解讀</div>
          <button class="row action" data-action="run-ai" ${S.triggerBusy ? 'disabled' : ''}>${spinnerLabel(S.triggerBusy, '✨ 請 AI 綜合解讀', '分析中…')}</button>
          ${S.aiText && S.aiTextRange === S.range ? `<div class="row ai-text">${esc(S.aiText)}</div>` : ''}
        </section>
      `}
      <p class="foot">推論只代表「時間上的關聯」，不代表因果。建議一次只停掉一項可疑食物或產品，觀察 2 週來驗證；痘痘嚴重或反覆發炎請就醫。</p>
    `;
  },

  export() {
    const recs = buildRecords(S.exportStart, S.exportEnd, S);
    return `
      <section class="group">
        <div class="group-head">日期區間</div>
        <div class="row"><span class="label">開始</span><input type="date" data-bind="export-start" value="${S.exportStart}" max="${S.exportEnd}"></div>
        <div class="row"><span class="label">結束</span><input type="date" data-bind="export-end" value="${S.exportEnd}" min="${S.exportStart}" max="${todayKey()}"></div>
        <div class="row btn-row">
          <button class="btn" data-action="quick-range" data-preset="7">近 7 天</button>
          <button class="btn" data-action="quick-range" data-preset="30">近 30 天</button>
          <button class="btn" data-action="quick-range" data-preset="month">本月</button>
          <button class="btn" data-action="quick-range" data-preset="last-month">上個月</button>
        </div>
      </section>

      <section class="group">
        <div class="group-head">內容</div>
        <div class="row kv"><span>有紀錄的天數</span><b>${recs.length} 天</b></div>
        <div class="row kv"><span>餐點</span><b>${sum(recs, (r) => r.meals.length)} 餐</b></div>
        <div class="row kv"><span>長痘天數</span><b>${recs.filter((r) => r.check?.severity > 0).length} 天</b></div>
        ${toggle('opt', 'includePhotos', S.includePhotos, 'PDF 附上餐點照片')}
        ${toggle('opt', 'includeAnalysis', S.includeAnalysis, '加入痘痘誘因分析')}
      </section>

      <section class="group">
        <button class="row action" data-action="export-pdf" ${S.exporting ? 'disabled' : ''}>${spinnerLabel(S.exporting === 'pdf', '📄 產生 PDF 報告', '產生中…')}</button>
        <button class="row action" data-action="export-excel" ${S.exporting ? 'disabled' : ''}>${spinnerLabel(S.exporting === 'excel', '📊 產生 Excel（.xlsx）', '產生中…')}</button>
      </section>
      <p class="foot">Excel 內含：每日總覽、飲食明細、保養紀錄、保健食品紀錄、肌膚狀況、誘因分析等工作表。產生後可以用分享選單存到「檔案」、Dropbox，或傳給別人。</p>
    `;
  },
};

function careSection(period) {
  const log = careLogOf(S.day, period);
  const used = log?.productNames || [];
  const prev = prevCareLog(S.day, period);
  const list = S.products
    .filter((p) => p.isActive || used.includes(p.name))
    .sort((a, b) => Number(isRoutine(b, period)) - Number(isRoutine(a, period)));
  return `<section class="group">
    <div class="group-head"><span>${period === '早上' ? '☀️' : '🌙'} ${period}保養</span><span>${used.length ? `${used.length} 項` : ''}</span></div>
    ${list.length ? list.map((p) => `
      <button class="row" data-action="toggle-care" data-period="${period}" data-name="${esc(p.name)}">
        <span class="checkbox ${used.includes(p.name) ? 'on' : ''}"></span>
        <span class="grow">${esc(p.name)}<small>${esc([p.brand, p.category].filter(Boolean).join('・'))}</small></span>
        ${isRoutine(p, period) ? '<small class="muted">常用</small>' : ''}
      </button>`).join('') : `<button class="row muted" data-tab="products">尚未建立保養品，點這裡新增 ›</button>`}
    ${list.length ? `<button class="row action small" data-action="apply-routine" data-period="${period}">套用${period}常用組合</button>` : ''}
    ${prev ? `<button class="row action small" data-action="copy-prev-care" data-period="${period}" data-from="${prev.day}">📋 同前一天（${fmtMd(prev.day)}：${esc(prev.productNames.join('、'))}）</button>` : ''}
  </section>`;
}

function suppSection(day) {
  const taken = suppLogOf(day)?.names || [];
  const prev = prevSuppLog(day);
  const list = S.supplements
    .filter((s) => s.isActive || taken.includes(s.name))
    .sort((a, b) => Number(Boolean(b.daily)) - Number(Boolean(a.daily)));
  if (!list.length && !prev) {
    return `<section class="group">
      <div class="group-head">💊 保健食品</div>
      <button class="row muted" data-tab="supps">有吃保健食品？點這裡建立清單 ›</button>
    </section>`;
  }
  return `<section class="group">
    <div class="group-head"><span>💊 保健食品</span><span>${taken.length ? `${taken.length} 項` : ''}</span></div>
    ${list.map((s) => `
      <button class="row" data-action="toggle-supp" data-name="${esc(s.name)}">
        <span class="checkbox ${taken.includes(s.name) ? 'on' : ''}"></span>
        <span class="grow">${esc(s.name)}<small>${esc([s.brand, s.dosage].filter(Boolean).join('・'))}</small></span>
        ${s.daily ? '<small class="muted">每天</small>' : ''}
      </button>`).join('')}
    ${list.some((s) => s.daily && s.isActive) ? '<button class="row action small" data-action="apply-supp-daily">套用每天吃的</button>' : ''}
    ${prev ? `<button class="row action small" data-action="copy-prev-supp" data-from="${prev.day}">📋 同前一天（${fmtMd(prev.day)}：${esc(prev.names.join('、'))}）</button>` : ''}
  </section>`;
}

const itemThumb = (x, emoji) => (x.thumb ? `<img class="thumb" src="${x.thumb}" alt="">` : `<span class="thumb">${emoji}</span>`);
const RISK_COLOR = { 低: 'var(--green)', 中: 'var(--orange)', 高: 'var(--red)' };
const riskLine = (ai) => (ai && RISK_COLOR[ai.risk]
  ? `<span class="tagline" style="color:${RISK_COLOR[ai.risk]}">痘痘風險：${ai.risk}${ai.flags.length ? `・${esc(ai.flags.slice(0, 3).join('、'))}` : ''}</span>` : '');

// 保養品與保健食品編輯頁共用的「拍照＋AI 辨識」區塊
function itemPhotoSection(ed, kind) {
  const ai = ed.ai;
  return `<section class="group">
      <div class="group-head">包裝照片</div>
      ${ed.photo ? `<div class="row"><img class="photo" src="${ed.photo}" alt="包裝照片"></div>` : ''}
      <div class="row btn-row">
        <label class="btn">📷 拍照<input type="file" accept="image/*" capture="environment" data-bind="item-photo" data-kind="${kind}" hidden></label>
        <label class="btn">🖼️ 從相簿<input type="file" accept="image/*" data-bind="item-photo" data-kind="${kind}" hidden></label>
        ${ed.photo ? `<button class="btn danger" data-action="remove-item-photo" data-kind="${kind}">移除照片</button>` : ''}
      </div>
      ${ed.photo ? `<button class="row action" data-action="analyze-item" data-kind="${kind}" ${S.aiBusy ? 'disabled' : ''}>${spinnerLabel(S.aiBusy, '✨ AI 辨識產品與成分', '分析中，約需 10–30 秒…')}</button>` : ''}
      ${ai ? `
        <div class="row kv"><span>痘痘風險</span><b style="color:${RISK_COLOR[ai.risk] || 'inherit'}">${ai.risk}</b></div>
        ${ai.flags.length ? `<div class="row kv"><span>留意成分</span><b>${esc(ai.flags.join('、'))}</b></div>` : ''}
        ${ai.summary ? `<div class="row small">${esc(ai.summary)}</div>` : ''}` : ''}
    </section>
    <p class="foot">${ed.photo ? '拍正面包裝和背面成分表效果最好。AI 會自動填入下方空白的欄位，結果可以再修改。' : '拍下包裝或成分表，AI 可以幫你填好名稱、品牌與成分，並評估對痘痘肌的風險。'}</p>`;
}

const faceButtons = () => `
  <label class="btn pink">🤳 自拍<input type="file" accept="image/*" capture="user" data-bind="face-photo" hidden></label>
  <label class="btn">🖼️ 從相簿<input type="file" accept="image/*" data-bind="face-photo" hidden></label>`;

function faceStrip(day) {
  const faces = facesOn(day);
  return `<div class="row face-grid">
      ${faces.map((f) => `<button class="face-cell" data-action="edit-face" data-id="${f.id}"><img src="${f.thumb}" alt=""><small>${f.time}${f.ai ? ' ✨' : ''}</small></button>`).join('')}
      <label class="face-cell add">🤳<small>自拍記錄</small><input type="file" accept="image/*" capture="user" data-bind="face-photo" hidden></label>
    </div>`;
}

function skinSection(day) {
  const c = checkOf(day);
  if (!c) {
    return `<section class="group">
        <div class="group-head">🙂 臉部狀況</div>
        <div class="row two">
          <button class="btn" data-action="skin-set" data-sev="0">😊 沒有長痘</button>
          <button class="btn pink" data-action="skin-set" data-sev="1">😣 有長痘</button>
        </div>
        ${faceStrip(day)}
      </section>
      <p class="foot">每天記錄（包含沒長痘的日子），誘因分析才會準確。</p>`;
  }
  return `<section class="group">
    <div class="group-head"><span>🙂 臉部狀況</span><span>${c.severity > 0 ? '有長痘' : '沒有長痘'}</span></div>
    <div class="row">${seg(SEVERITIES, SEVERITIES[c.severity], 'skin-sev')}</div>
    ${c.severity > 0 ? `
      <div class="row col"><small class="muted">部位</small><div class="chips">${chips(FACE_AREAS, c.areas, 'skin-area')}</div></div>
      <div class="row col"><small class="muted">類型</small><div class="chips">${chips(ACNE_KINDS, c.kinds, 'skin-kind', 'purple')}</div></div>` : ''}
    <div class="row"><textarea data-bind="skin-notes" placeholder="備註（例：生理期前、熬夜、壓力大、戴口罩）">${esc(c.notes)}</textarea></div>
    ${faceStrip(day)}
    <button class="row danger small" data-action="skin-clear">清除當日紀錄</button>
  </section>`;
}

function foodLibChips(e) {
  const q = (e.filter || '').trim();
  const list = foodLibrary().filter((f) => !q || f.name.includes(q)).slice(0, q ? 60 : 30);
  if (!list.length) return '<span class="muted small">找不到符合的食物</span>';
  const picked = e.items.map((i) => i.name.trim());
  return list.map((f) => `<button class="chip ${picked.includes(f.name) ? 'on' : ''}" data-action="pick-food" data-value="${esc(f.name)}">${esc(f.name)}<small> ${Number(f.calories) || 0}</small></button>`).join('');
}

// ---------- 抽屜 ----------
const SHEETS = {
  meal() {
    const e = editor;
    const total = sum(e.items, (i) => Number(i.calories) || 0);
    const lib = foodLibrary();
    const prevSame = e.id ? null : prevMealOfType(e.day, e.type);
    const item = (it, i) => `<div class="row item">
        <div class="item-line">
          <input class="strong" data-bind="item" data-idx="${i}" data-field="name" value="${esc(it.name)}" placeholder="食物名稱">
          <button class="icon danger" data-action="remove-item" data-idx="${i}" aria-label="刪除">✕</button>
        </div>
        <div class="item-line">
          <input data-bind="item" data-idx="${i}" data-field="portion" value="${esc(it.portion)}" placeholder="份量（例：一碗）">
          <input class="kcal-input" type="number" inputmode="numeric" min="0" data-bind="item" data-idx="${i}" data-field="calories" value="${Number(it.calories) || 0}">
          <span class="muted">kcal</span>
        </div>
        <div class="item-line">
          <label class="multi orange">過敏原
            <select multiple data-bind="item-multi" data-idx="${i}" data-field="allergens">${ALLERGENS.map((a) => `<option ${it.allergens.includes(a) ? 'selected' : ''}>${a}</option>`).join('')}</select>
          </label>
          <label class="multi purple">痘痘風險
            <select multiple data-bind="item-multi" data-idx="${i}" data-field="acneTags">${ACNE_TAGS.map((a) => `<option ${it.acneTags.includes(a) ? 'selected' : ''}>${a}</option>`).join('')}</select>
          </label>
        </div>
        ${it.allergens.length ? `<span class="tagline orange">過敏原：${esc(it.allergens.join('、'))}</span>` : ''}
        ${it.acneTags.length ? `<span class="tagline purple">痘痘風險：${esc(it.acneTags.join('、'))}</span>` : ''}
      </div>`;

    return `<div class="sheet-bar"><button data-action="close-sheet">取消</button><b>${e.id ? '編輯餐點' : '新增餐點'}</b><button class="primary" data-action="save-meal">儲存</button></div>
      <div class="sheet-body">
        <section class="group">
          <div class="row">${seg(MEAL_TYPES, e.type, 'meal-type')}</div>
          <div class="row"><span class="label">日期</span><input type="date" data-bind="meal-day" value="${e.day}" max="${todayKey()}"><input type="time" data-bind="meal-time" value="${e.time}"></div>
        </section>

        <section class="group">
          <div class="group-head">餐點照片</div>
          ${e.photo ? `<div class="row"><img class="photo" src="${e.photo}" alt="餐點照片"></div>` : ''}
          <div class="row btn-row">
            <label class="btn">📷 拍照<input type="file" accept="image/*" capture="environment" data-bind="meal-photo" hidden></label>
            <label class="btn">🖼️ 從相簿<input type="file" accept="image/*" data-bind="meal-photo" hidden></label>
            ${e.photo ? '<button class="btn danger" data-action="remove-photo">移除照片</button>' : ''}
          </div>
        </section>

        <section class="group">
          <div class="group-head">AI 分析</div>
          <div class="row"><textarea data-bind="meal-hint" placeholder="補充說明（例：飯吃半碗、微糖、醬料另外放）。沒有照片時也可以只用文字描述。">${esc(e.hint)}</textarea></div>
          <button class="row action" data-action="analyze-meal" ${S.aiBusy ? 'disabled' : ''}>${spinnerLabel(S.aiBusy, '✨ AI 估算熱量與過敏原', '分析中，約需 10–30 秒…')}</button>
          ${e.summary ? `<div class="row small muted">${esc(e.summary)}</div>` : ''}
        </section>
        <p class="foot">熱量依照片粗估，僅供參考；結果可以在下方修改。</p>

        ${prevSame || lib.length ? `<section class="group">
          <div class="group-head">快速選取</div>
          ${prevSame ? `<button class="row action small" data-action="copy-prev-meal" data-id="${prevSame.id}">📋 同前一天的${e.type}（${fmtMd(prevSame.day)}：${esc(mealNames(prevSame))}）</button>` : ''}
          ${lib.length ? `
            ${lib.length > 12 ? `<div class="row"><input type="search" data-bind="food-filter" value="${esc(e.filter || '')}" placeholder="搜尋常吃的食物"></div>` : ''}
            <div class="row"><div class="chips" id="food-lib">${foodLibChips(e)}</div></div>` : ''}
        </section>
        ${lib.length ? '<p class="foot">點一下加入（再點一下移除），份量與熱量沿用上次的紀錄，可以再修改。</p>' : ''}` : ''}

        <section class="group">
          <div class="group-head"><span>食物</span><span id="meal-total">合計 ${total} kcal</span></div>
          ${e.items.map(item).join('')}
          <button class="row action" data-action="add-item">＋ 手動新增食物</button>
        </section>

        <section class="group">
          <div class="group-head">備註</div>
          <div class="row"><textarea data-bind="meal-notes" placeholder="例：外食、聚餐、喝很多水">${esc(e.notes)}</textarea></div>
        </section>
        ${e.id ? '<button class="btn block danger" data-action="delete-meal">刪除這一餐</button>' : ''}
      </div>`;
  },

  product() {
    const p = productEditor;
    return `<div class="sheet-bar"><button data-action="close-sheet">取消</button><b>${p.id ? '編輯保養品' : '新增保養品'}</b><button class="primary" data-action="save-product">儲存</button></div>
      <div class="sheet-body">
        ${itemPhotoSection(p, 'product')}
        <section class="group">
          <div class="group-head">產品</div>
          <div class="row"><span class="label">名稱</span><input data-bind="prod" data-field="name" value="${esc(p.name)}" placeholder="必填"></div>
          <div class="row"><span class="label">品牌</span><input data-bind="prod" data-field="brand" value="${esc(p.brand)}"></div>
          <div class="row"><span class="label">類別</span><select data-bind="prod" data-field="category">${CATEGORIES.map((c) => `<option ${c === p.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        </section>
        <section class="group">
          <div class="group-head">使用時段</div>
          ${toggle('prod', 'useMorning', p.useMorning, '☀️ 早上使用')}
          ${toggle('prod', 'useEvening', p.useEvening, '🌙 晚上使用')}
          ${toggle('prod', 'isActive', p.isActive, '目前使用中')}
        </section>
        <section class="group">
          <div class="group-head">成分</div>
          <div class="row"><textarea data-bind="prod" data-field="ingredients" rows="6" placeholder="可以貼上包裝上的全成分">${esc(p.ingredients)}</textarea></div>
        </section>
        <p class="foot">停用而不是刪除，可以保留過去的使用紀錄供分析。</p>
        ${p.id ? '<button class="btn block danger" data-action="delete-product">刪除這個保養品</button>' : ''}
      </div>`;
  },

  supp() {
    const s = suppEditor;
    return `<div class="sheet-bar"><button data-action="close-sheet">取消</button><b>${s.id ? '編輯保健食品' : '新增保健食品'}</b><button class="primary" data-action="save-supp">儲存</button></div>
      <div class="sheet-body">
        ${itemPhotoSection(s, 'supplement')}
        <section class="group">
          <div class="group-head">產品</div>
          <div class="row"><span class="label">名稱</span><input data-bind="supp" data-field="name" value="${esc(s.name)}" placeholder="必填，例：魚油、維他命 C"></div>
          <div class="row"><span class="label">品牌</span><input data-bind="supp" data-field="brand" value="${esc(s.brand)}"></div>
          <div class="row"><span class="label">用量</span><input data-bind="supp" data-field="dosage" value="${esc(s.dosage)}" placeholder="例：每日 1 顆，早餐後"></div>
        </section>
        <section class="group">
          <div class="group-head">服用</div>
          ${toggle('supp', 'daily', s.daily, '每天吃（可一鍵套用）')}
          ${toggle('supp', 'isActive', s.isActive, '目前服用中')}
        </section>
        <section class="group">
          <div class="group-head">成分</div>
          <div class="row"><textarea data-bind="supp" data-field="ingredients" rows="5" placeholder="可以貼上營養標示的成分與含量">${esc(s.ingredients)}</textarea></div>
        </section>
        <p class="foot">停用而不是刪除，可以保留過去的服用紀錄供分析。有服用藥物或特殊狀況，保健食品的使用請詢問醫師或藥師。</p>
        ${s.id ? '<button class="btn block danger" data-action="delete-supp">刪除這個保健食品</button>' : ''}
      </div>`;
  },

  face() {
    const f = faceEditor;
    const prev = S.faces.filter((x) => x.id !== f.id && `${x.day} ${x.time}` < `${f.day} ${f.time}`)
      .sort((a, b) => `${b.day} ${b.time}`.localeCompare(`${a.day} ${a.time}`))[0];
    const ai = f.ai;
    return `<div class="sheet-bar"><button data-action="close-sheet">取消</button><b>${f.id ? '臉部自拍' : '新增自拍'}</b><button class="primary" data-action="save-face">儲存</button></div>
      <div class="sheet-body">
        <section class="group">
          <div class="row"><img class="photo" src="${f.photo}" alt="臉部自拍"></div>
          <div class="row"><span class="label">日期</span><input type="date" data-bind="face-day" value="${f.day}" max="${todayKey()}"><input type="time" data-bind="face-time" value="${f.time}"></div>
        </section>
        ${prev ? `<section class="group">
          <div class="group-head"><span>上一張（${fmtMd(prev.day)} ${prev.time}）</span><span>比較用</span></div>
          <div class="row"><img class="photo" style="max-height:200px" src="${prev.thumb}" alt="上一張自拍"></div>
          ${prev.ai?.summary ? `<div class="row small muted">${esc(prev.ai.summary)}</div>` : ''}
        </section>` : ''}

        <section class="group">
          <div class="group-head">AI 判讀膚況</div>
          <button class="row action" data-action="analyze-face" ${S.aiBusy ? 'disabled' : ''}>${spinnerLabel(S.aiBusy, '✨ 請 AI 判讀痘痘狀況', '分析中，約需 10–30 秒…')}</button>
          ${ai ? `
            <div class="row kv"><span>嚴重程度</span><b>${SEVERITIES[ai.severity]}</b></div>
            ${ai.areas.length ? `<div class="row kv"><span>部位</span><b>${esc(ai.areas.join('、'))}</b></div>` : ''}
            ${ai.kinds.length ? `<div class="row kv"><span>類型</span><b>${esc(ai.kinds.join('、'))}</b></div>` : ''}
            <div class="row small">${esc(ai.summary)}</div>
            <button class="row action small" data-action="apply-face-ai">⤵️ 套用到 ${fmtMd(f.day)} 的臉部狀況</button>` : ''}
        </section>
        <p class="foot">${S.provider === 'gemini' ? '⚠︎ 使用 Gemini 免費方案時，Google 可能用送出的照片改進產品；介意的話不要使用 AI 判讀，自己記錄即可。' : 'AI 判讀僅供參考，可以在「今日」頁面自行修改。'}</p>

        <section class="group">
          <div class="group-head">備註</div>
          <div class="row"><textarea data-bind="face-notes" placeholder="例：素顏、剛洗完臉、生理期第 2 天">${esc(f.notes)}</textarea></div>
        </section>
        ${f.id ? '<button class="btn block danger" data-action="delete-face">刪除這張自拍</button>' : ''}
      </div>`;
  },

  foods() {
    const lib = foodLibrary();
    return `<div class="sheet-bar"><span style="min-width:56px"></span><b>常吃的食物</b><button class="primary" data-action="close-sheet">完成</button></div>
      <div class="sheet-body">
        <section class="group">
          ${lib.length ? lib.map((f) => `<div class="row">
              <span class="grow">${esc(f.name)}<small>${esc(f.portion || '')} ${Number(f.calories) || 0} kcal・吃過 ${f.count} 次${f.allergens.length ? `・⚠︎ ${esc(f.allergens.join('、'))}` : ''}</small></span>
              <button class="icon danger" data-action="hide-food" data-value="${esc(f.name)}" aria-label="從清單移除">✕</button>
            </div>`).join('') : '<div class="row muted">儲存過餐點後，吃過的食物會自動出現在這裡</div>'}
        </section>
        <p class="foot">清單由過去的餐點自動整理，新增餐點時可以直接點選。按 ✕ 只會從清單隱藏，不會刪除過去的紀錄。</p>
        ${S.hiddenFoods.length ? `<section class="group"><div class="group-head">已隱藏（${S.hiddenFoods.length}）</div>
          ${S.hiddenFoods.map((n) => `<div class="row"><span class="grow muted">${esc(n)}</span><button class="btn" data-action="unhide-food" data-value="${esc(n)}">恢復</button></div>`).join('')}</section>` : ''}
      </div>`;
  },

  settings() {
    const last = S.lastBackup ? new Date(S.lastBackup) : null;
    const lastText = last ? `${fmtYmd(todayKeyOf(last))} ${String(last.getHours()).padStart(2, '0')}:${String(last.getMinutes()).padStart(2, '0')}` : '從未備份';
    let dbx;
    if (!S.dropboxKey) {
      dbx = `<div class="row"><input data-bind="draft" data-field="dropboxKey" placeholder="Dropbox App Key"></div>
        <button class="row action" data-action="dbx-save-key">儲存 App Key</button>`;
    } else if (!S.dropboxLinked) {
      dbx = `<button class="row action" data-action="dbx-link">① 連結 Dropbox（會開啟登入頁）</button>
        ${S.dropboxPending ? `<div class="row"><input data-bind="draft" data-field="dropboxCode" placeholder="② 貼上 Dropbox 顯示的授權碼"></div>
          <button class="row action" data-action="dbx-finish">③ 完成連結</button>` : ''}
        ${CONFIG.dropboxAppKey ? '' : '<button class="row small muted" data-action="dbx-clear-key">更換 App Key</button>'}`;
    } else {
      dbx = `<button class="row action" data-action="dbx-backup">${spinnerLabel(sheet.busy === 'dbx-backup', '☁️ 立即備份到 Dropbox', '上傳中…')}</button>
        <button class="row action" data-action="dbx-list">${spinnerLabel(sheet.busy === 'dbx-list', '⤵️ 從 Dropbox 還原', '讀取中…')}</button>
        <button class="row danger small" data-action="dbx-unlink">中斷 Dropbox 連結</button>`;
    }

    return `<div class="sheet-bar"><span style="min-width:56px"></span><b>設定</b><button class="primary" data-action="close-sheet">完成</button></div>
      <div class="sheet-body">
        <section class="group">
          <div class="group-head">AI 服務</div>
          <div class="row">${seg(Object.values(PROVIDERS), PROVIDERS[S.provider], 'set-provider')}</div>
          ${S.provider === 'gemini' ? `
          <div class="row col"><span class="small muted">Gemini API Key</span>
            <input type="password" autocomplete="off" autocapitalize="off" spellcheck="false" data-bind="draft" data-field="geminiKey" value="${esc(drafts.geminiKey ?? S.geminiKey)}" placeholder="AIza..."></div>
          <div class="row col"><span class="small muted">模型（通常不用改）</span>
            <input autocomplete="off" autocapitalize="off" spellcheck="false" data-bind="draft" data-field="geminiModel" value="${esc(drafts.geminiModel ?? S.geminiModel)}" placeholder="${GEMINI_DEFAULT_MODEL}"></div>
          <button class="row action small" data-action="gemini-models">${spinnerLabel(sheet.busy === 'gemini-models', '🔍 查詢可用模型', '查詢中…')}</button>
          ${sheet.models ? `<div class="row col"><span class="small muted">點選要使用的模型（建議選名稱有 flash 的）</span>
            <div class="chips">${chips(sheet.models, [S.geminiModel || GEMINI_DEFAULT_MODEL], 'pick-model')}</div></div>` : ''}` : `
          <div class="row col"><span class="small muted">Claude API Key</span>
            <input type="password" autocomplete="off" autocapitalize="off" spellcheck="false" data-bind="draft" data-field="apiKey" value="${esc(drafts.apiKey ?? S.apiKey)}" placeholder="sk-ant-..."></div>`}
          <div class="row two">
            <button class="btn pink" data-action="save-api-key">儲存</button>
            ${aiKey() ? '<button class="btn danger" data-action="clear-api-key">移除金鑰</button>' : ''}
          </div>
        </section>
        <p class="foot">${S.provider === 'gemini'
          ? '免費：到 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> 用 Google 帳號建立金鑰。免費方案每天有次數上限，且 Google 可能用送出的照片與文字改進產品。'
          : '到 <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a> 儲值後申請（與 Claude.ai 訂閱分開計費）。'}
          金鑰只存在這支手機。沒有金鑰也能使用，只是要手動輸入食物與熱量。</p>

        <section class="group">
          <div class="group-head">資料備份</div>
          <div class="row kv"><span>上次備份</span><b>${lastText}</b></div>
          <button class="row action" data-action="backup-file">💾 匯出備份檔（可存到 Dropbox／iCloud）</button>
          <label class="row action">📂 從備份檔還原<input type="file" accept=".json,application/json" data-bind="restore-file" hidden></label>
        </section>
        <p class="foot">所有紀錄只存在這支手機的瀏覽器裡。若刪除主畫面圖示或清除 Safari 資料，紀錄會消失，請定期備份。</p>

        <section class="group">
          <div class="group-head">Dropbox 一鍵備份</div>
          ${dbx}
        </section>
        <p class="foot">${S.dropboxLinked ? '備份檔存在 Dropbox 的「應用程式」資料夾中。' : '連結後按一下就能把備份上傳到你自己的 Dropbox。App Key 的申請方式請見說明文件。'}</p>

        <section class="group">
          <div class="group-head">關於</div>
          <div class="row small muted">本 App 的熱量、過敏原與痘痘誘因皆為依紀錄推估的參考資訊，不能取代醫師或營養師的專業判斷。有嚴重過敏或痘痘反覆發炎，請就醫。</div>
        </section>
      </div>`;
  },

  file() {
    return `<div class="sheet-bar"><span style="min-width:56px"></span><b>檔案已產生</b><button class="primary" data-action="close-sheet">完成</button></div>
      <div class="sheet-body">
        <section class="group">
          <div class="row"><span class="grow"><b>${esc(sheet.filename)}</b><small>${(sheet.blob.size / 1024 / 1024).toFixed(2)} MB</small></span></div>
          <button class="row action" data-action="share-file">⬆️ 分享／儲存到「檔案」</button>
        </section>
        <p class="foot">在分享選單選「儲存到檔案」，就可以存到 iCloud 雲碟或 Dropbox；也可以直接用 LINE、Email 傳送。</p>
      </div>`;
  },

  dbxList() {
    return `<div class="sheet-bar"><button data-action="open-settings">‹ 設定</button><b>從 Dropbox 還原</b><span style="min-width:56px"></span></div>
      <div class="sheet-body">
        <section class="group">
          <div class="group-head">選擇要還原的備份</div>
          ${sheet.entries.length ? sheet.entries.slice(0, 20).map((f) => `
            <button class="row" data-action="dbx-restore" data-path="${esc(f.path_lower)}">
              <span class="grow">${esc(f.name)}<small>${new Date(f.server_modified).toLocaleString('zh-TW')}・${(f.size / 1024 / 1024).toFixed(2)} MB</small></span>›
            </button>`).join('') : '<div class="row muted">Dropbox 裡還沒有備份檔</div>'}
        </section>
        <p class="foot">還原會用備份檔的內容取代這支手機目前的所有紀錄。</p>
      </div>`;
  },
};

const todayKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const drafts = {};

// ---------- 動作 ----------
async function openMealEditor(id) {
  if (id) {
    const m = S.meals.find((x) => x.id === id);
    const photo = m.hasPhoto ? (await db.get('photos', id))?.data || null : null;
    editor = { ...structuredClone(m), photo, hint: '' };
  } else {
    const time = nowTime();
    editor = { id: null, day: S.tab === 'today' ? S.day : todayKey(), time, type: guessMealType(time), photo: null, items: [], notes: '', summary: '', hint: '' };
  }
  openSheet('meal');
}

async function saveMeal() {
  const e = editor;
  const id = e.id || uid();
  const items = e.items
    .filter((i) => i.name.trim())
    .map((i) => ({ ...i, name: i.name.trim(), calories: Math.max(0, Math.round(Number(i.calories) || 0)) }));
  const meal = {
    id, day: e.day, time: e.time, type: e.type,
    thumb: e.photo ? await resizeImage(e.photo, 200, 0.6) : null,
    hasPhoto: Boolean(e.photo),
    items, notes: e.notes.trim(), summary: e.summary, updatedAt: Date.now(),
  };
  await db.put('meals', meal);
  if (e.photo) await db.put('photos', { id, data: e.photo }); else await db.del('photos', id);
  upsert(S.meals, meal);
  closeSheet();
  render();
  toast('已儲存');
}

async function saveCheck(check) {
  await db.put('skinChecks', check);
  upsert(S.skinChecks, check, 'day');
  render();
}

async function saveCareLog(period, mutate) {
  const id = `${S.day}|${period}`;
  const log = careLogOf(S.day, period) || { id, day: S.day, period, productNames: [] };
  const next = { ...log, productNames: mutate([...log.productNames]) };
  await db.put('careLogs', next);
  upsert(S.careLogs, next);
  render();
}

async function saveProduct() {
  const p = productEditor;
  const name = p.name.trim();
  if (!name) return toast('請輸入產品名稱');
  if (S.products.some((x) => x.name === name && x.id !== p.id)) return toast('已經有相同名稱的保養品');
  const old = p.id ? S.products.find((x) => x.id === p.id) : null;
  // 改名時同步更新過去的保養紀錄，避免分析時斷開
  if (old && old.name !== name) {
    for (const log of S.careLogs.filter((l) => l.productNames.includes(old.name))) {
      log.productNames = log.productNames.map((n) => (n === old.name ? name : n));
      await db.put('careLogs', log);
    }
  }
  const { photo, photoChanged, ...rest } = p;
  const product = { ...rest, id: p.id || uid(), name, brand: p.brand.trim(), createdAt: p.createdAt || Date.now() };
  await saveItemPhoto(product, photo, photoChanged);
  await db.put('products', product);
  upsert(S.products, product);
  closeSheet();
  render();
  toast('已儲存');
}

// 包裝照片：原圖存在 photos，清單只放縮圖
async function saveItemPhoto(item, photo, changed) {
  if (!changed) return;
  if (photo) {
    item.thumb = await resizeImage(photo, 200, 0.6);
    item.hasPhoto = true;
    await db.put('photos', { id: item.id, data: photo });
  } else {
    item.thumb = null;
    item.hasPhoto = false;
    await db.del('photos', item.id);
  }
}

async function loadItemPhoto(item) {
  return item.hasPhoto ? (await db.get('photos', item.id))?.data || item.thumb : null;
}

async function saveSupp() {
  const s = suppEditor;
  const name = s.name.trim();
  if (!name) return toast('請輸入名稱');
  if (S.supplements.some((x) => x.name === name && x.id !== s.id)) return toast('已經有相同名稱的保健食品');
  const old = s.id ? S.supplements.find((x) => x.id === s.id) : null;
  if (old && old.name !== name) {
    for (const log of S.suppLogs.filter((l) => l.names.includes(old.name))) {
      log.names = log.names.map((n) => (n === old.name ? name : n));
      await db.put('suppLogs', log);
    }
  }
  const { photo, photoChanged, ...rest } = s;
  const supp = { ...rest, id: s.id || uid(), name, brand: s.brand.trim(), dosage: s.dosage.trim(), createdAt: s.createdAt || Date.now() };
  await saveItemPhoto(supp, photo, photoChanged);
  await db.put('supplements', supp);
  upsert(S.supplements, supp);
  closeSheet();
  render();
  toast('已儲存');
}

async function saveSuppLog(mutate) {
  const log = suppLogOf(S.day) || { day: S.day, names: [] };
  const next = { ...log, names: mutate([...log.names]) };
  await db.put('suppLogs', next);
  upsert(S.suppLogs, next, 'day');
  render();
}

const itemEditor = (kind) => (kind === 'product' ? productEditor : suppEditor);

async function openFaceEditor(id) {
  const f = S.faces.find((x) => x.id === id);
  const photo = (await db.get('photos', id))?.data || f.thumb;
  faceEditor = { ...structuredClone(f), photo };
  openSheet('face');
}

async function saveFace() {
  const f = faceEditor;
  const id = f.id || uid();
  const face = {
    id, day: f.day, time: f.time, notes: f.notes.trim(), ai: f.ai || null,
    thumb: f.thumb || await resizeImage(f.photo, 360, 0.7), updatedAt: Date.now(),
  };
  await db.put('faces', face);
  if (!f.id) await db.put('photos', { id, data: f.photo });
  upsert(S.faces, face);
  closeSheet();
  render();
  toast('已儲存');
}

// 複製前一天的餐點（不含照片），時間與餐別沿用
async function copyMeals(fromDay, toDay) {
  for (const m of mealsOn(fromDay)) {
    const meal = {
      id: uid(), day: toDay, time: m.time, type: m.type, thumb: null, hasPhoto: false,
      items: m.items.map(cloneItem), notes: m.notes, summary: m.summary, updatedAt: Date.now(),
    };
    await db.put('meals', meal);
    S.meals.push(meal);
  }
}

function openFileSheet(blob, filename, isBackup = false) {
  openSheet('file', { blob, filename, isBackup });
}

async function exportReport(kind) {
  const start = S.exportStart, end = S.exportEnd;
  const records = buildRecords(start, end, S);
  if (!records.length) return toast('這段期間沒有任何紀錄');
  S.exporting = kind;
  render();
  try {
    const analysis = S.includeAnalysis ? analyze({ start, end, ...S }) : null;
    const range = `${compactDay(start)}-${compactDay(end)}`;
    if (kind === 'excel') {
      openFileSheet(buildExcel(records, analysis, S.products, S.supplements), `食膚日記_${range}.xlsx`);
    } else {
      const blob = await buildPDF({
        records, start, end, analysis, includePhotos: S.includePhotos,
        getPhoto: async (id) => (await db.get('photos', id))?.data,
      });
      openFileSheet(blob, `食膚日記_${range}.pdf`);
    }
  } catch (err) {
    fail(err);
  } finally {
    S.exporting = false;
    render();
  }
}

async function afterRestore(exportedAt) {
  await loadAll();
  closeSheet();
  render();
  toast(`已還原${exportedAt ? `（備份時間 ${new Date(exportedAt).toLocaleString('zh-TW')}）` : ''}`, 3500);
}

async function busy(key, fn) {
  if (sheet?.busy) return;
  sheet.busy = key;
  renderSheet();
  try { await fn(); } catch (err) { fail(err); } finally { if (sheet) { sheet.busy = null; renderSheet(); } }
}

const ACTIONS = {
  'day-prev': () => { S.day = addDays(S.day, -1); render(); },
  'day-next': () => { if (S.day < todayKey()) { S.day = addDays(S.day, 1); render(); } },

  'new-meal': () => openMealEditor(null),
  'edit-meal': (t) => openMealEditor(t.dataset.id),
  'close-sheet': () => closeSheet(),
  'meal-type': (t) => { editor.type = t.dataset.value; renderSheet(); },
  'remove-photo': () => { editor.photo = null; renderSheet(); },
  'add-item': () => { editor.items.push({ name: '', portion: '', calories: 0, allergens: [], acneTags: [] }); renderSheet(); },
  'remove-item': (t) => { editor.items.splice(Number(t.dataset.idx), 1); renderSheet(); },
  'save-meal': () => saveMeal().catch(fail),
  'delete-meal': async () => {
    if (!confirm('確定要刪除這一餐嗎？')) return;
    await db.del('meals', editor.id);
    await db.del('photos', editor.id);
    removeWhere(S.meals, (m) => m.id === editor.id);
    closeSheet();
    render();
  },
  'analyze-meal': async () => {
    if (S.aiBusy) return;
    if (!aiKey()) return needKey();
    if (!editor.photo && !editor.hint.trim()) { toast('請先拍照，或在補充說明輸入吃了什麼'); return; }
    S.aiBusy = true;
    renderSheet();
    const target = editor;
    try {
      const r = await aiMeal(target.photo, target.hint);
      target.items = r.items;
      target.summary = r.summary;
      if (!r.items.length) toast('沒有辨識到食物，可以手動新增', 3500);
    } catch (err) {
      fail(err);
    } finally {
      S.aiBusy = false;
      if (sheet?.kind === 'meal' && editor === target) renderSheet();
    }
  },

  'copy-prev-meals': async (t) => {
    const from = t.dataset.from;
    const n = mealsOn(from).length;
    const has = mealsOn(S.day).length;
    if (!confirm(`要把 ${fmtMd(from)} 的 ${n} 餐複製到 ${fmtMd(S.day)} 嗎？${has ? `\n（${fmtMd(S.day)} 已經有 ${has} 餐，會另外新增，不會覆蓋）` : ''}\n照片不會複製，之後可以個別修改。`)) return;
    await copyMeals(from, S.day);
    render();
    toast(`已複製 ${n} 餐`);
  },
  'copy-prev-meal': (t) => {
    const m = S.meals.find((x) => x.id === t.dataset.id);
    const have = editor.items.map((i) => i.name.trim());
    editor.items.push(...m.items.filter((i) => !have.includes(i.name.trim())).map(cloneItem));
    if (!editor.notes && m.notes) editor.notes = m.notes;
    renderSheet();
  },
  'pick-food': (t) => {
    const name = t.dataset.value;
    const idx = editor.items.findIndex((i) => i.name.trim() === name);
    if (idx >= 0) editor.items.splice(idx, 1);
    else editor.items.push(cloneItem(foodLibrary().find((f) => f.name === name)));
    renderSheet();
  },
  'open-foods': () => openSheet('foods'),
  'hide-food': async (t) => {
    S.hiddenFoods = uniqSorted([...S.hiddenFoods, t.dataset.value]);
    await db.setSetting('hiddenFoods', S.hiddenFoods);
    renderSheet();
    render();
  },
  'unhide-food': async (t) => {
    S.hiddenFoods = S.hiddenFoods.filter((n) => n !== t.dataset.value);
    await db.setSetting('hiddenFoods', S.hiddenFoods);
    renderSheet();
    render();
  },

  'edit-face': (t) => openFaceEditor(t.dataset.id),
  'save-face': () => saveFace().catch(fail),
  'delete-face': async () => {
    if (!confirm('確定要刪除這張自拍嗎？')) return;
    await db.del('faces', faceEditor.id);
    await db.del('photos', faceEditor.id);
    removeWhere(S.faces, (f) => f.id === faceEditor.id);
    closeSheet();
    render();
  },
  'analyze-face': async () => {
    if (S.aiBusy) return;
    if (!aiKey()) return needKey();
    S.aiBusy = true;
    renderSheet();
    const target = faceEditor;
    try {
      target.ai = { ...(await aiFace(target.photo)), at: Date.now() };
    } catch (err) {
      fail(err);
    } finally {
      S.aiBusy = false;
      if (sheet?.kind === 'face' && faceEditor === target) renderSheet();
    }
  },
  'apply-face-ai': async () => {
    const f = faceEditor, ai = f.ai;
    const old = checkOf(f.day);
    const check = { day: f.day, severity: ai.severity, areas: ai.areas, kinds: ai.kinds, notes: old?.notes || '' };
    await db.put('skinChecks', check);
    upsert(S.skinChecks, check, 'day');
    render();
    toast(`已更新 ${fmtMd(f.day)} 的臉部狀況`);
  },

  'toggle-care': (t) => {
    const name = t.dataset.name;
    saveCareLog(t.dataset.period, (names) => (names.includes(name) ? names.filter((n) => n !== name) : [...names, name]));
  },
  'apply-routine': (t) => {
    const period = t.dataset.period;
    saveCareLog(period, (names) => uniqSorted([...names, ...S.products.filter((p) => p.isActive && isRoutine(p, period)).map((p) => p.name)]));
  },
  'copy-prev-care': (t) => {
    const prev = careLogOf(t.dataset.from, t.dataset.period);
    saveCareLog(t.dataset.period, () => [...prev.productNames]);
    toast(`已套用 ${fmtMd(t.dataset.from)} 的${t.dataset.period}保養`);
  },

  'skin-set': (t) => saveCheck({ day: S.day, severity: Number(t.dataset.sev), areas: [], kinds: [], notes: '' }),
  'skin-sev': (t) => saveCheck({ ...checkOf(S.day), severity: SEVERITIES.indexOf(t.dataset.value) }),
  'skin-area': (t) => {
    const c = checkOf(S.day), v = t.dataset.value;
    saveCheck({ ...c, areas: c.areas.includes(v) ? c.areas.filter((x) => x !== v) : [...c.areas, v] });
  },
  'skin-kind': (t) => {
    const c = checkOf(S.day), v = t.dataset.value;
    saveCheck({ ...c, kinds: c.kinds.includes(v) ? c.kinds.filter((x) => x !== v) : [...c.kinds, v] });
  },
  'skin-clear': async () => {
    await db.del('skinChecks', S.day);
    removeWhere(S.skinChecks, (c) => c.day === S.day);
    render();
  },

  'new-product': () => {
    productEditor = { id: null, name: '', brand: '', category: '化妝水', ingredients: '', useMorning: true, useEvening: true, isActive: true, photo: null, ai: null };
    openSheet('product');
  },
  'edit-product': async (t) => {
    const p = S.products.find((x) => x.id === t.dataset.id);
    productEditor = { ...structuredClone(p), photo: await loadItemPhoto(p) };
    openSheet('product');
  },
  'save-product': () => saveProduct().catch(fail),
  'delete-product': async () => {
    if (!confirm(`確定要刪除「${productEditor.name}」嗎？\n（過去的保養紀錄仍會保留產品名稱）`)) return;
    await db.del('products', productEditor.id);
    await db.del('photos', productEditor.id);
    removeWhere(S.products, (p) => p.id === productEditor.id);
    closeSheet();
    render();
  },

  'new-supp': () => {
    suppEditor = { id: null, name: '', brand: '', dosage: '', ingredients: '', daily: true, isActive: true, photo: null, ai: null };
    openSheet('supp');
  },
  'edit-supp': async (t) => {
    const s = S.supplements.find((x) => x.id === t.dataset.id);
    suppEditor = { ...structuredClone(s), photo: await loadItemPhoto(s) };
    openSheet('supp');
  },
  'save-supp': () => saveSupp().catch(fail),
  'delete-supp': async () => {
    if (!confirm(`確定要刪除「${suppEditor.name}」嗎？\n（過去的服用紀錄仍會保留名稱）`)) return;
    await db.del('supplements', suppEditor.id);
    await db.del('photos', suppEditor.id);
    removeWhere(S.supplements, (s) => s.id === suppEditor.id);
    closeSheet();
    render();
  },
  'toggle-supp': (t) => {
    const name = t.dataset.name;
    saveSuppLog((names) => (names.includes(name) ? names.filter((n) => n !== name) : [...names, name]));
  },
  'apply-supp-daily': () => saveSuppLog((names) => uniqSorted([...names, ...S.supplements.filter((s) => s.isActive && s.daily).map((s) => s.name)])),
  'copy-prev-supp': (t) => {
    const prev = suppLogOf(t.dataset.from);
    saveSuppLog(() => [...prev.names]);
    toast(`已套用 ${fmtMd(t.dataset.from)} 的保健食品`);
  },

  'remove-item-photo': (t) => {
    const ed = itemEditor(t.dataset.kind);
    Object.assign(ed, { photo: null, photoChanged: true });
    renderSheet();
  },
  'analyze-item': async (t) => {
    if (S.aiBusy) return;
    if (!aiKey()) return needKey();
    const kind = t.dataset.kind;
    const target = itemEditor(kind);
    S.aiBusy = true;
    renderSheet();
    try {
      const r = await aiItem(kind, target.photo);
      target.ai = { risk: r.risk, flags: r.flags, summary: r.summary, at: Date.now() };
      // 只填入空白的欄位，避免蓋掉使用者自己輸入的內容
      for (const f of ['name', 'brand', 'ingredients', 'dosage']) if (r[f] && !(target[f] || '').trim()) target[f] = r[f];
      if (r.category && !target.id) target.category = r.category;
      if (!r.name) toast('看不出產品名稱，請手動輸入', 3500);
    } catch (err) {
      fail(err);
    } finally {
      S.aiBusy = false;
      if (itemEditor(kind) === target) renderSheet();
    }
  },

  'range': (t) => { S.range = Number(t.dataset.days); render(); },
  'run-ai': async () => {
    if (S.triggerBusy) return;
    if (!aiKey()) return needKey();
    const end = todayKey(), start = addDays(end, -(S.range - 1));
    const result = analyze({ start, end, ...S });
    S.triggerBusy = true;
    render();
    try {
      S.aiText = await aiTriggers(aiPrompt(buildRecords(start, end, S), result, S.products, S.supplements));
      S.aiTextRange = S.range;
    } catch (err) {
      fail(err);
    } finally {
      S.triggerBusy = false;
      render();
    }
  },

  'quick-range': (t) => {
    const today = todayKey();
    const preset = t.dataset.preset;
    if (preset === 'month') { S.exportStart = today.slice(0, 8) + '01'; S.exportEnd = today; }
    else if (preset === 'last-month') {
      const firstThis = today.slice(0, 8) + '01';
      S.exportEnd = addDays(firstThis, -1);
      S.exportStart = S.exportEnd.slice(0, 8) + '01';
    } else { S.exportEnd = today; S.exportStart = addDays(today, -(Number(preset) - 1)); }
    render();
  },
  'export-pdf': () => exportReport('pdf'),
  'export-excel': () => exportReport('excel'),
  'share-file': async () => {
    const shared = await shareOrDownload(sheet.blob, sheet.filename);
    if (shared && sheet.isBackup) { await markBackedUp(); S.lastBackup = new Date().toISOString(); render(); }
  },

  'open-settings': () => {
    for (const f of ['apiKey', 'geminiKey', 'geminiModel']) delete drafts[f];
    openSheet('settings');
  },
  'set-provider': async (t) => {
    S.provider = Object.keys(PROVIDERS).find((k) => PROVIDERS[k] === t.dataset.value) || 'gemini';
    await db.setSetting('aiProvider', S.provider);
    renderSheet();
  },
  'save-api-key': async () => {
    if (S.provider === 'gemini') {
      S.geminiKey = (drafts.geminiKey ?? S.geminiKey).trim();
      S.geminiModel = (drafts.geminiModel ?? S.geminiModel).trim();
      await db.setSetting('geminiKey', S.geminiKey);
      await db.setSetting('geminiModel', S.geminiModel);
    } else {
      S.apiKey = (drafts.apiKey ?? S.apiKey).trim();
      await db.setSetting('apiKey', S.apiKey);
    }
    renderSheet();
    render();
    toast(aiKey() ? 'API Key 已儲存' : '已清除');
  },
  'gemini-models': () => busy('gemini-models', async () => {
    const key = (drafts.geminiKey ?? S.geminiKey).trim();
    const models = await listGeminiModels(key);
    if (!models.length) throw new Error('這把金鑰查不到可用的 Gemini 模型。');
    sheet.models = models;
  }),
  'pick-model': async (t) => {
    S.geminiModel = t.dataset.value === GEMINI_DEFAULT_MODEL ? '' : t.dataset.value;
    drafts.geminiModel = S.geminiModel;
    await db.setSetting('geminiModel', S.geminiModel);
    renderSheet();
    toast(`已改用 ${t.dataset.value}`);
  },
  'clear-api-key': async () => {
    const field = S.provider === 'gemini' ? 'geminiKey' : 'apiKey';
    S[field] = '';
    drafts[field] = '';
    await db.setSetting(field, '');
    renderSheet();
    toast('已移除 API Key');
  },
  'backup-file': async () => {
    try { openFileSheet(await makeBackup(), backupFilename(), true); } catch (err) { fail(err); }
  },

  'dbx-save-key': async () => {
    const key = (drafts.dropboxKey || '').trim();
    if (!key) return toast('請輸入 App Key');
    S.dropboxKey = key;
    await db.setSetting('dropboxAppKey', key);
    renderSheet();
  },
  'dbx-clear-key': async () => {
    S.dropboxKey = '';
    S.dropboxPending = false;
    await db.setSetting('dropboxAppKey', '');
    renderSheet();
  },
  'dbx-link': async () => {
    try {
      await dropbox.startLink(S.dropboxKey);
      S.dropboxPending = true;
      renderSheet();
    } catch (err) { fail(err); }
  },
  'dbx-finish': () => busy('dbx-finish', async () => {
    const code = (drafts.dropboxCode || '').trim();
    if (!code) throw new Error('請貼上授權碼');
    await dropbox.finishLink(S.dropboxKey, code);
    S.dropboxLinked = true;
    S.dropboxPending = false;
    drafts.dropboxCode = '';
    toast('已連結 Dropbox');
  }),
  'dbx-backup': () => busy('dbx-backup', async () => {
    await dropbox.upload(S.dropboxKey, backupFilename(), await makeBackup());
    await markBackedUp();
    S.lastBackup = new Date().toISOString();
    render();
    toast('已備份到 Dropbox');
  }),
  'dbx-list': () => busy('dbx-list', async () => {
    const entries = await dropbox.listBackups(S.dropboxKey);
    sheet = { kind: 'dbxList', entries };
  }),
  'dbx-restore': async (t) => {
    if (!confirm('確定要還原這個備份嗎？\n這支手機目前的所有紀錄會被取代。')) return;
    try {
      toast('下載中…', 10000);
      const exportedAt = await restoreBackup(await dropbox.download(S.dropboxKey, t.dataset.path));
      await afterRestore(exportedAt);
    } catch (err) { fail(err); }
  },
  'dbx-unlink': async () => {
    if (!confirm('確定要中斷 Dropbox 連結嗎？（Dropbox 裡的備份檔不會被刪除）')) return;
    await dropbox.unlink();
    S.dropboxLinked = false;
    renderSheet();
  },
};

// ---------- 輸入事件 ----------
const INPUTS = {
  'meal-hint': (t) => { editor.hint = t.value; },
  'meal-notes': (t) => { editor.notes = t.value; },
  'food-filter': (t) => { editor.filter = t.value; $('#food-lib').innerHTML = foodLibChips(editor); },
  'face-notes': (t) => { faceEditor.notes = t.value; },
  'item': (t) => {
    const item = editor.items[Number(t.dataset.idx)];
    item[t.dataset.field] = t.dataset.field === 'calories' ? Number(t.value) || 0 : t.value;
    $('#meal-total').textContent = `合計 ${sum(editor.items, (i) => Number(i.calories) || 0)} kcal`;
  },
  'prod': (t) => { productEditor[t.dataset.field] = t.type === 'checkbox' ? t.checked : t.value; },
  'supp': (t) => { suppEditor[t.dataset.field] = t.type === 'checkbox' ? t.checked : t.value; },
  'draft': (t) => { drafts[t.dataset.field] = t.value; },
};

const CHANGES = {
  'day-input': (t) => { S.day = t.value && t.value <= todayKey() ? t.value : todayKey(); render(); },
  'meal-day': (t) => { if (t.value) editor.day = t.value; },
  'meal-time': (t) => { if (t.value) editor.time = t.value; },
  'meal-photo': async (t) => {
    const file = t.files?.[0];
    if (!file) return;
    try {
      editor.photo = await resizeImage(file);
      renderSheet();
    } catch {
      toast('無法讀取這張照片，請換一張試試');
    }
  },
  'face-photo': async (t) => {
    const file = t.files?.[0];
    t.value = '';
    if (!file) return;
    let photo;
    try { photo = await resizeImage(file); } catch { return toast('無法讀取這張照片，請換一張試試'); }
    faceEditor = { id: null, day: S.tab === 'today' ? S.day : todayKey(), time: nowTime(), photo, thumb: null, notes: '', ai: null };
    openSheet('face');
  },
  'face-day': (t) => { if (t.value) { faceEditor.day = t.value; renderSheet(); } },
  'face-time': (t) => { if (t.value) faceEditor.time = t.value; },
  'item-multi': (t) => {
    editor.items[Number(t.dataset.idx)][t.dataset.field] = [...t.selectedOptions].map((o) => o.value);
    renderSheet();
  },
  'prod': INPUTS.prod,
  'supp': INPUTS.supp,
  'item-photo': async (t) => {
    const file = t.files?.[0];
    t.value = '';
    if (!file) return;
    try {
      Object.assign(itemEditor(t.dataset.kind), { photo: await resizeImage(file, 1600, 0.8), photoChanged: true });
      renderSheet();
    } catch {
      toast('無法讀取這張照片，請換一張試試');
    }
  },
  'skin-notes': (t) => {
    const c = checkOf(S.day);
    if (c) { c.notes = t.value.trim(); db.put('skinChecks', c); }
  },
  'export-start': (t) => { if (t.value) { S.exportStart = t.value; if (S.exportStart > S.exportEnd) S.exportEnd = S.exportStart; } render(); },
  'export-end': (t) => { if (t.value) { S.exportEnd = t.value; if (S.exportEnd < S.exportStart) S.exportStart = S.exportEnd; } render(); },
  'opt': (t) => { S[t.dataset.field] = t.checked; },
  'restore-file': async (t) => {
    const file = t.files?.[0];
    if (!file) return;
    if (!confirm('確定要從這個備份檔還原嗎？\n這支手機目前的所有紀錄會被取代。')) { t.value = ''; return; }
    try { await afterRestore(await restoreBackup(await file.text())); } catch (err) { fail(err); }
  },
};

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    S.tab = tab.dataset.tab;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); Promise.resolve(fn(el, e)).catch(fail); }
});

document.addEventListener('input', (e) => {
  const fn = INPUTS[e.target.dataset?.bind];
  if (fn && e.target.type !== 'checkbox' && e.target.tagName !== 'SELECT') fn(e.target);
});

document.addEventListener('change', (e) => {
  const fn = CHANGES[e.target.dataset?.bind];
  if (fn) Promise.resolve(fn(e.target)).catch(fail);
});

// 跨過午夜再打開 App 時，回到新的一天
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !sheet && S.tab === 'today' && S.day > todayKey()) { S.day = todayKey(); render(); }
});

// ---------- 啟動 ----------
async function init() {
  try {
    await loadAll();
  } catch (err) {
    $('#view').innerHTML = `<div class="empty">無法開啟資料庫：${esc(err.message)}<br>請確認沒有使用「私密瀏覽」。</div>`;
    return;
  }
  navigator.storage?.persist?.().catch(() => {});
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
