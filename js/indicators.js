/**
 * indicators.js — ตัวชี้วัดที่กติกาใช้จริง (pure functions)
 *
 * เหลือแค่ EMA กับ ATR เพราะกติกาใหม่ใช้แค่สองตัวนี้
 * ระบบเก่ามีตัวชี้วัด 12 ตัวที่วัดเรื่องเดียวกันซ้ำ ๆ (RSI, MACD, Stochastic ต่างก็วัดโมเมนตัม)
 * บวกกันแล้วไม่ได้หลักฐานเพิ่ม ได้แต่นับเรื่องเดิมหลายรอบ — วัดบนทองจริงแล้วคะแนนสูงไม่ได้ชนะมากกว่า
 *
 * กติกาสำคัญ: ค่าที่ index i คำนวณจากข้อมูล 0..i เท่านั้น (ไม่มองอนาคต)
 * ผลลัพธ์ยาวเท่าอินพุตเสมอ ช่วงอุ่นเครื่องเป็น null
 */

export const nz = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? d : v);

/** EMA เริ่มจากค่าเฉลี่ยธรรมดาของ period ตัวแรก แล้วไล่ด้วยตัวคูณ 2/(n+1) */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder smoothing (RMA) — ฐานของ ATR */
export function rma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += nz(values[i]);
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + nz(values[i])) / period;
    out[i] = prev;
  }
  return out;
}

/** ช่วงราคาจริงของแท่ง — นับรวมช่องว่างจากราคาปิดของแท่งก่อนหน้าด้วย */
export function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
}

/** ATR (Wilder) — ใช้วางระยะตัดขาดทุนตามความผันผวนจริงของตลาดตอนนั้น */
export function atr(candles, period = 14) {
  return rma(trueRange(candles), period);
}
