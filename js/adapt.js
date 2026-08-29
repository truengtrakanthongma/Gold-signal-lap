/**
 * adapt.js — ให้ระบบศึกษาตลาดเอง แล้วปรับกลยุทธ์ตามสิ่งที่เรียนรู้
 *
 * ต่างจาก optimizeExits/walkForward ที่มีอยู่เดิมยังไง
 * ────────────────────────────────────────────────────────
 * ของเดิมแบ่งข้อมูลครั้งเดียว (60% เรียนรู้ / 40% สอบ) แล้วจบ
 * ซึ่งตอบได้แค่ "ค่าที่จูนจากอดีตครึ่งแรก ใช้กับครึ่งหลังได้ไหม"
 *
 * แต่การเทรดจริงไม่ได้จูนครั้งเดียวแล้วใช้ตลอดชีวิต — ตลาดเปลี่ยนคาแรกเตอร์
 * ช่วงหนึ่งเป็นเทรนด์ยาว อีกช่วงเป็นกรอบแคบ ความผันผวนก็ไม่เท่ากัน
 * ระบบที่ "ศึกษาตลาดเองได้" ต้องจูนใหม่เป็นระยะ โดยใช้ได้แค่ข้อมูลที่ผ่านมาแล้วเท่านั้น
 *
 * ไฟล์นี้จึงจำลองการทำแบบนั้นทั้งเส้นเวลา:
 *
 *   ช่วงที่ 1  [───เรียนรู้───][สอบ]
 *   ช่วงที่ 2  [──────เรียนรู้──────][สอบ]
 *   ช่วงที่ 3  [─────────เรียนรู้─────────][สอบ]
 *   ช่วงที่ 4  [────────────เรียนรู้────────────][สอบ]
 *
 * ทุกช่วง "สอบ" คือข้อมูลที่ตอนจูนไม่เคยเห็น เอาผลมาต่อกันได้เส้นทุนที่ซื่อสัตย์
 * ของ "ระบบที่ปรับตัวเอง" ไม่ใช่ของ "ระบบที่รู้อนาคต"
 *
 * และเทียบกับค่าตั้งต้นคงที่บนช่วงสอบชุดเดียวกัน จึงตอบได้จริง ๆ ว่า
 * "การปรับตัวเองช่วยหรือไม่ช่วย" แทนที่จะเชื่อว่ามันต้องช่วยแน่ ๆ
 */

import { runBacktest, evaluateTarget, DEFAULT_BT, wilsonInterval } from './backtest.js';

export const TUNE_GRID = {
  thresholds: [25, 30, 35, 40, 45, 50],
  slMults: [1.0, 1.25, 1.5, 2.0, 2.5],
  targets: [0.75, 1, 1.25, 1.5, 2, 2.5, 3],
};

/**
 * จูนพารามิเตอร์จากข้อมูลช่วง [from, to) เท่านั้น
 *
 * เลือกจุดที่อยู่บน "ที่ราบสูง" ไม่ใช่ยอดแหลม — ให้คะแนนแต่ละจุดด้วยค่าเฉลี่ย
 * ของตัวมันเองกับเพื่อนบ้าน จุดที่ดีเพราะบังเอิญจะมีเพื่อนบ้านแย่ แล้วร่วงไปเอง
 */
