/**
 * system.js — กติกาเทรดของระบบ (ชุดเดียว ใช้ร่วมกันทุกที่)
 *
 * หน้าเว็บ บอท Discord การทดสอบย้อนหลัง และตัวเลขอ้างอิง 4 ปี ต่างเรียกฟังก์ชันในไฟล์นี้
 * ไม่มีโค้ดตัดสินใจชุดที่สองที่ไหนอีก — ระบบเก่าเคยมีสองมาตรฐาน (บอทกับเว็บคิดคนละสูตร)
 * และเคยวัดผลด้วยตัวจำลองคนละตัวกับที่ใช้ให้สัญญาณจริง ตัวเลขจึงเชื่อไม่ได้ทั้งคู่
 *
 * ─────────────────────────────────────────────────────────────────────────
 * กติกา (ได้มาจากการวัดบนทองจริง XAU/USD 2022-2025 ไม่ใช่จากตำรา)
 *
 *  1. เทรนด์ใหญ่ — กราฟรายวัน (เฉพาะแท่งที่ปิดแล้ว)
 *       ขาขึ้น:  ราคาปิด > EMA50  และ  EMA20 > EMA50
 *       ขาลง:   ราคาปิด < EMA50  และ  EMA20 < EMA50
 *       นอกนั้น = ไม่มีเทรนด์ → ไม่เทรด
 *  2. จังหวะเข้า — กราฟ 4 ชั่วโมง ตอนแท่งปิด
 *       ขาขึ้น: ราคาปิดย่อลงมาต่ำกว่า EMA20 ของกราฟ 4 ชม. → ซื้อ
 *       ขาลง:  ราคาปิดเด้งขึ้นเหนือ EMA20 ของกราฟ 4 ชม. → ขาย
 *  3. เข้าที่ราคาเปิดของแท่งถัดไป · ตัดขาดทุน 2 × ATR(14) · ทำกำไร 2 เท่าของที่เสี่ยง
 *  4. ถือไม่เกิน 36 แท่ง (6 วัน) · ออกไม้แล้วพัก 6 แท่ง (24 ชม.) · ถือทีละไม้เดียว
 *
 * ผลบนทองจริง 4 ปี: 165 ไม้ ชนะ 45% ได้เฉลี่ย +0.29 เท่าของที่เสี่ยงต่อไม้ หลังหักต้นทุน
 * กำไรทุกปีรวมถึงปี 2023 ที่ตลาดออกข้าง · ดูรายละเอียดและข้อจำกัดใน reference.js
 *
 * กำไรส่วนใหญ่มาจากข้อ 1 (ตามเทรนด์ใหญ่) — สุ่มเข้าตอนไหนก็ได้ในเทรนด์ยังได้ +0.24R
 * ข้อ 2 (รอย่อ) ช่วยเพิ่มอีกนิดและทำให้รอดปีที่ตลาดออกข้าง
 * ระบบเก่าขาดทุนเพราะไม่มีข้อ 1: เปิดขายสวนตลาดขาขึ้น 1,927 ครั้ง เสียไป 176R
 * ─────────────────────────────────────────────────────────────────────────
 */
import { ema, atr } from './indicators.js';
import { spotOpenAt } from './macro.js';

export const RULE = {
  trendFast: 20,     // EMA เร็วของกราฟรายวัน
  trendSlow: 50,     // EMA ช้าของกราฟรายวัน
  pullbackEma: 20,   // EMA ของกราฟ 4 ชม. ที่ใช้วัดว่าราคา "ย่อ" แล้ว
  atrPeriod: 14,
  stopAtr: 2,        // ระยะตัดขาดทุน = กี่เท่าของ ATR
  targetR: 2,        // เป้ากำไร = กี่เท่าของระยะที่เสี่ยง
  maxHold: 36,       // ถือได้กี่แท่ง 4 ชม. ก่อนปิดทิ้งที่ราคาตลาด (6 วัน)
  cooldown: 6,       // ออกไม้แล้วต้องพักกี่แท่งก่อนเข้าใหม่ (24 ชม.)
};

