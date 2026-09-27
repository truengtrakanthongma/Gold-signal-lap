/**
 * ชุดทดสอบ — รันด้วย: node test/run-tests.mjs
 *
 * เน้นสิ่งที่ถ้าพลาดแล้วผลลัพธ์จะ "ดูดีเกินจริง" หรือหลอกผู้ใช้:
 *  1. คณิตศาสตร์ถูก (เทียบค่าที่คำนวณมือได้)
 *  2. ไม่มองอนาคต — การตัดสินที่แท่ง i ต้องไม่เปลี่ยนเมื่อมีข้อมูลหลังแท่ง i เพิ่มเข้ามา
 *  3. การจำลองเทรดตรงกับที่แอปบอกให้ทำจริง (ราคาเข้า ต้นทุน SL/TP ขนาดไม้)
 *  4. ด่านความปลอดภัย (ตลาดปิด ข้อมูลค้าง ทุนไม่พอ) ทำงานทุกทาง ทั้งเว็บและบอท
 */
import * as ta from '../js/indicators.js';
import {
  RULE, COSTS, H4, D1, resample, markClosed, spotBarsOnly, trendSeries, alignTrend, buildSystem,
  signalAt, runSystem, currentState, statsOf, wilson, probPositive, sizePlan, planAt,
} from '../js/system.js';
import { REFERENCE } from '../js/reference.js';
import { goldMarketOpen, spotOpenAt, sessionInfo, xauToThaiBaht } from '../js/macro.js';
import { MarketFeed, mergeCandle } from '../js/feed.js';
import { SOURCES, validateBars, testSource } from '../js/sources.js';
import { positionStatus, checkPosition, positionAdvice } from '../js/position.js';
import { isValidWebhook, webhookProblem, sendDiscord, buildSignalMessage, buildTestMessage } from '../js/discord.js';
import { niceStep } from '../js/chart.js';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
function section(t) { console.log(`\n${t}`); }
const read = (p) => readFileSync(p, 'utf8');

function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** ตลาดสมมติแบบสุ่มเดิน มีช่วงเทรนด์สลับกัน — ใช้ทดสอบกลไก ไม่ใช่วัดความได้เปรียบ */
function randomBars(n, stepMs, seed = 7, start = Date.UTC(2024, 0, 1)) {
  const r = mulberry(seed);
  const out = [];
  let p = 2000, drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 90 === 0) drift = (r() - 0.45) * 1.2;
    const o = p, c = p + drift + (r() - 0.5) * 8;
    out.push({ t: start + i * stepMs, o, h: Math.max(o, c) + r() * 3, l: Math.min(o, c) - r() * 3, c, v: 1, closed: true });
    p = c;
  }
  return out;
}

/* ───────────────────────────────────────────────────────────────────── */
section('1) คณิตศาสตร์ของตัวชี้วัด');
{
  const e = ta.ema([2, 4, 6, 8, 10], 3);
  // seed = เฉลี่ย 3 ตัวแรก = 4 · k = 0.5 · 8×0.5+4×0.5 = 6 · 10×0.5+6×0.5 = 8
  ok('EMA(3) เริ่มจากค่าเฉลี่ย แล้วไล่สูตรถูก', e[1] === null && near(e[2], 4) && near(e[3], 6) && near(e[4], 8), `ได้ ${e}`);
  ok('EMA ข้อมูลไม่พอ → ว่างทั้งแถว ไม่ใช่ตัวเลขมั่ว', ta.ema([1, 2], 3).every((v) => v === null));
  const tr = ta.trueRange([{ o: 10, h: 12, l: 9, c: 11 }, { o: 11, h: 15, l: 10, c: 14 }, { o: 20, h: 21, l: 19, c: 20 }]);
  ok('True Range: แท่งแรก = สูง-ต่ำ · มีช่องว่างราคา = นับรวมช่องว่าง', near(tr[0], 3) && near(tr[1], 5) && near(tr[2], 7), `ได้ ${tr}`);
  const flat = Array.from({ length: 30 }, () => ({ o: 10, h: 11, l: 9, c: 10 }));
  ok('ATR ของแท่งที่กว้างเท่ากันทุกแท่ง = ความกว้างนั้น', near(ta.atr(flat, 14)[29], 2));
  const rr = ta.rma([1, 1, 1, 4], 3);
  ok('RMA (Wilder): (1×2 + 4)/3 = 2', near(rr[3], 2), `ได้ ${rr[3]}`);
  const px = randomBars(300, H4).map((b) => b.c);
  const e20 = ta.ema(px, 20), e20cut = ta.ema(px.slice(0, 150), 20);
  ok('EMA ไม่มองอนาคต — ตัดข้อมูลท้ายทิ้งแล้วค่าก่อนหน้าไม่เปลี่ยน', e20cut.every((v, i) => v === null || near(v, e20[i], 1e-9)));
}

/* ───────────────────────────────────────────────────────────────────── */
section('2) เทรนด์ใหญ่ — ต้องใช้แท่งรายวันที่ "ปิดแล้ว" เท่านั้น');
{
  const up = Array.from({ length: 80 }, (_, i) => ({ t: Date.UTC(2025, 0, 1) + i * D1, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i }));
  const tu = trendSeries(up);
  ok('ราคาขึ้นต่อเนื่อง → ขาขึ้น', tu[79].side === 1 && tu[79].ready);
  const dn = up.map((b, i) => ({ ...b, o: 200 - i, h: 201 - i, l: 199 - i, c: 200 - i }));
  ok('ราคาลงต่อเนื่อง → ขาลง', trendSeries(dn)[79].side === -1);
  ok('ข้อมูลไม่พอให้ EMA50 → ยังไม่ตัดสิน', trendSeries(up.slice(0, 40))[39].ready === false);
  /* ราคาปิดเพิ่งกระโดดข้าม EMA50 แต่ EMA20 ยังอยู่ใต้ → เงื่อนไขไม่ครบ = ไม่มีเทรนด์ */
  const turn = [...dn.slice(0, 70), ...Array.from({ length: 3 }, (_, k) => ({ t: dn[69].t + (k + 1) * D1, o: 160, h: 200, l: 160, c: 195 }))];
  const tt = trendSeries(turn)[72];
  ok('ราคาปิดเหนือ EMA50 แต่ EMA20 ยังต่ำกว่า → ยังไม่นับเป็นขาขึ้น', tt.side === 0 && tt.close > tt.slow && tt.fast < tt.slow,
    JSON.stringify({ side: tt.side, c: tt.close, f: tt.fast && tt.fast.toFixed(1), s: tt.slow && tt.slow.toFixed(1) }));

  /* จุดที่มองอนาคตง่ายที่สุด: แท่งรายวันของวันนี้ยังไม่ปิด ห้ามเอามาใช้ */
  const d1 = [{ t: Date.UTC(2025, 5, 2), c: 1 }, { t: Date.UTC(2025, 5, 3), c: 2 }];
  const tr = [{ side: 1 }, { side: -1 }];
  const h4 = [{ t: Date.UTC(2025, 5, 3, 8) }, { t: Date.UTC(2025, 5, 3, 20) }, { t: Date.UTC(2025, 5, 4, 0) }];
  const al = alignTrend(h4, d1, tr);
  ok('แท่ง 4 ชม. ระหว่างวัน ใช้เทรนด์ของ "เมื่อวาน" ไม่ใช่ของวันนี้ที่ยังไม่จบ', al[0] === tr[0], JSON.stringify(al[0]));
  ok('แท่ง 4 ชม. สุดท้ายของวัน ปิดพร้อมแท่งรายวัน → ใช้ของวันนี้ได้', al[1] === tr[1]);
  const al2 = alignTrend(h4, [{ ...d1[0] }, { ...d1[1], closed: false }], tr);
  ok('แท่งรายวันที่ติดป้ายยังไม่ปิด ต้องไม่ถูกใช้แม้เวลาจะครบ', al2[1] === tr[0]);
}