export function tuneOn(ctx, from, to, opts = {}) {
  const o = { ...DEFAULT_BT, ...opts };
  const grid = opts.grid || TUNE_GRID;

  /*
   * เว้นระยะกันข้อมูลรั่ว (embargo)
   *
   * ไม้ที่เข้าใกล้ ๆ เส้นแบ่ง จะไปปิดหลังเส้นแบ่ง — ผลของมันขึ้นกับแท่งใน "ช่วงสอบ"
   * ถ้าเอาไม้พวกนี้มาจูน เท่ากับแอบดูอนาคตไปแล้วบางส่วน
   * จึงหยุดรับไม้ใหม่ก่อนถึงเส้นแบ่งเท่ากับระยะถือสูงสุด ไม้ทุกไม้ที่ใช้จูนจึงปิดก่อนเส้นแบ่งแน่นอน
   */
  const entryTo = to - (o.maxHold + 2);
  const bars = entryTo - Math.max(from, o.warmup);
  if (bars < 150) return null;
  const minTrades = opts.minTrades || Math.max(8, Math.round(bars / 40));

  const points = [];
  for (const slAtrMult of grid.slMults) {
    const tuned = { ...ctx, cfg: { ...ctx.cfg, slAtrMult } };
    for (const threshold of grid.thresholds) {
      const r = runBacktest(tuned, { ...o, threshold, fromIndex: from, toIndex: entryTo });
      if (r.stats.n < minTrades) continue;
      for (const targetR of grid.targets) {
        const ev = evaluateTarget(r.trades, targetR, 0);
        if (ev) points.push({ slAtrMult, threshold, targetR, expectancy: ev.expectancy, n: ev.n, hitRate: ev.hitRate });
      }
    }
  }
  if (!points.length) return null;

  const adjacent = (a, b, list) => {
    const i = list.indexOf(a), j = list.indexOf(b);
    return i >= 0 && j >= 0 && Math.abs(i - j) <= 1;
  };
  for (const p of points) {
    const near = points.filter((q) =>
      adjacent(q.slAtrMult, p.slAtrMult, grid.slMults)
      && adjacent(q.threshold, p.threshold, grid.thresholds)
      && adjacent(q.targetR, p.targetR, grid.targets));
    p.robust = near.reduce((a, q) => a + q.expectancy, 0) / near.length;
    p.neighbours = near.length;
  }
  points.sort((a, b) => b.robust - a.robust);
  return { ...points[0], candidates: points.length };
}

/** เดินระบบด้วยพารามิเตอร์ชุดหนึ่งบนช่วง [from, to) แล้วสรุปผล */
function runWith(ctx, params, from, to, o) {
  const tuned = { ...ctx, cfg: { ...ctx.cfg, slAtrMult: params.slAtrMult } };
  const r = runBacktest(tuned, { ...o, threshold: params.threshold, fromIndex: from, toIndex: to });
  const ev = evaluateTarget(r.trades, params.targetR, 0);
  return { run: r, ev, trades: r.trades };
}

/** ผลของไม้ชุดหนึ่งเมื่อคิดที่เป้าหมาย targetR (หน่วย R ต่อไม้) */
function rSeries(trades, targetR) {
  return trades.map((t) => {
    if ((t.favBeforeStop || 0) >= targetR) return targetR;
    if (t.result === 'loss') return -1;
    return Math.max(-1, Math.min(targetR, t.rMultiple));
  });
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);

/**
 * ตรวจสอบแบบเลื่อนหน้าต่าง — หัวใจของไฟล์นี้
 *
 * @param opts.folds     จำนวนช่วงสอบ (ค่าตั้งต้น 4)
 * @param opts.anchored  true = ช่วงเรียนรู้ขยายขึ้นเรื่อย ๆ (จำอดีตทั้งหมด)
 *                       false = ช่วงเรียนรู้เลื่อนตาม (ลืมอดีตไกล ๆ เพราะตลาดเปลี่ยนไปแล้ว)
 */
