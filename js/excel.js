// 依日期區間組成 Excel 的工作表
import { buildXLSX } from './xlsx.js';
import { fmtYmd, weekday } from './util.js';
import { SEVERITIES } from './vocab.js';
import { mealCalories, mealNames } from './records.js';
import { levelOf } from './analyzer.js';

const mealsText = (meals) => meals.map((m) => `${mealNames(m) || '（未填）'}（${mealCalories(m)} kcal）`).join('\n');

export function buildExcel(records, analysis, products, supplements = []) {
  const brandOf = new Map(products.map((p) => [p.name, p.brand]));
  const suppOf = new Map(supplements.map((s) => [s.name, s]));

  const overview = {
    name: '每日總覽',
    header: ['日期', '星期', '早餐', '午餐', '晚餐', '點心', '總熱量(kcal)', '可能過敏原',
      '早上保養', '晚上保養', '保健食品', '是否長痘', '嚴重程度', '部位', '類型', '肌膚備註'],
    widths: [12, 6, 24, 24, 24, 20, 12, 18, 26, 26, 22, 9, 9, 16, 16, 24],
    rows: records.map((r) => {
      const of = (t) => mealsText(r.meals.filter((m) => m.type === t));
      const c = r.check;
      return [fmtYmd(r.day), weekday(r.day), of('早餐'), of('午餐'), of('晚餐'), of('點心'),
        r.calories, r.allergens.join('、'), r.morning.join('、'), r.evening.join('、'), r.supps.join('、'),
        c ? (c.severity > 0 ? '是' : '否') : '未記錄', c ? SEVERITIES[c.severity] : '',
        c?.areas.join('、') ?? '', c?.kinds.join('、') ?? '', c?.notes ?? ''];
    }),
  };

  const foods = {
    name: '飲食明細',
    header: ['日期', '時間', '餐別', '食物', '份量', '熱量(kcal)', '過敏原', '痘痘風險標籤', '餐點備註', 'AI 摘要'],
    widths: [12, 7, 7, 20, 14, 10, 18, 18, 20, 36],
    rows: records.flatMap((r) => r.meals.flatMap((m) => {
      const items = m.items.length ? m.items : [{ name: '（未填）', portion: '', calories: 0, allergens: [], acneTags: [] }];
      return items.map((i) => [fmtYmd(r.day), m.time, m.type, i.name, i.portion, Number(i.calories) || 0,
        i.allergens.join('、'), i.acneTags.join('、'), m.notes || '', m.summary || '']);
    })),
  };

  const care = {
    name: '保養紀錄',
    header: ['日期', '時段', '產品', '品牌'],
    widths: [12, 7, 26, 18],
    rows: records.flatMap((r) => [
      ...r.morning.map((n) => [fmtYmd(r.day), '早上', n, brandOf.get(n) || '']),
      ...r.evening.map((n) => [fmtYmd(r.day), '晚上', n, brandOf.get(n) || '']),
    ]),
  };

  const skin = {
    name: '肌膚狀況',
    header: ['日期', '是否長痘', '嚴重程度', '部位', '類型', '備註', '自拍張數', 'AI 膚況描述'],
    widths: [12, 9, 9, 20, 20, 30, 9, 40],
    rows: records.filter((r) => r.check || r.faces.length).map((r) => {
      const c = r.check;
      const ai = r.faces.map((f) => f.ai?.summary).filter(Boolean).join('\n');
      return [fmtYmd(r.day), c ? (c.severity > 0 ? '是' : '否') : '未記錄', c ? SEVERITIES[c.severity] : '',
        c?.areas.join('、') ?? '', c?.kinds.join('、') ?? '', c?.notes ?? '', r.faces.length, ai];
    }),
  };

  const supps = {
    name: '保健食品紀錄',
    header: ['日期', '保健食品', '品牌', '用法用量'],
    widths: [12, 26, 18, 24],
    rows: records.flatMap((r) => r.supps.map((n) => [fmtYmd(r.day), n, suppOf.get(n)?.brand || '', suppOf.get(n)?.dosage || ''])),
  };

  const sheets = [overview, foods, care, supps, skin];

  if (analysis) {
    sheets.push({
      name: '誘因分析',
      header: ['類型', '項目', '長痘前出現', '無痘日前出現', '關聯指數', '判讀'],
      widths: [10, 44, 12, 12, 10, 10],
      rows: [
        ...[...analysis.diet, ...analysis.products, ...analysis.supplements].map((s) => [s.kind, s.name, `${s.breakoutHits}/${s.breakoutTotal}`,
          `${s.cleanHits}/${s.cleanTotal}`, Math.round(s.score * 100) / 100, levelOf(s.score).text]),
        ...analysis.newProductAlerts.map((a) => ['新產品', a, '', '', '', '']),
        ...analysis.comedogenicHits.map((a) => ['成分', a, '', '', '', '']),
        ...analysis.newSuppAlerts.map((a) => ['新保健食品', a, '', '', '', '']),
        ...analysis.suppHits.map((a) => ['保健食品成分', a, '', '', '', '']),
        ['說明', `分析期間 ${fmtYmd(analysis.start)}～${fmtYmd(analysis.end)}，推論可信度：${analysis.confidence}。僅代表時間上的關聯，不代表因果。`, '', '', '', ''],
      ],
    });
  }

  return buildXLSX(sheets);
}
