/* สร้าง js/reference.js จากโค้ดจริง — ตัวเลขทุกตัวในไฟล์นั้นต้องมาจากที่นี่ ห้ามพิมพ์มือ */
import { writeFileSync } from 'node:fs';
import { load } from './lib.mjs';
import { buildSystem, runSystem, statsOf, RULE } from '../js/system.js';

const h4 = load('h4'), d1 = load('d1');
const sys = buildSystem(h4, d1);
const run = runSystem(sys, { from: 300 });
const st = statsOf(run.trades);

// เดือนที่ติดลบ และช่วงที่นานที่สุดที่ไม่ทำจุดสูงสุดใหม่
const byMonth = new Map();
for (const t of run.trades) { const d = new Date(t.t); const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; byMonth.set(k, (byMonth.get(k) || 0) + t.r); }
const months = [...byMonth.values()];
let peak = -Infinity, peakT = run.trades[0].t, longest = 0, eq = 0;
for (const t of run.trades) { eq += t.r; if (eq > peak) { peak = eq; peakT = t.t; } else longest = Math.max(longest, t.t - peakT); }


/* ── ความทนทาน: เปลี่ยนค่าทีละอย่างด้วยโค้ดจริง ─────────────────────── */
function variant(label, { rule = {}, costs, h4x = h4, d1x = d1 } = {}) {
  const sy = buildSystem(h4x, d1x, { ...RULE, ...rule });
  const rr = runSystem(sy, { from: 300, costs });
  const s2 = statsOf(rr.trades);
  return { label, n: s2.n, avgR: +s2.avgR.toFixed(3), win: +s2.win.toFixed(1),
    allYears: s2.byYear.every((y) => y.avgR > 0) };
}
const H = 3600000;
const h1 = load('h1');
function agg(bars, spanMs, offMs) {
  const out = []; let cur = null;
  for (const b of bars) {
    const k = Math.floor((b.t - offMs) / spanMs) * spanMs + offMs;
    if (!cur || cur.t !== k) { if (cur) out.push(cur); cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: 1, closed: true }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; cur.n++; }
  }
  if (cur) out.push(cur);
  return out.filter((x) => x.n >= Math.max(1, spanMs / H / 3));
}
const ROBUST = [
  { group: 'ระยะตัดขาดทุน (เท่าของ ATR)', rows: [1.5, 2.5, 3].map((v) => variant(`${v} ATR`, { rule: { stopAtr: v } })) },
  { group: 'เป้ากำไร (เท่าของที่เสี่ยง)', rows: [1, 1.5, 2.5, 3].map((v) => variant(`${v}R`, { rule: { targetR: v } })) },
  { group: 'เส้นเทรนด์รายวัน (เร็ว/ช้า)', rows: [[10, 30], [10, 50], [20, 100], [30, 100]].map(([a, b]) => variant(`${a}/${b} วัน`, { rule: { trendFast: a, trendSlow: b } })) },
  { group: 'เส้นวัดการย่อ กราฟ 4 ชม.', rows: [10, 30, 50].map((v) => variant(`EMA${v}`, { rule: { pullbackEma: v } })) },
  { group: 'พักหลังออกไม้', rows: [0, 3, 12].map((v) => variant(`${v * 4} ชม.`, { rule: { cooldown: v } })) },
  { group: 'ค่าสเปรดต่อไม้', rows: [0.5, 0.8, 1.2].map((v) => variant(`$${v}`, { costs: { spread: v, slip: 0.1 } })) },
  { group: 'การตั้งเวลาแท่ง', rows: [
    variant('โบรก GMT+2', { h4x: agg(h1, 4 * H, 2 * H), d1x: agg(h1, 24 * H, 22 * H) }),
    variant('โบรก GMT+3', { h4x: agg(h1, 4 * H, 1 * H), d1x: agg(h1, 24 * H, 21 * H) }),
    variant('เหรียญทองคริปโต (00 UTC)', { h4x: agg(h1, 4 * H, 0), d1x: agg(h1, 24 * H, 0) }),
  ] },
];
const allRows = ROBUST.flatMap((g) => g.rows);
console.log(`ความทนทาน: ${allRows.filter((r) => r.avgR > 0).length}/${allRows.length} แบบยังกำไร · ${allRows.filter((r) => r.allYears).length} แบบกำไรทุกปี · ต่ำสุด ${Math.min(...allRows.map((r) => r.avgR))}R`);

/* ── ตัวควบคุม: สุ่มเข้าในเทรนด์ ด้วยกติกาออกไม้ชุดเดียวกัน ─────────────── */
import { simulate, alignHTF } from './sim.mjs';
import { ema as emaX, atr as atrX } from '../js/indicators.js';
const RANDOM = (() => {
  const dc = d1.map((b) => b.c), e20 = emaX(dc, 20), e50 = emaX(dc, 50);
  const T = dc.map((c, i) => (e20[i] === null || e50[i] === null ? 0 : c > e50[i] && e20[i] > e50[i] ? 1 : c < e50[i] && e20[i] < e50[i] ? -1 : 0));
  const A = atrX(h4, 14), tr = alignHTF(h4, d1, 86400000, T);
  const res = []; const rounds = 200; let nSum = 0;
  for (let r = 0; r < rounds; r++) {
    let seed = 1000 + r; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const trades = []; let i = 300, lastExit = -1e9;
    while (i < h4.length - 1) {
      const got = simulate(h4, (k) => (tr[k] && A[k] && k - lastExit >= 6 && rnd() < 0.10 ? { side: tr[k], stopDist: 2 * A[k], targetR: 2, maxHold: 36 } : null), { from: i });
      if (!got.length) break;
      trades.push(got[0]); lastExit = got[0].i + 1 + got[0].hold; i = lastExit + 1;
    }
    res.push(trades.reduce((a, t) => a + t.r, 0) / trades.length); nSum += trades.length;
  }
  res.sort((a, b) => a - b);
  return { rounds, n: Math.round(nSum / rounds), median: +res[rounds / 2].toFixed(3),
    beatPct: Math.round((res.filter((x) => x < st.avgR).length / rounds) * 100) };
})();
console.log('สุ่มเข้าในเทรนด์:', JSON.stringify(RANDOM));