export function rollingWalkForward(ctx, opts = {}) {
  const o = { ...DEFAULT_BT, ...opts };
  const folds = opts.folds || 4;
  const anchored = opts.anchored !== false;
  const n = ctx.candles.length;
  const start = o.warmup;
  const usable = n - start;

  // ต้องมีข้อมูลพอให้ทั้งเรียนรู้ครั้งแรกและสอบทุกช่วง
  const minTrain = opts.minTrain || 600;
  const foldSize = Math.floor((usable - minTrain) / folds);
  if (foldSize < 150) {
    return { ok: false, reason: `ข้อมูลไม่พอสำหรับแบ่ง ${folds} ช่วง — ต้องการราว ${minTrain + folds * 150 + start} แท่ง (มี ${n})` };
  }

  const results = [];
  for (let k = 0; k < folds; k++) {
    const testFrom = start + minTrain + k * foldSize;
    const testTo = k === folds - 1 ? n : testFrom + foldSize;
    const trainFrom = anchored ? start : Math.max(start, testFrom - minTrain);
    const params = tuneOn(ctx, trainFrom, testFrom, o);
    if (!params) { results.push({ fold: k + 1, testFrom, testTo, ok: false, reason: 'จูนไม่ได้ — ไม้ในช่วงเรียนรู้น้อยเกินไป' }); continue; }

    const adapt = runWith(ctx, params, testFrom, testTo, o);
    const fixed = runWith(ctx, {
      threshold: opts.fixedThreshold || ctx.cfg.threshold || 35,
      slAtrMult: opts.fixedSlAtr || ctx.cfg.slAtrMult || 1.5,
      targetR: opts.fixedTarget || 2,
    }, testFrom, testTo, o);

    results.push({
      fold: k + 1, ok: true, trainFrom, testFrom, testTo,
      trainBars: testFrom - trainFrom, testBars: testTo - testFrom,
      params,
      adapt: { n: adapt.ev ? adapt.ev.n : 0, expectancy: adapt.ev ? adapt.ev.expectancy : null,
        hitRate: adapt.ev ? adapt.ev.hitRate : null, r: rSeries(adapt.trades, params.targetR) },
      fixed: { n: fixed.ev ? fixed.ev.n : 0, expectancy: fixed.ev ? fixed.ev.expectancy : null,
        hitRate: fixed.ev ? fixed.ev.hitRate : null, r: rSeries(fixed.trades, opts.fixedTarget || 2) },
      t0: ctx.candles[testFrom] ? ctx.candles[testFrom].t : null,
      t1: ctx.candles[Math.min(testTo, n - 1)] ? ctx.candles[Math.min(testTo, n - 1)].t : null,
    });
  }

  const good = results.filter((f) => f.ok);
  if (!good.length) return { ok: false, reason: 'ทุกช่วงจูนไม่สำเร็จ — ข้อมูลน้อยเกินไป', folds: results };

  const adaptR = good.flatMap((f) => f.adapt.r);
  const fixedR = good.flatMap((f) => f.fixed.r);
  const pack = (rs, hits) => ({
    n: rs.length,
    expectancy: mean(rs),
    totalR: sum(rs),
    winRate: rs.length ? (rs.filter((v) => v > 0).length / rs.length) * 100 : null,
    ci: rs.length ? wilsonInterval(rs.filter((v) => v > 0).length, rs.length) : null,
  });
  const A = pack(adaptR), F = pack(fixedR);

  // เส้นทุนของระบบที่ปรับตัวเอง เรียงตามเวลาจริง
  let eq = 0;
  const equity = adaptR.map((v) => (eq += v));

  return {
    ok: true, anchored, foldSize, minTrain,
    folds: results,
    adapt: A, fixed: F,
    equity,
    diff: A.expectancy !== null && F.expectancy !== null ? A.expectancy - F.expectancy : null,
    stability: paramStability(good),
    verdict: verdictOf(A, F, good.length),
  };
}

/**
 * พารามิเตอร์ที่จูนได้ในแต่ละช่วง "นิ่ง" แค่ไหน
 *
 * ถ้าทุกช่วงจูนได้ค่าใกล้เคียงกัน = ตลาดนี้มีคาแรกเตอร์ชัด ระบบเรียนรู้ได้จริง
 * ถ้าค่ากระโดดไปมาทุกช่วง = กำลังไล่ตามเสียงรบกวน ไม่ใช่เรียนรู้ตลาด
 * ตัวเลขนี้สำคัญพอ ๆ กับผลกำไร เพราะบอกว่าที่ได้มาเป็นความรู้หรือความบังเอิญ
 */
function paramStability(folds) {
  const keys = ['threshold', 'slAtrMult', 'targetR'];
  const out = {};
  for (const k of keys) {
    const vals = folds.map((f) => f.params[k]);
    const m = mean(vals);
    const sd = Math.sqrt(mean(vals.map((v) => (v - m) ** 2)));
    out[k] = { values: vals, mean: m, sd, cv: m ? sd / Math.abs(m) : null };
  }
  const cvs = keys.map((k) => out[k].cv).filter((v) => v !== null);
  const avgCv = mean(cvs);
  out.level = avgCv === null ? 'unknown' : avgCv < 0.15 ? 'stable' : avgCv < 0.35 ? 'mixed' : 'unstable';
  out.avgCv = avgCv;
  return out;
}

