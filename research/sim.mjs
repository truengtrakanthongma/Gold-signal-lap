/*
 * ห้องทดลอง: ตัวจำลองเทรดแบบเรียบง่ายที่ตรวจสอบได้ทุกบรรทัด
 * ราคาในข้อมูลเป็นราคา bid · ซื้อจ่ายที่ ask = bid + สเปรด · ปิด short ก็จ่ายที่ ask
 * - ตัดสินตอนแท่ง i ปิด แล้วเข้าที่ราคาเปิดของแท่ง i+1 (ไม่มีการมองอนาคต)
 * - ความเสี่ยงต่อไม้ = ระยะถึง SL + สเปรด ทั้งสองฝั่งเท่ากัน
 * - สลิปเพจ $0.10 ตอนโดน SL · แท่งเดียวแตะทั้ง SL และ TP → ถือว่าโดน SL ก่อน
 */
export const COST = { spread: 0.30, slip: 0.10 };

export function tfMsOf(bars) {
  const g = []; for (let i = 1; i < Math.min(bars.length, 500); i++) g.push(bars[i].t - bars[i - 1].t);
  g.sort((a, b) => a - b); return g[Math.floor(g.length / 2)];
}

/* ค่าจากกรอบใหญ่ ณ แท่งเล็ก i — ใช้ได้เฉพาะแท่งใหญ่ที่ปิดแล้วก่อนแท่งเล็กปิด */
export function alignHTF(bars, htf, htfMs, values) {
  const ltfMs = tfMsOf(bars);
  const out = new Array(bars.length).fill(null);
  let j = -1;
  for (let i = 0; i < bars.length; i++) {
    while (j + 1 < htf.length && htf[j + 1].t + htfMs <= bars[i].t + ltfMs) j++;
    out[i] = j >= 0 ? values[j] : null;
  }
  return out;
}

export function simulate(bars, decide, { from = 1, to = bars.length, cost = COST, ind = {} } = {}) {
  const trades = [];
  let i = Math.max(from, 1);
  const end = Math.min(to, bars.length) - 1;
  while (i < end) {
    const d = decide(i);
    if (!d) { i++; continue; }
    const k = i + 1, side = d.side, B = bars[k].o;
    const entry = side > 0 ? B + cost.spread : B;
    const stop0 = side > 0 ? B - d.stopDist : B + cost.spread + d.stopDist;
    const risk = Math.abs(entry - stop0);
    const target = d.targetR ? entry + side * d.targetR * risk : null;
    let stop = stop0, exitPx = null, why = '', j = k;
    for (; j < bars.length && j <= k + d.maxHold; j++) {
      const b = bars[j];
      const askH = b.h + cost.spread, askL = b.l + cost.spread, askO = b.o + cost.spread;
      if (side > 0) {
        if (b.l <= stop) { exitPx = Math.min(b.o, stop) - cost.slip; why = 'stop'; break; }
        if (target !== null && b.h >= target) { exitPx = target; why = 'target'; break; }
      } else {
        if (askH >= stop) { exitPx = Math.max(askO, stop) + cost.slip; why = 'stop'; break; }
        if (target !== null && askL <= target) { exitPx = target; why = 'target'; break; }
      }
      const closeOut = side > 0 ? b.c : b.c + cost.spread;
      if (d.exit === 'ema' && ind.exitEma && ind.exitEma[j] !== null
          && ((side > 0 && b.c > ind.exitEma[j]) || (side < 0 && b.c < ind.exitEma[j]))) { exitPx = closeOut; why = 'ema'; break; }
      if (d.exit === 'donchian' && j - d.exitN >= 0) {
        let x = side > 0 ? Infinity : -Infinity;
        for (let q = j - d.exitN; q < j; q++) x = side > 0 ? Math.min(x, bars[q].l) : Math.max(x, bars[q].h);
        if ((side > 0 && b.c < x) || (side < 0 && b.c > x)) { exitPx = closeOut; why = 'trail'; break; }
      }
      if (d.trailAtr && ind.atr && ind.atr[j]) {
        const cand = side > 0 ? b.h - d.trailAtr * ind.atr[j] : askL + d.trailAtr * ind.atr[j];
        stop = side > 0 ? Math.max(stop, cand) : Math.min(stop, cand);
      }
    }
    if (exitPx === null) {
      j = Math.min(j, bars.length - 1);
      exitPx = side > 0 ? bars[j].c : bars[j].c + cost.spread; why = 'time';
    }
    trades.push({ t: bars[k].t, side, r: ((exitPx - entry) * side) / risk, why, hold: j - k, i });
    i = j + 1;
  }
  return trades;
}
