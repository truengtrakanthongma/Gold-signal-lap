/**
 * learn.js — เรียนรู้น้ำหนักปัจจัยจากผลจริง แทนการเดา
 *
 * ปัญหา: น้ำหนักทั้ง 12 ปัจจัย (16, 12, 12, 10, ...) เป็นตัวเลขที่ตั้งขึ้นจากความรู้สึก
 * ไม่เคยมีหลักฐานว่าถูก — ปัจจัยที่ให้น้ำหนักเยอะอาจทำนายได้แย่กว่าปัจจัยที่ให้น้ำหนักน้อย
 *
 * วิธีแก้: ทุกไม้ในการทดสอบย้อนหลังมีข้อมูลครบอยู่แล้วว่า
 *   - แต่ละปัจจัยเห็นด้วยกับทิศทางที่เข้าแรงแค่ไหน (ตัวแปรต้น)
 *   - สุดท้ายไม้นั้นถึงเป้าหรือไม่ (ตัวแปรตาม)
 * ซึ่งก็คือชุดข้อมูลสำหรับ logistic regression พอดี
 *
 * *** ต้องฟิตกับช่วงเรียนรู้เท่านั้น แล้ววัดผลกับช่วงสอบจริง ***
 * ไม่งั้นก็แค่จำอดีตได้ ซึ่งไม่มีประโยชน์กับอนาคต
 *
 * ------------------------------------------------------------------
 * ทำไมต้องซับซ้อนกว่า "ฟิตแล้วเอาเลข" (บทเรียนจากรุ่นแรกที่พัง)
 *
 * รุ่นแรกฟิตตรง ๆ แล้วตัดค่าติดลบทิ้ง ผลคือ 10 จาก 12 ปัจจัยกลายเป็นศูนย์
 * เหลือแค่ 2 ปัจจัยกินน้ำหนักทั้งหมด ซึ่งไม่ใช่ "ความรู้" แต่เป็นอาการของ 3 ปัญหา:
 *
 *   1. ไม่ปรับสเกลตัวแปร — ปัจจัยที่นาน ๆ ติดที (ค่าเป็น 0 เกือบตลอด) มีความแปรปรวนต่ำ
 *      L2 จึงบีบสัมประสิทธิ์ของมันลงเกือบศูนย์ ทั้งที่อาจทำนายได้ดีตอนมันติด
 *      → แก้ด้วยการทำ z-score ก่อนฟิต ทุกปัจจัยจึงถูกวัดด้วยไม้บรรทัดเดียวกัน
 *
 *   2. ตัดค่าติดลบแล้วปรับสเกลใหม่ — ถ้าบังเอิญมีแค่ 2 ตัวที่เป็นบวก สองตัวนั้น
 *      จะดูดน้ำหนักทั้ง 120 ไปหมด ทั้งที่หลักฐานอาจอ่อนมาก
 *      → แก้ด้วยการวัด "ความมั่นใจ" ของแต่ละปัจจัยด้วย bootstrap
 *         ปัจจัยที่เครื่องหมายพลิกไปมาเหมือนโยนหัวก้อย = ไม่มีหลักฐาน = ไม่ได้น้ำหนักเพิ่ม
 *
 *   3. ข้อมูลน้อยเทียบกับจำนวนปัจจัย (63 ไม้ ต่อ 12 ปัจจัย) และปัจจัยเกี่ยวพันกันเอง
 *      (EMA/ADX/MACD ชี้ทางเดียวกันในเทรนด์) สัมประสิทธิ์รายตัวจึงแกว่งมาก
 *      → แก้ด้วยการ "ผสม" กับน้ำหนักเดิม ไม่ใช่แทนที่ สัดส่วนขึ้นกับจำนวนไม้ที่มี
 *         ข้อมูลน้อย = เชื่อของเดิมเป็นหลัก, ข้อมูลมากขึ้น = เชื่อข้อมูลมากขึ้นตามลำดับ
 */