/*
 * ต้นทุนต่อไม้ — ราคาในข้อมูลเป็นราคา bid ซื้อจึงจ่ายแพงกว่าหนึ่งสเปรด
 * สลิปเพจคิดเฉพาะตอนโดน SL เพราะเป็นคำสั่ง stop ที่ได้ราคาแย่กว่าที่ตั้งเสมอ
 */
export const COSTS = { spread: 0.30, slip: 0.10 };

export const H4 = 4 * 3600000;
export const D1 = 86400000;

/* ── เตรียมข้อมูล ─────────────────────────────────────────────────────── */

/**
 * รวมแท่งเล็กเป็นแท่งใหญ่ (เช่น 1 ชม. → 4 ชม.) โดยนับเวลาเริ่มจาก 00:00 UTC
 * ใช้กับแหล่งที่ไม่มีกราฟ 4 ชม. ให้ตรง ๆ — ทุกแหล่งจึงได้แท่งที่ตั้งเวลาเหมือนกัน
 * แท่งสุดท้ายยังไม่ปิดถ้าแท่งย่อยตัวสุดท้ายยังไม่ปิด หรือเวลายังไม่ครบกรอบ
 */
export function resample(bars, spanMs, now = Date.now()) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const k = Math.floor(b.t / spanMs) * spanMs;
    if (!cur || cur.t !== k) {
      if (cur) out.push(cur);
      cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, closed: true };
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0;
    }
    if (b.closed === false) cur.closed = false;
  }
  if (cur) { if (cur.t + spanMs > now) cur.closed = false; out.push(cur); }
  return out;
}

/**
 * ทำเครื่องหมายแท่งที่ยังไม่ปิด ตามเวลาจริง ไม่ใช่ตามที่แหล่งข้อมูลบอก
 *
 * ตัวแปลงข้อมูลของหลายแหล่งติดป้าย closed: true ให้ทุกแท่ง รวมแท่งที่กำลังก่อตัวอยู่ด้วย
 * ถ้าเชื่อป้ายนั้น ระบบจะตัดสินสัญญาณจากแท่งที่ยังไม่จบ ซึ่งราคาปิดยังเปลี่ยนได้อีก
 * สัญญาณจะโผล่แล้วหายกลางแท่ง และไม่ตรงกับที่ทดสอบย้อนหลังไว้
 */
export function markClosed(bars, spanMs, now = Date.now()) {
  return bars.map((b) => ({ ...b, closed: b.closed !== false && b.t + spanMs <= now }));
}

/**
 * ตัดแท่งที่ตลาดทอง spot ปิดทั้งแท่งทิ้ง
 *
 * แหล่งราคาฟรีเป็นเหรียญทองที่ซื้อขาย 24/7 จึงมีแท่งวันเสาร์-อาทิตย์ที่ราคานิ่ง ๆ ปนมา
 * ถ้าปล่อยไว้ EMA กับ ATR จะถูกลากด้วยช่วงที่ตลาดจริงไม่ได้เปิด
 * กติกาถูกวัดบนทอง spot ซึ่งไม่มีแท่งพวกนี้ จึงต้องทำข้อมูลให้หน้าตาเดียวกัน
 * (วัดแล้ว: ตัดหรือไม่ตัดแท่งเสาร์-อาทิตย์ของกราฟรายวัน ได้ผลแทบเท่ากัน — +0.279R ทั้งคู่)
 */
export function spotBarsOnly(bars, spanMs) {
  const probes = Math.max(1, Math.round(spanMs / 3600000));
  const step = spanMs / probes;
  return bars.filter((b) => {
    for (let k = 0; k < probes; k++) if (spotOpenAt(b.t + step * k + step / 2)) return true;
    return false;
  });
}

