/*
 * 本地端的痘痘誘因推算
 *
 * 做法：找出每次「開始長痘」的日子（前一天沒有長痘），
 * 比較這些日子之前的飲食（前 1–3 天）與保養品（前 0–7 天），
 * 和「沒長痘的日子」之前的同樣觀察期。某項目在爆痘前明顯比較常出現，就列為可疑。
 */
import { addDays, daysBetween, fmtMd, fmtYmd, groupBy } from './util.js';
import { COMEDOGENIC, SUPP_ACNE, SEVERITIES } from './vocab.js';

const FOOD_LAGS = [1, 2, 3];
const CARE_LAGS = [0, 1, 2, 3, 4, 5, 6, 7];
const NEW_PRODUCT_DAYS = 14;

export const KIND = { food: '食物', tag: '飲食類型', allergen: '過敏原', product: '保養品', supp: '保健食品' };

export function levelOf(score) {
  if (score >= 1.5) return { text: '高度相關', cls: 'high', color: '#d93b3b' };
  if (score >= 0.8) return { text: '中度相關', cls: 'mid', color: '#d9730d' };
  return { text: '低度相關', cls: 'low', color: '#c9b000' };
}

function rank(kind, breakout, clean) {
  const nB = breakout.length, nC = clean.length;
  if (!nB) return [];
  const bCount = new Map(), cCount = new Map();
  for (const set of breakout) for (const f of set) bCount.set(f, (bCount.get(f) || 0) + 1);
  for (const set of clean) for (const f of set) cCount.set(f, (cCount.get(f) || 0) + 1);

  // 爆痘次數夠多時，至少要出現兩次才列入，避免單次巧合
  const minHits = nB >= 3 ? 2 : 1;
  const out = [];
  for (const [name, a] of bCount) {
    if (a < minHits) continue;
    const c = cCount.get(name) || 0;
    // 加上平滑項，避免分母為 0
    const pB = (a + 0.5) / (nB + 1);
    const pC = (c + 0.5) / (nC + 1);
    const rr = pB / pC;
    if (rr < 1.2) continue;
    out.push({ kind, name, breakoutHits: a, breakoutTotal: nB, cleanHits: c, cleanTotal: nC, score: rr * (a / nB) });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 8);
}

export function analyze({ start, end, meals, careLogs, skinChecks, products, supplements = [], suppLogs = [] }) {
  const ranged = skinChecks.filter((c) => c.day >= start && c.day <= end);
  const byDay = new Map(ranged.map((c) => [c.day, c]));
  const breakoutDays = ranged.filter((c) => c.severity > 0).map((c) => c.day).sort();
  const onsets = breakoutDays.filter((d) => !(byDay.get(addDays(d, -1))?.severity > 0));
  const cleanDays = ranged.filter((c) => !(c.severity > 0)).map((c) => c.day);

  const mealsByDay = groupBy(meals, (m) => m.day);
  const logsByDay = groupBy(careLogs, (l) => l.day);

  const foodWindow = (day) => {
    const w = { foods: new Set(), tags: new Set(), allergens: new Set() };
    let hasData = false;
    for (const lag of FOOD_LAGS) {
      for (const meal of mealsByDay.get(addDays(day, -lag)) || []) {
        hasData = true;
        for (const item of meal.items) {
          const name = (item.name || '').trim().toLowerCase();
          if (name) w.foods.add(name);
          item.acneTags.forEach((t) => w.tags.add(t));
          item.allergens.forEach((a) => w.allergens.add(a));
        }
      }
    }
    return hasData ? w : null;
  };

  const careWindow = (day) => {
    const used = new Set();
    let hasData = false;
    for (const lag of CARE_LAGS) {
      for (const log of logsByDay.get(addDays(day, -lag)) || []) {
        hasData = true;
        log.productNames.forEach((n) => used.add(n));
      }
    }
    return hasData ? used : null;
  };

  // 保健食品和保養品一樣看前 0–7 天
  const suppByDay = new Map(suppLogs.map((l) => [l.day, l]));
  const suppWindow = (day) => {
    const used = new Set();
    let hasData = false;
    for (const lag of CARE_LAGS) {
      const log = suppByDay.get(addDays(day, -lag));
      if (log) { hasData = true; log.names.forEach((n) => used.add(n)); }
    }
    return hasData ? used : null;
  };

  const bFood = onsets.map(foodWindow).filter(Boolean);
  const cFood = cleanDays.map(foodWindow).filter(Boolean);
  const bCare = onsets.map(careWindow).filter(Boolean);
  const cCare = cleanDays.map(careWindow).filter(Boolean);

  // 爆痘前用過、且含可能致粉刺成分的產品
  const usedBefore = new Set(bCare.flatMap((s) => [...s]));
  const comedogenicHits = [];
  for (const p of products) {
    if (!usedBefore.has(p.name)) continue;
    const ing = (p.ingredients || '').toLowerCase();
    const hits = [...new Set(COMEDOGENIC.filter(([k]) => ing.includes(k.toLowerCase())).map(([, label]) => label))];
    if (hits.length) comedogenicHits.push(`「${p.name}」含有 ${hits.join('、')}`);
  }

  const bSupp = onsets.map(suppWindow).filter(Boolean);
  const cSupp = cleanDays.map(suppWindow).filter(Boolean);
  const suppBefore = new Set(bSupp.flatMap((s) => [...s]));
  const suppHits = [];
  for (const s of supplements) {
    if (!suppBefore.has(s.name)) continue;
    const ing = `${s.name} ${s.ingredients || ''}`.toLowerCase();
    const hits = [...new Set(SUPP_ACNE.filter(([k]) => ing.includes(k.toLowerCase())).map(([, label]) => label))];
    if (hits.length) suppHits.push(`「${s.name}」含有 ${hits.join('、')}`);
  }

  const foods = rank(KIND.food, bFood.map((w) => w.foods), cFood.map((w) => w.foods));
  const tags = rank(KIND.tag, bFood.map((w) => w.tags), cFood.map((w) => w.tags));
  const allergens = rank(KIND.allergen, bFood.map((w) => w.allergens), cFood.map((w) => w.allergens));
  const productSuspects = rank(KIND.product, bCare, cCare);
  const suppSuspects = rank(KIND.supp, bSupp, cSupp);
  const suppAsLogs = suppLogs.map((l) => ({ day: l.day, productNames: l.names }));

  return {
    start, end,
    checkedDays: ranged.length,
    breakoutDays: breakoutDays.length,
    onsets,
    cleanDays: cleanDays.length,
    diet: [...foods, ...tags, ...allergens].sort((a, b) => b.score - a.score).slice(0, 8),
    products: productSuspects,
    supplements: suppSuspects,
    top: [...foods, ...tags, ...allergens, ...productSuspects, ...suppSuspects].sort((a, b) => b.score - a.score).slice(0, 5),
    newProductAlerts: newProductAlerts(careLogs, onsets),
    newSuppAlerts: newProductAlerts(suppAsLogs, onsets, '服用'),
    comedogenicHits,
    suppHits,
    confidence: confidence(onsets.length),
  };
}

