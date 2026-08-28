/**
 * backtest.js — ทดสอบกฎสัญญาณย้อนหลังบนข้อมูลจริงที่โหลดมา
 *
 * เหตุผลที่ต้องมี: ตัวเลข "ความน่าจะเป็น" ที่ไม่ได้มาจากสถิติ คือการเดา
 * ที่นี่เราจึงจำลองการเทรดตามกฎเดียวกับสัญญาณสด (scoreAt + buildSetup) ทุกแท่งย้อนหลัง
 * แล้วนับว่า "แตะเป้า 1R ก่อนโดน SL" กี่ครั้ง → นั่นคือความน่าจะเป็นที่รายงานบนหน้าจอ
 *
 * ข้อจำกัดที่ต้องรู้ (เขียนไว้ให้ผู้ใช้เห็นบนหน้าจอด้วย):
 *  - ใช้ข้อมูลแท่งเทียน ไม่ใช่ tick — ถ้าแท่งเดียวแตะทั้ง SL และ TP เรานับเป็น "แพ้" เสมอ (อนุรักษ์นิยม)
 *  - อดีตไม่รับประกันอนาคต ตลาดเปลี่ยน regime ได้
 *  - ยิ่งจำนวนตัวอย่างน้อย ยิ่งเชื่อถือได้น้อย
 */

import { scoreAt, buildSetup } from './signals.js';

/**
 * ช่วงเวลาที่ใช้แบ่งสถิติ (เวลาไทย)
 * ต้องเป็นชุดเดียวกับที่ตัวกรองสดใช้ ไม่งั้นตัวเลขที่เห็นกับกฎที่ใช้จะคนละเรื่องกัน
 */
export const SESSION_BUCKETS = [
  { key: 'asia', label: 'เอเชีย (07:00-14:00 น.)', from: 7, to: 14 },
  { key: 'london', label: 'ลอนดอน (14:00-20:00 น.)', from: 14, to: 20 },
  { key: 'overlap', label: 'ลอนดอน×นิวยอร์ก (20:00-24:00 น.)', from: 20, to: 24 },
  { key: 'late', label: 'ดึก-เช้ามืด (00:00-07:00 น.)', from: 0, to: 7 },
];

/** ตอนนี้อยู่ช่วงไหน (เวลาไทย) */
export function sessionBucketAt(date = new Date()) {
  const h = (date.getUTCHours() + 7) % 24;
  return SESSION_BUCKETS.find((s) => h >= s.from && h < s.to) || null;
}

export const DEFAULT_BT = {
  threshold: 35,
  maxHold: 60,        // ถือไม้ได้สูงสุดกี่แท่ง ก่อนตัดออกที่ราคาตลาด
  spread: 0.30,       // ต้นทุนสเปรด USD ต่อออนซ์ (ทองคำ spot ทั่วไป 0.2-0.4)
  slippage: 0.10,     // สลิปเพจตอนโดน SL
  warmup: 210,        // ต้องมีแท่งพอให้ EMA200 นิ่งก่อน
  useFilters: true,
};