/** สถานะเทรนด์ของกราฟรายวันทีละแท่ง */
export function trendSeries(d1, rule = RULE) {
  const c = d1.map((b) => b.c);
  const fast = ema(c, rule.trendFast), slow = ema(c, rule.trendSlow);
  return d1.map((b, i) => {
    const f = fast[i], s = slow[i];
    if (f === null || s === null) return { side: 0, ready: false, close: b.c, fast: f, slow: s };
    const up = b.c > s && f > s, down = b.c < s && f < s;
    return { side: up ? 1 : down ? -1 : 0, ready: true, close: b.c, fast: f, slow: s, t: b.t };
  });
}

/**
 * จับคู่เทรนด์รายวันให้แท่ง 4 ชม. — ใช้ได้เฉพาะแท่งรายวันที่ "ปิดแล้ว" ก่อนแท่ง 4 ชม. นั้นปิด
 * นี่คือจุดที่ง่ายที่สุดที่จะมองอนาคตโดยไม่รู้ตัว: ถ้าใช้แท่งรายวันที่ยังไม่ปิด
 * การทดสอบย้อนหลังจะรู้ราคาปิดของวันนั้นล่วงหน้า แล้วตัวเลขจะสวยเกินจริง
 */
export function alignTrend(h4, d1, trend) {
  const out = new Array(h4.length).fill(null);
  let j = -1;
  for (let i = 0; i < h4.length; i++) {
    while (j + 1 < d1.length && d1[j + 1].closed !== false && d1[j + 1].t + D1 <= h4[i].t + H4) j++;
    out[i] = j >= 0 ? trend[j] : null;
  }
  return out;
}

/**
 * เตรียมทุกอย่างที่กติกาต้องใช้ในครั้งเดียว
 * h4, d1 = แท่งเรียงเก่า→ใหม่ แท่งสุดท้ายยังไม่ปิดได้ (closed: false)
 */
export function buildSystem(h4, d1, rule = RULE) {
  const c = h4.map((b) => b.c);
  const trend = trendSeries(d1, rule);
  return {
    h4, d1, rule, trend,
    ema: ema(c, rule.pullbackEma),
    atr: atr(h4, rule.atrPeriod),
    trendAt: alignTrend(h4, d1, trend),
  };
}

/* ── สัญญาณ ─────────────────────────────────────────────────────────── */

/**
 * อ่านสถานะกติกาที่แท่ง i (ต้องปิดแล้ว) — คืนเหตุผลครบทุกข้อ ไม่ใช่แค่ใช่/ไม่ใช่
 * หน้าจอเอารายการ checks ไปแสดงเป็นเช็คลิสต์ ผู้ใช้จะเห็นว่าขาดข้อไหน
 */
