/**
 * strategy.js — กลยุทธ์เดียว หนึ่งชุดตัวเลข
 *
 * ปัญหาที่ไฟล์นี้แก้:
 * ก่อนหน้านี้ระบบมีเครื่องวัดหลายตัวแยกกันอยู่ — หาจุดตัดขาดทุนที่ดีที่สุด,
 * เทียบวิธีบริหารไม้, ตรวจแบบแบ่งข้อมูล, เรียนรู้น้ำหนักปัจจัย — แต่ละตัว
 * แบ่งข้อมูลเอง ให้คำตัดสินเอง คนอ่านจึงเห็นตัวเลขหลายชุดที่ไม่ประกอบกัน
 * และไม่มีตัวเลขไหนตอบได้ว่า "ถ้าทำตามระบบนี้ทั้งระบบ จะได้เท่าไร"
 *
 * ที่แย่กว่านั้น: แผนบอกผู้ใช้ให้ "ตั้ง limit รอราคาย่อ" แต่การทดสอบย้อนหลัง
 * เข้าไม้ที่ราคาตลาดเสมอ สถิติที่โชว์จึงไม่เคยวัดสิ่งที่แอปสั่งให้ทำเลย
 *
 * ที่นี่รวมทุกทางเลือกไว้ในวัตถุเดียว (Strategy) แบ่งข้อมูลจุดเดียว
 * เลือกทุกอย่างจากช่วงเรียนอย่างเดียว แล้วสอบครั้งเดียวบนช่วงที่ไม่เคยเห็น
 * ได้ออกมาเป็นคำตัดสินเดียว กับสถิติชุดเดียวที่เอาไปรวมกันได้จริง
 */
import { runBacktest, optimizeExits, embargoIndex, DEFAULT_BT } from './backtest.js';

/** ทุกทางเลือกของระบบ รวมไว้ที่เดียว — ที่ไหนก็ตามที่เทรด ต้องอ่านจากวัตถุนี้ */
export const DEFAULT_STRATEGY = {
  threshold: DEFAULT_BT.threshold,
  slAtrMult: null,        // null = ใช้ค่าจาก cfg ของบริบท
  targetR: 2,
  maxHold: DEFAULT_BT.maxHold,
  exitStyle: DEFAULT_BT.exitStyle,
  entryMode: DEFAULT_BT.entryMode,
  fillWindow: DEFAULT_BT.fillWindow,
  useFilters: DEFAULT_BT.useFilters,
  spread: DEFAULT_BT.spread,
  slippage: DEFAULT_BT.slippage,
};

const EXIT_TH = {
  partial: 'ปิดครึ่งที่ 1R แล้วเลื่อนกันทุน', full: 'ถือเต็มไม้ถึงเป้า',
  'full-be': 'ถือเต็มไม้ แล้วเลื่อนกันทุนหลังผ่าน 1R',
  trail: 'ลากจุดตัดตามราคา ไม่มีเป้าตายตัว', 'trail-1R': 'ปิดครึ่งที่ 1R แล้วลากที่เหลือ',
};
const ENTRY_TH = { market: 'เข้าที่ราคาตลาดทันทีที่สัญญาณครบ', pullback: 'ตั้ง limit รอราคาย่อกลับมาที่แนวใกล้' };

/** อธิบายกลยุทธ์ทั้งชุดเป็นภาษาคน — ใช้ทั้งบนเว็บ ในบอท และในรายงาน */
export function describeStrategy(st) {
  const s = { ...DEFAULT_STRATEGY, ...st };
  return [
    `เข้าเมื่อคะแนนถึง ${s.threshold}`,
    ENTRY_TH[s.entryMode] || s.entryMode,
    s.slAtrMult ? `จุดตัดขาดทุน ${s.slAtrMult} เท่าของ ATR` : 'จุดตัดขาดทุนตามค่าตั้งต้น',
    `เป้า ${s.targetR}R`,
    EXIT_TH[s.exitStyle] || s.exitStyle,
    `ถือได้ไม่เกิน ${s.maxHold} แท่ง`,
  ].join(' · ');
}

/** แปลงกลยุทธ์เป็นตัวเลือกของเครื่องจำลอง — ที่เดียวที่แปลง จะได้ไม่หลุดกัน */
export function toBacktestOpts(st, extra = {}) {
  const s = { ...DEFAULT_STRATEGY, ...st };
  return {
    threshold: s.threshold, maxHold: s.maxHold, spread: s.spread, slippage: s.slippage,
    useFilters: s.useFilters, exitStyle: s.exitStyle, entryMode: s.entryMode,
    fillWindow: s.fillWindow, ...extra,
  };
}