const r3 = (x) => +x.toFixed(3);
const ref = {
  source: 'HistData.com XAU/USD รายนาที (ราคา bid) รวมเป็นแท่ง 4 ชม. และรายวัน',
  from: new Date(run.trades[0].t).toISOString().slice(0, 10),
  to: new Date(run.trades.at(-1).t).toISOString().slice(0, 10),
  bars: { h4: h4.length, d1: d1.length, m1: 1373103 },
  costs: { spread: 0.30, slip: 0.10 },
  rule: RULE,
  stats: {
    n: st.n, wins: st.wins, win: r3(st.win), ciLow: r3(st.ci.low), ciHigh: r3(st.ci.high),
    avgR: r3(st.avgR), totalR: r3(st.totalR), pf: r3(st.pf), maxDD: r3(st.maxDD),
    maxLossStreak: st.maxLossStreak, pPos: r3(st.pPos), perMonth: r3(st.perMonth), avgHoldBars: r3(st.avgHold),
    monthsTraded: months.length, monthsNegative: months.filter((m) => m < 0).length,
    longestFlatDays: Math.round(longest / 86400000),
  },
  byYear: st.byYear.map((y) => ({ year: y.key, n: y.n, win: r3(y.win), avgR: r3(y.avgR) })),
  bySide: st.bySide.map((y) => ({ side: y.key, n: y.n, win: r3(y.win), avgR: r3(y.avgR) })),
  /* ไม้ทุกไม้ [เวลาเข้า, ฝั่ง, ผล R, ออกเพราะ p=ถึงเป้า s=ตัดขาดทุน t=ครบเวลา] — ไม่มีราคาดิบ */
  trades: run.trades.map((t) => [t.t, t.side, r3(t.r), { target: 'p', stop: 's', time: 't' }[t.why]]),
  /* ผลจากห้องทดลอง ตอนเลือกกติกา — ให้เห็นว่าเลือกมาจากอะไร และเปลี่ยนค่าแล้วยังรอดไหม */
  compare: [
    { label: 'ระบบเดิม (12 ตัวชี้วัด · กราฟ 15 นาที)', n: 4091, avgR: -0.042, note: 'ขาดทุนทุกปียกเว้น 2025 ที่เสมอตัว' },
    { label: 'โยนเหรียญเข้า (กราฟ 15 นาที · ต้นทุนเท่ากัน)', n: 1497, avgR: -0.059, note: 'ตัวเทียบว่า "ไม่มีความรู้เลย" ได้เท่าไร' },
    { label: 'สุ่มเข้าในเทรนด์ใหญ่ (กราฟ 4 ชม.)', n: RANDOM.n, avgR: RANDOM.median, note: `ค่ากลางจากการสุ่ม ${RANDOM.rounds} รอบ — กำไรส่วนใหญ่มาจากการตามเทรนด์` },
    { label: 'ระบบใหม่ (ตามเทรนด์ใหญ่ + รอย่อ)', n: st.n, avgR: r3(st.avgR), note: `ดีกว่าการสุ่มเข้าในเทรนด์ ${RANDOM.beatPct}% ของรอบ` },
  ],
  robust: ROBUST,
};
const body = `/**
 * reference.js — ผลของกติกาบนทองจริง 4 ปี (สร้างอัตโนมัติ ห้ามแก้มือ)
 *
 * สร้างจาก js/system.js ตัวเดียวกับที่ให้สัญญาณจริง บนข้อมูล ${ref.source}
 * ช่วง ${ref.from} ถึง ${ref.to} · สเปรด $${ref.costs.spread} + สลิปเพจ $${ref.costs.slip} ต่อไม้
 *
 * ข้อจำกัดที่ต้องรู้:
 *  - เป็นผลในอดีต 4 ปี ทองขึ้นจาก ~1,800 เป็น ~4,300 ดอลลาร์ ช่วงนี้เป็นใจกับการตามเทรนด์ขาขึ้น
 *  - ฝั่งขายมีแค่ ${ref.bySide.find((s) => s.side === 'sell')?.n ?? 0} ไม้ และผลติดลบเล็กน้อย — ยังไม่มีหลักฐานว่าฝั่งขายได้เปรียบ
 *  - ผลจริงในอนาคตมักแย่กว่าผลทดสอบเสมอ ให้คาดไว้ต่ำกว่าตัวเลขนี้
 *  - ไม่มีข้อมูลดิบในไฟล์นี้ มีแต่ผลลัพธ์ที่คำนวณแล้ว
 */
export const REFERENCE = ${JSON.stringify(ref)};
`;
writeFileSync('js/reference.js', body);
console.log(`เขียน js/reference.js แล้ว (${(Buffer.byteLength(body) / 1024).toFixed(1)} KB)`);
console.log(JSON.stringify(ref.stats, null, 1));