function verdictOf(A, F, nFolds) {
  if (A.n < 20) {
    return { level: 'unknown', text: `ช่วงสอบรวมกันมีแค่ ${A.n} ไม้ — น้อยเกินกว่าจะสรุปว่าการปรับตัวเองช่วยหรือไม่` };
  }
  const d = A.expectancy - F.expectancy;
  const sign = d >= 0 ? '+' : '';
  if (A.expectancy <= 0 && F.expectancy <= 0) {
    return { level: 'bad', text: `บนข้อมูลที่ไม่เคยเห็น ขาดทุนทั้งสองแบบ (ปรับตัวเอง ${A.expectancy.toFixed(3)}R, คงที่ ${F.expectancy.toFixed(3)}R) — `
      + 'ปัญหาไม่ได้อยู่ที่การตั้งค่า แต่อยู่ที่กฎสัญญาณยังไม่มีความได้เปรียบกับตลาดช่วงนี้ อย่าเทรดตาม' };
  }
  if (d > 0.05) {
    return { level: 'good', text: `การปรับตัวเองช่วยได้จริง — ผ่าน ${nFolds} ช่วงสอบ ได้ ${A.expectancy.toFixed(3)}R ต่อไม้ `
      + `เทียบกับค่าคงที่ ${F.expectancy.toFixed(3)}R (${sign}${d.toFixed(3)}R) โดยทุกช่วงจูนจากอดีตล้วน ไม่เห็นอนาคต` };
  }
  if (d < -0.05) {
    return { level: 'bad', text: `การปรับตัวเองทำให้แย่ลง — ${A.expectancy.toFixed(3)}R เทียบกับค่าคงที่ ${F.expectancy.toFixed(3)}R (${d.toFixed(3)}R) `
      + 'แปลว่าการจูนกำลังไล่ตามเสียงรบกวน ควรใช้ค่าคงที่จะดีกว่า' };
  }
  return { level: 'ok', text: `เสมอ — ปรับตัวเอง ${A.expectancy.toFixed(3)}R เทียบกับค่าคงที่ ${F.expectancy.toFixed(3)}R ต่างกันแค่ ${Math.abs(d).toFixed(3)}R `
    + 'ซึ่งอยู่ในระดับความบังเอิญ การจูนไม่ได้เสียหาย แต่ก็ยังไม่ใช่จุดที่ทำให้ระบบดีขึ้น' };
}

/**
 * ผลกำลังเสื่อมลงหรือเปล่า
 *
 * ระบบที่ปรับตัวเองได้ต้องรู้ตัวด้วยว่า "สิ่งที่เรียนรู้มาเริ่มใช้ไม่ได้แล้ว"
 * เทียบผลของช่วงสอบท้าย ๆ กับช่วงต้น ๆ ถ้าตกลงชัดเจน = ตลาดเปลี่ยนไปจากที่เรียนมา
 */
export function driftCheck(rwf, opts = {}) {
  if (!rwf || !rwf.ok) return null;
  const good = rwf.folds.filter((f) => f.ok && f.adapt.r.length);
  if (good.length < 3) return { level: 'unknown', text: 'ช่วงสอบน้อยเกินกว่าจะดูแนวโน้มว่าผลกำลังเสื่อมหรือไม่' };
  const half = Math.floor(good.length / 2);
  const early = mean(good.slice(0, half).flatMap((f) => f.adapt.r));
  const late = mean(good.slice(good.length - half).flatMap((f) => f.adapt.r));
  const drop = early - late;
  const nLate = good.slice(good.length - half).reduce((a, f) => a + f.adapt.r.length, 0);
  if (nLate < 12) return { level: 'unknown', early, late, text: `ช่วงหลังมีแค่ ${nLate} ไม้ — ยังบอกไม่ได้ว่าผลเสื่อมหรือไม่` };
  if (late < 0 && early > 0) {
    return { level: 'bad', early, late, drop,
      text: `ช่วงแรกได้ ${early.toFixed(3)}R ต่อไม้ แต่ช่วงหลังเหลือ ${late.toFixed(3)}R — ติดลบแล้ว `
        + 'แปลว่าตลาดเปลี่ยนไปจากที่ระบบเรียนรู้มา ควรลดขนาดไม้ลงมากหรือหยุดจนกว่าจะเห็นผลกลับมา' };
  }
  if (drop > 0.15) {
    return { level: 'warn', early, late, drop,
      text: `ผลกำลังตกลง: ช่วงแรก ${early.toFixed(3)}R ต่อไม้ ช่วงหลัง ${late.toFixed(3)}R — ยังเป็นบวกแต่แผ่วลง ลดขนาดไม้ลงไว้ก่อน` };
  }
  return { level: 'ok', early, late, drop,
    text: `ผลยังไม่เสื่อม: ช่วงแรก ${early.toFixed(3)}R ต่อไม้ ช่วงหลัง ${late.toFixed(3)}R — สม่ำเสมอพอใช้ได้` };
}