/* ───────────────────────────────────────────────────────────────────── */
section('3) สัญญาณ — เช็คลิสต์ต้องตรงกับที่ตัดสินจริง');
{
  const mk = (trendSide, close, ema) => ({
    h4: [{ t: 0, o: close, h: close, l: close, c: close }],
    trendAt: [{ side: trendSide, ready: true, close: 110, fast: trendSide >= 0 ? 105 : 95, slow: 100 }],
    ema: [ema], atr: [2], rule: RULE,
  });
  const buy = signalAt(mk(1, 99, 100), 0);
  ok('ขาขึ้น + ราคาปิดใต้ EMA20 → ซื้อ', buy.side === 1 && buy.checks.every((c) => c.ok === true));
  const wait = signalAt(mk(1, 101, 100), 0);
  ok('ขาขึ้น + ราคายังเหนือ EMA20 → รอ (ข้อสามยังไม่ผ่าน)', wait.side === 0 && wait.trend === 1 && wait.checks[2].ok === false);
  const sysDown = mk(-1, 101, 100); sysDown.trendAt[0] = { side: -1, ready: true, close: 90, fast: 95, slow: 100 };
  const sell = signalAt(sysDown, 0);
  ok('ขาลง + ราคาปิดเหนือ EMA20 → ขาย', sell.side === -1 && sell.checks.every((c) => c.ok === true));
  const none = mk(0, 99, 100); none.trendAt[0] = { side: 0, ready: true, close: 110, fast: 95, slow: 100 };
  const nt = signalAt(none, 0);
  ok('ไม่มีเทรนด์ → ไม่มีสัญญาณแม้ราคาจะย่อ', nt.side === 0 && nt.trend === 0);
  ok('ไม่มีเทรนด์ → บอกได้ว่าข้อไหนผ่าน ข้อไหนขาด (ไม่ใช่กากบาททั้งแถว)',
    nt.checks[0].ok === true && nt.checks[1].ok === false && nt.checks[2].ok === null);
  const noData = signalAt({ h4: [{ c: 1 }], trendAt: [null], ema: [null], atr: [null], rule: RULE }, 0);
  ok('ข้อมูลไม่พอ → ไม่ตัดสิน', noData.ready === false && noData.side === 0);
}

