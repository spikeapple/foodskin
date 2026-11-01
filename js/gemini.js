// 直接從瀏覽器呼叫 Google Gemini API（Google AI Studio 的金鑰，有免費額度）
import {
  MEAL_SYSTEM, TRIGGER_SYSTEM, MEAL_SCHEMA, mealPrompt, parseMeal,
  FACE_SYSTEM, FACE_SCHEMA, FACE_PROMPT, parseFace, ITEM_AI, parseItem,
} from './claude.js';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// Gemini 的 responseSchema 用 OpenAPI 子集：型別大寫、不支援 additionalProperties
function toGeminiSchema(s) {
  const out = { type: s.type.toUpperCase() };
  if (s.enum && s.type === 'string') out.enum = s.enum;  // Gemini 只支援字串列舉
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
  const { example, ...payload } = body;  // example 只給 withoutSchema 用，不送出
  try {
    return await fetch(`${BASE}${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('無法連線到 Gemini，請確認網路。');
  }
}

const MEAL_EXAMPLE = '{"foods":[{"name":"食物名稱","portion":"份量","calories":整數,"allergens":["…"],"acne_tags":["…"]}],"summary":"總結"}';
const FACE_EXAMPLE = '{"severity":0到3的整數,"areas":["…"],"kinds":["…"],"summary":"描述"}';

// 有些模型不接受 responseSchema（回 400），改成只要求 JSON、把格式寫在指示裡
function withoutSchema(body) {
  const { responseSchema, ...config } = body.generationConfig;
  const hint = `\n\n只回傳 JSON，不要其他文字，清單類欄位只能用上面清單中的詞。格式如下：\n${body.example}`;
  return {
    ...body,
    system_instruction: { parts: [{ text: body.system_instruction.parts[0].text + hint }] },
    generationConfig: config,
  };
}

async function send(apiKey, model, body) {
  if (!apiKey) throw new Error('尚未設定 Gemini API Key，請按右上角 ⚙︎ 輸入。');
  const first = model || GEMINI_DEFAULT_MODEL;
  const models = [...new Set([first, GEMINI_DEFAULT_MODEL, ...FALLBACK_MODELS])];
  const seen = new Set();
  let res, data, lastMsg = '';
  outer: for (const m of models) {
    let req = body;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await post(apiKey, m, req);
      data = await res.json().catch(() => ({}));
      if (res.ok) break outer;
      seen.add(res.status);
      lastMsg = data?.error?.message || res.statusText;
      const reason = JSON.stringify(data?.error?.details || '');
      if (reason.includes('API_KEY_INVALID') || res.status === 401 || res.status === 403) {
        throw new Error('Gemini API Key 無效，請到設定重新輸入。');
      }
      if (BUSY.has(res.status) && attempt === 0) { await sleep(2000); continue; }
      if (res.status === 400 && attempt === 0 && req.generationConfig?.responseSchema) { req = withoutSchema(req); continue; }
      if (BUSY.has(res.status) || [400, 404, 429].includes(res.status)) continue outer;
      throw new Error(`Gemini API 錯誤（${res.status}）：${lastMsg}`);
    }
  }
  if (!res.ok) {
    if (seen.has(429)) throw new Error('已達 Gemini 免費額度上限或請求太頻繁，請稍後（或明天）再試。');
    if ([...seen].some((s) => BUSY.has(s))) throw new Error('Google 的 AI 目前太多人使用（伺服器忙線），請過幾分鐘再試一次。');
    throw new Error(`Gemini 無法使用模型「${first}」（${res.status}：${lastMsg}）。請到設定按「查詢可用模型」重新選擇。`);
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

/** 列出這把金鑰能用來產生內容的 Gemini 模型（新的在前） */
export async function listGeminiModels(apiKey) {
  if (!apiKey) throw new Error('請先輸入並儲存 Gemini API Key。');
  let res;
  try {
    res = await fetch(`${BASE}?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey } });
  } catch {
    throw new Error('無法連線到 Gemini，請確認網路。');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error('Gemini API Key 無效，請到設定重新輸入。');
    throw new Error(`查詢模型失敗（${res.status}）：${data?.error?.message || res.statusText}`);
  }
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => n.startsWith('gemini') && !/(tts|image|live|audio|embedding|transcribe|robotics|computer)/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

export async function analyzeMealGemini(apiKey, model, photoDataURL, hint) {
  const parts = [];
  if (photoDataURL) parts.push({ inline_data: { mime_type: 'image/jpeg', data: photoDataURL.split(',')[1] } });
  parts.push({ text: mealPrompt(photoDataURL, hint) });

  const json = await send(apiKey, model, {
    system_instruction: { parts: [{ text: MEAL_SYSTEM }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(MEAL_SCHEMA) },
    example: MEAL_EXAMPLE,
  });
  return parseMeal(json);
}

export async function analyzeFaceGemini(apiKey, model, photoDataURL) {
  const json = await send(apiKey, model, {
    system_instruction: { parts: [{ text: FACE_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: photoDataURL.split(',')[1] } }, { text: FACE_PROMPT }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(FACE_SCHEMA) },
    example: FACE_EXAMPLE,
  });
  return parseFace(json);
}

export async function analyzeItemGemini(apiKey, model, kind, photoDataURL) {
  const ai = ITEM_AI[kind];
  const json = await send(apiKey, model, {
    system_instruction: { parts: [{ text: ai.system }] },
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: photoDataURL.split(',')[1] } }, { text: ai.prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(ai.schema) },
    example: ai.example,
  });
  return parseItem(kind, json);
}

export function analyzeTriggersGemini(apiKey, model, prompt) {
  return send(apiKey, model, {
    system_instruction: { parts: [{ text: TRIGGER_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
}