/**
 * สรุปว่า "ตอนนี้ควรตั้งค่าอะไร" — จูนจากอดีตทั้งหมดที่มี
 *
 * ค่าที่ได้จากตรงนี้ยังไม่เคยถูกสอบ (เพราะใช้ข้อมูลหมดแล้ว)
 * ตัวเลขที่บอกว่า "คาดหวังได้แค่ไหน" ต้องอ่านจาก rollingWalkForward เท่านั้น
 * ฟังก์ชันนี้จึงคืนทั้งสองอย่างคู่กันเสมอ กันการเอาตัวเลขในช่วงเรียนรู้ไปโชว์
 */
export function autoTune(ctx, opts = {}) {
  const o = { ...DEFAULT_BT, ...opts };
  const rwf = rollingWalkForward(ctx, o);
  const params = tuneOn(ctx, o.warmup, ctx.candles.length, o);
  if (!params) return { ok: false, reason: 'ข้อมูลน้อยเกินไปสำหรับจูนค่า', rwf };
  return {
    ok: true,
    params,
    rwf,
    drift: driftCheck(rwf, o),
    // ตัวเลขที่เชื่อได้ มาจากช่วงสอบเท่านั้น ไม่ใช่จากการจูน
    expected: rwf.ok ? rwf.adapt : null,
  };
}

/**
 * เล่าเป็นภาษาคนว่า "ระบบศึกษาตลาดนี้แล้วได้อะไร"
 *
 * ตัวเลขในตารางบอกได้ว่าเกิดอะไรขึ้น แต่ไม่ได้บอกว่ามันแปลว่าอะไร
 * ส่วนนี้จึงแปลผลให้ครบสามคำถามที่ผู้ใช้ต้องรู้จริง ๆ:
 *   1. ตลาดนี้มีคาแรกเตอร์แบบไหน และเปลี่ยนไปมากแค่ไหน
 *   2. ระบบเรียนรู้อะไรได้บ้าง และสิ่งที่เรียนรู้นั้นน่าเชื่อหรือเป็นความบังเอิญ
 *   3. แล้วตอนนี้ควรทำยังไง
 */