/* ───────────────────────────────────────────────────────────────────── */
section('4) จำลองการเทรด — ทุกตัวเลขคำนวณมือได้');
{
  /*
   * สร้างระบบด้วยมือ: เทรนด์ขาขึ้นตลอด · EMA = 100 · ATR = 5 ทุกแท่ง
   * แท่ง 2 ปิดที่ 99 (ใต้ EMA) = สัญญาณ → เข้าที่ราคาเปิดแท่ง 3
   */
  const trendUp = { side: 1, ready: true, close: 120, fast: 110, slow: 100 };
  const mkSys = (bars, rule = RULE) => ({
    h4: bars.map((b, i) => ({ t: i * H4, closed: true, ...b })), rule,
    ema: bars.map(() => 100), atr: bars.map(() => 5), trendAt: bars.map(() => trendUp),
  });
  const base = [{ o: 105, h: 106, l: 104, c: 105 }, { o: 105, h: 106, l: 104, c: 105 }, { o: 101, h: 101, l: 98, c: 99 }];
  const costs = { spread: 0.3, slip: 0.1 };

  // ถึงเป้า: เข้า 100+0.3 = 100.3 · SL 100-10 = 90 · เสี่ยง 10.3 · เป้า 100.3+20.6 = 120.9
  const hit = runSystem(mkSys([...base, { o: 100, h: 101, l: 99, c: 100 }, { o: 100, h: 121, l: 99.5, c: 120 }, { o: 120, h: 121, l: 119, c: 120 }]), { costs });
  const t1 = hit.trades[0];
  ok('เข้าที่ราคาเปิดของแท่งถัดไป + สเปรด (ซื้อจ่ายแพงกว่า)', t1 && near(t1.entry, 100.3), t1 && t1.entry);
  ok('ตัดขาดทุน = ราคาเปิด − 2×ATR', t1 && near(t1.stop, 90));
  ok('ความเสี่ยงรวมสเปรดด้วย (100.3 − 90 = 10.3)', t1 && near(t1.risk, 10.3));
  ok('เป้า = ราคาเข้า + 2 เท่าของความเสี่ยง (120.9)', t1 && near(t1.target, 120.9));
  ok('ถึงเป้า → ได้ +2R พอดี', t1 && t1.why === 'target' && near(t1.r, 2), t1 && t1.r);

  // โดน SL: ออกที่ 90 − สลิป 0.1 → (89.9 − 100.3)/10.3 = −1.00971
  const stop = runSystem(mkSys([...base, { o: 100, h: 101, l: 89, c: 95 }, { o: 95, h: 96, l: 94, c: 95 }]), { costs });
  ok('โดน SL → เสียเกิน 1R นิดหน่อยเพราะสลิปเพจ', near(stop.trades[0].r, (89.9 - 100.3) / 10.3), stop.trades[0].r);

  // ราคาเปิดกระโดดข้าม SL → ได้ราคาเปิด ไม่ใช่ราคา SL (ขาดทุนจริงเกิน 1R)
  const gap = runSystem(mkSys([...base, { o: 100, h: 101, l: 99, c: 100 }, { o: 85, h: 86, l: 84, c: 85 }]), { costs });
  ok('ราคาเปิดกระโดดข้าม SL → ออกที่ราคาเปิด (ขาดทุนเกิน 1R ตามจริง)', near(gap.trades[0].r, (84.9 - 100.3) / 10.3), gap.trades[0].r);

  // แท่งเดียวแตะทั้ง SL และเป้า → ถือว่าโดน SL ก่อน
  const both = runSystem(mkSys([...base, { o: 100, h: 125, l: 85, c: 100 }]), { costs });
  ok('แท่งเดียวแตะทั้ง SL และเป้า → มองแง่ร้าย ถือว่าโดน SL', both.trades[0].why === 'stop' && both.trades[0].r < -1);

  // ครบเวลาถือ: ตั้ง maxHold = 3 แท่ง ราคานิ่ง → ปิดที่ราคาปิดของแท่ง k+3
  const rule3 = { ...RULE, maxHold: 3 };
  const flatRun = [{ o: 101, h: 102, l: 100, c: 101 }, { o: 101, h: 102, l: 100, c: 102 }, { o: 102, h: 103, l: 101, c: 103 }, { o: 103, h: 104, l: 102, c: 104 }, { o: 104, h: 105, l: 103, c: 104 }];
  const tm = runSystem(mkSys([...base, ...flatRun], rule3), { costs });
  ok('ครบเวลาถือ → ปิดที่ราคาปิดของแท่งสุดท้ายที่ถือ', tm.trades[0].why === 'time' && tm.trades[0].exitIndex === 3 + 3 && near(tm.trades[0].exit, 104),
    JSON.stringify(tm.trades[0] && { why: tm.trades[0].why, j: tm.trades[0].exitIndex, x: tm.trades[0].exit }));

  // ขาย: เข้าที่ bid · SL = bid + สเปรด + 2ATR · ปิดด้วย ask
  const trendDn = { side: -1, ready: true, close: 80, fast: 90, slow: 100 };
  const sellSys = {
    h4: [{ o: 95, h: 96, l: 94, c: 95 }, { o: 95, h: 96, l: 94, c: 95 }, { o: 99, h: 102, l: 99, c: 101 },
      { o: 100, h: 100.5, l: 99, c: 99 }, { o: 99, h: 99.5, l: 79, c: 80 }].map((b, i) => ({ t: i * H4, closed: true, ...b })),
    rule: RULE, ema: Array(5).fill(100), atr: Array(5).fill(5), trendAt: Array(5).fill(trendDn),
  };
  const s1 = runSystem(sellSys, { costs }).trades[0];
  ok('ขาย: เข้าที่ราคา bid (100) · SL ที่ 110.3 · เสี่ยง 10.3', s1 && near(s1.entry, 100) && near(s1.stop, 110.3) && near(s1.risk, 10.3));
  ok('ขาย: เป้า 100 − 20.6 = 79.4 · ราคา ask แตะแล้ว → +2R', s1 && near(s1.target, 79.4) && s1.why === 'target' && near(s1.r, 2), s1 && s1.r);
  ok('โหมดเฉพาะฝั่งซื้อ → ไม่เปิดไม้ขาย', runSystem(sellSys, { costs, longOnly: true }).trades.length === 0);

  // พักหลังออกไม้: สัญญาณที่แท่ง 5, 6 ต้องถูกข้าม เพราะเพิ่งออกที่แท่ง 4
  const again = [...base, { o: 100, h: 121, l: 99.5, c: 99 }, { o: 99, h: 100, l: 98, c: 99 }, { o: 99, h: 100, l: 98, c: 99 },
    ...Array.from({ length: 8 }, () => ({ o: 99, h: 100, l: 98, c: 99 }))];
  const cd = runSystem(mkSys(again), { costs });
  ok('ออกไม้แล้วพักครบ 6 แท่งก่อนเข้าใหม่', cd.trades.length >= 1 && (cd.trades.length < 2 || cd.trades[1].signalIndex - cd.trades[0].exitIndex >= RULE.cooldown)
    && (!cd.open || cd.open.signalIndex - cd.trades[0].exitIndex >= RULE.cooldown),
    JSON.stringify({ exit: cd.trades[0] && cd.trades[0].exitIndex, next: cd.trades[1] ? cd.trades[1].signalIndex : cd.open && cd.open.signalIndex }));
  ok('ถือทีละไม้เดียว — ไม้ใหม่เริ่มหลังไม้เก่าออกเสมอ',
    cd.trades.every((t, k) => k === 0 || t.entryIndex > cd.trades[k - 1].exitIndex));

  // ไม้ที่ยังไม่ปิดตอนท้ายข้อมูล = ระบบถืออยู่
  const openRun = runSystem(mkSys([...base, { o: 100, h: 104, l: 99, c: 103 }, { o: 103, h: 105, l: 102, c: 104 }]), { costs });
  ok('ไม้ยังไม่ปิด → รายงานเป็นไม้ที่ถืออยู่ พร้อมผลตอนนี้เป็น R', openRun.open && openRun.trades.length === 0 && near(openRun.open.rNow, (104 - 100.3) / 10.3));
}

/* ───────────────────────────────────────────────────────────────────── */
section('5) ไม่มองอนาคต — บนตลาดสมมติขนาดใหญ่');
{
  const h1 = randomBars(12000, 3600000, 11);
  const h4 = resample(h1, H4, Infinity), d1 = resample(h1, D1, Infinity);
  const full = runSystem(buildSystem(h4, d1));
  const cut = Math.floor(h4.length * 0.6);
  const part = runSystem(buildSystem(h4.slice(0, cut), d1.filter((b) => b.t + D1 <= h4[cut - 1].t + H4)));
  const done = part.trades;
  const same = done.every((t, k) => full.trades[k] && full.trades[k].t === t.t && near(full.trades[k].r, t.r, 1e-12));
  ok(`ไม้ที่จบก่อนจุดตัด ${done.length} ไม้ เหมือนเดิมทุกไม้ แม้จะรู้ข้อมูลหลังจากนั้นเพิ่ม`, done.length > 5 && same);
  const sysA = buildSystem(h4.slice(0, cut), d1), sysB = buildSystem(h4, d1);
  let diff = 0;
  for (let i = 60; i < cut; i++) if (signalAt(sysA, i).side !== signalAt(sysB, i).side) diff++;
  ok('สัญญาณทุกแท่งก่อนจุดตัด ไม่เปลี่ยนเมื่อมีแท่ง 4 ชม. ในอนาคตเพิ่มเข้ามา', diff === 0, `ต่างกัน ${diff} แท่ง`);
  const st = statsOf(full.trades);
  ok('ตลาดสุ่มเดิน: ไม่ได้กำไรแบบผิดธรรมชาติ (ถ้าได้ แปลว่ามีการมองอนาคตหลุดมา)', st.n > 30 && st.avgR < 0.35, `ได้ ${st.avgR && st.avgR.toFixed(3)}R จาก ${st.n} ไม้`);
}