export function signalAt(sys, i) {
  const bar = sys.h4[i];
  const tr = sys.trendAt[i];
  const e = sys.ema[i], a = sys.atr[i];
  if (!bar || !tr || !tr.ready || e === null || !a) {
    return { side: 0, ready: false, trend: 0, checks: [], reason: 'ข้อมูลยังไม่พอให้เส้นค่าเฉลี่ยนิ่ง' };
  }
  const trendSide = tr.side;
  const dipLong = bar.c < e, dipShort = bar.c > e;
  /*
   * ถ้ายังไม่มีเทรนด์ ให้เช็คตามทางที่ "เอียง" อยู่ (ราคาอยู่ฝั่งไหนของเส้น 50 วัน)
   * ผู้ใช้จะอ่านได้ว่า "เกือบเป็นขาขึ้นแล้ว ขาดอีกข้อเดียว" แทนที่จะเห็นกากบาทล้วน
   */
  const lean = trendSide || (tr.close > tr.slow ? 1 : -1);
  const beyond = (a, b) => (lean > 0 ? a > b : a < b);
  const c1 = beyond(tr.close, tr.slow), c2 = beyond(tr.fast, tr.slow);
  const f2 = (v) => v.toFixed(2);
  const checks = [
    { key: 'd1-close', ok: c1,
      text: `ราคาปิดรายวัน ${f2(tr.close)} ${lean > 0 ? (c1 ? 'อยู่เหนือ' : 'ยังอยู่ใต้') : (c1 ? 'อยู่ใต้' : 'ยังอยู่เหนือ')}เส้นค่าเฉลี่ย 50 วัน (${f2(tr.slow)})` },
    { key: 'd1-cross', ok: c2,
      text: `เส้นค่าเฉลี่ย 20 วัน (${f2(tr.fast)}) ${lean > 0 ? (c2 ? 'อยู่เหนือ' : 'ยังอยู่ใต้') : (c2 ? 'อยู่ใต้' : 'ยังอยู่เหนือ')}เส้น 50 วัน` },
    { key: 'h4-dip', ok: trendSide > 0 ? dipLong : trendSide < 0 ? dipShort : null,
      text: !trendSide
        ? 'กราฟ 4 ชม.: จะดูจังหวะเข้าต่อเมื่อเทรนด์ใหญ่ชัดแล้ว'
        : trendSide > 0
          ? `กราฟ 4 ชม.: ราคาปิด ${f2(bar.c)} ${dipLong ? 'ย่อลงมาใต้' : 'ยังอยู่เหนือ'}เส้นค่าเฉลี่ย 20 แท่ง (${f2(e)})`
          : `กราฟ 4 ชม.: ราคาปิด ${f2(bar.c)} ${dipShort ? 'เด้งขึ้นเหนือ' : 'ยังอยู่ใต้'}เส้นค่าเฉลี่ย 20 แท่ง (${f2(e)})` },
  ];
  const side = trendSide > 0 && dipLong ? 1 : trendSide < 0 && dipShort ? -1 : 0;
  return {
    side, ready: true, trend: trendSide, checks,
    price: bar.c, ema: e, atr: a, trendInfo: tr,
    reason: side ? (side > 0 ? 'เทรนด์ใหญ่ขาขึ้น และราคาย่อถึงจุดเข้าแล้ว' : 'เทรนด์ใหญ่ขาลง และราคาเด้งถึงจุดเข้าแล้ว')
      : trendSide ? (trendSide > 0 ? 'เทรนด์ใหญ่ขาขึ้น รอราคาย่อ' : 'เทรนด์ใหญ่ขาลง รอราคาเด้ง')
      : 'เทรนด์ใหญ่ยังไม่ชัด — ไม่เทรด',
  };
}

/* ── จำลองการเทรด ───────────────────────────────────────────────────── */

/**
 * เดินกติกาไปทีละแท่งตั้งแต่ต้นจนจบ แล้วคืนไม้ทั้งหมด + ไม้ที่ยังเปิดอยู่ตอนท้าย
 *
 * ใช้ทั้งทดสอบย้อนหลังและบอกสถานะตอนนี้ — ไม้สุดท้ายที่ยังไม่ปิดคือ "ระบบถืออยู่"
 * การแยกสองอย่างนี้ออกจากกันคือสิ่งที่ทำให้ระบบเก่าบอกอย่างหนึ่งแต่วัดอีกอย่าง
 *
 * ราคาเป็น bid: ซื้อเข้า = bid + สเปรด · ปิด short = bid + สเปรด
 * ความเสี่ยงต่อไม้ = ระยะถึง SL + สเปรด ทั้งสองฝั่ง
 * แท่งเดียวแตะทั้ง SL และ TP → ถือว่าโดน SL ก่อน (มองแง่ร้ายไว้ก่อนเสมอ)
 */