export function explainAdaptation(res, tfLabel = '') {
  if (!res || !res.ok) return [{ title: 'ยังศึกษาไม่ได้', body: (res && res.reason) || 'ไม่มีผล' }];
  const rwf = res.rwf || res;
  if (!rwf.ok) return [{ title: 'ยังศึกษาไม่ได้', body: rwf.reason }];

  const good = rwf.folds.filter((f) => f.ok);
  const st = rwf.stability;
  const out = [];

  // 1. ตลาดเปลี่ยนไปแค่ไหน — ดูจากค่าที่จูนได้ในแต่ละช่วง
  const thr = st.threshold.values, sl = st.slAtrMult.values, tg = st.targetR.values;
  const changed = new Set(thr).size > 1 || new Set(sl).size > 1 || new Set(tg).size > 1;
  out.push({
    title: '1. ตลาดช่วงนี้เปลี่ยนคาแรกเตอร์ไปแค่ไหน',
    body: changed
      ? `ระบบแบ่งข้อมูลเป็น ${good.length} ช่วงแล้วจูนใหม่ทุกช่วงโดยดูแค่อดีต ผลคือได้ค่าไม่เหมือนกัน — `
        + `คะแนนขั้นต่ำที่เหมาะสมไล่จาก ${Math.min(...thr)} ถึง ${Math.max(...thr)}, `
        + `ความกว้างจุดตัดขาดทุน ${Math.min(...sl)}–${Math.max(...sl)} เท่าของ ATR, `
        + `เป้าหมาย ${Math.min(...tg)}–${Math.max(...tg)} เท่าของความเสี่ยง `
        + 'แปลว่าตลาดไม่ได้นิ่ง การตั้งค่าตายตัวชุดเดียวจึงไม่พอดีกับทุกช่วง'
      : `ทั้ง ${good.length} ช่วงจูนได้ค่าเดียวกันหมด (คะแนน ${thr[0]}, SL ${sl[0]} เท่า ATR, เป้า ${tg[0]} เท่า) — `
        + 'ตลาดช่วงที่โหลดมามีคาแรกเตอร์ค่อนข้างเดียว ค่าตั้งต้นชุดเดียวก็เอาอยู่',
  });

  // 2. สิ่งที่เรียนรู้น่าเชื่อแค่ไหน
  const stabText = {
    stable: 'ค่าที่จูนได้ในแต่ละช่วงใกล้เคียงกัน — เป็นสัญญาณว่าระบบจับคาแรกเตอร์ของตลาดนี้ได้จริง ไม่ใช่ไล่ตามเสียงรบกวน',
    mixed: 'ค่าที่จูนได้แกว่งพอสมควรระหว่างช่วง — เรียนรู้ได้บ้าง แต่ส่วนหนึ่งก็เป็นความบังเอิญ ให้ถือเบามือ',
    unstable: 'ค่าที่จูนได้กระโดดไปมาทุกช่วง — นี่คืออาการของการไล่ตามเสียงรบกวน ไม่ใช่การเรียนรู้ อย่าเชื่อค่าที่จูนมา',
    unknown: 'ช่วงสอบน้อยเกินกว่าจะบอกว่าสิ่งที่เรียนรู้นิ่งหรือไม่',
  }[st.level];
  out.push({
    title: '2. สิ่งที่ระบบเรียนรู้ เชื่อได้แค่ไหน',
    body: `${stabText}\n\n${rwf.verdict.text}`,
    level: rwf.verdict.level,
  });

  // 3. ตอนนี้ควรทำยังไง
  const p = res.params;
  const drift = res.drift;
  let advice;
  if (rwf.verdict.level === 'bad') {
    advice = 'ยังไม่ควรเทรดตามระบบนี้กับข้อมูลชุดนี้ — บนข้อมูลที่ไม่เคยเห็น ผลยังไม่เป็นบวก '
      + 'ลองเปลี่ยนกรอบเวลา หรือโหลดข้อมูลให้ยาวขึ้นแล้วศึกษาใหม่';
  } else if (st.level === 'unstable') {
    advice = 'ให้ใช้ค่าตั้งต้นเดิมไปก่อน — ค่าที่จูนมาไม่นิ่งพอจะเชื่อ การเปลี่ยนไปใช้มันคือการเดาแบบใหม่เท่านั้น';
  } else if (p) {
    advice = `ค่าที่เหมาะกับตลาดช่วงนี้ (จูนจากอดีตทั้งหมดที่โหลดมา): `
      + `เข้าเมื่อคะแนนถึง ${p.threshold}, ตั้งจุดตัดขาดทุนกว้าง ${p.slAtrMult} เท่าของ ATR, ตั้งเป้า ${p.targetR} เท่าของความเสี่ยง`
      + (rwf.verdict.level === 'good' ? ' — กดปุ่มใช้ได้เลย' : ' — จะใช้หรือไม่ใช้ก็ได้ เพราะวัดแล้วผลไม่ต่างกันอย่างมีนัย');
  } else {
    advice = 'ยังจูนค่าไม่ได้ ข้อมูลน้อยเกินไป';
  }
  if (drift && (drift.level === 'warn' || drift.level === 'bad')) advice += `\n\n⚠ ${drift.text}`;
  out.push({ title: '3. แล้วตอนนี้ควรทำยังไง', body: advice, level: rwf.verdict.level });

  return out;
}
