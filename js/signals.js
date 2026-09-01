/**
 * signals.js — เครื่องยนต์วิเคราะห์สัญญาณซื้อ/ขาย (Confluence Engine)
 *
 * แนวคิด: ไม่มีตัวชี้วัดตัวไหนแม่นพอด้วยตัวเอง เราจึงให้ "หลายปัจจัยโหวต"
 * แต่ละปัจจัยคืนค่า side (+1 ซื้อ / -1 ขาย / 0 ไม่ออกเสียง), strength (0-1) และ "เหตุผลภาษาไทย"
 * คะแนนรวม = ผลรวม(น้ำหนัก × ความแรง × ทิศทาง) / น้ำหนักรวม × 100  → ช่วง -100..+100
 *
 * *** สำคัญ: ฟังก์ชัน scoreAt() ใช้ทั้งตอนวิเคราะห์สดและตอน backtest ***
 * ดังนั้น "ความน่าจะเป็น" ที่แสดงบนหน้าจอ จึงเป็นสถิติของกฎชุดเดียวกันจริง ๆ
 */

import * as ta from './indicators.js';
import { detectPatterns } from './patterns.js';
import { findPivots, clusterLevels, nearestLevels, marketStructure, rsiDivergence, nearestRound } from './levels.js';

export const DEFAULT_CFG = {
  emaFast: 20, emaMid: 50, emaSlow: 200,
  rsiPeriod: 14, atrPeriod: 14, adxPeriod: 14,
  bbPeriod: 20, bbMult: 2,
  stochK: 14, stochD: 3, stochSmooth: 3,
  pivotK: 3,
  zoneAtrMult: 0.4,   // ความกว้างของโซนแนวรับ/ต้าน เทียบกับ ATR (แคบ = โซนคมชัดขึ้น)
  slAtrMult: 1.5,
  maxSlAtrMult: 3.0,
  minEntryRR: 1.2,     // ได้:เสีย ต่ำกว่านี้ = ไม่คุ้มเข้า แม้สัญญาณจะยังดี
  /*
   * เป้าหมายต่ำสุดที่ยอมให้ระบบเลือกได้ (เท่าของความเสี่ยง)
   *
   * ทำไมต้องมี: ตัวหาค่าที่ดีที่สุดจะเลือกเป้าที่ "ค่าคาดหวังสูงสุด" ซึ่งมักได้เป้าเตี้ย ๆ
   * เพราะเป้าเตี้ยแตะง่าย อัตราชนะเลยสูง ตัวเลขบนกระดาษจึงสวย
   *
   * แต่การเสี่ยง 1 เพื่อได้ 0.75 แปลว่าต้องชนะเกิน 57% ถึงจะเสมอตัว
   * พลาดแค่ไม่กี่ไม้ กำไรที่สะสมมาทั้งวันก็หายหมด — ไม่ทนต่อความผิดพลาด
   *
   * ที่ 1R ต้องชนะเกิน 50% ซึ่งเป็นเส้นแบ่งที่มีความหมายจริง:
   * ชนะหนึ่งไม้ลบล้างการแพ้หนึ่งไม้ได้พอดี
   */
  minTargetR: 1.0,
  threshold: 35,       // คะแนนขั้นต่ำที่ถือว่าเป็นสัญญาณ
  adxTrendMin: 22,     // ADX เกินนี้ = โหมดเทรนด์, ต่ำกว่า = โหมดกรอบ
  /*
   * ขนาดไม้ที่โบรกเกอร์ยอมให้ส่งจริง
   *
   * ทำไมต้องมี: สูตรคำนวณขนาดไม้ให้ทศนิยมละเอียดเท่าไรก็ได้ แต่โบรกเกอร์รับเป็นขั้น
   * ขั้นต่ำสุดที่พบทั่วไปคือ 0.01 ล็อต (= ทอง 1 ออนซ์) การบอกให้เทรด 0.0078 ล็อต
   * จึงเป็นตัวเลขที่ส่งคำสั่งไม่ได้ และถ้าผู้ใช้ปัดขึ้นเป็น 0.01 เอง
   * ความเสี่ยงจริงจะโตกว่าที่ตั้งใจไว้โดยไม่มีใครบอก
   */
  lotStep: 0.01,       // ขั้นของขนาดไม้ที่โบรกเกอร์รับ
  minLot: 0.01,        // ไม้เล็กที่สุดที่ส่งคำสั่งได้
  minAtrPct: 0.02,     // ผันผวนต่ำกว่านี้ = ตลาดตาย ไม่คุ้มค่าสเปรด (%)
  maxAtrPct: 1.5,      // ผันผวนสูงกว่านี้ = ข่าวแรง/เสี่ยงเกิน (%)
};

export const WEIGHTS = {
  emaTrend: 16, adxTrend: 12, macdMom: 12, rsiMom: 10, structure: 12,
  patterns: 10, volume: 8, bands: 8, levels: 10, divergence: 10, vwap: 6, stoch: 6,
};
const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

