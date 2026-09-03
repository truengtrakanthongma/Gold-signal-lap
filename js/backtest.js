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
  /*
   * วิธีบริหารไม้หลังเข้า — เป็นตัวกำหนดว่า "ชนะ" แล้วได้เท่าไรจริง ๆ
   *
   *  'partial'  ปิดครึ่งที่ 1R เลื่อน SL มาที่ทุน ที่เหลือวิ่งต่อ
   *             → อัตราชนะดูสูง แต่ไม้ที่ถูกเขี่ยที่ทุนได้แค่ +0.5R
   *  'full'     ถือเต็มไม้ถึงเป้า ไม่ปิดบางส่วน ไม่เลื่อน SL
   *             → ชนะทีได้เต็มเป้า แพ้ทีเสีย 1R เต็ม ไม่มีไม้กำไรจิ๊บจ๊อย
   *  'full-be'  ถือเต็มไม้ แต่เลื่อน SL มาที่ทุนเมื่อผ่าน 1R
   *             → ชนะได้เต็มเป้า ไม้ที่ย้อนกลับมาได้ 0R (เสมอตัว) แทนที่จะขาดทุน
   *  'trail'    ไม่มีเป้าตายตัว ลากจุดตัดขาดทุนตามยอดที่ทำได้ (Chandelier Exit)
   *             → ไม้ที่วิ่งยาวได้เต็มระยะ แต่ทุกไม้ต้องคืนกำไรส่วนหนึ่งตอนออก
   *  'trail-1R' ปิดครึ่งที่ 1R แล้วลากที่เหลือ — ท่าผสมที่ตำราส่วนใหญ่แนะนำ
   *
   * วัดบนข้อมูลจำลองสองระบอบแล้วได้ผลตรงกับที่ตำราบอกเป๊ะ ๆ:
   *   ตลาดมีเทรนด์ยาว  → ลากชนะขาด (5.20R ต่อไม้ เทียบกับเป้าตายตัว 0.97R)
   *   ตลาดออกข้าง      → ลากแย่เกือบที่สุด (-0.66R เทียบกับเป้าตายตัว -0.49R)
   * เพราะการลากคือการยอมคืนกำไรส่วนปลายทุกไม้ เพื่อแลกกับการเก็บไม้ที่วิ่งยาว
   * ถ้าไม่มีไม้วิ่งยาวให้เก็บ ก็เหลือแต่ส่วนที่คืนไป
   */
  exitStyle: 'partial',
  /*
   * Chandelier Exit — Chuck LeBeau
   *
   * จุดตัดขาดทุนอยู่ใต้ "ยอดสูงสุดนับจากเข้าไม้" ลงมา k เท่าของ ATR
   * ขยับได้ทางเดียวคือตามราคาไป ไม่มีถอยหลัง ต้นฉบับใช้ k = 3
   *
   * เหตุผลที่ตำราให้ไว้: เป้าตายตัวตัดไม้ที่กำลังวิ่งยาวทิ้งไปด้วย
   * ส่วนการลากตามจะเก็บไม้ยาว ๆ ไว้ได้ แลกกับการคืนกำไรส่วนปลายทุกไม้
   * อันไหนคุ้มกว่าสำหรับทองกรอบ 15 นาที ต้องวัด ไม่ใช่เชื่อตาม
   */
  trailAtrMult: 3,
};

/** สไตล์ที่ลากจุดตัดขาดทุนตามราคา (ไม่มีเป้าตายตัว) */
export const isTrailStyle = (style) => style === 'trail' || style === 'trail-1R';