import { runBacktest, wilsonInterval, embargoIndex } from './backtest.js';

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/**
 * ฟิตน้ำหนักด้วย logistic regression (gradient descent + L2)
 * @param {Array} rows [{x: number[], y: 0|1}]
 * @returns {{w:number[], b:number, iters:number, logLoss:number}}
 */
export function fitLogistic(rows, { lr = 0.3, iters = 3000, l2 = 0.05 } = {}) {
  if (!rows.length) return null;
  const d = rows[0].x.length;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (const r of rows) {
      let z = b;
      for (let k = 0; k < d; k++) z += w[k] * r.x[k];
      const err = sigmoid(z) - r.y;
      for (let k = 0; k < d; k++) gw[k] += err * r.x[k];
      gb += err;
    }
    for (let k = 0; k < d; k++) w[k] -= lr * (gw[k] / rows.length + l2 * w[k]);
    b -= lr * (gb / rows.length);
  }
  return { w, b, iters, logLoss: logLoss(rows, w, b) };
}

/** ค่าความคลาดเคลื่อนเฉลี่ยของแบบจำลอง (ยิ่งน้อยยิ่งดี) */
export function logLoss(rows, w, b) {
  if (!rows.length) return null;
  let loss = 0;
  for (const r of rows) {
    let z = b;
    for (let k = 0; k < w.length; k++) z += w[k] * r.x[k];
    const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(z)));
    loss += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
  }
  return loss / rows.length;
}

/** ค่าอ้างอิง: ถ้าทายด้วยอัตราชนะรวมอย่างเดียว จะพลาดเท่าไร — แบบจำลองต้องดีกว่านี้ */
export function baselineLogLoss(rows) {
  if (!rows.length) return null;
  const p = Math.min(1 - 1e-9, Math.max(1e-9, rows.filter((r) => r.y).length / rows.length));
  let loss = 0;
  for (const r of rows) loss += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
  return loss / rows.length;
}

/**
 * แปลงไม้เทรดเป็นชุดข้อมูลสำหรับฟิต
 * ตัวแปรต้นของแต่ละปัจจัย = ความแรงที่ปัจจัยนั้นเห็นด้วยกับทิศทางที่เข้า (-1..+1)
 */
export function toDataset(trades, keys) {
  return trades
    .filter((t) => t.features)
    .map((t) => ({ x: keys.map((k) => t.features[k] || 0), y: t.hit1R ? 1 : 0 }));
}

/** ค่าเฉลี่ยและส่วนเบี่ยงเบนของแต่ละตัวแปร */
function moments(rows, d) {
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const r of rows) for (let k = 0; k < d; k++) mean[k] += r.x[k];
  for (let k = 0; k < d; k++) mean[k] /= rows.length;
  for (const r of rows) for (let k = 0; k < d; k++) std[k] += (r.x[k] - mean[k]) ** 2;
  for (let k = 0; k < d; k++) std[k] = Math.sqrt(std[k] / rows.length);
  return { mean, std };
}

/**
 * ปรับตัวแปรให้เป็น z-score เพื่อให้ L2 ลงโทษทุกปัจจัยเท่ากัน
 * ปัจจัยที่แทบไม่เคยติด (std ≈ 0) ถือว่า "ไม่มีหลักฐาน" → คงเป็นศูนย์ไว้ ไม่ให้เข้าแบบจำลอง
 */
export function standardize(rows, { mean, std }) {
  const d = mean.length;
  return rows.map((r) => ({
    y: r.y,
    x: r.x.map((v, k) => (std[k] > 1e-9 ? (v - mean[k]) / std[k] : 0)),
  }));
}

/**
 * สุ่มตัวอย่างซ้ำ (bootstrap) เพื่อดูว่าเครื่องหมายของแต่ละสัมประสิทธิ์นิ่งแค่ไหน
 *
 * ปัจจัยที่ "เป็นบวกทุกครั้งที่สุ่ม" = หลักฐานหนัก
 * ปัจจัยที่ "บวกบ้างลบบ้างครึ่ง ๆ" = บังเอิญ ไม่ควรได้น้ำหนักเพิ่มจากของเดิม
 */