export function runSystem(sys, { costs = COSTS, from = 0, to, longOnly = false } = {}) {
  const { h4, rule } = sys;
  const end = Math.min(to === undefined ? h4.length : to, h4.length);
  const trades = [];
  let open = null;
  let lastExit = -Infinity;
  let i = Math.max(from, 1);

  while (i < end - 1) {
    if (h4[i].closed === false || i - lastExit < rule.cooldown) { i++; continue; }
    const s = signalAt(sys, i);
    if (!s.side || (longOnly && s.side < 0)) { i++; continue; }

    const k = i + 1, side = s.side, B = h4[k].o;
    const entry = side > 0 ? B + costs.spread : B;
    const stop = side > 0 ? B - rule.stopAtr * s.atr : B + costs.spread + rule.stopAtr * s.atr;
    const risk = Math.abs(entry - stop);
    const target = entry + side * rule.targetR * risk;
    const trade = { side, signalIndex: i, entryIndex: k, t: h4[k].t, entry, stop, target, risk,
      atr: s.atr, ema: s.ema };

    let j = k, done = false;
    for (; j < end && j <= k + rule.maxHold; j++) {
      const b = h4[j];
      if (side > 0) {
        if (b.l <= stop) { close(trade, j, Math.min(b.o, stop) - costs.slip, 'stop'); done = true; break; }
        if (b.h >= target) { close(trade, j, target, 'target'); done = true; break; }
      } else {
        const askH = b.h + costs.spread, askL = b.l + costs.spread, askO = b.o + costs.spread;
        if (askH >= stop) { close(trade, j, Math.max(askO, stop) + costs.slip, 'stop'); done = true; break; }
        if (askL <= target) { close(trade, j, target, 'target'); done = true; break; }
      }
      if (j === k + rule.maxHold && b.closed !== false) {
        close(trade, j, side > 0 ? b.c : b.c + costs.spread, 'time'); done = true; break;
      }
    }
    if (!done) {
      /* ยังไม่ปิด = ไม้ที่ระบบถืออยู่ตอนนี้ คิดกำไรขาดทุนจากราคาล่าสุด */
      const last = h4[end - 1];
      const px = side > 0 ? last.c : last.c + costs.spread;
      open = { ...trade, lastIndex: end - 1, lastPrice: last.c, rNow: ((px - entry) * side) / risk,
        barsHeld: end - 1 - k, barsLeft: Math.max(0, k + rule.maxHold - (end - 1)) };
      break;
    }
    trades.push(trade);
    lastExit = trade.exitIndex;
    i = trade.exitIndex + 1;
  }
  return { trades, open, lastExit: Number.isFinite(lastExit) ? lastExit : null };

  function close(tr, j, px, why) {
    tr.exitIndex = j; tr.exitT = h4[j].t; tr.exit = px; tr.why = why;
    tr.r = ((px - tr.entry) * tr.side) / tr.risk;
    tr.hold = j - tr.entryIndex;
  }
}

/* ── สถิติ ──────────────────────────────────────────────────────────── */

/** ช่วงความเชื่อมั่น 95% แบบ Wilson — ตัวอย่างน้อยจะได้ช่วงกว้าง ซึ่งคือความจริง */
export function wilson(wins, n, z = 1.96) {
  if (!n) return null;
  const p = wins / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, c - m) * 100, high: Math.min(1, c + m) * 100 };
}

/**
 * โอกาสที่ค่าเฉลี่ยจริงเป็นบวก — สุ่มหยิบไม้ซ้ำ (bootstrap) ด้วย seed ตายตัว
 * seed ตายตัวเพื่อให้ตัวเลขเดิมทุกครั้งที่เปิดหน้า ไม่ใช่กระโดดไปมาจนดูน่าสงสัย
 */
export function probPositive(rs, rounds = 3000, seed = 7) {
  if (rs.length < 5) return null;
  let s = seed | 0;
  const rnd = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let pos = 0;
  for (let b = 0; b < rounds; b++) {
    let sum = 0;
    for (let k = 0; k < rs.length; k++) sum += rs[Math.floor(rnd() * rs.length)];
    if (sum > 0) pos++;
  }
  return pos / rounds;
}

