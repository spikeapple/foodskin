// PDF 報告：用 canvas 排版（中文字型由手機系統提供），每頁轉成 JPEG 後組成 PDF
import { fmtDay, fmtYmd, todayKey, nowTime, loadImage, sum } from './util.js';
import { SEVERITIES } from './vocab.js';
import { mealCalories, mealAllergens, mealNames } from './records.js';
import { levelOf } from './analyzer.js';

const W = 1190, H = 1684, M = 80;          // A4，2 倍解析度
const FONT = '-apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';
const PINK = '#d6406f';

export async function buildPDF({ records, start, end, analysis, includePhotos, getPhoto }) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const pages = [];
  let y = M;

  const clear = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); y = M; };
  const flush = async () => {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86));
    pages.push(new Uint8Array(await blob.arrayBuffer()));
    clear();
  };
  const ensure = async (h) => { if (y + h > H - M) await flush(); };

  const wrap = (text, maxWidth) => {
    const lines = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const ch of para) {
        if (ctx.measureText(line + ch).width > maxWidth && line) { lines.push(line); line = ch; }
        else line += ch;
      }
      lines.push(line);
    }
    return lines;
  };

  const write = async (text, { size = 22, bold = false, color = '#222', indent = 0, after = 8 } = {}) => {
    ctx.font = `${bold ? 700 : 400} ${size}px ${FONT}`;
    const lineH = Math.round(size * 1.5);
    for (const line of wrap(text, W - M * 2 - indent)) {
      await ensure(lineH);
      ctx.font = `${bold ? 700 : 400} ${size}px ${FONT}`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'top';
      ctx.fillText(line, M + indent, y);
      y += lineH;
    }
    y += after;
  };

  const rule = async () => {
    await ensure(20);
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M, y + 8);
    ctx.lineTo(W - M, y + 8);
    ctx.stroke();
    y += 20;
  };

  const thumbnails = async (dataURLs) => {
    const size = 128, gap = 12;
    let x = M + 24;
    await ensure(size + gap);
    for (const src of dataURLs) {
      let img;
      try { img = await loadImage(src); } catch { continue; }
      if (x + size > W - M) { x = M + 24; y += size + gap; await ensure(size + gap); }
      const ratio = Math.max(size / img.naturalWidth, size / img.naturalHeight);
      const dw = img.naturalWidth * ratio, dh = img.naturalHeight * ratio;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, size, size, 12) : ctx.rect(x, y, size, size);
      ctx.clip();
      ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
      ctx.restore();
      x += size + gap;
    }
    y += size + gap;
  };

  clear();

  // ---- 摘要 ----
  await write('飲食紀錄與臉部保養報告', { size: 44, bold: true, color: PINK, after: 10 });
  await write(`期間：${fmtYmd(start)} ～ ${fmtYmd(end)}`, { size: 24, color: '#555' });
  await write(`產生時間：${fmtYmd(todayKey())} ${nowTime()}`, { size: 20, color: '#888', after: 22 });

  const mealDays = records.filter((r) => r.meals.length);
  const avg = mealDays.length ? Math.round(sum(mealDays, (r) => r.calories) / mealDays.length) : 0;
  const checks = records.map((r) => r.check).filter(Boolean);
  const allergenCount = new Map();
  records.forEach((r) => r.allergens.forEach((a) => allergenCount.set(a, (allergenCount.get(a) || 0) + 1)));
  const topAllergens = [...allergenCount].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]) => `${a}（${n} 天）`);

  await write('摘要', { size: 30, bold: true, after: 10 });
  await write(`有紀錄的天數：${records.length} 天　餐點數：${sum(records, (r) => r.meals.length)} 餐`, { indent: 24 });
  await write(`有飲食紀錄日的平均熱量：${avg} kcal / 天`, { indent: 24 });
  await write(`肌膚紀錄：${checks.length} 天，其中長痘 ${checks.filter((c) => c.severity > 0).length} 天`, { indent: 24 });
  if (topAllergens.length) await write(`最常出現的過敏原：${topAllergens.join('、')}`, { indent: 24 });

  if (analysis && analysis.onsets.length) {
    y += 12;
    await write(`可能的痘痘誘因（推論可信度：${analysis.confidence}）`, { size: 30, bold: true, after: 10 });
    const suspects = [...analysis.diet.slice(0, 5), ...analysis.products.slice(0, 3)];
    if (!suspects.length) await write('沒有明顯可疑的項目', { indent: 24 });
    for (const s of suspects) {
      await write(`・[${s.kind}] ${s.name}　${levelOf(s.score).text}：長痘前 ${s.breakoutHits}/${s.breakoutTotal} 次、無痘日前 ${s.cleanHits}/${s.cleanTotal} 次`, { indent: 24 });
    }
    for (const a of [...analysis.newProductAlerts, ...analysis.comedogenicHits]) {
      await write(`・${a}`, { indent: 24, color: '#555' });
    }
  }
  await write('※ 熱量與誘因皆為依紀錄推估，僅供參考，不能取代醫療建議。', { size: 18, color: '#888', after: 16 });

  // ---- 每日紀錄 ----
  await rule();
  await write('每日紀錄', { size: 30, bold: true, after: 14 });
  for (const r of records) {
    await ensure(130);
    const breakout = r.check?.severity > 0;
    await write(`${fmtDay(r.day)}　${r.calories} kcal`, { size: 26, bold: true, color: breakout ? PINK : '#222', after: 6 });

    for (const m of r.meals) {
      let line = `${m.type} ${m.time}　${mealNames(m) || '（未填）'}　${mealCalories(m)} kcal`;
      const allergens = mealAllergens(m);
      if (allergens.length) line += `　過敏原：${allergens.join('、')}`;
      await write(line, { size: 21, indent: 24, after: 4 });
    }
    if (includePhotos) {
      const photos = [];
      for (const m of r.meals) if (m.hasPhoto) { const p = await getPhoto(m.id); if (p) photos.push(p); }
      if (photos.length) { y += 4; await thumbnails(photos); }
    }
    if (r.morning.length || r.evening.length) {
      await write(`保養　早：${r.morning.join('、') || '—'}　晚：${r.evening.join('、') || '—'}`, { size: 21, color: '#555', indent: 24, after: 4 });
    }
    if (r.check) {
      const c = r.check;
      let line = '肌膚　' + (c.severity > 0 ? `有長痘（${SEVERITIES[c.severity]}）` : '沒有長痘');
      if (c.areas.length) line += `　部位：${c.areas.join('、')}`;
      if (c.kinds.length) line += `　類型：${c.kinds.join('、')}`;
      if (c.notes) line += `　備註：${c.notes}`;
      await write(line, { size: 21, color: breakout ? PINK : '#555', indent: 24, after: 4 });
    }
    await rule();
  }

  await flush();
  return assemblePDF(pages);
}

function assemblePDF(jpegs) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; chunks.push(b); length += b.length; };
  const obj = (id, body) => { offsets[id] = length; push(`${id} 0 obj\n${body}\nendobj\n`); };

  push('%PDF-1.4\n%âãÏÓ\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${jpegs.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${jpegs.length} >>`);

  const draw = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q';
  jpegs.forEach((jpg, i) => {
    const page = 3 + i * 3, image = page + 1, content = page + 2;
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`);
    offsets[image] = length;
    push(`${image} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    push(jpg);
    push('\nendstream\nendobj\n');
    obj(content, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  });

  const size = 3 + jpegs.length * 3;
  const xref = length;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