/** คำนวณ series ทั้งหมดรอบเดียว แล้ว scoreAt() แค่อ่านค่าที่ index i (เร็วและไม่มี look-ahead) */
export function buildContext(candles, cfg = DEFAULT_CFG) {
  const close = candles.map((c) => c.c);
  const vol = candles.map((c) => c.v);
  const macdRes = ta.macd(close, 12, 26, 9);
  const bb = ta.bollinger(close, cfg.bbPeriod, cfg.bbMult);
  const adxRes = ta.adx(candles, cfg.adxPeriod);
  const stochRes = ta.stochastic(candles, cfg.stochK, cfg.stochD, cfg.stochSmooth);
  const atrSeries = ta.atr(candles, cfg.atrPeriod);
  const pivots = findPivots(candles, cfg.pivotK);
  // แนวรับ/ต้านใช้ swing ที่ "ใหญ่กว่า" (มองซ้าย-ขวากว้างขึ้น) เพื่อให้ได้แนวที่มีนัยจริง
  // ส่วน pivot ชุดปกติยังใช้สำหรับวาง SL และอ่านโครงสร้างตลาด
  const majorPivots = findPivots(candles, cfg.pivotK + 3);
  // ใช้ ATR ช่วง 200 แท่งแรกกำหนดความกว้างของโซน (จำนวนคงที่ ไม่ใช่สัดส่วน)
  // เพื่อให้ค่านี้ไม่ขึ้นกับความยาวข้อมูล และไม่ดึงข้อมูลอนาคตเข้ามาเป็นพารามิเตอร์
  const warm = atrSeries.slice(0, 200).filter((v) => v !== null);
  const medianAtr = median(warm.length ? warm : atrSeries.filter((v) => v !== null)) || (close[close.length - 1] * 0.002);

  return {
    cfg, candles, close, vol,
    ema20: ta.ema(close, cfg.emaFast),
    ema50: ta.ema(close, cfg.emaMid),
    ema200: ta.ema(close, cfg.emaSlow),
    rsi: ta.rsi(close, cfg.rsiPeriod),
    macd: macdRes,
    bb,
    bbWidthLow: rollingMin(bb.width, 20),
    adx: adxRes,
    stoch: stochRes,
    atr: atrSeries,
    volSma: ta.sma(vol, 20),
    obv: ta.obv(candles),
    obvSlope: ta.slopePct(ta.obv(candles), 5),
    vwap: ta.vwapDaily(candles),
    pivots,
    zones: clusterLevels(majorPivots, medianAtr * (cfg.zoneAtrMult || 0.4)),
    majorPivots,
    ema50Slope: ta.slopePct(ta.ema(close, cfg.emaMid), 5),
  };
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function rollingMin(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity, ok = false;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] === null) continue;
      ok = true;
      if (values[j] < m) m = values[j];
    }
    out[i] = ok ? m : null;
  }
  return out;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * ปริมาณซื้อขายของ "แท่งที่ยังไม่ปิด" เอาไปเทียบกับค่าเฉลี่ยของแท่งที่ปิดแล้วตรง ๆ ไม่ได้
 * เพราะแท่งที่เพิ่งเปิดมีเวลาสะสมปริมาณน้อยกว่ามาก (ต้นแท่งจะดู "เบาผิดปกติ" เสมอ)
 * จึงต้องเทียบบัญญัติไตรยางศ์เป็น "ถ้าแท่งนี้ปิด จะมีปริมาณประมาณเท่าไร" ก่อน
 *
 * ใช้เฉพาะกับแท่งที่ closed === false เท่านั้น backtest จึงยังคงให้ผลเดิมทุกครั้ง
 */
export function projectedVolume(candles, i, now = Date.now()) {
  const c = candles[i];
  if (!c || c.closed !== false || i === 0) return { v: c ? c.v : 0, partial: false, frac: 1 };
  const step = c.t - candles[i - 1].t;
  if (!(step > 0)) return { v: c.v, partial: false, frac: 1 };
  const elapsed = Math.min(step, Math.max(1, now - c.t));
  const frac = Math.max(0.08, elapsed / step);
  return { v: c.v / frac, partial: true, frac };
}

/**
 * ให้คะแนนที่แท่ง i (ใช้ข้อมูล 0..i เท่านั้น)
 * @returns {{score:number, side:number, factors:Array, regime:string, atrPct:number}}
 */
