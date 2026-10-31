// 參考台灣食品過敏原標示規定的常見過敏原
export const ALLERGENS = ['甲殼類', '軟體動物', '魚類', '芒果', '花生', '堅果', '芝麻', '乳製品', '蛋', '含麩質穀物', '大豆', '亞硫酸鹽'];
// 文獻上較常被討論與痘痘相關的飲食類型
export const ACNE_TAGS = ['乳製品', '高升糖', '高糖', '油炸油膩', '辛辣', '酒精', '巧克力', '乳清蛋白', '加工食品'];
export const FACE_AREAS = ['額頭', '鼻子', '左臉頰', '右臉頰', '下巴', '嘴周', '髮際線'];
export const ACNE_KINDS = ['閉鎖粉刺', '黑頭粉刺', '紅腫痘', '膿皰', '囊腫痘'];
export const SEVERITIES = ['無', '輕微', '中等', '嚴重'];
export const MEAL_TYPES = ['早餐', '午餐', '晚餐', '點心'];
export const PERIODS = ['早上', '晚上'];
export const CATEGORIES = ['洗面乳', '卸妝', '化妝水', '精華液', '乳液', '乳霜', '防曬', '面膜', '彩妝', '其他'];

// 常被列為可能致粉刺（comedogenic）的成分：[關鍵字, 顯示名稱]
export const COMEDOGENIC = [
  ['椰子油', '椰子油'], ['coconut oil', '椰子油'], ['cocos nucifera', '椰子油'],
  ['肉豆蔻酸異丙酯', '肉豆蔻酸異丙酯'], ['isopropyl myristate', '肉豆蔻酸異丙酯'],
  ['棕櫚酸異丙酯', '棕櫚酸異丙酯'], ['isopropyl palmitate', '棕櫚酸異丙酯'],
  ['乙醯化羊毛脂', '乙醯化羊毛脂'], ['acetylated lanolin', '乙醯化羊毛脂'],
  ['羊毛脂', '羊毛脂'], ['lanolin', '羊毛脂'],
  ['可可脂', '可可脂'], ['cocoa butter', '可可脂'], ['theobroma cacao', '可可脂'],
  ['小麥胚芽油', '小麥胚芽油'], ['wheat germ oil', '小麥胚芽油'],
  ['鹿角菜', '鹿角菜膠'], ['carrageenan', '鹿角菜膠'],
  ['海藻萃取', '海藻萃取'], ['algae extract', '海藻萃取'],
  ['肉豆蔻酸肉豆蔻酯', '肉豆蔻酸肉豆蔻酯'], ['myristyl myristate', '肉豆蔻酸肉豆蔻酯'],
  ['laureth-4', 'Laureth-4'], ['oleth-3', 'Oleth-3'],
  ['月桂酸', '月桂酸'], ['lauric acid', '月桂酸'],
  ['亞麻籽油', '亞麻籽油'], ['linseed oil', '亞麻籽油'],
];

export function guessMealType(time) {
  const h = Number(time.slice(0, 2));
  if (h >= 4 && h < 10) return '早餐';
  if (h >= 10 && h < 14) return '午餐';
  if (h >= 17 && h < 22) return '晚餐';
  return '點心';
}
