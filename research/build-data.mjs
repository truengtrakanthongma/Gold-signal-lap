/*
 * แปลงข้อมูล HistData (M1, เวลา EST แบบไม่ปรับ DST = UTC-5 คงที่) เป็นแท่งหลายกรอบเวลา
 * ไม่มีปริมาณซื้อขายจริงในข้อมูลชุดนี้ จึงใช้ "ผลรวมช่วงราคารายนาที" แทนเป็นตัววัดความคึกคัก
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const SRC = process.env.HISTDATA_DIR || '../data-src/M1_XAUUSD';
const OUT = process.env.CACHE_DIR || 'research/.cache';
mkdirSync(OUT, { recursive: true });
const years = [2022, 2023, 2024, 2025];
const m1 = [];
for (const y of years) {
  const lines = readFileSync(`${SRC}/DAT_MT_XAUUSD_M1_${y}.csv`, 'utf8').split('\n');
  for (const L of lines) {
    if (!L) continue;
    const [d, tm, o, h, l, c] = L.split(',');
    const [Y, M, D] = d.split('.').map(Number);
    const [hh, mm] = tm.split(':').map(Number);
    const t = Date.UTC(Y, M - 1, D, hh + 5, mm);          // EST คงที่ → UTC
    const bar = { t, o: +o, h: +h, l: +l, c: +c };
    if ([bar.o, bar.h, bar.l, bar.c].every(Number.isFinite) && bar.h >= bar.l) m1.push(bar);
  }
}
m1.sort((a, b) => a.t - b.t);
console.log(`M1: ${m1.length} แท่ง · ${new Date(m1[0].t).toISOString()} → ${new Date(m1.at(-1).t).toISOString()}`);

function resample(minutes, dayAnchorUtcH = null) {
  const out = []; let cur = null, key = null;
  const span = minutes * 60000;
  for (const b of m1) {
    const k = dayAnchorUtcH === null
      ? Math.floor(b.t / span) * span
      : Math.floor((b.t - dayAnchorUtcH * 3600000) / 86400000) * 86400000 + dayAnchorUtcH * 3600000;
    if (k !== key) {
      if (cur) out.push(cur);
      key = k; cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: 0, n: 0 };
    }
    if (b.h > cur.h) cur.h = b.h;
    if (b.l < cur.l) cur.l = b.l;
    cur.c = b.c; cur.v += b.h - b.l; cur.n++;
  }
  if (cur) out.push(cur);
  const minN = Math.max(1, Math.floor(Math.min(minutes, 1440) / 3));   // ทิ้งแท่งที่ข้อมูลโหว่หนัก
  return out.filter((x) => x.n >= minN).map((x) => [x.t, +x.o.toFixed(3), +x.h.toFixed(3), +x.l.toFixed(3), +x.c.toFixed(3), +x.v.toFixed(3)]);
}
for (const [name, mins, anchor] of [['m15', 15, null], ['h1', 60, null], ['h4', 240, null], ['d1', 1440, 22]]) {
  const bars = resample(mins, anchor);
  writeFileSync(`${OUT}/xau_${name}.json`, JSON.stringify(bars));
  console.log(`${name}: ${bars.length} แท่ง`);
}