/* ───────────────────────────────────────────────────────────────────── */
section('6) สถานะตอนนี้ — ต้องมาจากการเดินกติกาเดียวกับทดสอบย้อนหลัง');
{
  const trendUp = { side: 1, ready: true, close: 120, fast: 110, slow: 100 };
  const mk = (bars, lastOpen = true) => {
    const h4 = bars.map((b, i) => ({ t: i * H4, closed: true, ...b }));
    if (lastOpen) h4[h4.length - 1].closed = false;
    return { h4, rule: RULE, ema: h4.map(() => 100), atr: h4.map(() => 5), trendAt: h4.map(() => trendUp) };
  };
  const calm = { o: 105, h: 106, l: 104, c: 105 };
  const dip = { o: 101, h: 101, l: 98, c: 99 };
  ok('แท่งที่เพิ่งปิดเป็นสัญญาณ → "เข้าได้ตอนนี้"', currentState(mk([calm, calm, dip, { o: 100, h: 100, l: 100, c: 100 }])).kind === 'entry');
  ok('แหล่งที่ส่งมาแต่แท่งปิดแล้ว สัญญาณที่แท่งท้ายสุด → ยัง "เข้าได้ตอนนี้"', currentState(mk([calm, calm, dip], false)).kind === 'entry');
  ok('สัญญาณจากแท่งก่อน ๆ และยังไม่ออก → "ระบบถืออยู่ อย่าไล่ราคา"',
    currentState(mk([calm, calm, dip, { o: 100, h: 104, l: 99, c: 103 }, { o: 103, h: 104, l: 102, c: 103 }])).kind === 'holding');
  ok('เทรนด์ใหญ่ชัด แต่ราคายังไม่ย่อ → "รอราคาย่อ"', currentState(mk([calm, calm, calm, calm])).kind === 'wait');
  /* แท่งที่ยังก่อตัวอยู่ย่อลงใต้เส้นระหว่างแท่ง แต่ราคาปิดยังเปลี่ยนได้ — ต้องรอให้ปิดก่อน
     ถ้านับตอนนี้ สัญญาณจะโผล่แล้วหายกลางแท่ง และไม่ตรงกับที่ทดสอบย้อนหลังไว้ */
  ok('แท่งที่ยังไม่ปิดย่อลงใต้เส้น → ยังไม่ใช่สัญญาณ ต้องรอปิดแท่ง', currentState(mk([calm, calm, calm, dip])).kind === 'wait');
  const cool = mk([calm, calm, dip, { o: 100, h: 121, l: 99.5, c: 120 }, calm, calm]);
  const cs = currentState(cool);
  ok('เพิ่งออกไม้ → "พักหลังออกไม้" พร้อมบอกผลไม้ล่าสุด', cs.kind === 'cooldown' && cs.lastTrade && cs.lastTrade.why === 'target');
  const nt = mk([calm, calm, calm]); nt.trendAt = nt.h4.map(() => ({ side: 0, ready: true, close: 100, fast: 99, slow: 100 }));
  ok('ไม่มีเทรนด์ → "ไม่เทรด"', currentState(nt).kind === 'no-trend');
  const dn = mk([calm, calm, { o: 99, h: 102, l: 99, c: 101 }]); dn.trendAt = dn.h4.map(() => ({ side: -1, ready: true, close: 90, fast: 95, slow: 100 }));
  ok('ขาลง แต่ตั้งไว้เฉพาะฝั่งซื้อ → ไม่เทรด (ไม่ใช่รอขาย)', currentState(dn, { longOnly: true }).kind === 'no-trend');
}

/* ───────────────────────────────────────────────────────────────────── */
section('7) ขนาดไม้ — ทุนไม่พอต้องไม่มีแผนให้กด');
{
  const std = { contractSize: 100, minLot: 0.01, lotStep: 0.01 };
  const a = sizePlan({ entry: 3000, stop: 2990, target: 3020, account: 10000, riskPct: 1, broker: std });
  ok('เสี่ยง 1% ของ 10,000 = 100 · SL 10 → 0.1 ล็อต (10 ออนซ์)', near(a.lots, 0.1) && near(a.oz, 10) && near(a.riskUsd, 100));
  ok('ได้ = 2 เท่าของเสีย', near(a.rewardUsd, 200) && a.tradeable);
  const b = sizePlan({ entry: 3000, stop: 2993, target: 3014, account: 10000, riskPct: 1, broker: std });
  ok('ปัดขนาดไม้ "ลง" ตามขั้นของโบรก ไม่ปัดขึ้นจนเสี่ยงเกินที่ตั้ง', near(b.lots, 0.14) && b.riskUsd <= 100 + 1e-9, `${b.lots} ล็อต เสี่ยง ${b.riskUsd}`);
  /* ไม้จริงของผู้ใช้: ทุน 59 · 1 ออนซ์ · SL ห่าง ~10 → เสี่ยง ~17% */
  const real = sizePlan({ entry: 4472.54, stop: 4462.41, target: 4492.80, account: 59, riskPct: 2, broker: std });
  ok('เคสจริงของผู้ใช้: ไม้เล็กสุด 0.01 ล็อตเสี่ยง ~17% ของทุน', real.forced && near(real.riskPctActual, 10.13 / 59 * 100, 0.1), `${real.riskPctActual && real.riskPctActual.toFixed(1)}%`);
  ok('เคสจริงของผู้ใช้: เกินเพดาน 10% → ห้ามเทรด', real.tradeable === false);
  ok('บอกด้วยว่าต้องมีทุนเท่าไรถึงจะเสี่ยงแค่ 2%', real.capitalFor2pct === Math.ceil(10.13 / 0.02), `${real.capitalFor2pct}`);
  ok('บอกว่าแพ้ติดกันกี่ไม้ทุนหายครึ่ง', real.lossesToHalf === Math.ceil(29.5 / 10.13));
  const cent = sizePlan({ entry: 4472.54, stop: 4462.41, target: 4492.80, account: 59, riskPct: 2, broker: { contractSize: 1, minLot: 0.01, lotStep: 0.01 } });
  ok('บัญชี 1 ล็อต = 1 ออนซ์ → ทุน 59 เดิมเทรดได้ที่ความเสี่ยงปกติ', cent.tradeable && cent.riskPctActual <= 2 + 1e-9, `${cent.lots} ล็อต ${cent.riskPctActual.toFixed(2)}%`);

  const pb = planAt(1, 3000, 5, RULE, { spread: 0.3, slip: 0.1 });
  ok('แผนซื้อ: เข้าที่ ask · SL 2ATR ใต้ราคา · เป้า 2R', near(pb.entry, 3000.3) && near(pb.stop, 2990) && near(pb.target, 3000.3 + 2 * 10.3));
  const ps = planAt(-1, 3000, 5, RULE, { spread: 0.3, slip: 0.1 });
  ok('แผนขาย: เข้าที่ bid · SL = bid + สเปรด + 2ATR · เป้า 2R', near(ps.entry, 3000) && near(ps.stop, 3010.3) && near(ps.target, 3000 - 2 * 10.3));
}