export function bootstrapSigns(rows, { samples = 100, seed = 12345, ...fitOpts } = {}) {
  const d = rows[0].x.length;
  const pos = new Array(d).fill(0);
  const sums = new Array(d).fill(0);
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let b = 0; b < samples; b++) {
    const draw = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) draw[i] = rows[(rnd() * rows.length) | 0];
    // ต้องมีทั้งไม้ชนะและไม้แพ้ ไม่งั้นฟิตไม่ได้ความ
    const wins = draw.filter((r) => r.y).length;
    if (!wins || wins === draw.length) continue;
    const f = fitLogistic(draw, { iters: 800, ...fitOpts });
    for (let k = 0; k < d; k++) { if (f.w[k] > 0) pos[k]++; sums[k] += f.w[k]; }
  }
  const done = samples;
  return {
    samples: done,
    posFrac: pos.map((p) => p / done),
    meanCoef: sums.map((v) => v / done),
  };
}

/**
 * เรียนรู้น้ำหนักชุดใหม่จากไม้ในช่วงเรียนรู้
 *
 * @param trades      ไม้จากช่วงเรียนรู้เท่านั้น (ห้ามมีไม้จากช่วงสอบปน)
 * @param keys        รายชื่อปัจจัยตามลำดับ
 * @param baseWeights น้ำหนักเดิมที่ตั้งด้วยมือ ใช้เป็นจุดตั้งต้นให้ผสม
 * @param opts.priorN จำนวนไม้ที่ถือว่า "เท่ากับความเชื่อมั่นในน้ำหนักเดิม" (ค่าตั้งต้น 200)
 * @param opts.maxBlend เพดานสัดส่วนที่ยอมให้ข้อมูลเปลี่ยนน้ำหนัก (ค่าตั้งต้น 0.6)
 */