export function statsOf(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const rs = trades.map((t) => t.r);
  const wins = rs.filter((r) => r > 0).length;
  const total = rs.reduce((a, r) => a + r, 0);
  const gw = rs.filter((r) => r > 0).reduce((a, r) => a + r, 0);
  const gl = -rs.filter((r) => r < 0).reduce((a, r) => a + r, 0);
  let eq = 0, peak = 0, maxDD = 0, streak = 0, maxLoss = 0;
  const curve = [];
  for (const r of rs) {
    eq += r; curve.push(+eq.toFixed(3));
    peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
    if (r <= 0) { streak++; maxLoss = Math.max(maxLoss, streak); } else streak = 0;
  }
  const group = (keyOf) => {
    const m = new Map();
    for (const t of trades) { const k = keyOf(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
    return [...m.entries()].sort((a, b) => (a[0] > b[0] ? 1 : -1)).map(([k, L]) => ({
      key: k, n: L.length, win: (L.filter((t) => t.r > 0).length / L.length) * 100,
      avgR: L.reduce((a, t) => a + t.r, 0) / L.length,
    }));
  };
  const span = trades[n - 1].t - trades[0].t;
  return {
    n, wins, win: (wins / n) * 100, ci: wilson(wins, n),
    avgR: total / n, totalR: total, pf: gl ? gw / gl : null,
    maxDD, maxLossStreak: maxLoss, curve,
    avgHold: trades.reduce((a, t) => a + (t.hold || 0), 0) / n,
    perMonth: span > 0 ? n / (span / (30.44 * D1)) : null,
    pPos: probPositive(rs),
    byYear: group((t) => new Date(t.t).getUTCFullYear()),
    bySide: group((t) => (t.side > 0 ? 'buy' : 'sell')),
  };
}

/* ── สถานะตอนนี้ ─────────────────────────────────────────────────────── */

/**
 * ตอนนี้ระบบอยู่ในสถานะไหน — มาจากการเดินกติกาเดียวกับทดสอบย้อนหลังจนถึงแท่งล่าสุด
 *
 *  'entry'     แท่ง 4 ชม. เพิ่งปิดเป็นสัญญาณ ระบบเข้าไม้ที่ราคาเปิดของแท่งนี้ → ยังเข้าตามทัน
 *  'holding'   ระบบถือไม้อยู่ตั้งแต่แท่งก่อน ๆ → ถ้ายังไม่ได้เข้า อย่าไล่ตาม
 *  'cooldown'  เพิ่งออกไม้ ต้องพักให้ครบก่อน
 *  'wait'      เทรนด์ใหญ่ชัดแล้ว รอราคาย่อ/เด้งมาถึงจุดเข้า
 *  'no-trend'  เทรนด์ใหญ่ไม่ชัด ไม่เทรด
 *  'warming'   ข้อมูลยังไม่พอ
 */
export function currentState(sys, { costs = COSTS, longOnly = false } = {}) {
  const { h4, rule } = sys;
  const run = runSystem(sys, { costs, longOnly });
  const lastIdx = h4.length - 1;
  let closedIdx = lastIdx;
  while (closedIdx >= 0 && h4[closedIdx].closed === false) closedIdx--;
  const sig = closedIdx >= 0 ? signalAt(sys, closedIdx) : { ready: false, checks: [] };
  const base = { run, signal: sig, closedIndex: closedIdx, lastIndex: lastIdx,
    nextCloseAt: h4[lastIdx] ? (h4[lastIdx].closed === false ? h4[lastIdx].t + H4 : h4[lastIdx].t + 2 * H4) : null };

  if (!sig.ready) return { ...base, kind: 'warming' };
  if (run.open) {
    /* สัญญาณมาจากแท่งที่เพิ่งปิดล่าสุด = เพิ่งเข้า ยังตามทัน · มาจากแท่งก่อนหน้า = ถืออยู่ */
    return { ...base, kind: run.open.signalIndex === closedIdx ? 'entry' : 'holding', trade: run.open };
  }
  const inCooldown = run.lastExit !== null && closedIdx - run.lastExit < rule.cooldown;
  /* แหล่งข้อมูลบางเจ้าส่งมาแต่แท่งที่ปิดแล้ว สัญญาณที่แท่งสุดท้ายจึงยังไม่มีแท่งถัดไปให้เข้า
     ต้องนับเป็น "เข้าได้ตอนนี้" ไม่ใช่ปล่อยหล่นไปเป็นสถานะรอ */
  const allowed = sig.side > 0 || (sig.side < 0 && !longOnly);
  if (!inCooldown && allowed && closedIdx === lastIdx) return { ...base, kind: 'entry', trade: null };
  if (inCooldown) {
    const left = rule.cooldown - (closedIdx - run.lastExit);
    return { ...base, kind: 'cooldown', lastTrade: run.trades[run.trades.length - 1],
      readyAt: h4[closedIdx].t + H4 * (left + 1) };
  }
  if (sig.trend > 0 || (sig.trend < 0 && !longOnly)) return { ...base, kind: 'wait' };
  return { ...base, kind: 'no-trend' };
}

/* ── ขนาดไม้ ────────────────────────────────────────────────────────── */

/**
 * คำนวณขนาดไม้จากเงินที่ยอมเสีย แล้วคิดความเสี่ยง "ย้อนกลับ" จากขนาดที่ส่งคำสั่งได้จริง
 *
 * ไม้เล็กสุดของโบรกเกอร์อาจเสี่ยงเกินที่ตั้งไว้หลายเท่า — ถ้าเกินเพดานต้องไม่มีแผนให้กด
 * มาจากไม้จริงของผู้ใช้: ทุน 59 ดอลลาร์ เข้าไม้ละ 1 ออนซ์ เสี่ยง 17% ต่อไม้
 * แพ้สามไม้ติดใน 50 นาที ทุนหายครึ่งหนึ่ง ทั้งที่แอปเตือนอยู่ใต้แผนแล้ว
 *
 * broker: { contractSize: ออนซ์ต่อ 1 ล็อต, minLot, lotStep }
 */
export function sizePlan({ entry, stop, target, account, riskPct, broker, ceilingPct = 10 }) {
  const contract = broker && broker.contractSize > 0 ? broker.contractSize : 100;
  const step = broker && broker.lotStep > 0 ? broker.lotStep : 0.01;
  const minLot = broker && broker.minLot > 0 ? broker.minLot : 0.01;
  const dist = Math.abs(entry - stop);
  const riskMoney = account * (riskPct / 100);
  const raw = dist > 0 ? riskMoney / (dist * contract) : 0;
  let lots = Math.floor(raw / step + 1e-9) * step;
  const forced = lots < minLot;
  if (forced) lots = minLot;
  lots = +lots.toFixed(6);
  const oz = lots * contract;
  const riskUsd = oz * dist;
  const rewardUsd = oz * Math.abs(target - entry);
  const riskPctActual = account > 0 ? (riskUsd / account) * 100 : null;
  const tradeable = riskPctActual !== null && riskPctActual <= ceilingPct;
  return {
    lots, oz, riskUsd, rewardUsd, riskPctActual, riskMoney, forced, tradeable, ceilingPct,
    /* ทุนที่ต้องมีเพื่อให้ไม้เล็กสุดเสี่ยงไม่เกิน 2% — ตัวเลขที่ทำให้เห็นว่าต้องทำอะไรต่อ */
    capitalFor2pct: Math.ceil(riskUsd / 0.02),
    lossesToHalf: riskUsd > 0 ? Math.ceil((account * 0.5) / riskUsd) : null,
    lossesToZero: riskUsd > 0 ? Math.ceil(account / riskUsd) : null,
  };
}

/**
 * แผนสำหรับเข้าไม้ตอนนี้ที่ราคาปัจจุบัน — ใช้ ATR ของแท่งสัญญาณ ระยะเดียวกับที่ทดสอบ
 * price = ราคากลางล่าสุด (bid) · คืนราคาเป็นตัวเลขที่ตั้งในโปรแกรมเทรดได้ตรง ๆ
 */
export function planAt(side, price, atrValue, rule = RULE, costs = COSTS) {
  const entry = side > 0 ? price + costs.spread : price;
  const stop = side > 0 ? price - rule.stopAtr * atrValue : price + costs.spread + rule.stopAtr * atrValue;
  const risk = Math.abs(entry - stop);
  return { side, entry, stop, target: entry + side * rule.targetR * risk, risk, targetR: rule.targetR };
}
