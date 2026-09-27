import { readFileSync } from 'node:fs';
export const LAB = process.env.CACHE_DIR || 'research/.cache';
export function load(tf) {
  return JSON.parse(readFileSync(`${LAB}/xau_${tf}.json`, 'utf8'))
    .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, closed: true }));
}
export const yearOf = (t) => new Date(t).getUTCFullYear();
export function wilson(w, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = w / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d;
  const m = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [(c - m) * 100, (c + m) * 100];
}
/* บูตสแตรป: โอกาสที่ค่าเฉลี่ย R จริงเป็นบวก (สุ่มไม้ซ้ำ 4000 รอบ) */
export function probPositive(rs, B = 4000, seed = 7) {
  if (rs.length < 5) return NaN;
  let s = seed | 0; const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let pos = 0; const n = rs.length;
  for (let b = 0; b < B; b++) { let sum = 0; for (let k = 0; k < n; k++) sum += rs[Math.floor(rnd() * n)]; if (sum > 0) pos++; }
  return pos / B;
}
export function summarize(label, trades) {
  const n = trades.length;
  if (!n) return { label, n: 0 };
  const w = trades.filter((t) => t.r > 0).length;
  const R = trades.reduce((a, t) => a + t.r, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of trades) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const [lo, hi] = wilson(w, n);
  return { label, n, win: w / n * 100, lo, hi, avgR: R / n, totR: R, maxDD: dd, pPos: probPositive(trades.map((t) => t.r)) };
}
export function fmt(s) {
  if (!s.n) return `${s.label.padEnd(26)} |     0 ไม้`;
  return `${s.label.padEnd(26)} | ${String(s.n).padStart(5)} | ${s.win.toFixed(1).padStart(5)}% (${s.lo.toFixed(0)}-${s.hi.toFixed(0)}) | ${(s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(3)}R | รวม ${s.totR.toFixed(0).padStart(5)}R | DD ${s.maxDD.toFixed(0).padStart(4)}R | P(+)=${(s.pPos * 100).toFixed(0)}%`;
}
export const HEAD = `${'ชุด'.padEnd(26)} |  ไม้  | ชนะ (ช่วง95%)    | R/ไม้   | รวม       | ติดลบลึก | โอกาสเป็นบวกจริง`;