function confidence(n) {
  if (n === 0) return '尚無長痘紀錄';
  if (n < 3) return '資料不足（至少需要 3 次長痘與多天無痘紀錄）';
  if (n < 6) return '低';
  if (n < 12) return '中';
  return '較高';
}

/** 新開始使用的產品，在 1–14 天內出現痘痘 */
function newProductAlerts(careLogs, onsets, verb = '使用') {
  if (!careLogs.length) return [];
  const firstLogDay = careLogs.map((l) => l.day).sort()[0];
  const firstUse = new Map();
  for (const log of careLogs) {
    for (const name of log.productNames) {
      if (!firstUse.has(name) || log.day < firstUse.get(name)) firstUse.set(name, log.day);
    }
  }
  const alerts = [];
  // 第一天就有紀錄的產品視為原本就在用的，不算新產品
  for (const [name, started] of [...firstUse].sort((a, b) => a[1].localeCompare(b[1]))) {
    if (started <= firstLogDay) continue;
    const onset = onsets.find((d) => { const gap = daysBetween(started, d); return gap >= 1 && gap <= NEW_PRODUCT_DAYS; });
    if (onset) alerts.push(`「${name}」於 ${fmtMd(started)} 開始${verb}，${daysBetween(started, onset)} 天後（${fmtMd(onset)}）開始長痘`);
  }
  return alerts;
}

/** 給 AI 深度解讀用的資料摘要 */
export function aiPrompt(records, result, products, supplements = []) {
  const lines = [`分析期間：${fmtYmd(result.start)} ～ ${fmtYmd(result.end)}`, '', '【保養品清單】'];
  for (const p of products) {
    const ing = p.ingredients ? p.ingredients.slice(0, 300) : '未填';
    lines.push(`- ${p.name}（${p.brand || ''} ${p.category}，${p.isActive ? '使用中' : '已停用'}）成分：${ing}`);
  }
  if (supplements.length) {
    lines.push('', '【保健食品清單】');
    for (const s of supplements) {
      const ing = s.ingredients ? s.ingredients.slice(0, 300) : '未填';
      lines.push(`- ${s.name}（${s.brand || ''}${s.dosage ? `，${s.dosage}` : ''}，${s.isActive ? '服用中' : '已停用'}）成分：${ing}`);
    }
  }
  lines.push('', '【每日紀錄】');
  for (const r of records) {
    const parts = [];
    const foods = r.meals.map((m) => `${m.type}:${m.items.map((i) => (i.acneTags.length ? `${i.name}(${i.acneTags.join(',')})` : i.name)).join('、')}`);
    if (foods.length) parts.push('飲食 ' + foods.join('；'));
    if (r.morning.length) parts.push('早保養 ' + r.morning.join('、'));
    if (r.evening.length) parts.push('晚保養 ' + r.evening.join('、'));
    if (r.supps?.length) parts.push('保健食品 ' + r.supps.join('、'));
    if (r.check) {
      let skin = `肌膚 ${SEVERITIES[r.check.severity]}`;
      if (r.check.areas.length) skin += `（${r.check.areas.join('、')}）`;
      if (r.check.kinds.length) skin += ` ${r.check.kinds.join('、')}`;
      if (r.check.notes) skin += ` 備註:${r.check.notes}`;
      parts.push(skin);
    }
    lines.push(`${fmtMd(r.day)} | ${parts.join(' | ')}`);
  }
  lines.push('', `【App 本地統計】有肌膚紀錄 ${result.checkedDays} 天，長痘 ${result.breakoutDays} 天，開始長痘 ${result.onsets.length} 次。`);
  for (const s of result.top) {
    lines.push(`- ${s.kind}「${s.name}」：爆痘前 ${s.breakoutHits}/${s.breakoutTotal}、無痘日前 ${s.cleanHits}/${s.cleanTotal}`);
  }
  result.newProductAlerts.forEach((a) => lines.push(`- 新產品：${a}`));
  result.comedogenicHits.forEach((a) => lines.push(`- 成分：${a}`));
  result.newSuppAlerts.forEach((a) => lines.push(`- 新保健食品：${a}`));
  result.suppHits.forEach((a) => lines.push(`- 保健食品成分：${a}`));
  return lines.join('\n');
}