export function runBacktest(ctx, opts = {}) {
  const o = { ...DEFAULT_BT, ...opts };
  const { candles, cfg } = ctx;
  const n = candles.length;
  const stopAt = Math.min(o.toIndex === undefined ? n : o.toIndex, n) - 2;
  const trades = [];
  let i = Math.max(o.warmup, 2, o.fromIndex || 0);

  while (i < stopAt) {
    const s = scoreAt(ctx, i);
    if (!s.ready || Math.abs(s.score) < o.threshold) { i++; continue; }
    if (o.useFilters && (s.atrPct < cfg.minAtrPct || s.atrPct > cfg.maxAtrPct)) { i++; continue; }

    const side = Math.sign(s.score);
    const rawEntry = candles[i + 1].o;
    const entry = side > 0 ? rawEntry + o.spread / 2 : rawEntry - o.spread / 2;
    const setup = buildSetup(ctx, i, { ...s, side }, { entryPrice: entry });
    if (!setup || setup.slDist <= 0) { i++; continue; }

    const { sl, tp1, tp2, slDist } = setup;
    let exitIdx = null, result = null, rMultiple = 0, hit1R = false;
    let maxFav = 0, maxAdv = 0;

    // ไปได้ไกลสุดกี่ R "ก่อน" จะโดน SL — ตัวเลขนี้ทำให้ประเมินเป้าหมายทุกระดับได้
    // โดยไม่ต้องจำลองใหม่: เป้า T จะถึงก็ต่อเมื่อ favBeforeStop >= T
    let favBeforeStop = 0;
    for (let j = i + 1; j <= Math.min(i + o.maxHold, n - 1); j++) {
      const b = candles[j];
      const favPrev = maxFav;   // ค่าก่อนนับแท่งนี้ ใช้ตอนแท่งนี้เป็นแท่งที่โดน SL
      const fav = side > 0 ? (b.h - entry) / slDist : (entry - b.l) / slDist;
      const adv = side > 0 ? (entry - b.l) / slDist : (b.h - entry) / slDist;
      if (fav > maxFav) maxFav = fav;
      if (adv > maxAdv) maxAdv = adv;

      const hitSL = side > 0 ? b.l <= sl : b.h >= sl;
      const hitTP1 = side > 0 ? b.h >= tp1 : b.l <= tp1;
      const hitTP2 = side > 0 ? b.h >= tp2 : b.l <= tp2;

      // แท่งเดียวแตะทั้งคู่ = นับแพ้ (ไม่รู้ลำดับจริงจากข้อมูลแท่งเทียน)
      if (hitSL && !hit1R) {
        exitIdx = j; result = 'loss';
        // แท่งที่โดน SL ไม่นับระยะกำไรของแท่งนั้น เพราะไม่รู้ว่าแตะจุดไหนก่อน
        favBeforeStop = favPrev;
        rMultiple = -1 - o.slippage / slDist;
        break;
      }
      // ผ่านด่าน SL ของแท่งนี้มาได้ = ระยะกำไรของแท่งนี้นับได้เต็ม
      // ต้องบันทึกก่อนเส้นทาง break อื่น ๆ ไม่งั้นไม้ที่ปิดกำไรจะถูกบันทึกค่าต่ำกว่าจริง
      // (บั๊กนี้ทำให้ตารางบอกว่าเป้าไกล ๆ ไปไม่ถึงเลยสักไม้)
      favBeforeStop = maxFav;
      if (hitTP1 && !hit1R) {
        hit1R = true;
        // แผนบริหารไม้: ปิดครึ่งที่ 1R แล้วเลื่อน SL มาที่ทุน
        if (hitTP2) { exitIdx = j; result = 'win2R'; rMultiple = 0.5 * 1 + 0.5 * 2; break; }
        continue;
      }
      if (hit1R) {
        if (hitTP2) { exitIdx = j; result = 'win2R'; rMultiple = 0.5 + 1; break; }
        const hitBE = side > 0 ? b.l <= entry : b.h >= entry;
        if (hitBE) { exitIdx = j; result = 'win1R-be'; rMultiple = 0.5; break; }
      }
    }

    if (exitIdx === null) {
      exitIdx = Math.min(i + o.maxHold, n - 1);
      const last = candles[exitIdx].c;
      const openR = side > 0 ? (last - entry) / slDist : (entry - last) / slDist;
      result = 'timeout';
      rMultiple = hit1R ? 0.5 + Math.max(0, openR) * 0.5 : openR;
    }

    const d = new Date(candles[i + 1].t);
    // เก็บว่าปัจจัยไหนเห็นด้วย/ค้าน เพื่อย้อนดูทีหลังว่าปัจจัยไหนทำนายได้จริง
    //
    // ปัจจัยเดียวอาจถูกบันทึกหลายรายการที่ชี้คนละทาง (เช่น MACD ทิศทางขึ้น แต่จุดตัดชี้ลง)
    // ต้องรวมเป็นยอดสุทธิต่อปัจจัยก่อน แล้วค่อยตัดสินว่าฝั่งไหน — ให้ตรงกับวิธีที่คะแนนรวมใช้จริง
    const netByKey = new Map();
    for (const f of s.factors) {
      if (!f.contribution) continue;
      netByKey.set(f.key, (netByKey.get(f.key) || 0) + f.contribution);
    }
    const agree = [], against = [];
    const features = {};
    for (const [key, net] of netByKey) {
      if (!net) continue;
      (Math.sign(net) === side ? agree : against).push(key);
    }
    // ตัวแปรต้นสำหรับเรียนรู้น้ำหนัก: ปรับให้เป็น -1..+1 โดยเทียบกับน้ำหนักสูงสุดของปัจจัยนั้น
    // และคูณทิศทางที่เข้า เพื่อให้ค่าบวก = ปัจจัยนี้เชียร์ทิศทางที่เราเข้าจริง ๆ
    for (const f of s.factors) {
      if (!f.weight) continue;
      features[f.key] = (features[f.key] || 0) + (f.contribution / f.weight) * side;
    }
    for (const k of Object.keys(features)) features[k] = Math.max(-1, Math.min(1, features[k]));
    trades.push({
      agree, against, features,
      index: i, entryIndex: i + 1, exitIndex: exitIdx, t: candles[i + 1].t,
      side, score: s.score, absScore: Math.abs(s.score), regime: s.regime,
      entry, sl, tp1, tp2, slDist, result, rMultiple, hit1R, maxFav, maxAdv, favBeforeStop,
      bars: exitIdx - i, hourTh: (d.getUTCHours() + 7) % 24,
    });
    i = exitIdx + 1; // ไม้เดียวต่อครั้ง (ไม่ซ้อนไม้ = ใกล้เคียงการเทรดจริง)
  }

  return summarize(trades, o);
}

