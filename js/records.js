// 將某一天的所有紀錄整合在一起，供報告、Excel 與 AI 分析共用
import { addDays, groupBy, sum, uniqSorted } from './util.js';

export const mealCalories = (meal) => sum(meal.items, (i) => Number(i.calories) || 0);
export const mealAllergens = (meal) => uniqSorted(meal.items.flatMap((i) => i.allergens));
export const mealNames = (meal) => meal.items.map((i) => i.name).filter(Boolean).join('、');

export function buildRecords(start, end, { meals, careLogs, skinChecks, faces = [], suppLogs = [] }) {
  const suppByDay = new Map(suppLogs.map((l) => [l.day, l.names]));
  const [first, last] = start <= end ? [start, end] : [end, start];
  const mealsByDay = groupBy(meals, (m) => m.day);
  const facesByDay = groupBy(faces, (f) => f.day);
  const logsByDay = groupBy(careLogs, (l) => l.day);
  const checkByDay = new Map(skinChecks.map((c) => [c.day, c]));

  const records = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const logs = logsByDay.get(day) || [];
    const dayMeals = (mealsByDay.get(day) || []).sort((a, b) => a.time.localeCompare(b.time));
    const record = {
      day,
      meals: dayMeals,
      morning: logs.find((l) => l.period === '早上')?.productNames || [],
      evening: logs.find((l) => l.period === '晚上')?.productNames || [],
      check: checkByDay.get(day) || null,
      faces: (facesByDay.get(day) || []).sort((a, b) => a.time.localeCompare(b.time)),
      supps: suppByDay.get(day) || [],
    };
    record.calories = sum(dayMeals, mealCalories);
    record.allergens = uniqSorted(dayMeals.flatMap(mealAllergens));
    if (dayMeals.length || record.morning.length || record.evening.length || record.check || record.faces.length || record.supps.length) records.push(record);
  }
  return records;
}