export function learnWeights(trades, keys, baseWeights, opts = {}) {
  const raw = toDataset(trades, keys);
  const minRows = opts.minRows || 40;
  if (raw.length < minRows) {
    return { ok: false, reason: `มีไม้ให้เรียนรู้แค่ ${raw.length} ไม้ (ต้องการอย่างน้อย ${minRows}) — น้อยเกินกว่าจะเชื่อผลที่ได้` };
  }
  const wins = raw.filter((r) => r.y).length;
  if (!wins || wins === raw.length) {
    return { ok: false, reason: 'ไม้ในช่วงเรียนรู้ชนะหมดหรือแพ้หมด — ไม่มีความต่างให้เรียนรู้' };
  }

  const d = keys.length;
  const mom = moments(raw, d);
  const rows = standardize(raw, mom);
  const live = mom.std.map((s) => s > 1e-9);

  const fit = fitLogistic(rows, opts);
  if (!fit) return { ok: false, reason: 'ฟิตไม่สำเร็จ' };
  const boot = bootstrapSigns(rows, opts);

  /*
   * แปลงสัมประสิทธิ์ → น้ำหนัก
   *
   * เพราะตัวแปรถูกทำ z-score แล้ว สัมประสิทธิ์จึงเทียบกันได้ตรง ๆ:
   * ตัวไหนใหญ่ = ขยับ 1 ส่วนเบี่ยงเบนแล้วเปลี่ยนโอกาสชนะได้มากกว่า
   *
   * แต่ก่อนจะเชื่อ ต้องคูณด้วย "ความมั่นใจ" จาก bootstrap
   *   posFrac 1.00 → conf 1.00 (เป็นบวกทุกครั้งที่สุ่ม)
   *   posFrac 0.50 → conf 0.00 (โยนหัวก้อย ไม่ใช่หลักฐาน)
   * ปัจจัยที่ทำนายกลับทาง (สัมประสิทธิ์ติดลบ) ให้ค่าเป็น 0 คือ "ไม่นับ"
   * ไม่ใช่กลับด้าน เพราะจะทำให้คะแนนตีความไม่ได้
   */
  const conf = boot.posFrac.map((p) => Math.max(0, 2 * p - 1));
  const strength = keys.map((k, idx) => (live[idx] ? Math.max(0, fit.w[idx]) * conf[idx] : 0));

  // ปัจจัยที่ไม่มีหลักฐาน (std≈0) ไม่เข้าการปรับ — คงน้ำหนักเดิมไว้ทั้งก้อน
  const liveTotal = keys.reduce((a, k, idx) => a + (live[idx] ? (baseWeights[k] || 0) : 0), 0);
  const sumStrength = strength.reduce((a, b) => a + b, 0);
  if (sumStrength <= 1e-9) {
    return {
      ok: false, fit, boot, rows: raw.length,
      reason: 'ไม่มีปัจจัยไหนทำนายได้ดีกว่าการเดาสุ่มอย่างมีนัยในข้อมูลชุดนี้ — น้ำหนักเดิมยังใช้ต่อได้',
    };
  }

  /*
   * ผสมกับน้ำหนักเดิม แทนการแทนที่
   *   blend = n / (n + priorN)
   * 63 ไม้ กับ priorN 200 → 0.24 คือให้ข้อมูลออกเสียงราวหนึ่งในสี่
   * ยิ่งเก็บไม้ได้มาก ข้อมูลยิ่งมีสิทธิ์เปลี่ยนน้ำหนักมากขึ้นเอง โดยไม่ต้องแก้โค้ด
   */
  const priorN = opts.priorN || 200;
  const maxBlend = opts.maxBlend === undefined ? 0.6 : opts.maxBlend;
  const blend = Math.min(maxBlend, raw.length / (raw.length + priorN));

  const weights = {};
  keys.forEach((k, idx) => {
    const base = baseWeights[k] || 0;
    if (!live[idx]) { weights[k] = base; return; }
    const learned = (strength[idx] / sumStrength) * liveTotal;
    weights[k] = (1 - blend) * base + blend * learned;
  });

  const totalBase = keys.reduce((a, k) => a + (baseWeights[k] || 0), 0);
  const totalNew = keys.reduce((a, k) => a + weights[k], 0);
  // กันเศษทศนิยมสะสม ให้ผลรวมเท่าเดิมเป๊ะ เพื่อให้คะแนนสองชุดเทียบกันได้
  if (totalNew > 1e-9) for (const k of keys) weights[k] *= totalBase / totalNew;

  return {
    ok: true,
    weights,
    fit,
    boot,
    blend,
    rows: raw.length,
    logLoss: fit.logLoss,
    baseline: baselineLogLoss(rows),
    coefficients: keys.map((k, idx) => ({
      key: k,
      coef: fit.w[idx],
      posFrac: boot.posFrac[idx],
      confidence: conf[idx],
      live: live[idx],
      base: baseWeights[k] || 0,
      weight: weights[k],
      delta: weights[k] - (baseWeights[k] || 0),
    })).sort((a, b) => b.weight - a.weight),
  };
}

/**
 * ความน่าจะเป็นที่ "ชุด B ดีกว่าชุด A จริง" ไม่ใช่แค่บังเอิญ
 *
 * ทำไมต้องมี: ถ้าตัดสินด้วย "ค่าคาดหวังใหม่มากกว่าเดิมนิดหน่อย" อย่างเดียว
 * บนข้อมูลที่ไม่มีอะไรให้เรียนรู้เลย เราจะตัดสินว่า "ผ่าน" ราวครึ่งหนึ่งของครั้ง
 * ซึ่งก็คือการโยนหัวก้อยแล้วเรียกว่าการพิสูจน์
 *
 * วิธี: สุ่มหยิบผลไม้เทรดของทั้งสองชุดขึ้นมาใหม่ (bootstrap) หลายพันรอบ
 * แล้วนับว่ากี่รอบที่ชุด B ยังชนะ ถ้าชนะเกือบทุกรอบ = หลักฐานหนัก
 * ถ้าชนะแค่ครึ่ง ๆ = ความต่างที่เห็นเป็นเสียงรบกวน
 */