function summarize(trades, o) {
  const n = trades.length;
  const wins1R = trades.filter((t) => t.hit1R).length;
  const grossWin = trades.filter((t) => t.rMultiple > 0).reduce((a, t) => a + t.rMultiple, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.rMultiple < 0).reduce((a, t) => a + t.rMultiple, 0));
  const totalR = trades.reduce((a, t) => a + t.rMultiple, 0);

  let peak = 0, dd = 0, eq = 0, maxDD = 0, streak = 0, maxLossStreak = 0;
  const equity = [];
  for (const t of trades) {
    eq += t.rMultiple;
    equity.push({ t: t.t, eq });
    if (eq > peak) peak = eq;
    dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
    if (t.rMultiple < 0) { streak++; if (streak > maxLossStreak) maxLossStreak = streak; } else streak = 0;
  }

  const bands = [
    { min: o.threshold, max: 45, label: `${o.threshold}-45` },
    { min: 45, max: 60, label: '45-60' },
    { min: 60, max: 75, label: '60-75' },
    { min: 75, max: 101, label: '75+' },
  ].map((b) => {
    const list = trades.filter((t) => t.absScore >= b.min && t.absScore < b.max);
    const w = list.filter((t) => t.hit1R).length;
    return { ...b, n: list.length, winRate: list.length ? (w / list.length) * 100 : null,
      avgR: list.length ? list.reduce((a, t) => a + t.rMultiple, 0) / list.length : null };
  });

  const sessions = SESSION_BUCKETS.map((s) => {
    const list = trades.filter((t) => t.hourTh >= s.from && t.hourTh < s.to);
    const w = list.filter((t) => t.hit1R).length;
    return { ...s, n: list.length, winRate: list.length ? (w / list.length) * 100 : null,
      avgR: list.length ? list.reduce((a, t) => a + t.rMultiple, 0) / list.length : null };
  });

  const bySide = [1, -1].map((sd) => {
    const list = trades.filter((t) => t.side === sd);
    const w = list.filter((t) => t.hit1R).length;
    return { side: sd, n: list.length, winRate: list.length ? (w / list.length) * 100 : null,
      avgR: list.length ? list.reduce((a, t) => a + t.rMultiple, 0) / list.length : null };
  });

  // ปัจจัยไหนคุ้มน้ำหนักที่ให้ไว้จริง — วัดจากอัตราชนะตอนมันเห็นด้วย เทียบกับตอนมันค้าน
  const factorKeys = [...new Set(trades.flatMap((t) => [...(t.agree || []), ...(t.against || [])]))];
  const factors = factorKeys.map((key) => {
    const withIt = trades.filter((t) => (t.agree || []).includes(key));
    const vsIt = trades.filter((t) => (t.against || []).includes(key));
    const wr = (list) => (list.length ? (list.filter((t) => t.hit1R).length / list.length) * 100 : null);
    const a = wr(withIt), b = wr(vsIt);
    return {
      key, nAgree: withIt.length, nAgainst: vsIt.length, winAgree: a, winAgainst: b,
      avgR: withIt.length ? withIt.reduce((x, t) => x + t.rMultiple, 0) / withIt.length : null,
      edge: a !== null && b !== null ? a - b : null,
    };
  }).sort((x, y) => (y.edge === null ? -1e9 : y.edge) - (x.edge === null ? -1e9 : x.edge));

  const wonTrades = trades.filter((t) => t.hit1R);
  return {
    trades, equity, bands, sessions, bySide, factors,
    stats: {
      n,
      winRate: n ? (wins1R / n) * 100 : null,
      expectancy: n ? totalR / n : null,
      totalR,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      maxDD, maxLossStreak,
      avgBars: n ? trades.reduce((a, t) => a + t.bars, 0) / n : null,
      avgMaxFav: n ? trades.reduce((a, t) => a + t.maxFav, 0) / n : null,
      avgMaxFavWinners: wonTrades.length ? wonTrades.reduce((a, t) => a + t.maxFav, 0) / wonTrades.length : null,
      avgMaxAdv: n ? trades.reduce((a, t) => a + t.maxAdv, 0) / n : null,
      timeouts: trades.filter((t) => t.result === 'timeout').length,
    },
    opts: o,
  };
}