/* ───────────────────────────────────────────────────────────────────── */
section('8) สถิติ — ตัวอย่างน้อยต้องได้ช่วงกว้าง ซึ่งคือความจริง');
{
  const ci = wilson(7, 10);
  ok('ชนะ 7 จาก 10 → ช่วงความเชื่อมั่นกว้างมาก (ไม่ใช่ "70% แน่นอน")', ci.low < 45 && ci.high > 85, JSON.stringify(ci));
  const ci2 = wilson(700, 1000);
  ok('ชนะ 700 จาก 1000 → ช่วงแคบลงชัดเจน', ci2.high - ci2.low < 6);
  ok('ไม่มีข้อมูล → ไม่คืนตัวเลขมั่ว', wilson(0, 0) === null && probPositive([1, 2]) === null);
  const st = statsOf([1, -1, -1, -1, 2, -1, 2].map((r, i) => ({ r, t: Date.UTC(2025, 0, 1 + i * 20), side: 1, hold: 3 })));
  ok('นับแพ้ติดกันสูงสุดถูก (3 ไม้)', st.maxLossStreak === 3);
  ok('ติดลบลึกสุดวัดจากยอดสูงสุดเดิม (1 → −2 = 3R)', near(st.maxDD, 3));
  ok('กำไรรวมและเฉลี่ยถูก', near(st.totalR, 1) && near(st.avgR, 1 / 7));
  ok('Profit factor = กำไรรวม ÷ ขาดทุนรวม = 5/4', near(st.pf, 1.25));
  ok('โอกาสเป็นบวกจากการสุ่มซ้ำ ได้ตัวเลขเดิมทุกครั้ง (seed ตายตัว)', statsOf([1, -1, 2, -1, 1]).pPos === statsOf([1, -1, 2, -1, 1]).pPos);
}

/* ───────────────────────────────────────────────────────────────────── */
section('9) ผลอ้างอิง 4 ปี — ต้องตรงกับกติกาที่ใช้จริง');
{
  /* ถ้ามีคนแก้กติกาใน system.js แล้วลืมสร้างผลอ้างอิงใหม่ หน้าจอจะโชว์ผลของกติกาที่ไม่ได้ใช้แล้ว */
  ok('กติกาในผลอ้างอิง = กติกาที่ใช้ให้สัญญาณจริงทุกค่า', JSON.stringify(REFERENCE.rule) === JSON.stringify(RULE),
    `อ้างอิง ${JSON.stringify(REFERENCE.rule)} · จริง ${JSON.stringify(RULE)}`);
  const S = REFERENCE.stats, T = REFERENCE.trades;
  const rs = T.map((t) => t[2]);
  ok('จำนวนไม้ตรงกับรายการไม้', S.n === T.length);
  ok('อัตราชนะคำนวณจากรายการไม้ได้ตรง', near(S.win, rs.filter((r) => r > 0).length / rs.length * 100, 0.01));
  ok('กำไรรวมคำนวณจากรายการไม้ได้ตรง', near(S.totalR, rs.reduce((a, r) => a + r, 0), 0.01));
  ok('ผลรายปีรวมกันได้ครบทุกไม้', REFERENCE.byYear.reduce((a, y) => a + y.n, 0) === S.n);
  ok('ผลแยกฝั่งรวมกันได้ครบทุกไม้', REFERENCE.bySide.reduce((a, y) => a + y.n, 0) === S.n);
  ok('ต้นทุนที่ใช้ทดสอบ = ต้นทุนตั้งต้นของระบบ', REFERENCE.costs.spread === COSTS.spread && REFERENCE.costs.slip === COSTS.slip);
  ok('ไม่มีราคาดิบของผู้ให้ข้อมูลในไฟล์ (เก็บแค่ผลที่คำนวณแล้ว)', T.every((t) => t.length === 4 && Math.abs(t[2]) < 10));
  ok('ความทนทาน: ทุกแบบที่เปลี่ยนค่ายังมีรายงาน (ไม่ได้เลือกโชว์เฉพาะที่ดี)', REFERENCE.robust.flatMap((g) => g.rows).length >= 20);
}

/* ───────────────────────────────────────────────────────────────────── */
section('10) เตรียมข้อมูล — แท่งที่ยังไม่ปิดต้องถูกติดป้ายตามเวลาจริง');
{
  const h1 = Array.from({ length: 10 }, (_, i) => ({ t: Date.UTC(2025, 5, 2, i), o: 10 + i, h: 11 + i, l: 9 + i, c: 10.5 + i, v: 1, closed: true }));
  const r4 = resample(h1, H4, Date.UTC(2025, 5, 2, 9, 30));
  ok('รวม 1 ชม. เป็น 4 ชม.: เปิด=ของแท่งแรก · สูง/ต่ำสุดของช่วง · ปิด=ของแท่งท้าย', r4.length === 3 && r4[0].o === 10 && r4[0].h === 14 && r4[0].l === 9 && r4[0].c === 13.5);
  ok('แท่ง 4 ชม. ที่เวลายังไม่ครบ → ยังไม่ปิด', r4[2].closed === false && r4[1].closed === true);
  /* ตัวแปลงข้อมูลหลายเจ้าติดป้าย closed: true ให้ทุกแท่ง รวมแท่งที่ยังก่อตัวอยู่ */
  const liars = [{ t: Date.UTC(2025, 5, 2, 0), closed: true }, { t: Date.UTC(2025, 5, 2, 4), closed: true }];
  const mc = markClosed(liars, H4, Date.UTC(2025, 5, 2, 5));
  ok('แท่งที่แหล่งข้อมูลบอกว่าปิดแล้ว แต่เวลายังไม่ครบ → ยังไม่ปิด', mc[0].closed === true && mc[1].closed === false);
  const week = Array.from({ length: 7 }, (_, d) => ({ t: Date.UTC(2025, 5, 2 + d), c: 1 }));   // จันทร์ 2 มิ.ย. 2025
  const kept = spotBarsOnly(week, D1).map((b) => new Date(b.t).getUTCDay());
  ok('ตัดแท่งรายวันวันเสาร์ทิ้ง (ตลาดทองปิดทั้งวัน)', !kept.includes(6), kept.join(','));
  ok('เก็บวันทำการไว้ครบ', [1, 2, 3, 4, 5].every((d) => kept.includes(d)));
  const sat4h = Array.from({ length: 6 }, (_, k) => ({ t: Date.UTC(2025, 5, 7, k * 4) }));
  ok('ตัดแท่ง 4 ชม. ของวันเสาร์ทิ้งทั้งหมด', spotBarsOnly(sat4h, H4).length === 0);
}