/**
 * ดัชนีสุดท้ายที่ยังรับไม้ใหม่ได้ โดยรับประกันว่าไม้จะปิดก่อนเส้นแบ่ง
 *
 * ทำไมต้องมี: toIndex จำกัดแค่ "แท่งที่เข้าไม้" ไม่ได้จำกัดแท่งที่ปิดไม้
 * ไม้ที่เข้าตอนใกล้เส้นแบ่งจึงถือข้ามไปปิดในช่วงสอบได้ แปลว่าผลแพ้ชนะ
 * ของไม้ที่เอาไปเรียนรู้ ถูกตัดสินด้วยข้อมูลที่ยังไม่ควรรู้
 *
 * ตรวจพบตอนเพิ่มปัจจัยใหม่แล้วเทสต์เส้นแบ่งล้ม — บั๊กนี้ซ่อนอยู่ก่อนหน้านั้น
 * และไม่ล้มเพราะบังเอิญไม่มีไม้ไหนคาบเกี่ยวพอดี ไม่ใช่เพราะกันไว้จริง
 * (adapt.js กันเรื่องนี้ไว้อยู่แล้ว ที่นี่คือเอามาใช้ให้ทั่วถึง)
 */
export function embargoIndex(splitAt, opts = {}) {
  const maxHold = opts.maxHold === undefined ? DEFAULT_BT.maxHold : opts.maxHold;
  return Math.max(0, splitAt - (maxHold + 2));
}

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

    const style = o.exitStyle;
    let exitIdx = null, result = null, rMultiple = 0, hit1R = false;
    let maxFav = 0, maxAdv = 0;
    const trailing = isTrailStyle(style);
    /* จุดตัดขาดทุนที่ลากตามได้ เริ่มที่ SL เดิมเสมอ การลากจึงทำได้แต่ทาง
       "ปลอดภัยขึ้น" ไม่มีทางที่การลากจะทำให้ความเสี่ยงเริ่มต้นบานปลาย */
    let trailStop = sl;
    let runHigh = -Infinity, runLow = Infinity;

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

      if (trailing) {
        /*
         * *** ลำดับสำคัญมาก ***
         * ต้องเช็คว่าโดนจุดตัดขาดทุน "ที่คำนวณไว้จากข้อมูลถึงแท่งก่อนหน้า" ก่อน
         * แล้วค่อยเอายอด/ก้นของแท่งนี้ไปขยับจุดตัดสำหรับแท่งถัดไป
         *
         * ถ้าสลับลำดับ = เอายอดของแท่งนี้ไปเลื่อนจุดตัดแล้วค่อยเช็คแท่งเดียวกัน
         * เท่ากับรู้ล่วงหน้าว่าแท่งนี้จะขึ้นไปถึงไหน ซึ่งตอนเทรดจริงไม่มีทางรู้
         */
        const hitTrail = side > 0 ? b.l <= trailStop : b.h >= trailStop;
        if (hitTrail) {
          exitIdx = j;
          favBeforeStop = trailStop === sl ? favPrev : maxFav;
          const stopR = (side > 0 ? trailStop - entry : entry - trailStop) / slDist;
          rMultiple = stopR - o.slippage / slDist;
          if (style === 'trail-1R' && hit1R) rMultiple = 0.5 + 0.5 * rMultiple;
          result = rMultiple > 0.05 ? 'trail-win' : (rMultiple < -0.05 ? 'loss' : 'be');
          break;
        }
        favBeforeStop = maxFav;
        /* ต้องบันทึกว่าเคยผ่าน 1R ทุกสไตล์ที่ลาก ไม่ใช่เฉพาะแบบผสม
           เพราะ hit1R เป็นตัวนับ "อัตราชนะ" ของรายงาน ไม่ได้ใช้แค่ตัดสินใจออก
           ถ้าไม่เซ็ต รายงานจะขึ้นอัตราชนะ 0% ทั้งที่ไม้กำไรมีอยู่จริง */
        if (!hit1R && hitTP1) hit1R = true;

        runHigh = Math.max(runHigh, b.h);
        runLow = Math.min(runLow, b.l);
        const aj = ctx.atr[j];
        // แบบผสมจะเริ่มลากหลังปิดครึ่งแรกแล้วเท่านั้น ก่อนหน้านั้นใช้ SL เดิม
        const mayTrail = style !== 'trail-1R' || hit1R;
        if (mayTrail && Number.isFinite(aj) && aj > 0) {
          const k = o.trailAtrMult;
          trailStop = side > 0 ? Math.max(trailStop, runHigh - k * aj)
                               : Math.min(trailStop, runLow + k * aj);
        }
        continue;
      }

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
      if (style === 'full' || style === 'full-be') {
        /*
         * ถือเต็มไม้ถึงเป้าเดียว — ไม่ปิดบางส่วน
         *
         * เหตุผล: การปิดครึ่งที่ 1R ทำให้ "ชนะ" ครึ่งหนึ่งได้แค่ +0.5R
         * ทั้งที่ตอนแพ้เสียเต็ม -1R อัตราชนะที่ต้องได้จึงสูงกว่าที่ตาเห็นมาก
         * แบบนี้ชนะทีได้เต็มเป้า ตัวเลขที่เห็นจึงตรงกับสิ่งที่เกิดขึ้นจริง
         */
        if (hitTP1) hit1R = true;
        if (hitTP2) { exitIdx = j; result = 'win2R'; rMultiple = 2; break; }
        if (style === 'full-be' && hit1R) {
          const hitBE = side > 0 ? b.l <= entry : b.h >= entry;
          if (hitBE) { exitIdx = j; result = 'be'; rMultiple = 0; break; }
        }
        continue;
      }
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
      if (trailing) {
        // ลากอยู่แล้วหมดเวลาถือ = ปิดที่ราคาตลาด ครึ่งแรกที่ปิดไปแล้วยังนับให้
        rMultiple = (style === 'trail-1R' && hit1R) ? 0.5 + 0.5 * openR : openR;
      } else {
        rMultiple = (style === 'full' || style === 'full-be')
          ? openR                                   // ถือเต็มไม้: ปิดที่ราคาตลาดตรง ๆ
          : (hit1R ? 0.5 + Math.max(0, openR) * 0.5 : openR);
      }
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
      exitStyle: style,
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
      /*
       * อัตราชนะที่มีความหมายจริง
       *
       * "ชนะ" ที่ได้กำไร 0.5R ตอนที่แพ้ทีเสีย 1R ไม่ใช่ชนะจริง — ต้องชนะสองไม้
       * ถึงจะลบล้างการแพ้หนึ่งไม้ได้ ตัวเลขอัตราชนะจึงหลอกตาได้ง่ายมาก
       *
       * realWinRate นับเฉพาะไม้ที่ได้กำไร "อย่างน้อยเท่าที่เสี่ยงไป" (>= 1R)
       * ซึ่งเป็นเส้นแบ่งที่ทำให้ชนะหนึ่งไม้ลบล้างแพ้หนึ่งไม้ได้พอดี
       */
      realWinRate: n ? (trades.filter((t) => t.rMultiple >= 1).length / n) * 100 : null,
      avgWin: (() => {
        const w = trades.filter((t) => t.rMultiple > 0);
        return w.length ? w.reduce((a, t) => a + t.rMultiple, 0) / w.length : null;
      })(),
      smallWinShare: n ? (trades.filter((t) => t.rMultiple > 0 && t.rMultiple < 1).length / n) * 100 : null,
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
  /*
   * การกวาดหาเป้าหมายอ่านค่า favBeforeStop ("ไปได้ไกลสุดกี่ R ก่อนโดน SL")
   * แต่สไตล์ลากจุดตัดขาดทุนจะตัดไม้ออกกลางทาง ค่านั้นจึงถูกตัดสั้นไปด้วย
   * ถ้าปล่อยให้ผ่าน จะได้ตารางเป้าหมายที่ตัวเลขต่ำกว่าความจริงโดยไม่มีใครรู้
   * บังคับกลับเป็นเป้าตายตัวและบอกให้รู้ ดีกว่าคืนตัวเลขผิดเงียบ ๆ
   */
  if (isTrailStyle(o.exitStyle)) o.exitStyle = 'partial';
  const n = ctx.candles.length;
  const splitAt = Math.floor(n * (o.splitRatio || 0.6));
  if (splitAt - o.warmup < 80) return { ok: false, reason: 'ข้อมูลน้อยเกินไปสำหรับหาค่าที่ดีที่สุด' };

  const slMults = o.slMults || [1.0, 1.25, 1.5, 2.0, 2.5];
  const thresholds = o.thresholds || [20, 25, 30, 35, 40, 45, 50];
  // พื้นขั้นต่ำของเป้าหมาย — เป้าที่เตี้ยกว่านี้ไม่ให้เข้ารอบเลย
  // ไม่ใช่แค่ไม่เลือก แต่ไม่ให้ปรากฏในผลการกวาดหาด้วย จะได้ไม่มีใครเผลอหยิบไปใช้
  const floorR = ctx.cfg.minTargetR === undefined ? 1.0 : ctx.cfg.minTargetR;
  const targets = (o.targets || [0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]).filter((t) => t >= floorR);
  // จำนวนไม้ขั้นต่ำต้องปรับตามข้อมูลที่มี — ถ้าตั้งไว้ตายตัวสูงเกินไป
  // ระบบจะหาไม่เจอเลยแล้วถอยไปใช้ค่าตั้งต้นเงียบ ๆ ซึ่งเสียประโยชน์ทั้งหมด
  const usableBars = splitAt - o.warmup;
  const minTrades = o.minTrades || Math.max(10, Math.round(usableBars / 30));

  const grid = [];
  for (const slAtrMult of slMults) {
    const tuned = { ...ctx, cfg: { ...ctx.cfg, slAtrMult } };
    for (const threshold of thresholds) {
      const r = runBacktest(tuned, { ...o, threshold, toIndex: embargoIndex(splitAt, o) });
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
  const inRun = runBacktest(tunedCtx, { ...o, threshold: best.threshold, toIndex: embargoIndex(splitAt, o) });
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
    const r = runBacktest(ctx, { ...o, threshold, toIndex: embargoIndex(splitAt, o) });
    return { threshold, n: r.stats.n, winRate: r.stats.winRate, expectancy: r.stats.expectancy, totalR: r.stats.totalR };
  });

  // เลือกเกณฑ์ที่ค่าคาดหวังดีที่สุด แต่ต้องมีตัวอย่างพอ (>= 12 ไม้) ไม่งั้นเป็นความบังเอิญ
  const usable = sweep.filter((x) => x.n >= 12 && x.expectancy !== null);
  const best = usable.sort((a, b) => b.expectancy - a.expectancy)[0] || null;
  if (!best) return { ok: false, reason: 'ช่วงเรียนรู้ไม่มีเกณฑ์ไหนสร้างไม้ได้มากพอจะสรุป', sweep, splitAt };

  const inSample = runBacktest(ctx, { ...o, threshold: best.threshold, toIndex: embargoIndex(splitAt, o) });
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