/**
 * ประเมินว่า "ถ้าตั้งเป้าที่ T เท่าของความเสี่ยง" ผลจะเป็นยังไง
 *
 * ใช้ค่า favBeforeStop ที่บันทึกไว้ตอนจำลอง จึงประเมินได้ทุกระดับเป้าหมาย
 * โดยไม่ต้องจำลองใหม่ — เร็วพอที่จะกวาดหาเป้าที่ดีที่สุดได้จริง
 *
 * แบบจำลอง: เป้าเดียว ตัดขาดทุนเดียว ไม่ปิดบางส่วน (ตรงไปตรงมา อธิบายง่าย)
 */
export function evaluateTarget(trades, targetR, costR = 0) {
  if (!trades.length) return null;
  let wins = 0, total = 0;
  for (const t of trades) {
    const reached = (t.favBeforeStop || 0) >= targetR;
    if (reached) { wins++; total += targetR - costR; }
    else if (t.result === 'loss') total += -1 - costR;
    else {
      // หมดเวลาถือ: ปิดที่ราคาตลาด ใช้ผลจริงที่บันทึกไว้เป็นค่าประมาณ
      total += Math.max(-1, Math.min(targetR, t.rMultiple)) - costR;
    }
  }
  return {
    targetR, n: trades.length, hitRate: (wins / trades.length) * 100,
    expectancy: total / trades.length, totalR: total,
  };
}

/** เปอร์เซ็นไทล์ของชุดตัวเลข (ใช้กับ MFE/MAE) */
function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

/**
 * หาจุดตัดขาดทุนและเป้าหมายที่ "ดีที่สุดตามสถิติ" แทนการตั้งเอาเอง
 *
 * กวาดหาความกว้างของ SL หลายค่า × เกณฑ์คะแนนหลายค่า แล้วในแต่ละคู่
 * ประเมินเป้าหมายทุกระดับจากข้อมูลที่บันทึกไว้ เลือกชุดที่ค่าคาดหวังสูงสุด
 *
 * ***หาจากช่วงเรียนรู้เท่านั้น*** แล้วไปพิสูจน์กับช่วงสอบจริง
 * ไม่งั้นก็แค่จูนตัวเลขให้พอดีกับอดีต ซึ่งไม่มีประโยชน์กับอนาคต
 */