/* ───────────────────────────────────────────────────────────────────── */
section('11) ตลาดทองปิดเสาร์-อาทิตย์ — ระบบต้องรู้เรื่องนี้');
{
  const at = (iso) => goldMarketOpen(new Date(iso));
  ok('ศุกร์ 16:59 ET — เปิด', at('2026-09-04T20:59:00Z').open === true);
  ok('ศุกร์หลัง 17:00 ET — ปิด', at('2026-09-04T21:01:00Z').open === false);
  ok('เสาร์ — ปิดทั้งวัน', at('2026-09-05T12:00:00Z').open === false);
  ok('อาทิตย์ก่อน 18:00 ET — ยังปิด', at('2026-09-06T21:00:00Z').open === false);
  ok('อาทิตย์หลัง 18:00 ET — เปิด', at('2026-09-06T22:01:00Z').open === true);
  ok('พักรายวัน 17:00-18:00 ET — ปิด', at('2026-09-08T21:30:00Z').open === false);
  ok('ฤดูหนาว: อาทิตย์ 23:00 UTC (18:00 ET) เปิด', at('2026-01-11T23:00:00Z').open === true && at('2026-01-11T22:00:00Z').open === false);
  const sat = at('2026-09-05T11:59:14Z');
  ok('บอกเวลาเปิดครั้งถัดไปได้ ลงตัวที่ต้นชั่วโมง', sat.opensAt.toISOString() === '2026-09-06T22:00:00.000Z');
  let agree = true;
  for (let t = Date.UTC(2026, 8, 1); t < Date.UTC(2026, 8, 15); t += 1800000) if (spotOpenAt(t) !== goldMarketOpen(new Date(t)).open) agree = false;
  ok('ตัวเช็คแบบเร็ว (ใช้กรองแท่ง) ตอบตรงกับตัวเช็คหลักทุกครึ่งชั่วโมงตลอด 2 สัปดาห์', agree);
  ok('ช่วงตลาดวันเสาร์ ต้องไม่ถูกเรียกว่า London session', sessionInfo(new Date('2026-09-05T12:00:00Z')).key === 'closed');
  ok('แปลงราคาทองไทย: 4000 ดอลลาร์ที่ 35 บาท ≈ 67,000 บาท/บาททอง', Math.abs(xauToThaiBaht(4000, 35) - 66213) < 50);
}