/** บริบทที่ปรับความกว้าง SL ตามกลยุทธ์แล้ว */
function ctxFor(ctx, st) {
  return st.slAtrMult ? { ...ctx, cfg: { ...ctx.cfg, slAtrMult: st.slAtrMult } } : ctx;
}

/** รันกลยุทธ์หนึ่งชุดบนช่วงข้อมูลหนึ่งช่วง แล้วคืนสถิติชุดเดียว */
export function evaluateStrategy(ctx, st, range = {}) {
  const s = { ...DEFAULT_STRATEGY, ...st };
  const r = runBacktest(ctxFor(ctx, s), toBacktestOpts(s, range));
  return {
    n: r.stats.n, missed: r.stats.missed, signals: r.stats.signals, fillRate: r.stats.fillRate,
    winRate: r.stats.winRate, realWinRate: r.stats.realWinRate, expectancy: r.stats.expectancy,
    totalR: r.stats.totalR, maxDD: r.stats.maxDD, profitFactor: r.stats.profitFactor,
    avgBars: r.stats.avgBars, maxLossStreak: r.stats.maxLossStreak,
    rs: r.trades.map((t) => t.rMultiple), trades: r.trades,
  };
}

/*
 * โอกาสที่ผลชุดหนึ่งดีกว่าอีกชุดจริง ไม่ใช่บังเอิญ (bootstrap)
 * เขียนซ้ำในไฟล์นี้แทนการ import จาก learn.js เพื่อไม่ให้เกิดการเรียกวนกลับ
 * ซึ่งตัวรวมไฟล์เป็นหน้าเดียวรับไม่ได้ (โมดูลถูกต่อกันตามลำดับ)
 */
function probPositive(rs, { samples = 2000, seed = 20260903 } = {}) {
  if (!rs.length) return null;
  let stt = seed >>> 0;
  const rnd = () => { stt = (stt * 1664525 + 1013904223) >>> 0; return stt / 4294967296; };
  let wins = 0;
  for (let k = 0; k < samples; k++) {
    let sum = 0;
    for (let j = 0; j < rs.length; j++) sum += rs[(rnd() * rs.length) | 0];
    if (sum > 0) wins++;
  }
  return wins / samples;
}

/**
 * หากลยุทธ์ที่ดีที่สุด แล้วสอบครั้งเดียว — จุดแบ่งข้อมูลจุดเดียวสำหรับทุกอย่าง
 *
 * ขั้นที่ 1 หาเกณฑ์คะแนน · ความกว้าง SL · เป้าหมาย  (จากช่วงเรียน)
 * ขั้นที่ 2 หาวิธีเข้าไม้ · วิธีบริหารไม้ ที่เข้ากับค่าจากขั้นที่ 1 (จากช่วงเรียน)
 * ขั้นที่ 3 เอาชุดที่ได้ไปสอบบนช่วงที่ไม่เคยเห็น ครั้งเดียว
 *
 * ทำเป็นขั้นแทนการกวาดทุกคู่พร้อมกัน เพราะกวาดพร้อมกันคือ 2,800 รอบจำลอง
 * ซึ่งค้างบนมือถือ และยิ่งกวาดมาก ยิ่งเจอค่าที่ดีเพราะบังเอิญมากตามไปด้วย
 */