export function optimizeExits(ctx, opts = {}) {
  const o = { ...DEFAULT_BT, ...opts };
  const n = ctx.candles.length;
  const splitAt = Math.floor(n * (o.splitRatio || 0.6));
  if (splitAt - o.warmup < 80) return { ok: false, reason: 'ข้อมูลน้อยเกินไปสำหรับหาค่าที่ดีที่สุด' };

  const slMults = o.slMults || [1.0, 1.25, 1.5, 2.0, 2.5];
  const thresholds = o.thresholds || [20, 25, 30, 35, 40, 45, 50];
  const targets = o.targets || [0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
  // จำนวนไม้ขั้นต่ำต้องปรับตามข้อมูลที่มี — ถ้าตั้งไว้ตายตัวสูงเกินไป
  // ระบบจะหาไม่เจอเลยแล้วถอยไปใช้ค่าตั้งต้นเงียบ ๆ ซึ่งเสียประโยชน์ทั้งหมด
  const usableBars = splitAt - o.warmup;
  const minTrades = o.minTrades || Math.max(10, Math.round(usableBars / 30));

  const grid = [];
  for (const slAtrMult of slMults) {
    const tuned = { ...ctx, cfg: { ...ctx.cfg, slAtrMult } };
    for (const threshold of thresholds) {
      const r = runBacktest(tuned, { ...o, threshold, toIndex: splitAt });
      if (r.stats.n < minTrades) continue;
      const costR = 0;   // ต้นทุนถูกคิดไปแล้วตอนจำลอง (สเปรด+สลิปเพจ)
      for (const targetR of targets) {
        const ev = evaluateTarget(r.trades, targetR, costR);
        if (ev) grid.push({ slAtrMult, threshold, ...ev });
      }
    }
  }
  if (!grid.length) {
    return { ok: false, minTrades,
      reason: `ในช่วงเรียนรู้ (${usableBars} แท่ง) ไม่มีชุดค่าไหนสร้างไม้ได้ถึง ${minTrades} ไม้ `
        + 'ซึ่งเป็นจำนวนขั้นต่ำที่จะสรุปอะไรได้ — ลองเปลี่ยนไปกรอบเวลาที่เล็กลง (5 นาที/15 นาที) จะมีสัญญาณถี่กว่า' };
  }

  /*
   * เลือกยังไงไม่ให้ได้ "ค่าที่บังเอิญดี"
   *
   * ถ้าเลือกจุดที่ค่าคาดหวังสูงสุดตรง ๆ มักได้จุดโดด ๆ ที่ดีเพราะบังเอิญ
   * พอเปลี่ยนพารามิเตอร์นิดเดียวผลก็พังทันที = ใช้กับอนาคตไม่ได้
   *
   * จึงให้คะแนนแต่ละจุดด้วยค่าเฉลี่ยของตัวมันเองกับจุดข้าง ๆ (ที่ SL/เกณฑ์/เป้า ใกล้เคียงกัน)
   * จุดที่ชนะคือจุดที่อยู่บน "ที่ราบสูง" ไม่ใช่ยอดแหลม — ทนต่อการที่ตลาดเปลี่ยนไปเล็กน้อย
   */
  const near = (a, b, list) => {
    const idxA = list.indexOf(a), idxB = list.indexOf(b);
    return idxA >= 0 && idxB >= 0 && Math.abs(idxA - idxB) <= 1;
  };
  for (const g of grid) {
    const neighbours = grid.filter((x) =>
      near(x.slAtrMult, g.slAtrMult, slMults)
      && near(x.threshold, g.threshold, thresholds)
      && near(x.targetR, g.targetR, targets));
    g.robust = neighbours.reduce((a, x) => a + x.expectancy, 0) / neighbours.length;
    g.neighbours = neighbours.length;
  }
  grid.sort((a, b) => b.robust - a.robust);
  const best = grid[0];

  // พิสูจน์กับช่วงสอบจริง ด้วยค่าที่เลือกมาโดยไม่เคยเห็นข้อมูลส่วนนี้
  const tunedCtx = { ...ctx, cfg: { ...ctx.cfg, slAtrMult: best.slAtrMult } };
  const outRun = runBacktest(tunedCtx, { ...o, threshold: best.threshold, fromIndex: splitAt });
  const outEval = evaluateTarget(outRun.trades, best.targetR, 0);

  // การกระจายของระยะที่ราคาวิ่งไป และระยะที่ต้องทนติดลบ
  const inRun = runBacktest(tunedCtx, { ...o, threshold: best.threshold, toIndex: splitAt });
  const all = [...inRun.trades, ...outRun.trades];
  const winners = all.filter((t) => (t.favBeforeStop || 0) >= best.targetR);
  const mfe = all.map((t) => t.favBeforeStop || 0);
  const maeWinners = winners.map((t) => t.maxAdv || 0);

  return {
    ok: true, splitAt, best, grid: grid.slice(0, 40),
    outOfSample: outEval,
    reachRates: targets.map((T) => ({
      targetR: T,
      inSample: (inRun.trades.filter((t) => (t.favBeforeStop || 0) >= T).length / Math.max(1, inRun.trades.length)) * 100,
      outSample: outRun.trades.length ? (outRun.trades.filter((t) => (t.favBeforeStop || 0) >= T).length / outRun.trades.length) * 100 : null,
    })),
    mfe: { p25: pct(mfe, 25), p50: pct(mfe, 50), p75: pct(mfe, 75), p90: pct(mfe, 90), n: mfe.length },
    maeWinners: { p50: pct(maeWinners, 50), p75: pct(maeWinners, 75), p90: pct(maeWinners, 90), max: maeWinners.length ? Math.max(...maeWinners) : null, n: maeWinners.length },
    slAdvice: slAdvice(maeWinners),
  };
}

/**
 * จุดตัดขาดทุนควรกว้างแค่ไหน — ตอบจากสถิติ ไม่ใช่ความรู้สึก
 * ดูว่า "ไม้ที่สุดท้ายชนะ" เคยติดลบลึกสุดแค่ไหน ถ้า 95% ไม่เคยเกิน X
 * แปลว่าตั้ง SL กว้างกว่า X ไปก็เปลืองเปล่า ๆ — ทำให้ขนาดไม้เล็กลงโดยไม่จำเป็น
 */
function slAdvice(maeWinners) {
  if (maeWinners.length < 10) {
    return { text: 'ไม้ที่ชนะยังน้อยเกินกว่าจะสรุปว่าจุดตัดขาดทุนควรกว้างแค่ไหน', level: 'unknown' };
  }
  const p95 = pct(maeWinners, 95);
  if (p95 < 0.7) {
    return {
      level: 'tighten', p95,
      text: `ไม้ที่ชนะ 95% ไม่เคยติดลบเกิน ${p95.toFixed(2)} เท่าของระยะ SL ปัจจุบัน — `
        + `แปลว่า SL ตั้งกว้างเกินความจำเป็น ถ้าแคบลงจะเสี่ยงเงินเท่าเดิมแต่ได้ขนาดไม้ใหญ่ขึ้น กำไรต่อไม้จึงมากขึ้น`,
    };
  }
  if (p95 > 0.95) {
    return {
      level: 'widen', p95,
      text: `ไม้ที่ชนะบางไม้ติดลบลึกถึง ${p95.toFixed(2)} เท่าของระยะ SL — เฉียดโดนเขี่ยออกก่อนราคาจะไปตามทาง `
        + `ควรเผื่อ SL ให้กว้างขึ้นอีกเล็กน้อย`,
    };
  }
  return { level: 'ok', p95, text: `ความกว้างของ SL พอดีแล้ว — ไม้ที่ชนะ 95% ติดลบไม่เกิน ${p95.toFixed(2)} เท่าของระยะ SL` };
}

/**
 * ตรวจสอบแบบแบ่งข้อมูล (walk-forward)
 *
 * ปัญหาของ backtest ธรรมดา: เราเลือกเกณฑ์จากข้อมูลชุดไหน แล้ววัดผลบนชุดนั้น
 * ตัวเลขจะสวยเสมอ เพราะเป็นการ "ตอบข้อสอบที่เห็นเฉลยแล้ว"
 *
 * วิธีนี้แบ่งข้อมูลเป็นสองท่อน:
 *   ช่วงเรียนรู้ (60% แรก) — ใช้หาว่าเกณฑ์คะแนนเท่าไรดีที่สุด
 *   ช่วงสอบจริง (40% หลัง) — ใช้เกณฑ์นั้นวัดผล โดยไม่เคยเห็นข้อมูลส่วนนี้มาก่อน
 *
 * ตัวเลขจากช่วงสอบจริงคือตัวเลขที่ควรเชื่อ ส่วนช่วงเรียนรู้ไว้เทียบว่าห่างกันแค่ไหน
 * ถ้าสองค่าต่างกันมาก แปลว่าระบบจำข้อมูลเก่าได้ ไม่ได้เข้าใจตลาดจริง (overfit)
 */
export function walkForward(ctx, opts = {}) {
  const o = { ...DEFAULT_BT, ...opts };
  const n = ctx.candles.length;
  const splitAt = Math.floor(n * (o.splitRatio || 0.6));
  if (splitAt - o.warmup < 80) {
    return { ok: false, reason: 'ข้อมูลน้อยเกินไปสำหรับแบ่งช่วงเรียนรู้/ช่วงสอบ (ต้องการอย่างน้อย ~400 แท่ง)' };
  }

  const candidates = (o.thresholds || [25, 30, 35, 40, 45, 50, 55, 60]);
  const sweep = candidates.map((threshold) => {
    const r = runBacktest(ctx, { ...o, threshold, toIndex: splitAt });
    return { threshold, n: r.stats.n, winRate: r.stats.winRate, expectancy: r.stats.expectancy, totalR: r.stats.totalR };
  });

  // เลือกเกณฑ์ที่ค่าคาดหวังดีที่สุด แต่ต้องมีตัวอย่างพอ (>= 12 ไม้) ไม่งั้นเป็นความบังเอิญ
  const usable = sweep.filter((x) => x.n >= 12 && x.expectancy !== null);
  const best = usable.sort((a, b) => b.expectancy - a.expectancy)[0] || null;
  if (!best) return { ok: false, reason: 'ช่วงเรียนรู้ไม่มีเกณฑ์ไหนสร้างไม้ได้มากพอจะสรุป', sweep, splitAt };

  const inSample = runBacktest(ctx, { ...o, threshold: best.threshold, toIndex: splitAt });
  const outSample = runBacktest(ctx, { ...o, threshold: best.threshold, fromIndex: splitAt });

  const drop = inSample.stats.winRate !== null && outSample.stats.winRate !== null
    ? inSample.stats.winRate - outSample.stats.winRate : null;

  return {
    ok: true, splitAt, sweep, chosenThreshold: best.threshold, inSample, outSample, drop,
    verdict: verdictOf(outSample, drop),
  };
}

function verdictOf(out, drop) {
  if (!out.stats.n) return { level: 'unknown', text: 'ช่วงสอบจริงไม่มีสัญญาณเลย — สรุปไม่ได้ ลองลดเกณฑ์คะแนนหรือโหลดข้อมูลมากขึ้น' };
  if (out.stats.n < 15) return { level: 'weak', text: `ช่วงสอบจริงมีแค่ ${out.stats.n} ไม้ — น้อยเกินกว่าจะเชื่อถือได้ ใช้ประกอบเท่านั้น` };
  if (out.stats.expectancy > 0.05 && (drop === null || drop < 15)) {
    return { level: 'good', text: 'ผ่าน — ระบบทำกำไรได้บนข้อมูลที่ไม่เคยเห็น และผลไม่ตกจากช่วงเรียนรู้มากนัก' };
  }
  if (out.stats.expectancy > 0) {
    return { level: 'ok', text: 'พอไปได้ — ยังเป็นบวกบนข้อมูลใหม่ แต่ผลตกลงจากช่วงเรียนรู้พอสมควร ให้ลดขนาดไม้ลง' };
  }
  return { level: 'bad', text: 'ไม่ผ่าน — บนข้อมูลที่ไม่เคยเห็น ระบบขาดทุน แปลว่ากฎชุดนี้ยังไม่มีความได้เปรียบจริงกับตลาดช่วงนี้ อย่าเทรดตาม' };
}

/**
 * แปลงคะแนนสัญญาณสด → ความน่าจะเป็นเชิงสถิติ (จาก band ที่ใกล้เคียงที่สุด)
 * ถ้าตัวอย่างน้อยกว่า 20 ไม้ จะบอกตรง ๆ ว่าเชื่อถือได้จำกัด
 */
export function probabilityFor(score, bt) {
  if (!bt || !bt.stats.n) return { p: null, n: 0, note: 'ยังไม่มีผล backtest — กดปุ่ม "ทดสอบย้อนหลัง" ก่อน' };
  const a = Math.abs(score);
  const band = bt.bands.find((b) => a >= b.min && a < b.max);
  if (band && band.n >= 20) {
    return { p: band.winRate, n: band.n, band: band.label, avgR: band.avgR,
      note: `จากสัญญาณคะแนน ${band.label} ที่เกิดขึ้นจริง ${band.n} ครั้งในข้อมูลชุดนี้` };
  }
  if (band && band.n > 0) {
    return { p: band.winRate, n: band.n, band: band.label, avgR: band.avgR, weak: true,
      note: `ตัวอย่างเพียง ${band.n} ครั้ง (น้อยกว่า 20) — ตัวเลขนี้ยังแกว่งสูง ใช้ค่ารวมทั้งระบบ ${bt.stats.winRate.toFixed(0)}% ประกอบด้วย` };
  }
  return { p: bt.stats.winRate, n: bt.stats.n, weak: true,
    note: `ไม่มีสัญญาณคะแนนระดับนี้ในอดีต ใช้อัตราชนะรวมของระบบแทน (${bt.stats.n} ไม้)` };
}

/** ช่วงความเชื่อมั่น 95% แบบ Wilson — บอกว่าอัตราชนะที่วัดได้ "แกว่งได้แค่ไหน" */
export function wilsonInterval(wins, n, z = 1.96) {
  if (!n) return null;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { low: ((centre - margin) / denom) * 100, high: ((centre + margin) / denom) * 100 };
}