export function scoreAt(ctx, i) {
  const { cfg, candles } = ctx;
  // น้ำหนักปรับได้ผ่าน cfg เพื่อให้ทดลองน้ำหนักที่เรียนรู้จากข้อมูลแล้ววัดผลเทียบกันได้
  const W = cfg.weights || WEIGHTS;
  const c = candles[i];
  const price = c.c;
  const atrVal = ctx.atr[i];
  const factors = [];
  if (atrVal === null || ctx.ema50[i] === null) {
    return { score: 0, side: 0, factors, regime: 'warmup', atrPct: 0, ready: false };
  }
  const atrPct = (atrVal / price) * 100;
  const adxVal = ctx.adx.adx[i];
  const regime = adxVal !== null && adxVal >= cfg.adxTrendMin ? 'trend' : 'range';

  const push = (key, name, side, strength, reason, extra = {}) => {
    if (!side || strength <= 0) return;
    factors.push({
      key, name, side, strength: clamp(strength, 0, 1), weight: W[key],
      contribution: W[key] * clamp(strength, 0, 1) * side, reason, ...extra,
    });
  };

  // ── 1) แนวโน้มจากการเรียงตัวของเส้นค่าเฉลี่ย ────────────────────────────
  const e20 = ctx.ema20[i], e50 = ctx.ema50[i], e200 = ctx.ema200[i];
  if (e20 !== null && e50 !== null) {
    const full = e200 !== null;
    if (price > e20 && e20 > e50 && (!full || e50 > e200)) {
      push('emaTrend', 'EMA Alignment', 1, full && e50 > e200 ? 1 : 0.7,
        `ราคา (${price.toFixed(2)}) ยืนเหนือ EMA20 (${e20.toFixed(2)}) > EMA50 (${e50.toFixed(2)})${full && e50 > e200 ? ` > EMA200 (${e200.toFixed(2)}) เรียงตัวสมบูรณ์` : ''} = ผู้ซื้อคุมเกมทุกกรอบเวลา`);
    } else if (price < e20 && e20 < e50 && (!full || e50 < e200)) {
      push('emaTrend', 'EMA Alignment', -1, full && e50 < e200 ? 1 : 0.7,
        `ราคา (${price.toFixed(2)}) หลุดใต้ EMA20 (${e20.toFixed(2)}) < EMA50 (${e50.toFixed(2)})${full && e50 < e200 ? ` < EMA200 (${e200.toFixed(2)}) เรียงตัวสมบูรณ์` : ''} = ผู้ขายคุมเกมทุกกรอบเวลา`);
    } else if (price > e50 && ctx.ema50Slope[i] > 0) {
      push('emaTrend', 'EMA Alignment', 1, 0.35, `ราคายืนเหนือ EMA50 และ EMA50 ยังชี้ขึ้น = เทรนด์ขาขึ้นระยะกลางยังไม่เสีย แต่ระยะสั้นยังไม่เรียงตัว`);
    } else if (price < e50 && ctx.ema50Slope[i] < 0) {
      push('emaTrend', 'EMA Alignment', -1, 0.35, `ราคาอยู่ใต้ EMA50 และ EMA50 ชี้ลง = เทรนด์ขาลงระยะกลางยังคุมอยู่`);
    }
  }

  // ── 2) ความแรงของเทรนด์ (ADX/DI) ────────────────────────────────────────
  const pDI = ctx.adx.plusDI[i], mDI = ctx.adx.minusDI[i];
  if (adxVal !== null && pDI !== null) {
    if (adxVal >= cfg.adxTrendMin) {
      const s = clamp((adxVal - 18) / 27, 0.2, 1);
      if (pDI > mDI) push('adxTrend', 'ADX / DI', 1, s, `ความแรงของแนวโน้ม (ADX) = ${adxVal.toFixed(1)} เกินเกณฑ์ ${cfg.adxTrendMin} แปลว่าตลาดมีทิศทางจริง ไม่ได้ออกข้าง · วัดแรงสองฝั่งแล้ว ฝั่งซื้อ ${pDI.toFixed(1)} มากกว่าฝั่งขาย ${mDI.toFixed(1)} = ผู้ซื้อกำลังคุมเกม`);
      else push('adxTrend', 'ADX / DI', -1, s, `ความแรงของแนวโน้ม (ADX) = ${adxVal.toFixed(1)} เกินเกณฑ์ ${cfg.adxTrendMin} แปลว่าตลาดมีทิศทางจริง ไม่ได้ออกข้าง · วัดแรงสองฝั่งแล้ว ฝั่งขาย ${mDI.toFixed(1)} มากกว่าฝั่งซื้อ ${pDI.toFixed(1)} = ผู้ขายกำลังคุมเกม`);
    }
  }

  // ── 3) โมเมนตัม MACD ────────────────────────────────────────────────────
  const h = ctx.macd.hist[i], hPrev = ctx.macd.hist[i - 1];
  if (h !== null && hPrev !== null) {
    const norm = clamp(Math.abs(h) / (atrVal * 0.6), 0, 1);
    const rising = h > hPrev;
    if (h > 0 && rising) push('macdMom', 'MACD', 1, Math.max(0.45, norm), `แรงส่งของราคา (MACD) เป็นบวกและกำลังเพิ่มขึ้น (${hPrev.toFixed(2)} → ${h.toFixed(2)}) = โมเมนตัมขาขึ้นกำลังเร่ง`);
    else if (h < 0 && !rising) push('macdMom', 'MACD', -1, Math.max(0.45, norm), `แรงส่งของราคา (MACD) เป็นลบและกำลังเพิ่มขึ้น (${hPrev.toFixed(2)} → ${h.toFixed(2)}) = โมเมนตัมขาลงกำลังเร่ง`);
    else if (h > 0 && !rising) push('macdMom', 'MACD', 1, 0.2, `แรงส่งของราคายังเป็นบวกแต่เริ่มลดลง = ขาขึ้นยังอยู่ แต่แรงส่งเริ่มแผ่ว ระวังพักฐาน`);
    else if (h < 0 && rising) push('macdMom', 'MACD', -1, 0.2, `แรงส่งของราคายังเป็นลบแต่เริ่มลดลง = ขาลงยังอยู่ แต่แรงขายเริ่มลด ระวังเด้ง`);
    if (hPrev <= 0 && h > 0) push('macdMom', 'MACD Cross', 1, 0.9, 'เส้นแรงส่ง (MACD) ตัดขึ้นเหนือเส้นสัญญาณในแท่งนี้ = จุดที่แรงซื้อเริ่มชนะ');
    if (hPrev >= 0 && h < 0) push('macdMom', 'MACD Cross', -1, 0.9, 'เส้นแรงส่ง (MACD) ตัดลงใต้เส้นสัญญาณในแท่งนี้ = จุดที่แรงขายเริ่มชนะ');
  }

  // ── 4) RSI (ตีความตาม regime) ───────────────────────────────────────────
  const r = ctx.rsi[i];
  if (r !== null) {
    if (regime === 'trend') {
      if (r > 55 && r < 78) push('rsiMom', 'RSI Momentum', 1, clamp((r - 50) / 25, 0, 1), `มาตรวัดแรงซื้อ-แรงขาย (RSI) = ${r.toFixed(1)} อยู่ในโซนที่ฝั่งซื้อแข็งแรง (55-78) ขณะตลาดมีแนวโน้มชัด = ไปต่อได้ ไม่ใช่สัญญาณขาย`);
      else if (r < 45 && r > 22) push('rsiMom', 'RSI Momentum', -1, clamp((50 - r) / 25, 0, 1), `มาตรวัดแรงซื้อ-แรงขาย (RSI) = ${r.toFixed(1)} อยู่ในโซนอ่อนแรง (22-45) ขณะตลาดมีแนวโน้มชัด = แรงขายยังคุม`);
      else if (r >= 78) push('rsiMom', 'RSI Overheat', -1, 0.3, `มาตรวัดแรงซื้อ-แรงขาย (RSI) = ${r.toFixed(1)} ร้อนแรงเกินไป เสี่ยงย่อพักตัว ไม่ควรไล่ราคาซื้อตรงนี้`);
      else if (r <= 22) push('rsiMom', 'RSI Oversold', 1, 0.3, `มาตรวัดแรงซื้อ-แรงขาย (RSI) = ${r.toFixed(1)} ถูกเทขายมากเกินไป เสี่ยงเด้งกลับ ไม่ควรไล่ขายตรงนี้`);
    } else {
      if (r < 32) push('rsiMom', 'RSI Mean-Revert', 1, clamp((32 - r) / 20, 0.3, 1), `ตลาดออกข้าง (ADX ${adxVal ? adxVal.toFixed(1) : '-'}) + มาตรวัดแรงซื้อ-แรงขาย (RSI) = ${r.toFixed(1)} ต่ำกว่า 32 = ราคาถูกกดลงเกินไป สถิติมักเด้งกลับเข้าค่ากลาง`);
      else if (r > 68) push('rsiMom', 'RSI Mean-Revert', -1, clamp((r - 68) / 20, 0.3, 1), `ตลาดออกข้าง (ADX ${adxVal ? adxVal.toFixed(1) : '-'}) + มาตรวัดแรงซื้อ-แรงขาย (RSI) = ${r.toFixed(1)} สูงกว่า 68 = ราคาถูกดันขึ้นเกินไป สถิติมักย่อกลับ`);
    }
  }

  // ── 5) โครงสร้างตลาด (Swing HH/HL) ──────────────────────────────────────
  const ms = marketStructure(ctx.pivots, i);
  if (ms.side !== 0) push('structure', 'Market Structure', ms.side, 0.85, `โครงสร้างราคาเป็น${ms.label}: ${ms.detail}`);

  // ── 6) รูปแบบแท่งเทียน ──────────────────────────────────────────────────
  const pats = detectPatterns(candles, i, atrVal);
  const patNet = pats.reduce((a, p) => a + p.side * p.strength, 0);
  if (patNet !== 0) {
    const best = pats.filter((p) => p.side === Math.sign(patNet)).sort((a, b) => b.strength - a.strength)[0];
    push('patterns', `Price Action: ${best.name}`, Math.sign(patNet), clamp(Math.abs(patNet), 0, 1), best.reason);
  }

  // ── 7) ปริมาณการซื้อขายยืนยัน ───────────────────────────────────────────
  const pv = projectedVolume(candles, i);
  if (ctx.volSma[i] && pv.v > 0) {
    const ratio = pv.v / ctx.volSma[i];
    const suffix = pv.partial ? ' (ประมาณการทั้งแท่ง เพราะแท่งนี้ยังไม่ปิด)' : '';
    const dir = Math.sign(c.c - c.o);
    if (ratio > 1.25 && dir !== 0) {
      push('volume', 'Volume Confirm', dir, clamp((ratio - 1) / 1.5, 0.3, 1), `ปริมาณซื้อขายแท่งนี้สูงกว่าค่าเฉลี่ย 20 แท่ง ${ratio.toFixed(2)} เท่า${suffix} และแท่ง${dir > 0 ? 'เป็นบวก' : 'เป็นลบ'} = มีเงินจริงหนุนการเคลื่อนไหว ไม่ใช่การแกว่งลอย ๆ`);
    } else if (ratio < 0.6) {
      factors.push({ key: 'volume', name: 'Volume Warning', side: 0, strength: 0, weight: 0, contribution: 0,
        reason: `ปริมาณซื้อขายเบาบาง (${(ratio * 100).toFixed(0)}% ของค่าเฉลี่ย${suffix}) = การเคลื่อนไหวนี้ขาดแรงยืนยัน ระวังสัญญาณหลอก` });
    }
  }

  // ── 8) Bollinger: บีบตัว-เบรกเอาต์ / ราคาสุดขอบ ─────────────────────────
  const bbU = ctx.bb.upper[i], bbL = ctx.bb.lower[i], pctB = ctx.bb.pctB[i], w = ctx.bb.width[i];
  if (bbU !== null && pctB !== null) {
    const squeeze = ctx.bbWidthLow[i] !== null && w <= ctx.bbWidthLow[i] * 1.08;
    if (squeeze && c.c > bbU) push('bands', 'BB Squeeze Breakout', 1, 0.95, `กรอบความผันผวนบีบแคบที่สุดในรอบ 20 แท่ง แล้วราคาปิดทะลุขอบบน = พลังงานที่สะสมไว้ระเบิดออกฝั่งขึ้น`);
    else if (squeeze && c.c < bbL) push('bands', 'BB Squeeze Breakdown', -1, 0.95, `กรอบความผันผวนบีบแคบที่สุดในรอบ 20 แท่ง แล้วราคาปิดหลุดขอบล่าง = พลังงานที่สะสมไว้ระเบิดออกฝั่งลง`);
    else if (regime === 'range' && pctB <= 0.05) push('bands', 'BB Lower Band', 1, 0.7, `ราคาลงมาแตะขอบล่างของกรอบความผันผวน (Bollinger Band) ในตลาดที่ออกข้าง = สถิติบอกว่าราคามักเด้งกลับเข้ากรอบ`);
    else if (regime === 'range' && pctB >= 0.95) push('bands', 'BB Upper Band', -1, 0.7, `ราคาขึ้นไปแตะขอบบนของกรอบความผันผวน (Bollinger Band) ในตลาดที่ออกข้าง = สถิติบอกว่าราคามักย่อกลับเข้ากรอบ`);
    else if (regime === 'trend' && pctB > 0.75 && pctB < 1.05) push('bands', 'Band Ride', 1, 0.35, `ราคาเกาะครึ่งบนของกรอบความผันผวนไปเรื่อย ๆ = พฤติกรรมเฉพาะของแนวโน้มขาขึ้นที่แข็งแรงจริง`);
    else if (regime === 'trend' && pctB < 0.25 && pctB > -0.05) push('bands', 'Band Ride', -1, 0.35, `ราคาเกาะครึ่งล่างของกรอบความผันผวนไปเรื่อย ๆ = พฤติกรรมเฉพาะของแนวโน้มขาลงที่แข็งแรงจริง`);
  }

  // ── 9) แนวรับ-แนวต้าน ───────────────────────────────────────────────────
  const { support, resistance } = nearestLevels(ctx.zones, price, i);
  if (support && (price - support.price) / atrVal < 0.6 && ms.side >= 0) {
    push('levels', 'Support Test', 1, clamp(support.touches / 4, 0.35, 1),
      `ราคาอยู่ห่างแนวรับ ${support.price.toFixed(2)} เพียง ${((price - support.price) / atrVal).toFixed(2)} เท่าของระยะแกว่งปกติต่อแท่ง และแนวนี้ถูกทดสอบมาแล้ว ${support.touches} ครั้ง = โซนที่มีคำสั่งซื้อรออยู่จริง (ความเสี่ยงต่อไม้ต่ำ เพราะวางจุดตัดขาดทุนใต้แนวนี้ได้ใกล้)`);
  }
  if (resistance && (resistance.price - price) / atrVal < 0.6 && ms.side <= 0) {
    push('levels', 'Resistance Test', -1, clamp(resistance.touches / 4, 0.35, 1),
      `ราคาอยู่ห่างแนวต้าน ${resistance.price.toFixed(2)} เพียง ${((resistance.price - price) / atrVal).toFixed(2)} เท่าของระยะแกว่งปกติต่อแท่ง และแนวนี้ถูกทดสอบมาแล้ว ${resistance.touches} ครั้ง = โซนที่มีคำสั่งขายรออยู่จริง`);
  }
  // เบรกแนวต้าน/หลุดแนวรับด้วยแท่งปิด
  const prevClose = candles[i - 1].c;
  const prevLv = nearestLevels(ctx.zones, prevClose, i - 1);
  if (prevLv.resistance && c.c > prevLv.resistance.price && prevClose <= prevLv.resistance.price) {
    push('levels', 'Resistance Break', 1, 0.85, `แท่งนี้ปิดทะลุแนวต้าน ${prevLv.resistance.price.toFixed(2)} ที่กดราคามา ${prevLv.resistance.touches} ครั้ง = แนวต้านเดิมมีโอกาสกลายเป็นแนวรับใหม่ (role reversal)`);
  }
  if (prevLv.support && c.c < prevLv.support.price && prevClose >= prevLv.support.price) {
    push('levels', 'Support Break', -1, 0.85, `แท่งนี้ปิดหลุดแนวรับ ${prevLv.support.price.toFixed(2)} ที่รับราคามา ${prevLv.support.touches} ครั้ง = แนวรับเดิมมีโอกาสกลายเป็นแนวต้านใหม่`);
  }

  // ── 10) RSI Divergence ──────────────────────────────────────────────────
  const div = rsiDivergence(candles, ctx.rsi, ctx.pivots, i);
  if (div) push('divergence', div.type, div.side, 0.85, div.detail);

  // ── 11) VWAP ────────────────────────────────────────────────────────────
  if (ctx.vwap[i]) {
    const dev = (price - ctx.vwap[i]) / atrVal;
    if (Math.abs(dev) > 0.15) {
      push('vwap', 'VWAP Position', Math.sign(dev), clamp(Math.abs(dev) / 2, 0.2, 1),
        `ราคาอยู่${dev > 0 ? 'เหนือ' : 'ใต้'}ราคาต้นทุนเฉลี่ยของวัน (VWAP ${ctx.vwap[i].toFixed(2)}) อยู่ ${Math.abs(dev).toFixed(2)} ช่วงแกว่ง = ต้นทุนเฉลี่ยของคนที่ถืออยู่${dev > 0 ? 'กำไร ฝั่งซื้อได้เปรียบ' : 'ขาดทุน ฝั่งขายได้เปรียบ'}`);
    }
  }

  // ── 12) Stochastic ──────────────────────────────────────────────────────
  const sk = ctx.stoch.k[i], sd = ctx.stoch.d[i], skP = ctx.stoch.k[i - 1], sdP = ctx.stoch.d[i - 1];
  if (sk !== null && sd !== null && skP !== null && sdP !== null) {
    if (skP <= sdP && sk > sd && sk < 45) push('stoch', 'Stochastic Cross', 1, 0.8, `Stochastic %K ตัดขึ้นเหนือ %D ในโซนต่ำ (${sk.toFixed(0)}) = จังหวะกลับตัวจากการย่อ`);
    else if (skP >= sdP && sk < sd && sk > 55) push('stoch', 'Stochastic Cross', -1, 0.8, `Stochastic %K ตัดลงใต้ %D ในโซนสูง (${sk.toFixed(0)}) = จังหวะกลับตัวจากการเด้ง`);
  }

  // ปัจจัยเดียวกันอาจถูก push หลายครั้ง (เช่น MACD ทั้งทิศทางและจุดตัด)
  // ต้องจำกัดผลรวมของแต่ละปัจจัยไม่ให้เกินน้ำหนักที่กำหนด ไม่งั้นจะเป็นการนับซ้ำ
  const byKey = new Map();
  for (const f of factors) {
    if (!byKey.has(f.key)) byKey.set(f.key, []);
    byKey.get(f.key).push(f);
  }
  for (const [key, list] of byKey) {
    const cap = W[key] || 0;
    const sum = list.reduce((a, f) => a + f.contribution, 0);
    if (cap > 0 && Math.abs(sum) > cap) {
      const scale = cap / Math.abs(sum);
      for (const f of list) { f.contribution *= scale; f.capped = true; }
    }
  }

  const raw = factors.reduce((a, f) => a + f.contribution, 0);
  const totalW = cfg.weights ? Object.values(cfg.weights).reduce((a, b) => a + b, 0) : TOTAL_WEIGHT;
  const score = clamp((raw / (totalW || 1)) * 100, -100, 100);
  return {
    score, side: Math.sign(score), factors, regime, atrPct,
    ready: true, adx: adxVal, rsi: r, atr: atrVal,
    support: support ? support.price : null,
    resistance: resistance ? resistance.price : null,
    structure: ms,
  };
}