export function probBetter(aR, bR, { samples = 2000, seed = 987654321 } = {}) {
  if (!aR.length || !bR.length) return null;
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const meanOf = (list, n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += list[(rnd() * list.length) | 0];
    return sum / n;
  };
  let win = 0;
  for (let b = 0; b < samples; b++) if (meanOf(bR, bR.length) > meanOf(aR, aR.length)) win++;
  return win / samples;
}

/**
 * เรียนรู้ + พิสูจน์ในขั้นตอนเดียว — และ "ไม่เอามาใช้ถ้าพิสูจน์ไม่ผ่าน"
 *
 * นี่คือส่วนที่สำคัญที่สุดของไฟล์นี้ ไม่ใช่ตัวเรียนรู้
 *
 * เหตุผล: การจูนตัวเลขให้เข้ากับอดีตทำได้เสมอ และได้ผลสวยเสมอ
 * สิ่งที่พิสูจน์ว่าน้ำหนักชุดใหม่ "ดีกว่าจริง" มีอย่างเดียวคือ
 * เอาไปวัดกับข้อมูลที่ตอนเรียนรู้ไม่เคยเห็น แล้วมันต้องชนะของเดิม
 *
 *   ช่วงเรียนรู้ (60% แรก) → เก็บไม้ → ฟิตน้ำหนัก
 *   ช่วงสอบ (40% หลัง)    → เดินระบบสองรอบ ด้วยน้ำหนักเดิม vs น้ำหนักใหม่ → เทียบกัน
 *
 * ถ้าน้ำหนักใหม่ไม่ชนะ ฟังก์ชันนี้จะบอกตรง ๆ ว่าไม่ผ่าน และให้ใช้ของเดิมต่อ
 *
 * หมายเหตุ: ใช้เกณฑ์คะแนนต่ำกว่าตอนเรียนรู้ (learnThreshold) เพื่อเก็บตัวอย่างให้มากขึ้น
 * ถ้าเก็บเฉพาะไม้ที่คะแนนสูง เราจะเห็นแต่ตอนที่ทุกปัจจัยเห็นตรงกัน ซึ่งแยกไม่ออกว่าใครมีผลจริง
 */
