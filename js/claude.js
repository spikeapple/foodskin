// 直接從瀏覽器呼叫 Claude Messages API（每位使用者用自己的 API Key）
import { ALLERGENS, ACNE_TAGS, FACE_AREAS, ACNE_KINDS, CATEGORIES } from './vocab.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5-5';

export const MEAL_SYSTEM = `你是營養師助理，協助使用者記錄飲食。請辨識照片（或文字描述）中的每一樣食物與飲料，並：
1. 以台灣常見份量粗估每一項的熱量（kcal，整數）。看不清楚份量時以一般一人份估算，並在 portion 寫出你假設的份量。
2. 標出每一項可能含有的過敏原，只能從清單中選：${ALLERGENS.join('、')}。醬料、勾芡、炸粉等隱藏成分也要考慮。
3. 標出可能與痘痘相關的飲食類型，只能從清單中選：${ACNE_TAGS.join('、')}。
4. summary 用一到兩句繁體中文總結這一餐（總熱量、營養是否均衡、需要留意的地方）。若照片不是食物或無法辨識，foods 回傳空陣列並在 summary 說明。
所有文字使用繁體中文。`;

export const TRIGGER_SYSTEM = `你是飲食與保養紀錄的分析助理。使用者會提供一段期間內每天的飲食、保養品使用與臉部痘痘紀錄，以及 App 本地統計的初步結果。
請用繁體中文、條列清楚地回答：
1. 最可能誘發痘痘的飲食（說明依據：出現在爆痘前幾天、出現頻率、與無痘日的差異）。
2. 保養品是否可能是原因（新產品開始使用的時間、可能致粉刺成分、使用與爆痘的時間關係）。
3. 保健食品是否可能有關（例如乳清蛋白、維生素 B12、碘、DHEA 等常被討論的成分，以及開始服用的時間）。若沒有保健食品紀錄就略過。
4. 其他可能的干擾因素（備註中的作息、生理期、壓力等）。
5. 接下來兩週可以怎麼驗證（例如一次只停一樣食物或產品）。
資料量少時請直接說明推論可信度有限。你不是醫師，不做醫療診斷；若痘痘嚴重、反覆發炎或疼痛，請建議就醫。
不要使用 Markdown 標題或表格，用簡單的條列即可。`;

export const MEAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['foods', 'summary'],
  properties: {
    foods: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'portion', 'calories', 'allergens', 'acne_tags'],
        properties: {
          name: { type: 'string' },
          portion: { type: 'string' },
          calories: { type: 'integer' },
          allergens: { type: 'array', items: { type: 'string', enum: ALLERGENS } },
          acne_tags: { type: 'array', items: { type: 'string', enum: ACNE_TAGS } },
        },
      },
    },
    summary: { type: 'string' },
  },
};

export const FACE_SYSTEM = `你是肌膚紀錄助理（不是醫師），協助使用者用自拍記錄每天的痘痘狀況，方便日後比較。請客觀觀察照片中的臉部：
1. severity：0＝看不到痘痘、1＝輕微（零星幾顆）、2＝中等（多處或有發炎）、3＝嚴重（大範圍、明顯紅腫或囊腫）。
2. areas：有痘痘的部位，只能從清單中選：${FACE_AREAS.join('、')}。
3. kinds：看得出的痘痘類型，只能從清單中選：${ACNE_KINDS.join('、')}。
4. summary：用一到兩句繁體中文描述（大約數量、位置、發炎程度、與膚色泛紅等）。光線、角度、遮擋或解析度不足而無法判斷時，請直接說明。
不要評論長相，不做醫療診斷。`;

export const FACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'areas', 'kinds', 'summary'],
  properties: {
    severity: { type: 'integer', enum: [0, 1, 2, 3] },
    areas: { type: 'array', items: { type: 'string', enum: FACE_AREAS } },
    kinds: { type: 'array', items: { type: 'string', enum: ACNE_KINDS } },
    summary: { type: 'string' },
  },
};

export const FACE_PROMPT = '請記錄這張自拍中的痘痘狀況。';

/** AI 回傳的 JSON 文字 → { severity, areas, kinds, summary }（Claude 與 Gemini 共用） */
export function parseFace(json) {
  let p;
  try { p = JSON.parse(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1)); } catch { throw new Error('無法解析 AI 回傳的資料，請再試一次。'); }
  return {
    severity: Math.min(3, Math.max(0, Math.round(Number(p.severity) || 0))),
    areas: (p.areas || []).filter((a) => FACE_AREAS.includes(a)),
    kinds: (p.kinds || []).filter((k) => ACNE_KINDS.includes(k)),
    summary: p.summary || '',
  };
}