/** รวมคะแนนหลายกรอบเวลา — กรอบใหญ่คือ "กระแสน้ำ" กรอบเล็กคือ "จังหวะเข้า" */
export function combineTimeframes(entry, htf1, htf2) {
  const w = [0.55, 0.30, 0.15];
  const parts = [entry, htf1, htf2].map((s) => (s && s.ready ? s.score : 0));
  let total = parts[0] * w[0] + parts[1] * w[1] + parts[2] * w[2];
  const notes = [];
  // ถ้ากรอบเล็กสวนกรอบใหญ่ที่มีเทรนด์แรง → ลดคะแนนลง เพราะสถิติแพ้บ่อย
  if (htf1 && htf1.ready && Math.sign(parts[0]) !== 0 && Math.sign(parts[1]) !== 0 && Math.sign(parts[0]) !== Math.sign(parts[1])) {
    total *= 0.6;
    notes.push('สัญญาณกรอบเล็กสวนทางกรอบใหญ่ — ตัดคะแนนลง 40% เพราะการเทรดสวนเทรนด์หลักมีอัตราชนะต่ำกว่า');
  } else if (htf1 && htf1.ready && Math.sign(parts[0]) === Math.sign(parts[1]) && parts[0] !== 0) {
    notes.push('กรอบเล็กและกรอบใหญ่ไปทางเดียวกัน — เป็นเงื่อนไขที่ทำให้ระยะทางกำไรมักไกลกว่าปกติ');
  }
  return { score: clamp(total, -100, 100), parts, notes };
}

