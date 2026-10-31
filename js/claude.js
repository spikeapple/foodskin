// 直接從瀏覽器呼叫 Claude Messages API（每位使用者用自己的 API Key）
import { ALLERGENS, ACNE_TAGS, FACE_AREAS, ACNE_KINDS } from './vocab.js';

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
3. 其他可能的干擾因素（備註中的作息、生理期、壓力等）。
4. 接下來兩週可以怎麼驗證（例如一次只停一樣食物或產品）。
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

/** 照片（JPEG dataURL，可為 null）＋文字補充 → 食物清單 */
export async function analyzeMeal(apiKey, photoDataURL, hint) {
  const content = [];
  if (photoDataURL) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: photoDataURL.split(',')[1] },
    });
  }
  content.push({ type: 'text', text: mealPrompt(photoDataURL, hint) });

  const json = await send(apiKey, {
    model: MODEL,
    max_tokens: 16000,
    system: MEAL_SYSTEM,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: MEAL_SCHEMA } },
  });
  return parseMeal(json);
}

export function mealPrompt(photoDataURL, hint) {
  let text = '請分析這一餐。';
  if (hint.trim()) text += `\n使用者補充說明：${hint.trim()}`;
  if (!photoDataURL) text += '\n（沒有照片，請依文字描述估算）';
  return text;
}

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

export async function analyzeFace(apiKey, photoDataURL) {
  const json = await send(apiKey, {
    model: MODEL,
    max_tokens: 16000,
    system: FACE_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoDataURL.split(',')[1] } },
        { type: 'text', text: FACE_PROMPT },
      ],
    }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: FACE_SCHEMA } },
  });
  return parseFace(json);
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