// ---------- 拍包裝辨識：保養品與保健食品共用一套流程 ----------
const RISKS = ['低', '中', '高', '無法判斷'];
const itemSchema = (extra) => ({
  type: 'object',
  additionalProperties: false,
  required: ['name', 'brand', ...Object.keys(extra), 'ingredients', 'acne_risk', 'flags', 'summary'],
  properties: {
    name: { type: 'string' },
    brand: { type: 'string' },
    ...extra,
    ingredients: { type: 'string' },
    acne_risk: { type: 'string', enum: RISKS },
    flags: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
});

export const ITEM_AI = {
  product: {
    system: `你是保養品成分分析助理，協助使用者建立保養品清單。照片是保養品的包裝、瓶身或成分標示。請：
1. 辨識產品名稱（name）與品牌（brand），看不出來就回空字串。
2. category 只能從清單中選：${CATEGORIES.join('、')}。
3. ingredients：照片上看得到的全成分，照原文抄寫（中文或英文都可，用逗號分隔）；看不到成分表就回空字串，不要自己編造。
4. acne_risk：以看得到的成分評估「對容易長痘的肌膚」的風險；沒有成分資訊時回「無法判斷」。
5. flags：可能致粉刺、致痘或容易刺激的成分名稱（例如椰子油、肉豆蔻酸異丙酯、羊毛脂、高濃度酒精、香精），沒有就回空陣列。
6. summary：一到兩句繁體中文說明這個產品的用途與對痘痘肌需要留意的地方。
不做醫療診斷。所有文字使用繁體中文（成分可保留原文）。`,
    schema: itemSchema({ category: { type: 'string', enum: CATEGORIES } }),
    example: '{"name":"產品名稱","brand":"品牌","category":"類別","ingredients":"成分","acne_risk":"低/中/高/無法判斷","flags":["…"],"summary":"說明"}',
    prompt: '請辨識這個保養品並分析成分。',
  },
  supplement: {
    system: `你是保健食品成分分析助理，協助使用者建立保健食品清單。照片是保健食品的包裝、瓶身或營養標示。請：
1. 辨識產品名稱（name）與品牌（brand），看不出來就回空字串。
2. dosage：包裝上的建議用法用量（例如「每日 1 顆，飯後」），看不到就回空字串。
3. ingredients：主要成分與每份含量，照包裝抄寫；看不到就回空字串，不要自己編造。
4. acne_risk：評估與痘痘的可能關聯；常被討論的有乳清蛋白、維生素 B12、碘（含海藻）、DHEA 或荷爾蒙相關成分、高劑量生物素等。沒有成分資訊時回「無法判斷」。
5. flags：可能與痘痘有關或需要留意的成分名稱，以及常見過敏原（${ALLERGENS.join('、')}），沒有就回空陣列。
6. summary：一到兩句繁體中文說明這個產品的主要用途與需要留意的地方。
不做醫療診斷，不建議停藥或加量；有服用藥物或特殊狀況時提醒詢問醫師或藥師。所有文字使用繁體中文。`,
    schema: itemSchema({ dosage: { type: 'string' } }),
    example: '{"name":"產品名稱","brand":"品牌","dosage":"用法用量","ingredients":"成分","acne_risk":"低/中/高/無法判斷","flags":["…"],"summary":"說明"}',
    prompt: '請辨識這個保健食品並分析成分。',
  },
};

/** AI 回傳的 JSON 文字 → 產品欄位（Claude 與 Gemini 共用） */
export function parseItem(kind, json) {
  let p;
  try { p = JSON.parse(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1)); } catch { throw new Error('無法解析 AI 回傳的資料，請再試一次。'); }
  const out = {
    name: (p.name || '').trim(),
    brand: (p.brand || '').trim(),
    ingredients: (p.ingredients || '').trim(),
    risk: RISKS.includes(p.acne_risk) ? p.acne_risk : '無法判斷',
    flags: Array.isArray(p.flags) ? p.flags.filter(Boolean) : [],
    summary: p.summary || '',
  };
  if (kind === 'product') out.category = CATEGORIES.includes(p.category) ? p.category : '';
  else out.dosage = (p.dosage || '').trim();
  return out;
}