/**
 * เทียบวิธีบริหารไม้บนข้อมูลของผู้ใช้เอง — แล้วให้ข้อมูลเป็นคนเลือก
 *
 * ทำไมต้องมี: ตำราแต่ละเล่มเชียร์คนละท่า และวัดบนข้อมูลจำลองแล้วพบว่า
 * "ท่าไหนดีที่สุด" พลิกไปมาตามลักษณะตลาดจริง ๆ ไม่ใช่มีคำตอบเดียว
 *   ตลาดมีเทรนด์ยาว → ลากจุดตัดขาดทุนชนะขาด
 *   ตลาดออกข้าง     → ลากแย่เกือบที่สุด เป้าตายตัวดีกว่า
 * เคยลองให้ ADX เป็นคนเลือกอัตโนมัติแล้ววัดดู ปรากฏว่าไม่ช่วยเลย
 * (ทุกเส้นแบ่งที่ลอง ได้ผลอยู่ระหว่างสองท่าปลาย ไม่ชนะท่าไหนสักท่า)
 * จึงไม่ใส่ไว้ ให้ตัดสินจากข้อมูลจริงของผู้ใช้แทน
 *
 * วิธี: เลือกท่าจาก "ช่วงเรียน" แล้วพิสูจน์บน "ช่วงสอบ" ที่ไม่เคยเห็น
 * ถ้าท่าที่เลือกไว้ไม่ชนะตอนสอบ = การเลือกนั้นคือการจูนเข้ากับอดีต ต้องบอกตรง ๆ
 */
