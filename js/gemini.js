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

async function send(apiKey, model, body) {
  if (!apiKey) throw new Error('尚未設定 Gemini API Key，請按右上角 ⚙︎ 輸入。');
  let res;
  try {
    res = await fetch(`${BASE}${encodeURIComponent(model || GEMINI_DEFAULT_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('無法連線到 Gemini，請確認網路。');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    const reason = JSON.stringify(data?.error?.details || '');
    if (reason.includes('API_KEY_INVALID') || res.status === 401 || res.status === 403) {
      throw new Error('Gemini API Key 無效，請到設定重新輸入。');
    }
    if (res.status === 429) throw new Error('已達 Gemini 免費額度上限或請求太頻繁，請稍後（或明天）再試。');
    if (res.status === 404) throw new Error(`找不到模型「${model}」，請到設定改回預設模型。`);
    throw new Error(`Gemini API 錯誤（${res.status}）：${msg}`);
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