async function send(apiKey, body) {
  if (!apiKey) throw new Error('尚未設定 Claude API Key，請按右上角 ⚙︎ 輸入。');
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2026-10-21',
        // 伺服器端備援：模型拒絕時自動改由其他模型處理
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        // 允許從瀏覽器直接呼叫（金鑰只存在使用者自己的手機）
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ ...body, fallbacks: 'default' }),
    });
  } catch {
    throw new Error('無法連線到 Claude，請確認網路。');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    if (res.status === 401) throw new Error('API Key 無效，請到設定重新輸入。');
    if (res.status === 429) throw new Error('請求太頻繁或額度不足，請稍後再試。');
    throw new Error(`Claude API 錯誤（${res.status}）：${msg}`);
  }
  if (data.stop_reason === 'refusal') throw new Error('AI 拒絕處理此請求，請換一張照片或改用文字描述。');
  // 回應內可能含 thinking 區塊，只取 text 區塊
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text) throw new Error('AI 沒有回傳內容，請稍後再試。');
  return text;
}

const imageBlocks = (photos) => photos.map((p) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.split(',')[1] } }));

/** 照片（JPEG dataURL 陣列，可為空）＋文字補充 → 食物清單 */
export async function analyzeMeal(apiKey, photos, hint) {
  const content = [...imageBlocks(photos), { type: 'text', text: mealPrompt(photos.length, hint) }];

  const json = await send(apiKey, {
    model: MODEL,
    max_tokens: 16000,
    system: MEAL_SYSTEM,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: MEAL_SCHEMA } },
  });
  return parseMeal(json);
}

export function mealPrompt(photoCount, hint) {
  let text = '請分析這一餐。';
  if (photoCount > 1) text += `\n共 ${photoCount} 張照片，可能是同一餐的不同角度或不同的菜，同一樣食物不要重複計算。`;
  if (hint.trim()) text += `\n使用者補充說明：${hint.trim()}`;
  if (!photoCount) text += '\n（沒有照片，請依文字描述估算）';
  return text;
}

/** 多張包裝照片時提示 AI 綜合判讀（例如正面包裝＋背面成分表） */
export const multiPhotoNote = (n) => (n > 1 ? `\n共 ${n} 張照片，是同一個產品的不同面（例如正面包裝與背面成分表），請綜合所有照片判讀。` : '');

/** 把 AI 回傳的 JSON 文字轉成 App 的餐點格式（Claude 與 Gemini 共用） */
export function parseMeal(json) {
  let parsed;
  // 沒有強制格式時，模型可能用 ```json 包起來，只取第一個 { 到最後一個 }
  const body = json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1);
  try { parsed = JSON.parse(body); } catch { throw new Error('無法解析 AI 回傳的資料，請再試一次。'); }
  return {
    summary: parsed.summary || '',
    items: (parsed.foods || []).map((f) => ({
      name: f.name,
      portion: f.portion || '',
      calories: Math.max(0, Math.round(f.calories || 0)),
      allergens: f.allergens || [],
      acneTags: f.acne_tags || [],
    })),
  };
}

export const facePrompt = (n) => FACE_PROMPT + (n > 1 ? `\n共 ${n} 張照片，是同一天臉部的不同角度，請綜合判讀，同一顆痘痘不要重複計算。` : '');

export async function analyzeFace(apiKey, photos) {
  const json = await send(apiKey, {
    model: MODEL,
    max_tokens: 16000,
    system: FACE_SYSTEM,
    messages: [{ role: 'user', content: [...imageBlocks(photos), { type: 'text', text: facePrompt(photos.length) }] }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: FACE_SCHEMA } },
  });
  return parseFace(json);
}

export async function analyzeItem(apiKey, kind, photos) {
  const ai = ITEM_AI[kind];
  const json = await send(apiKey, {
    model: MODEL,
    max_tokens: 16000,
    system: ai.system,
    messages: [{ role: 'user', content: [...imageBlocks(photos), { type: 'text', text: ai.prompt + multiPhotoNote(photos.length) }] }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: ai.schema } },
  });
  return parseItem(kind, json);
}

export function analyzeTriggers(apiKey, prompt) {
  return send(apiKey, {
    model: MODEL,
    max_tokens: 16000,
    system: TRIGGER_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: 'medium' },
  });
}