const BASE_STYLE = 'partial';

/*
 * โอกาสที่ชุด a ดีกว่าชุด b จริง ไม่ใช่บังเอิญ — สุ่มเลือกไม้ซ้ำแบบคืนที่ (bootstrap)
 *
 * เขียนไว้ในไฟล์นี้เองแทนที่จะยืม probBetter จาก learn.js
 * เพราะ learn.js เรียกใช้ backtest.js อยู่แล้ว ถ้าเรียกกลับจะกลายเป็นวงกลม
 * ซึ่งตัวรวมไฟล์เป็นหน้าเดียวรับไม่ได้ (โมดูลถูกต่อกันตามลำดับ ไม่มีการวนกลับ)
 */
function probBetterR(a, b, { samples = 2000, seed = 424242 } = {}) {
  if (!a.length || !b.length) return null;
  let st = seed >>> 0;
  const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
  let winsA = 0;
  for (let s = 0; s < samples; s++) {
    let sa = 0, sb = 0;
    for (let k = 0; k < a.length; k++) sa += a[(rnd() * a.length) | 0];
    for (let k = 0; k < b.length; k++) sb += b[(rnd() * b.length) | 0];
    if (sa / a.length > sb / b.length) winsA++;
  }
  return winsA / samples;
}

export function compareExitStyles(ctx, opts = {}) {
  const o = { ...DEFAULT_BT, ...opts };
  const styles = o.styles || ['partial', 'full', 'full-be', 'trail', 'trail-1R'];
  const n = ctx.candles.length;
  const splitAt = Math.floor(n * (o.splitRatio || 0.6));
  if (splitAt - o.warmup < 80) return { ok: false, reason: 'ข้อมูลน้อยเกินไปสำหรับเทียบวิธีบริหารไม้' };

  const rowFor = (style, runOpts) => {
    const r = runBacktest(ctx, { ...o, exitStyle: style, ...runOpts });
    const rs = r.trades.map((t) => t.rMultiple);
    return {
      style, n: r.stats.n, winRate: r.stats.winRate, expectancy: r.stats.expectancy,
      totalR: r.stats.totalR, maxDD: r.stats.maxDD, avgBars: r.stats.avgBars, rs,
    };
  };

  // เลือกจากช่วงเรียน — ต้องมีระยะกันชนไม่ให้ไม้ถือข้ามเส้นแบ่งไปอ่านช่วงสอบ
  const learn = styles.map((st) => rowFor(st, { toIndex: embargoIndex(splitAt, o) }));
  const ranked = [...learn].sort((a, b) => (b.expectancy || -Infinity) - (a.expectancy || -Infinity));
  const pick = ranked[0];
  const test = styles.map((st) => rowFor(st, { fromIndex: splitAt }));
  const testBy = new Map(test.map((r) => [r.style, r]));

  const picked = testBy.get(pick.style);
  const base = testBy.get(BASE_STYLE);
  const enough = picked && base && picked.n >= 20 && base.n >= 20;
  const testWinner = [...test].sort((a, b) => (b.expectancy || -Infinity) - (a.expectancy || -Infinity))[0];
  const name = (st) => `"${st}"`;

  let verdict, level, prob = null;
  if (!enough) {
    verdict = 'ไม้ในช่วงสอบยังน้อยเกินกว่าจะสรุปว่าท่าไหนดีกว่า — ใช้ค่าตั้งต้นไปก่อน';
    level = 'unknown';
  } else if (pick.style === BASE_STYLE) {
    /*
     * ช่วงเรียนเลือกค่าตั้งต้นเอง — ไม่มีอะไรให้เปลี่ยน
     * เคสนี้ต้องแยกออกมา ไม่งั้นจะกลายเป็นเอาค่าตั้งต้นไปเทียบกับตัวเอง
     * แล้วสรุปว่า "แพ้ค่าตั้งต้น" ทั้งที่เป็นตัวเลขเดียวกันเป๊ะ
     */
    if (testWinner.style === BASE_STYLE) {
      verdict = `ช่วงเรียนเลือกค่าตั้งต้น (${name(BASE_STYLE)}) และตอนสอบก็ยังดีที่สุดอยู่ — ไม่ต้องเปลี่ยนอะไร`;
      level = 'confirmed';
    } else {
      verdict = `ช่วงเรียนเลือกค่าตั้งต้น (${name(BASE_STYLE)}) แต่ตอนสอบ ${name(testWinner.style)} ทำได้ดีกว่า `
        + `(${testWinner.expectancy.toFixed(3)}R เทียบกับ ${base.expectancy.toFixed(3)}R) — `
        + 'ยังไม่คงเส้นคงวาพอจะเปลี่ยนตาม ถ้าอยากลองให้เก็บข้อมูลเพิ่มแล้วทดสอบใหม่';
      level = 'weak';
    }
  } else {
    /*
     * ต่างกันนิดเดียวบนไม้ไม่กี่สิบไม้ = บังเอิญได้ ไม่ใช่หลักฐาน
     * สุ่มเลือกไม้ซ้ำ ๆ (bootstrap) เพื่อดูว่า "ดีกว่า" ทนต่อการสลับไม้แค่ไหน
     */
    prob = probBetterR(picked.rs, base.rs);
    const better = picked.expectancy > base.expectancy;
    if (better && testWinner.style === pick.style && prob >= 0.9) {
      verdict = `เลือก ${name(pick.style)} จากช่วงเรียน แล้วชนะจริงตอนสอบด้วย `
        + `(${picked.expectancy.toFixed(3)}R ต่อไม้ เทียบกับค่าตั้งต้น ${base.expectancy.toFixed(3)}R `
        + `· โอกาสที่ดีกว่าจริงไม่ใช่บังเอิญ ${(prob * 100).toFixed(0)}%) — ใช้ได้`;
      level = 'confirmed';
    } else if (better) {
      verdict = `${name(pick.style)} ดีกว่าค่าตั้งต้นตอนสอบ แต่ยังไม่พอสรุป `
        + `(${testWinner.style === pick.style ? `โอกาสที่ดีกว่าจริงแค่ ${(prob * 100).toFixed(0)}%`
          : `ท่าที่ดีที่สุดตอนสอบคือ ${name(testWinner.style)}`}) — ความต่างระหว่างท่ายังไม่คงเส้นคงวา`;
      level = 'weak';
    } else {
      verdict = `เลือก ${name(pick.style)} จากช่วงเรียน แต่ตอนสอบแพ้ค่าตั้งต้น `
        + `(${picked.expectancy.toFixed(3)}R เทียบกับ ${base.expectancy.toFixed(3)}R) — `
        + 'แปลว่าการเลือกท่าจากอดีตคือการจูนเข้ากับอดีต ไม่ควรเปลี่ยนตาม';
      level = 'failed';
    }
  }

  const strip = (r) => { const { rs, ...rest } = r; return rest; };
  return {
    ok: true, splitAt, learn: learn.map(strip), test: test.map(strip),
    pick: pick.style, verdict, level, prob,
    recommend: level === 'confirmed' ? pick.style : BASE_STYLE,
  };
}