/* ───────────────────────────────────────────────────────────────────── */
section('12) ข้อมูลสด — "ดึงสำเร็จ" ไม่เท่ากับ "ราคายังมีชีวิต"');
{
  const f = new MarketFeed();
  f.stopped = false; f.source = 'kraken_paxg';
  const bar = { t: 1700000000000, o: 4470, h: 4471, l: 4469, c: 4470, v: 1, closed: true };
  f._emit(bar);
  const t0 = f.lastMoveAt;
  f._emit({ ...bar });
  ok('ได้ค่าเดิมซ้ำ ต้องไม่นับว่าราคาขยับ', t0 > 0 && f.lastMoveAt === t0);
  const now = Date.now();
  f.lastDataAt = now; f.lastMoveAt = now - (f.frozenAfterMs + 60000);
  const fr = f.freshness(now);
  ok('คำขอยังผ่าน แต่ราคาไม่ขยับนาน → จับได้ว่าค้าง', fr.stale === false && fr.frozen === true && fr.usable === false);
  f.lastDataAt = now - (f.staleAfterMs + 1000);
  ok('ไม่มีข้อมูลเข้ามานานเกิน → หลุด', f.freshness(now).stale === true);
  const arr = [{ t: 1, c: 1 }, { t: 2, c: 2 }];
  mergeCandle(arr, { t: 2, c: 3 }); mergeCandle(arr, { t: 3, c: 4 });
  ok('แท่งเดิม = แทนที่ · แท่งใหม่ = ต่อท้าย', arr.length === 3 && arr[1].c === 3 && arr[2].c === 4);
  ok('เลือกแหล่งตรง ๆ ได้ (กราฟทุกกรอบต้องมาจากเจ้าเดียวกัน)', typeof f.loadFrom === 'function');
  ok('ทุกแท่งต้องผ่านตัวจดว่าราคาขยับ ไม่มีทางลัด', !/this\.onCandle\(\{/.test(read('js/feed.js')));
}

/* ───────────────────────────────────────────────────────────────────── */
section('13) แหล่งราคา — ตัวแปลงต้องอ่านคอลัมน์ถูกลำดับ');
{
  const t0 = 1735689600000, step = 900000, O = 2600, Hh = 2620, L = 2590, C = 2610;
  const shapes = {
    binance_paxg: [[t0, `${O}`, `${Hh}`, `${L}`, `${C}`, '12.5', t0 + step - 1], [t0 + step, `${C}`, `${Hh}`, `${L}`, `${O}`, '11.0', t0 + 2 * step - 1]],
    kraken_paxg: { error: [], result: { PAXGUSD: [[t0 / 1000, `${O}`, `${Hh}`, `${L}`, `${C}`, '2605', '12.5', 40], [(t0 + step) / 1000, `${C}`, `${Hh}`, `${L}`, `${O}`, '2605', '11', 38]], last: 1 } },
    bitfinex_xaut: [[t0, O, C, Hh, L, 12.5], [t0 + step, C, O, Hh, L, -11.0]],
    okx_paxg: { code: '0', data: [[`${t0 + step}`, `${C}`, `${Hh}`, `${L}`, `${O}`, '11'], [`${t0}`, `${O}`, `${Hh}`, `${L}`, `${C}`, '12.5']] },
    twelvedata: { values: [{ datetime: '2025-01-01 00:00:00', open: `${O}`, high: `${Hh}`, low: `${L}`, close: `${C}`, volume: '12' },
      { datetime: '2025-01-01 00:15:00', open: `${C}`, high: `${Hh}`, low: `${L}`, close: `${O}`, volume: '11' }] },
  };
  for (const key of Object.keys(SOURCES)) {
    const bars = SOURCES[key].parse(shapes[key]);
    const b = bars[0] || {};
    ok(`${SOURCES[key].label}: อ่านเปิด/สูง/ต่ำ/ปิด ถูกลำดับ เรียงเก่า→ใหม่ เวลาเป็นมิลลิวินาที`,
      bars.length === 2 && b.o === O && b.h === Hh && b.l === L && b.c === C && bars[0].t === t0 && bars[1].t > bars[0].t,
      JSON.stringify(b));
  }
  ok('ทุกแหล่งมีกราฟรายวัน (กติกาต้องใช้)', Object.values(SOURCES).every((s) => s.tf['1d'] !== undefined));
  ok('ทุกแหล่งมีกราฟ 4 ชม. หรือ 1 ชม. ให้รวมเอง', Object.values(SOURCES).every((s) => s.tf['4h'] !== undefined || s.tf['1h'] !== undefined));
  ok('ตัวตรวจจับได้เมื่อสูง/ต่ำสลับกัน', !validateBars([{ t: t0, o: O, h: L, l: Hh, c: C }], step).ok);
  ok('ตัวตรวจจับได้เมื่อราคาไม่ใช่ช่วงราคาทอง', !validateBars([{ t: t0, o: 1.1, h: 1.2, l: 1.0, c: 1.15 }], step).ok);
  const blocked = await testSource('kraken_paxg', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  ok('โดนบล็อก → บอกสาเหตุเป็นภาษาคน', !blocked.ok && blocked.cors === true);
}

/* ───────────────────────────────────────────────────────────────────── */
section('14) ติดตามไม้ของฉัน — ตัวเลขต้องตรงกับที่โบรกเกอร์คิด');
{
  const real = { side: 1, entry: 4472.54, sl: 4463.23, tp: 4493.23, size: 1, contractSize: 1, openedAt: Date.now() };
  const st = positionStatus(real, 4463.22, 59.30);
  ok('ไม้จริงของผู้ใช้: โบรกเกอร์รายงาน −9.32 ดอลลาร์ พอดี', Math.abs(st.pl + 9.32) < 0.01, st.pl);
  ok('รู้ว่าเลยจุดตัดขาดทุนแล้ว', st.hitSL === true && st.state === 'sl');
  const sell = positionStatus({ side: -1, entry: 4472.54, sl: 4482.54, tp: 4452.54, size: 1, contractSize: 1 }, 4462.54, 1000);
  ok('ไม้ขาย: ราคาลง = กำไร +1R', near(sell.pl, 10, 0.01) && near(sell.r, 1));
  ok('0.01 ล็อต × 100 ออนซ์ = 1 ออนซ์', near(positionStatus({ ...real, size: 0.01, contractSize: 100 }, 4482.54, 0).pl, 10, 1e-6));
  ok('SL ผิดฝั่ง → ฟ้อง ไม่คำนวณต่อ', checkPosition({ ...real, sl: 4500 }).length > 0);
  ok('ข้อความสรุปรายงาน ไม่ใช่สั่ง', !/ควรปิด|รีบปิด|ถือต่อ|เพิ่มไม้/.test(positionAdvice(positionStatus(real, 4480, 1000)).text));
}

/* ───────────────────────────────────────────────────────────────────── */
section('15) Discord — ข้อความต้องไม่หลอกคนอ่าน');
{
  for (const u of ['https://discord.com/api/webhooks/123/abc', 'https://discord.com/api/v10/webhooks/123/abc-_X']) ok(`รับ URL ที่ถูกต้อง ${u.slice(8, 40)}`, isValidWebhook(u));
  for (const u of ['https://evil.com/api/webhooks/1/a', 'http://discord.com/api/webhooks/1/a', 'https://discord.com/channels/1/2', '', null]) ok(`ปฏิเสธ ${u}`, !isValidWebhook(u));
  ok('ลิงก์ห้องแชทถูกเรียกชื่อออกมาตรง ๆ', /ห้องแชท/.test(webhookProblem('https://discord.com/channels/111/222')));
  ok('เหตุผลไม่พาโทเค็นหลุดออกมา', !String(webhookProblem('https://discord.com/api/webhooks/1/sEcReT123/extra')).includes('sEcReT123'));

  const plan = planAt(1, 3000, 5), size = sizePlan({ ...plan, account: 10000, riskPct: 1, broker: { contractSize: 100, minLot: 0.01, lotStep: 0.01 } });
  const buy = buildSignalMessage({ action: 'buy', price: 3000, instrument: 'ทดสอบ', plan, size, checks: [{ ok: true, text: 'ก' }], stats: REFERENCE.stats });
  const fields = JSON.stringify(buy.embeds[0].fields);
  ok('สัญญาณซื้อมีราคาเข้า SL TP ขนาดไม้ และเงินที่เสี่ยงครบ', /ซื้อที่/.test(fields) && /ตัดขาดทุน/.test(fields) && /ทำกำไร/.test(fields) && /ขนาดไม้/.test(fields) && /เสี่ยง/.test(fields));
  ok('แนบผลของกติกาบนทองจริงไปด้วย', /166 ไม้|ไม้ · ชนะ/.test(fields));
  const nocap = buildSignalMessage({ action: 'nocap', price: 3000, instrument: 'ทดสอบ', blocks: ['ทุนไม่พอ'] });
  ok('ทุนไม่พอ → หัวเรื่องบอกว่ามีสัญญาณแต่ทุนไม่พอ (ไม่ใช่ "ยังไม่มีสัญญาณ")', /ทุนไม่พอ/.test(nocap.embeds[0].title) && !/ยังไม่มีสัญญาณ/.test(nocap.embeds[0].title));
  ok('ทุนไม่พอ → ไม่มีราคาเข้า/SL/TP ในข้อความ', !/ซื้อที่|ตัดขาดทุน|ทำกำไร \(/.test(JSON.stringify(nocap)));
  ok('ข้อความทดสอบสร้างได้', buildTestMessage().embeds[0].fields.length > 3);
  const sent = await sendDiscord('https://discord.com/api/webhooks/1/a', { x: 1 }, { fetchImpl: async () => ({ ok: false, status: 404 }) });
  ok('Discord ปฏิเสธ → รายงานเหตุผล ไม่ล้มเงียบ', !sent.ok && /ไม่รับ webhook/.test(sent.reason));
  const alerts = read('js/alerts.js');
  ok('หน้าเว็บส่ง Discord เฉพาะข้อความที่จัดรูปแล้ว ไม่เดาหัวเรื่องเอง', /if \(discord\) this\.sendWebhook\(discord\)/.test(alerts) && !/buildSignalMessage/.test(alerts));
}

/* ───────────────────────────────────────────────────────────────────── */
section('16) บอท — ทดสอบครบสายด้วยตลาดสมมติ (ไม่ต่อเน็ต)');
{
  const runBot = (scenario, nowIso, extraEnv = {}) => {
    try {
      return execFileSync(process.execPath, ['--import', './test/fixtures/mock-market.mjs', 'bot/run.mjs'], {
        env: { ...process.env, MOCK_SCENARIO: scenario, MOCK_NOW: String(Date.parse(nowIso)), BOT_SOURCES: 'kraken_paxg',
          DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc', BOT_STATE: `/tmp/gsl-test-state-${scenario}-${Date.now()}-${Math.random()}.json`,
          BOT_ACCOUNT: '10000', BOT_RISK_PCT: '1', BOT_DRY_RUN: '0', BOT_TEST_PING: '0', ...extraEnv },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
      });
    } catch (e) { return `EXIT ${e.status}\n${e.stdout}${e.stderr}`; }
  };
  const wed = '2026-09-23T09:10:00Z', sat = '2026-09-26T09:10:00Z';
  const entry = runBot('entry', wed);
  ok('ตลาดเปิด + แท่งเพิ่งปิดย่อลงใต้เส้น → ส่งสัญญาณซื้อ', /MOCK_DISCORD .*สัญญาณซื้อ/.test(entry), entry.slice(-400));
  const msg = (entry.match(/MOCK_DISCORD (.*)/) || [])[1] || '{}';
  ok('ข้อความจริงจากบอทมีแผนเทรดครบ', /ซื้อที่/.test(msg) && /ตัดขาดทุน/.test(msg) && /ขนาดไม้/.test(msg));
  const wait = runBot('wait', wed);
  ok('ยังไม่ย่อ → ไม่ส่งอะไร และบอกในล็อกว่ารออะไร', !/MOCK_DISCORD/.test(wait) && /รอราคาย่อ/.test(wait), wait.slice(-300));
  const closed = runBot('entry', sat);
  ok('วันเสาร์ ตลาดปิด → ไม่ส่งสัญญาณ แม้ราคาเหรียญทองจะขยับ', !/MOCK_DISCORD/.test(closed) && /ตลาดทอง spot ปิด/.test(closed), closed.slice(-300));
  const poor = runBot('entry', wed, { BOT_ACCOUNT: '59', BOT_RISK_PCT: '2' });
  ok('ทุน 59 → ส่งไปบอกว่าทุนไม่พอ ไม่มีราคาเข้า/SL/TP', /MOCK_DISCORD .*ทุนไม่พอ/.test(poor) && !/ซื้อที่/.test((poor.match(/MOCK_DISCORD (.*)/) || [])[1] || ''));
  const conflict = runBot('entry', wed, { BOT_DRY_RUN: '1', BOT_TEST_PING: '1' });
  ok('ติ๊กทั้ง dry run และ test ping → ไม่ส่งออก พร้อมบอกเหตุผล', !/MOCK_DISCORD/.test(conflict) && /dry run/.test(conflict));
  const ping = runBot('wait', sat, { BOT_TEST_PING: '1' });
  ok('ตรวจสถานะตามสั่ง → ส่งภาพตลาดจริงเสมอ แม้ตลาดปิด', /MOCK_DISCORD .*รายงานสถานะ/.test(ping) && /ตลาดทอง spot ปิด/.test(ping));
  const bad = runBot('entry', wed, { BOT_ACCOUNT: '1,000' });
  ok('ตั้งค่าเป็นตัวเลขไม่ได้ → หยุดพร้อมบอกว่าผิดตรงไหน ไม่เงียบทั้งวัน', /EXIT 1/.test(bad) && /BOT_ACCOUNT/.test(bad));
  const retired = runBot('wait', wed, { BOT_THRESHOLD: '40' });
  ok('ค่ารุ่นเก่าที่ไม่มีผลแล้ว → บอกให้รู้ ไม่เมินเงียบ ๆ', /BOT_THRESHOLD/.test(retired) && /ไม่มีผลแล้ว/.test(retired));
  const bot = read('bot/run.mjs');
  ok('บอทไม่มีสูตรตัดสินใจของตัวเอง — ใช้ currentState ตัวเดียวกับหน้าเว็บ', /currentState\(sys/.test(bot) && !/ema\(|atr\(/.test(bot));
}

/* ───────────────────────────────────────────────────────────────────── */
section('17) หน้าเว็บ — ด่านความปลอดภัยต้องต่อสายจริง');
{
  const app = read('js/app.js');
  ok('หน้าเว็บไม่มีสูตรตัดสินใจของตัวเอง — ใช้ currentState ตัวเดียวกับบอท', /currentState\(state\.sys/.test(app));
  ok('ตลาดปิด = ด่านตายตัว', /goldMarketOpen\(new Date\(\)\)/.test(app) && /key: 'closed'/.test(app));
  ok('ข้อมูลค้าง/ราคาไม่ขยับ = ห้ามเข้า', /fr\.stale/.test(app) && /fr\.frozen/.test(app));
  ok('ทุนไม่พอ = ไม่มีแผนให้กด (ซ่อนการ์ดแผน)', /!size\.tradeable/.test(app) && /renderPlan\(cur\.kind === 'entry' && !blockedTrade/.test(app));
  ok('ค่าตั้งที่อ่านมาต้องผ่านการตรวจช่วงก่อนใช้', /const RANGE = \{/.test(app) && /v >= lo && v <= hi/.test(app));
  ok('สัญญาณที่ค้างอยู่ก่อนเปิดหน้า ไม่ส่งเสียงซ้ำ', /if \(state\.firstCalc\) return;/.test(app));
  ok('ไม่มีคีย์ API ของใครฝังอยู่ในโค้ด', !/[0-9a-f]{32}/.test(app + read('js/feed.js') + read('js/sources.js')));
  const html = read('index.html');
  ok('ทุก id ที่โค้ดเรียกมีอยู่จริงในหน้า', [...app.matchAll(/\$\('([A-Za-z]+)'\)/g)].map((m) => m[1]).every((id) => html.includes(`id="${id}"`)),
    [...app.matchAll(/\$\('([A-Za-z]+)'\)/g)].map((m) => m[1]).filter((id) => !html.includes(`id="${id}"`)).join(','));
  const css = read('styles.css');
  ok('ของที่ซ่อนไว้ต้องซ่อนจริง (display ของปุ่มชนะ hidden ไม่ได้)', /\[hidden\] \{ display: none !important; \}/.test(css));
  ok('มีธีมสว่างและมืดครบ', /prefers-color-scheme: light/.test(css) && /\[data-theme="light"\]/.test(css));
  ok('เส้นตารางกราฟเป็นเลขกลม (1, 2, 5 × 10ⁿ)', niceStep(7) === 5 && niceStep(13) === 10 && niceStep(0.3) === 0.2 && niceStep(24) === 20);
}

/* ───────────────────────────────────────────────────────────────────── */
section('18) ไฟล์รวมและ TradingView');
{
  const out = execFileSync(process.execPath, ['build-single.mjs'], { encoding: 'utf8' });
  ok('สร้างไฟล์รวมได้ และไม่มี import/export หลงเหลือ', /ไม่มี import\/export หลงเหลือ/.test(out), out.slice(-200));
  const order = (read('build-single.mjs').match(/const ORDER = \[([^\]]*)\]/) || [])[1] || '';
  const files = readdirSync('js').filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));
  ok('ทุกไฟล์ใน js/ อยู่ในลำดับการรวม', files.every((f) => order.includes(`'${f}'`)), files.filter((f) => !order.includes(`'${f}'`)).join(','));
  const pine = read('tradingview/gold-signal-lab.pine');
  ok('Pine ใช้กติกาเดียวกัน: เทรนด์รายวัน EMA20/50', new RegExp(`trendFast\\s*=\\s*input\\.int\\(${RULE.trendFast}`).test(pine) && new RegExp(`trendSlow\\s*=\\s*input\\.int\\(${RULE.trendSlow}`).test(pine));
  ok('Pine ใช้กติกาเดียวกัน: ย่อใต้ EMA20 กราฟ 4 ชม. · SL 2ATR · เป้า 2R',
    new RegExp(`pullbackLen\\s*=\\s*input\\.int\\(${RULE.pullbackEma}`).test(pine) && new RegExp(`stopMult\\s*=\\s*input\\.float\\(${RULE.stopAtr}`).test(pine) && new RegExp(`targetR\\s*=\\s*input\\.float\\(${RULE.targetR}`).test(pine));
  ok('Pine ไม่มองอนาคต (ดึงค่ากราฟรายวันของเมื่อวาน [1] แบบไม่วาดใหม่)', /lookahead\s*=\s*barmerge\.lookahead_on/.test(pine) && /close\[1\]/.test(pine) && /ta\.ema\(close, trendSlow\)\[1\]/.test(pine));
  ok('Pine มีช่วงพักหลังออกไม้ และถือไม่เกิน 36 แท่ง', /cooldownBars/.test(pine) && new RegExp(`maxHold\\s*=\\s*input\\.int\\(${RULE.maxHold}`).test(pine));
  const tv = read('tradingview.html');
  ok('หน้า tradingview.html มีโค้ดตรงกับไฟล์ Pine จริง', tv.includes(pine.split('\n').find((l) => /indicator\(|strategy\(/.test(l)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`ผ่าน ${pass} / ล้มเหลว ${fail}`);
process.exit(fail ? 1 : 0);