export function learnAndValidate(ctx, opts = {}) {
  const keys = opts.keys;
  const base = opts.baseWeights;
  const threshold = opts.threshold === undefined ? 35 : opts.threshold;
  const learnThreshold = opts.learnThreshold === undefined ? Math.max(12, threshold - 15) : opts.learnThreshold;
  const btOpts = opts.backtest || {};
  const n = ctx.candles.length;
  const splitAt = Math.floor(n * (opts.splitRatio || 0.6));
  const warmup = btOpts.warmup === undefined ? 210 : btOpts.warmup;
  if (splitAt - warmup < 120) {
    return { ok: false, reason: 'ข้อมูลน้อยเกินไปสำหรับแบ่งช่วงเรียนรู้/ช่วงสอบ — โหลดแท่งเทียนเพิ่มก่อน' };
  }

  /* หยุดรับไม้ใหม่ก่อนถึงเส้นแบ่งเท่าระยะถือสูงสุด ไม้ที่ใช้เรียนรู้จึงปิดก่อนเส้นแบ่งแน่นอน */
  const inRun = runBacktest(ctx, { ...btOpts, threshold: learnThreshold, toIndex: embargoIndex(splitAt, btOpts) });
  const learned = learnWeights(inRun.trades, keys, base, opts);
  if (!learned.ok) return { ...learned, splitAt, learnThreshold, learnTrades: inRun.stats.n };

  // ช่วงสอบจริง: เดินระบบสองรอบบนแท่งเดียวกัน ต่างกันแค่ชุดน้ำหนัก
  const outBase = runBacktest(ctx, { ...btOpts, threshold, fromIndex: splitAt });
  const outNew = runBacktest({ ...ctx, cfg: { ...ctx.cfg, weights: learned.weights } },
    { ...btOpts, threshold, fromIndex: splitAt });

  const pack = (r) => ({
    n: r.stats.n,
    winRate: r.stats.winRate,
    expectancy: r.stats.expectancy,
    totalR: r.stats.totalR,
    ci: r.stats.n ? wilsonInterval(Math.round((r.stats.winRate / 100) * r.stats.n), r.stats.n) : null,
  });
  const a = pack(outBase), b = pack(outNew);
  const minN = opts.minOutTrades || 20;

  let verdict;
  if (a.n < minN || b.n < minN) {
    verdict = { level: 'unknown', apply: false,
      text: `ช่วงสอบมีไม้แค่ ${Math.min(a.n, b.n)} ไม้ (ต้องการ ${minN}) — น้อยเกินกว่าจะตัดสินว่าน้ำหนักชุดไหนดีกว่า ใช้ของเดิมต่อไปก่อน` };
  } else {
    const dE = b.expectancy - a.expectancy;
    const dW = b.winRate - a.winRate;
    const margin = opts.margin === undefined ? 0.05 : opts.margin;
    // ต้องผ่านสองด่าน: ดีขึ้นพอให้รู้สึกได้ *และ* พิสูจน์ได้ว่าไม่ใช่ความบังเอิญ
    const conf = opts.confidence === undefined ? 0.9 : opts.confidence;
    const pb = probBetter(outBase.trades.map((t) => t.rMultiple), outNew.trades.map((t) => t.rMultiple), opts);
    if (dE > margin && pb !== null && pb >= conf) {
      verdict = { level: 'better', apply: true, dE, dW, probBetter: pb,
        text: `ผ่าน — บนข้อมูลที่ตอนเรียนรู้ไม่เคยเห็น น้ำหนักชุดใหม่ให้ผลดีกว่า ${dE.toFixed(2)} R ต่อไม้ `
          + `(อัตราชนะ ${a.winRate.toFixed(1)}% → ${b.winRate.toFixed(1)}%) และสุ่มทดสอบซ้ำแล้วยังชนะ `
          + `${(pb * 100).toFixed(0)}% ของรอบ — กดใช้ได้` };
    } else if (dE < -margin) {
      verdict = { level: 'worse', apply: false, dE, dW, probBetter: pb,
        text: `ไม่ผ่าน — น้ำหนักชุดใหม่ให้ผล "แย่ลง" ${Math.abs(dE).toFixed(2)} R ต่อไม้บนข้อมูลที่ไม่เคยเห็น `
          + 'แปลว่ามันแค่จำอดีตได้ ไม่ได้เข้าใจตลาด — ใช้น้ำหนักเดิมต่อไป' };
    } else if (dE > margin) {
      verdict = { level: 'same', apply: false, dE, dW, probBetter: pb,
        text: `ยังไม่ผ่าน — ตัวเลขดีขึ้น ${dE.toFixed(2)} R ต่อไม้ก็จริง แต่พอสุ่มทดสอบซ้ำ ชุดใหม่ชนะแค่ `
          + `${(pb * 100).toFixed(0)}% ของรอบ (ต้องการ ${(conf * 100).toFixed(0)}%) — ยังแยกไม่ออกจากความบังเอิญ ใช้ของเดิมต่อไป` };
    } else {
      verdict = { level: 'same', apply: false, dE, dW, probBetter: pb,
        text: `เสมอ — ต่างกันแค่ ${dE.toFixed(3)} R ต่อไม้ ซึ่งอยู่ในระดับความบังเอิญ `
          + 'แปลว่าน้ำหนักที่ตั้งไว้เดิมก็ไม่ได้ผิด และการปรับน้ำหนักไม่ใช่จุดที่จะทำให้ระบบดีขึ้น' };
    }
  }

  return { ...learned, ok: true, splitAt, threshold, learnThreshold,
    learnTrades: inRun.stats.n, outBase: a, outNew: b, verdict };
}