export function tuneStrategy(ctx, opts = {}) {
  const base = { ...DEFAULT_STRATEGY, ...(opts.base || {}) };
  const n = ctx.candles.length;
  const splitRatio = opts.splitRatio || 0.6;
  const splitAt = Math.floor(n * splitRatio);
  const warmup = opts.warmup === undefined ? DEFAULT_BT.warmup : opts.warmup;
  if (splitAt - warmup < 80) return { ok: false, reason: 'ข้อมูลน้อยเกินไปสำหรับหากลยุทธ์ที่ดีที่สุด' };

  // ── ขั้นที่ 1: เกณฑ์ · ความกว้าง SL · เป้าหมาย ────────────────────────
  const stage1 = optimizeExits(ctx, { ...toBacktestOpts(base), splitRatio });
  if (!stage1.ok) return { ok: false, reason: stage1.reason };
  let best = { ...base, threshold: stage1.best.threshold, slAtrMult: stage1.best.slAtrMult, targetR: stage1.best.targetR };

  // ── ขั้นที่ 2: วิธีเข้า × วิธีออก บนช่วงเรียนเท่านั้น ─────────────────
  const entryModes = opts.entryModes || ['market', 'pullback'];
  const exitStyles = opts.exitStyles || ['partial', 'full', 'full-be', 'trail', 'trail-1R'];
  const learnTo = embargoIndex(splitAt, { maxHold: best.maxHold });
  const combos = [];
  for (const entryMode of entryModes) {
    for (const exitStyle of exitStyles) {
      const cand = { ...best, entryMode, exitStyle };
      const r = evaluateStrategy(ctx, cand, { toIndex: learnTo });
      combos.push({ entryMode, exitStyle, n: r.n, missed: r.missed, fillRate: r.fillRate,
        expectancy: r.expectancy, totalR: r.totalR, winRate: r.winRate });
    }
  }
  /* เลือกด้วย R รวม ไม่ใช่ R ต่อไม้
     เพราะวิธีเข้าแบบรอย่อจะ "อดเข้า" บางไม้ ทำให้ R ต่อไม้ดูดีขึ้นได้
     ทั้งที่เก็บกำไรรวมได้น้อยลง — R รวมเป็นตัวเดียวที่นับไม้ที่อดเข้าไปด้วยโดยปริยาย */
  const usable = combos.filter((c) => c.n >= (opts.minTrades || 15));
  const pool = usable.length ? usable : combos;
  pool.sort((a, b) => (b.totalR || -Infinity) - (a.totalR || -Infinity));
  best = { ...best, entryMode: pool[0].entryMode, exitStyle: pool[0].exitStyle };

  // ── ขั้นที่ 3: สอบครั้งเดียว บนข้อมูลที่ไม่เคยเห็น ────────────────────
  const inSample = evaluateStrategy(ctx, best, { toIndex: learnTo });
  const outSample = evaluateStrategy(ctx, best, { fromIndex: splitAt });
  const prob = outSample.n >= 10 ? probPositive(outSample.rs) : null;

  let level, verdict;
  if (outSample.n < 15) {
    level = 'unknown';
    verdict = `ไม้ในช่วงสอบมีแค่ ${outSample.n} ไม้ ยังน้อยเกินกว่าจะสรุปว่ากลยุทธ์นี้ใช้ได้จริง — อย่าเพิ่งเทรดตาม`;
  } else if (outSample.expectancy <= 0) {
    level = 'bad';
    verdict = `บนข้อมูลที่ระบบไม่เคยเห็น กลยุทธ์นี้ขาดทุน (${outSample.expectancy.toFixed(3)}R ต่อไม้) — `
      + 'แปลว่าค่าที่หามาได้คือการจูนเข้ากับอดีต ไม่ใช่ความได้เปรียบจริง อย่าเทรดตาม';
  } else if (prob !== null && prob >= 0.9) {
    level = 'good';
    verdict = `บนข้อมูลที่ระบบไม่เคยเห็น กลยุทธ์นี้ได้ ${outSample.expectancy.toFixed(3)}R ต่อไม้ `
      + `จาก ${outSample.n} ไม้ (โอกาสที่กำไรจริงไม่ใช่บังเอิญ ${(prob * 100).toFixed(0)}%)`;
  } else {
    level = 'weak';
    verdict = `บนข้อมูลที่ระบบไม่เคยเห็น กลยุทธ์นี้ได้ ${outSample.expectancy.toFixed(3)}R ต่อไม้ `
      + `แต่ยังไม่พอสรุป (โอกาสที่กำไรจริงไม่ใช่บังเอิญแค่ ${prob === null ? '—' : (prob * 100).toFixed(0) + '%'}) — `
      + 'เก็บข้อมูลเพิ่มแล้วทดสอบใหม่ก่อนลงเงินจริง';
  }

  const strip = (r) => { const { rs, trades, ...rest } = r; return rest; };
  return {
    ok: true, splitAt, strategy: best, describe: describeStrategy(best),
    inSample: strip(inSample), outSample: strip(outSample), prob, level, verdict,
    combos: pool,
    // ส่งต่อรายละเอียดจากขั้นที่ 1 ให้แผงอธิบาย "ตัวเลขนี้มาจากไหน" ใช้ต่อได้
    stage1: { grid: stage1.grid, slAdvice: stage1.slAdvice, mfe: stage1.mfe, maeWinners: stage1.maeWinners, reachRates: stage1.reachRates },
    // ยุบสองสิ่งที่เคยแยกกันให้เหลือชุดเดียว: ค่าที่เลือก กับผลสอบของค่าที่เลือกนั้น
    dropOff: inSample.expectancy !== null && outSample.expectancy !== null
      ? inSample.expectancy - outSample.expectancy : null,
  };
}