/**
 * สร้างแผนเทรด: จุดเข้า / จุดตัดขาดทุน / เป้าทำกำไร / ขนาดไม้
 * ใช้ ATR เป็นตัวกำหนดระยะ เพราะ SL ต้องกว้างพอที่ "noise ปกติ" จะไม่เขี่ยออก
 */
/**
 * ตัดสินว่าสัญญาณ "ยังอยู่" หรือ "จบแล้ว" โดยมีช่วงหน่วง (hysteresis)
 *
 * ปัญหาที่แก้: ถ้าใช้เส้นเดียวตัดสินทั้งเข้าและออก คะแนนที่แกว่งอยู่รอบ ๆ เกณฑ์
 * จะทำให้แผนเทรดกะพริบเข้าออกทุกไม่กี่วินาที คนใช้เห็นแล้วกดตามไม่ทัน
 * พอจะกดจริงแผนก็หายไปแล้ว ทั้งที่สภาพตลาดแทบไม่ได้เปลี่ยนเลย
 *
 * ทางแก้มาตรฐานคือใช้สองเส้น: เข้ายาก ออกง่ายกว่าเล็กน้อย
 * ต้องถึงเกณฑ์เต็มถึงจะเริ่มสัญญาณ แต่จะยกเลิกก็ต่อเมื่อตกลงไปต่ำกว่า
 * เกณฑ์คูณ releaseFrac ซึ่งทำให้สัญญาณอยู่นานพอให้มนุษย์ตัดสินใจได้
 *
 * ทิศกลับด้านคือเรื่องคนละเรื่อง — ของเดิมจบทันที ไม่มีการหน่วง
 *
 * @param {object|null} prev สถานะรอบก่อน (null = ยังไม่มีสัญญาณค้างอยู่)
 * @param {number} score คะแนนตอนนี้ (บวก = ซื้อ, ลบ = ขาย)
 * @param {number} threshold เกณฑ์เริ่มสัญญาณ
 */
