// 直接從瀏覽器呼叫 Google Gemini API（Google AI Studio 的金鑰，有免費額度）
import { MEAL_SYSTEM, TRIGGER_SYSTEM, MEAL_SCHEMA, mealPrompt, parseMeal } from './claude.js';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// Gemini 的 responseSchema 用 OpenAPI 子集：型別大寫、不支援 additionalProperties
function toGeminiSchema(s) {
  const out = { type: s.type.toUpperCase() };
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.required) out.required = s.required;
  return out;
}

// 免費方案常遇到模型忙線（503）或單一模型額度用完（429），依序改用較輕量的模型
const FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const BUSY = new Set([500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(apiKey, model, body) {
  try {
    return await fetch(`${BASE}${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('無法連線到 Gemini，請確認網路。');
  }
}

async function send(apiKey, model, body) {
  if (!apiKey) throw new Error('尚未設定 Gemini API Key，請按右上角 ⚙︎ 輸入。');
  const first = model || GEMINI_DEFAULT_MODEL;
  const models = [first, ...FALLBACK_MODELS.filter((m) => m !== first)];
  const seen = new Set();
  let res, data;
  outer: for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await post(apiKey, m, body);
      data = await res.json().catch(() => ({}));
      if (res.ok) break outer;
      seen.add(res.status);
      const reason = JSON.stringify(data?.error?.details || '');
      if (reason.includes('API_KEY_INVALID') || res.status === 401 || res.status === 403) {
        throw new Error('Gemini API Key 無效，請到設定重新輸入。');
      }
      if (BUSY.has(res.status) && attempt === 0) { await sleep(2000); continue; }
      if (BUSY.has(res.status) || res.status === 429 || res.status === 404) continue outer;
      throw new Error(`Gemini API 錯誤（${res.status}）：${data?.error?.message || res.statusText}`);
    }
  }
  if (!res.ok) {
    if (seen.has(429)) throw new Error('已達 Gemini 免費額度上限或請求太頻繁，請稍後（或明天）再試。');
    if (![...seen].some((s) => BUSY.has(s))) throw new Error(`找不到模型「${first}」，請到設定把模型欄位清空。`);
    throw new Error('Google 的 AI 目前太多人使用（伺服器忙線），請過幾分鐘再試一次。');
  }
  if (data.promptFeedback?.blockReason) throw new Error('AI 拒絕處理此請求，請換一張照片或改用文字描述。');
  const cand = data.candidates?.[0];
  if (cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT') {
    throw new Error('AI 拒絕處理此請求，請換一張照片或改用文字描述。');
  }
  // 略過思考摘要（thought: true），只取正式回答
  const text = (cand?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) throw new Error('AI 沒有回傳內容，請稍後再試。');
  return text;
}

export async function analyzeMealGemini(apiKey, model, photoDataURL, hint) {
  const parts = [];
  if (photoDataURL) parts.push({ inline_data: { mime_type: 'image/jpeg', data: photoDataURL.split(',')[1] } });
  parts.push({ text: mealPrompt(photoDataURL, hint) });

  const json = await send(apiKey, model, {
    system_instruction: { parts: [{ text: MEAL_SYSTEM }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(MEAL_SCHEMA) },
  });
  return parseMeal(json);
}

export function analyzeTriggersGemini(apiKey, model, prompt) {
  return send(apiKey, model, {
    system_instruction: { parts: [{ text: TRIGGER_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
}