export function holdSignal(prev, score, threshold, opts = {}) {
  const releaseFrac = opts.releaseFrac === undefined ? 0.75 : opts.releaseFrac;
  const now = opts.now === undefined ? Date.now() : opts.now;
  const side = Math.sign(score);
  const abs = Math.abs(score);
  const start = () => (abs >= threshold ? { side, startedAt: now, peak: abs, held: false } : null);

  if (!prev || !prev.side) return start();
  if (side !== 0 && side !== prev.side) return start();   // กลับทิศ = สัญญาณใหม่
  if (abs >= threshold * releaseFrac) {
    return { side: prev.side, startedAt: prev.startedAt, peak: Math.max(prev.peak, abs),
      held: abs < threshold };   // held = อยู่ได้เพราะช่วงหน่วง ไม่ใช่เพราะแรงพอ
  }
  return null;
}

export function buildSetup(ctx, i, scored, opts = {}) {
  const cfg = ctx.cfg;
  const {
    account = 1000, riskPct = 1, contractSize = 100, // XAU/USD 1 lot = 100 ออนซ์
    lotStep = cfg.lotStep === undefined ? 0.01 : cfg.lotStep,
    minLot = cfg.minLot === undefined ? 0.01 : cfg.minLot,
    slPrice = null,        // ผู้ใช้กำหนดจุดตัดขาดทุนเอง (ชนะค่าที่ระบบคำนวณ)
    side = scored.side, entryPrice = ctx.candles[i].c,
    targetR = null,        // เป้าหมายหลักที่หามาจากสถิติ (ถ้าไม่ส่งมาใช้ 2R ตามเดิม)
    slAtrMult = null,      // ความกว้าง SL ที่หามาจากสถิติ
  } = opts;
  if (!side) return null;
  const atrVal = scored.atr || ctx.atr[i];
  const notes = [];

  // SL: ใช้ค่าที่กว้างกว่าระหว่าง ATR กับใต้/เหนือ swing ล่าสุด แต่ไม่เกินเพดาน
  let slDist = atrVal * (slAtrMult || cfg.slAtrMult);
  const usable = ctx.pivots.filter((p) => p.confirmedAt <= i && i - p.index < 40);
  const lastLow = [...usable].reverse().find((p) => p.type === 'low');
  const lastHigh = [...usable].reverse().find((p) => p.type === 'high');
  if (side > 0 && lastLow && entryPrice > lastLow.price) {
    const structDist = entryPrice - lastLow.price + atrVal * 0.15;
    if (structDist > slDist && structDist <= atrVal * cfg.maxSlAtrMult) {
      slDist = structDist;
      notes.push(`ขยายจุดตัดขาดทุนลงไปใต้จุดต่ำล่าสุดที่ ${lastLow.price.toFixed(2)} เพื่อไม่ให้โดนไส้เทียนเขี่ยออกก่อนราคาไปตามทาง`);
    }
  }
  if (side < 0 && lastHigh && entryPrice < lastHigh.price) {
    const structDist = lastHigh.price - entryPrice + atrVal * 0.15;
    if (structDist > slDist && structDist <= atrVal * cfg.maxSlAtrMult) {
      slDist = structDist;
      notes.push(`ขยายจุดตัดขาดทุนขึ้นไปเหนือจุดสูงล่าสุดที่ ${lastHigh.price.toFixed(2)} เพื่อกันการ stop hunt`);
    }
  }
  slDist = Math.min(slDist, atrVal * cfg.maxSlAtrMult);

  /*
   * จุดตัดขาดทุนที่ผู้ใช้กำหนดเองชนะเสมอ
   *
   * ระบบวางจากสูตร (ATR กับโครงสร้างราคา) ซึ่งไม่รู้เรื่องของผู้ใช้เลย
   * เช่นแนวที่เขาเฝ้าอยู่ ข่าวที่กำลังรอ หรือขีดจำกัดของบัญชี
   * คนเทรดมักมีจุดในใจอยู่แล้ว หน้าที่ของระบบคือคิดขนาดไม้จากจุดนั้นให้ถูก
   * ไม่ใช่ยืนยันจุดของตัวเอง แต่ต้องเตือนถ้าจุดที่เลือกผิดปกติ
   */
  let slManual = false;
  if (slPrice !== null && Number.isFinite(slPrice)) {
    const ok = side > 0 ? slPrice < entryPrice : slPrice > entryPrice;
    if (ok) {
      slDist = Math.abs(entryPrice - slPrice);
      slManual = true;
      const mult = slDist / atrVal;
      if (mult < 0.5) {
        notes.push(`⚠ จุดตัดขาดทุนที่ตั้งเองห่างแค่ ${mult.toFixed(2)} เท่าของ ATR — แคบกว่าที่ราคาแกว่งปกติ `
          + 'มีโอกาสสูงที่จะโดนเขี่ยออกก่อนราคาไปตามทาง');
      } else if (mult > cfg.maxSlAtrMult) {
        notes.push(`⚠ จุดตัดขาดทุนที่ตั้งเองห่าง ${mult.toFixed(2)} เท่าของ ATR — กว้างกว่าเพดานปกติ `
          + `(${cfg.maxSlAtrMult} เท่า) ขนาดไม้จะเล็กลงมาก และเป้าหมายจะอยู่ไกลขึ้นตามไปด้วย`);
      }
    } else {
      notes.push(`⚠ จุดตัดขาดทุนที่ใส่มา (${slPrice.toFixed(2)}) อยู่ผิดฝั่งของราคาเข้า — ใช้ค่าที่ระบบคำนวณแทน`);
    }
  }

  const sl = side > 0 ? entryPrice - slDist : entryPrice + slDist;
  const tp1 = side > 0 ? entryPrice + slDist : entryPrice - slDist;
  const tp2 = side > 0 ? entryPrice + slDist * 2 : entryPrice - slDist * 2;
  let tp3 = side > 0 ? entryPrice + slDist * 3 : entryPrice - slDist * 3;

  // ถ้ามีแนวต้าน/แนวรับใหญ่ขวางอยู่ก่อนถึงเป้า ให้ย้ายเป้าสุดท้ายมาไว้ก่อนแนวนั้น
  const { support, resistance } = nearestLevels(ctx.zones, entryPrice, i);
  if (side > 0 && resistance) {
    if (resistance.price < tp1) notes.push(`⚠ มีแนวต้าน ${resistance.price.toFixed(2)} ขวางก่อนถึงเป้าแรก — ระยะกำไรถูกจำกัด ควรลดขนาดไม้หรือรอเบรกก่อน`);
    else if (resistance.price < tp3) { tp3 = resistance.price; notes.push(`ปรับเป้าสุดท้ายมาที่แนวต้าน ${resistance.price.toFixed(2)} (ขายก่อนแนวต้านดีกว่าหวังทะลุ)`); }
  }
  if (side < 0 && support) {
    if (support.price > tp1) notes.push(`⚠ มีแนวรับ ${support.price.toFixed(2)} รองรับก่อนถึงเป้าแรก — ระยะกำไรถูกจำกัด`);
    else if (support.price > tp3) { tp3 = support.price; notes.push(`ปรับเป้าสุดท้ายมาที่แนวรับ ${support.price.toFixed(2)}`); }
  }

  const round = nearestRound(entryPrice, 50);
  if (side > 0 && round.distAbove < slDist) notes.push(`เลขกลม ${round.above} อยู่ใกล้ (ห่าง ${round.distAbove.toFixed(2)}) — ทองมักมีแรงขายรอที่เลขกลม เผื่อทยอยปิดบางส่วนก่อน`);
  if (side < 0 && round.distBelow < slDist) notes.push(`เลขกลม ${round.below} อยู่ใกล้ (ห่าง ${round.distBelow.toFixed(2)}) — มักมีแรงซื้อรับที่เลขกลม เผื่อทยอยปิดบางส่วนก่อน`);

  const riskMoney = account * (riskPct / 100);
  const lotsRaw = slDist > 0 ? riskMoney / (slDist * contractSize) : 0;

  /*
   * ปัดขนาดไม้ลงให้ตรงขั้นของโบรกเกอร์ แล้วคิดความเสี่ยง "ย้อนกลับ" จากขนาดที่ส่งได้จริง
   *
   * เดิมรายงานขนาดไม้ดิบอย่าง 0.0078 ล็อต ซึ่งส่งคำสั่งไม่ได้เลย
   * ผู้ใช้ต้องปัดเป็น 0.01 เอง แล้วความเสี่ยงจริงก็โตกว่าที่ตั้งไว้โดยไม่รู้ตัว
   * ตัวเลขที่แสดงจึงต้องเป็นตัวเลขที่กดส่งได้ และความเสี่ยงต้องเป็นของขนาดนั้น
   */
  const step = lotStep > 0 ? lotStep : 0.01;
  let lots = Math.floor(lotsRaw / step + 1e-9) * step;
  if (lots < minLot) lots = minLot;
  lots = +(Math.round(lots / step) * step).toFixed(6);

  const riskActual = lots * slDist * contractSize;
  const riskActualPct = account > 0 ? (riskActual / account) * 100 : null;
  const sizeForced = lotsRaw < minLot;   // ทุนน้อยเกินกว่าจะเสี่ยงตามที่ตั้งไว้

  // เป้าหมายหลัก: ใช้ค่าที่หามาจากสถิติถ้ามี แต่ห้ามต่ำกว่าพื้นที่ตั้งไว้
  // ถึงสถิติจะบอกว่าเป้าเตี้ยให้ค่าคาดหวังดีกว่า ก็ไม่รับ เพราะไม่ทนต่อการพลาด
  const minTR = cfg.minTargetR === undefined ? 1.0 : cfg.minTargetR;
  const mainR = Math.max(minTR, targetR || 2);
  const tpMain = side > 0 ? entryPrice + slDist * mainR : entryPrice - slDist * mainR;
  const rewardActual = riskActual * mainR;

  /*
   * เตือนเมื่อทุนไม่พอจะเสี่ยงตามที่ตั้งไว้
   *
   * นี่คือกรณีที่เงียบแล้วอันตรายที่สุด: ระบบบอกให้เสี่ยง 1% แต่ไม้เล็กที่สุด
   * ที่โบรกเกอร์รับ อาจกินทุนไปหลายสิบเปอร์เซ็นต์หรือเกินทุนทั้งก้อน
   * ยิ่งทุนน้อยยิ่งแรง เพราะระยะตัดขาดทุนของทองไม่ได้เล็กลงตามทุน
   */
  if (sizeForced) {
    const pct = riskActualPct === null ? null : riskActualPct.toFixed(0);
    notes.push(`⚠ ทุนไม่พอสำหรับความเสี่ยงที่ตั้งไว้ — ไม้เล็กที่สุดที่ส่งคำสั่งได้คือ ${minLot} ล็อต `
      + `ซึ่งเสี่ยง ${riskActual.toFixed(2)} USD${pct === null ? '' : ` (${pct}% ของทุน ${account.toFixed(2)} USD)`} `
      + `แทนที่จะเป็น ${riskMoney.toFixed(2)} USD ตามที่ตั้งไว้`);
    if (riskActualPct !== null && riskActualPct >= 100) {
      notes.push('⛔ ไม้เดียวนี้เสี่ยงเกินทุนทั้งก้อน ถ้าชน SL คือล้างพอร์ต — ไม้นี้ไม่ควรเข้าด้วยทุนเท่านี้');
    } else if (riskActualPct !== null && riskActualPct >= 10) {
      notes.push(`⛔ เสี่ยง ${riskActualPct.toFixed(0)}% ของทุนในไม้เดียว แพ้ติดกันไม่กี่ไม้ก็หมดพอร์ต `
        + 'ทางแก้คือเพิ่มทุน ใช้บัญชีที่เทรดขนาดเล็กกว่านี้ได้ หรือข้ามไม้นี้ไป');
    }
  }

  /*
   * โซนราคาที่ "เข้าได้" ไม่ใช่ราคาเดียว
   *
   * ราคาที่ดีที่สุดคือรอให้ย่อกลับมาที่แนวใกล้ ๆ (เส้นค่าเฉลี่ย/แนวรับ) เพราะได้ระยะ SL สั้นลง
   * ส่วนราคาที่แย่ที่สุดที่ยังพอเข้าได้ คือจุดที่อัตราส่วนได้:เสีย ตกลงมาถึงขั้นต่ำที่ยอมรับได้
   *
   * คำนวณจาก: (เป้า − เข้า) ÷ (เข้า − ตัดขาดทุน) = อัตราส่วนขั้นต่ำ
   * แก้สมการหา "เข้า" ได้เป็น (เป้า + ขั้นต่ำ×ตัดขาดทุน) ÷ (1 + ขั้นต่ำ)
   * ใช้สูตรเดียวกันทั้งฝั่งซื้อและฝั่งขาย
   */
  const minRR = cfg.minEntryRR || 1.2;
  const entryLimit = (tpMain + minRR * sl) / (1 + minRR);

  // ราคาในอุดมคติ = ย่อกลับมาแตะแนวที่ใกล้ที่สุดที่ยังอยู่ระหว่างจุดเข้ากับจุดตัดขาดทุน
  const pullbackCandidates = [];
  const e20 = ctx.ema20[i];
  if (e20 !== null) pullbackCandidates.push({ price: e20, why: 'เส้นค่าเฉลี่ย 20 แท่ง' });
  if (side > 0 && support) pullbackCandidates.push({ price: support.price, why: `แนวรับที่ถูกทดสอบมา ${support.touches} ครั้ง` });
  if (side < 0 && resistance) pullbackCandidates.push({ price: resistance.price, why: `แนวต้านที่ถูกทดสอบมา ${resistance.touches} ครั้ง` });
  const valid = pullbackCandidates.filter((c) => (side > 0
    ? c.price < entryPrice && c.price > sl
    : c.price > entryPrice && c.price < sl));
  valid.sort((a, b) => (side > 0 ? b.price - a.price : a.price - b.price));
  const ideal = valid[0] || null;

  // ตอนนี้ราคาอยู่ตรงไหนของโซน — ตัดสินว่าเข้าได้เลยหรือควรตั้งรอ
  const stillOk = side > 0 ? entryPrice <= entryLimit : entryPrice >= entryLimit;
  const rrNow = Math.abs(tpMain - entryPrice) / slDist;

  return {
    side, entry: entryPrice, sl, tp1, tp2, tp3, tpMain, mainR,
    entryLimit, entryIdeal: ideal ? ideal.price : null, entryIdealWhy: ideal ? ideal.why : null,
    entryOk: stillOk, rrNow, minRR,
    slDist, slAtr: slDist / atrVal, atr: atrVal, slManual,
    rr3: Math.abs(tp3 - entryPrice) / slDist,
    riskMoney, lots, lotsRaw, lotStep: step, minLot, oz: lots * contractSize,
    riskActual, riskActualPct, rewardActual, sizeForced,
    notes,
    plan: `${side > 0 ? 'เข้าซื้อ (Buy)' : 'เข้าขาย (Sell)'} ที่ ${entryPrice.toFixed(2)} · ตัดขาดทุน ${sl.toFixed(2)} `
      + `(${side > 0 ? '-' : '+'}${slDist.toFixed(2)}) · เป้าทำกำไร ${tpMain.toFixed(2)} (${mainR}R)`
      + ` · ${lots} ล็อต = เสี่ยง ${riskActual.toFixed(2)} USD เพื่อลุ้น ${rewardActual.toFixed(2)} USD`,
  };
}

/** จัดอันดับเหตุผล เพื่อโชว์ "ทำไมถึงควรเข้า" และ "อะไรค้านอยู่" */
export function explain(scored) {
  const pro = scored.factors.filter((f) => Math.sign(f.contribution) === scored.side && f.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const con = scored.factors.filter((f) => f.contribution !== 0 && Math.sign(f.contribution) !== scored.side)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const neutral = scored.factors.filter((f) => f.contribution === 0);
  return { pro, con, neutral };
}

/** ป้ายระดับสัญญาณ — อิงกับเกณฑ์ที่ผู้ใช้ตั้งไว้ เพื่อไม่ให้ข้อความขัดกับการตัดสินใจ */
export function scoreLabel(score, threshold = 35) {
  const a = Math.abs(score);
  if (a < threshold) return { text: 'ยังไม่ถึงเกณฑ์', cls: 'grade-e' };
  if (a >= Math.max(60, threshold * 1.7)) return { text: 'สัญญาณแข็งแรงมาก', cls: 'grade-a' };
  if (a >= Math.max(45, threshold * 1.3)) return { text: 'สัญญาณแข็งแรง', cls: 'grade-b' };
  return { text: 'สัญญาณพอใช้', cls: 'grade-c' };
}
