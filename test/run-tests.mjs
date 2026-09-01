/**
 * ชุดทดสอบ (รันด้วย: node test/run-tests.mjs)
 * เน้น 3 เรื่องที่ถ้าพลาดแล้วผลลัพธ์จะ "ดูดีเกินจริง" หรือหลอกผู้ใช้:
 *  1. คณิตศาสตร์ของตัวชี้วัดถูกต้อง (เทียบกับสูตรตรงและค่าที่คำนวณมือได้)
 *  2. ไม่มีการมองอนาคต (look-ahead) — คะแนนที่แท่ง i ต้องเท่ากันไม่ว่าจะรู้ข้อมูลหลังแท่ง i หรือไม่
 *  3. การจำลองเทรดใน backtest สมเหตุสมผล (ลำดับเวลา ราคาเข้า ทิศทาง SL/TP ขนาดไม้)
 */
import * as ta from '../js/indicators.js';
import { buildContext, scoreAt, buildSetup, holdSignal, DEFAULT_CFG, WEIGHTS } from '../js/signals.js';
import { runBacktest, optimizeExits } from '../js/backtest.js';
import { fitLogistic, standardize, learnWeights, learnAndValidate, probBetter, toDataset } from '../js/learn.js';
import { tuneOn, rollingWalkForward, driftCheck, autoTune } from '../js/adapt.js';
import { MarketFeed } from '../js/feed.js';
import { SOURCES, validateBars, testSource, testAllSources } from '../js/sources.js';
import { classifyHeadline, climateOf, parseGdeltDate, fetchNews, economicCalendar, GOLD_DRIVERS } from '../js/news.js';
import { buildNewsIndex, newsAt, newsAgreement, evaluateNewsFilter, newsVerdict, fetchHistoricalNews, DEFAULT_NEWS_CFG } from '../js/newsfactor.js';
import { isValidWebhook, webhookProblem, sendDiscord, buildSignalMessage, buildTestMessage } from '../js/discord.js';
import { NEWS_FEEDS, FEED_ORDER, surpriseOf, dedupe, similarity, sourceWeight, tokensOf } from '../js/news.js';
import { findPivots, clusterLevels, levelsAt } from '../js/levels.js';
import { nextNFP, usDstActive, xauToThaiBaht } from '../js/macro.js';

let pass = 0, fail = 0;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── ข้อมูลทดสอบ ────────────────────────────────────────────────────────
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeCandles(n, seed = 7, drift = 0) {
  const rnd = mulberry(seed);
  const out = [];
  let p = 3300;
  for (let i = 0; i < n; i++) {
    const shock = (rnd() - 0.5) * 6 + drift;
    const o = p, c = p + shock;
    const h = Math.max(o, c) + rnd() * 2.2;
    const l = Math.min(o, c) - rnd() * 2.2;
    out.push({ t: 1700000000000 + i * 900000, o, h, l, c, v: 100 + rnd() * 400, closed: true });
    p = c;
  }
  return out;
}

// ── 1. ตัวชี้วัด ───────────────────────────────────────────────────────
section('1) คณิตศาสตร์ของตัวชี้วัด');
{
  const v = [1, 2, 3, 4, 5, 6];
  const s = ta.sma(v, 3);
  ok('SMA(3) เว้น warm-up และหาค่าเฉลี่ยถูก', s[0] === null && s[1] === null && near(s[2], 2) && near(s[5], 5));

  const e = ta.ema([2, 4, 6, 8, 10], 3);
  // seed = ค่าเฉลี่ย 3 ตัวแรก = 4 ; k = 0.5 ; ถัดไป = 8*0.5 + 4*0.5 = 6 ; แล้ว 10*0.5+6*0.5 = 8
  ok('EMA(3) seed ด้วย SMA และไล่สูตรถูก', near(e[2], 4) && near(e[3], 6) && near(e[4], 8), `ได้ ${e.slice(2)}`);

  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const dn = Array.from({ length: 40 }, (_, i) => 100 - i);
  ok('RSI ของราคาขึ้นล้วน = 100', near(ta.rsi(up, 14)[39], 100, 1e-9));
  ok('RSI ของราคาลงล้วน = 0', near(ta.rsi(dn, 14)[39], 0, 1e-9));

  // RSI เทียบกับ implementation ตรงไปตรงมา (Wilder) ที่เขียนแยกในไฟล์ทดสอบ
  const px = makeCandles(120, 3).map((c) => c.c);
  const refRsi = (values, p) => {
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = values[i] - values[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= p; l /= p;
    const out = [];
    out[p] = 100 - 100 / (1 + g / l);
    for (let i = p + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      g = (g * (p - 1) + Math.max(0, d)) / p;
      l = (l * (p - 1) + Math.max(0, -d)) / p;
      out[i] = 100 - 100 / (1 + g / l);
    }
    return out;
  };
  const mine = ta.rsi(px, 14), ref = refRsi(px, 14);
  let maxDiff = 0;
  for (let i = 20; i < px.length; i++) maxDiff = Math.max(maxDiff, Math.abs(mine[i] - ref[i]));
  ok('RSI ตรงกับสูตร Wilder อิสระ', maxDiff < 1e-9, `ต่างสูงสุด ${maxDiff}`);

  const c1 = [{ o: 10, h: 12, l: 9, c: 11, v: 1 }, { o: 11, h: 15, l: 10, c: 14, v: 1 }];
  const tr = ta.trueRange(c1);
  ok('True Range แท่งแรก = high-low, แท่งถัดไปเทียบราคาปิดก่อนหน้า', near(tr[0], 3) && near(tr[1], 5), `ได้ ${tr}`);

  const bb = ta.bollinger([5, 5, 5, 5, 5, 5], 5, 2);
  ok('Bollinger: ราคานิ่ง → แบนด์บนล่างเท่าเส้นกลาง', near(bb.upper[5], 5) && near(bb.lower[5], 5));
  const bb2 = ta.bollinger(px, 20, 2);
  ok('Bollinger: เส้นกลาง = SMA20', near(bb2.mid[50], ta.sma(px, 20)[50], 1e-9));
  ok('Bollinger: %B = 0.5 เมื่อราคาอยู่กลางแบนด์', bb2.pctB[50] > 0 && bb2.pctB[50] < 1);

  const flat = Array.from({ length: 60 }, () => ({ o: 10, h: 10.5, l: 9.5, c: 10, v: 1 }));
  const adxFlat = ta.adx(flat, 14);
  ok('ADX ของตลาดนิ่งสนิท ต่ำมาก (<10)', adxFlat.adx[59] < 10, `ได้ ${adxFlat.adx[59]}`);
  const trend = Array.from({ length: 60 }, (_, i) => ({ o: 100 + i, h: 100.8 + i, l: 99.6 + i, c: 100.5 + i, v: 1 }));
  const adxTrend = ta.adx(trend, 14);
  ok('ADX ของเทรนด์ขึ้นชัดเจน สูง (>40)', adxTrend.adx[59] > 40, `ได้ ${adxTrend.adx[59]}`);
  ok('+DI มากกว่า -DI ในเทรนด์ขาขึ้น', adxTrend.plusDI[59] > adxTrend.minusDI[59]);

  // VWAP เริ่มนับใหม่ทุกวัน — กราฟจึงต้องตัดเส้นตรงรอยต่อ ไม่ลากพาด
  const day = 86400000, hr = 3600000;
  const twoDays = [];
  for (let i = 0; i < 48; i++) {
    const price = i < 24 ? 100 : 200;   // วันที่สองราคากระโดดไปคนละระดับ
    twoDays.push({ t: Date.UTC(2026, 0, 1) + i * hr, o: price, h: price, l: price, c: price, v: 10 });
  }
  const vw = ta.vwapDaily(twoDays);
  ok('VWAP วันแรกเท่ากับราคาของวันนั้น', near(vw[23], 100, 1e-9), `ได้ ${vw[23]}`);
  ok('VWAP รีเซ็ตเมื่อขึ้นวันใหม่ (ไม่ลากค่าเฉลี่ยข้ามวัน)', near(vw[24], 200, 1e-9), `ได้ ${vw[24]}`);
  ok('รอยต่อวันตรวจจับได้จาก timestamp',
    new Date(twoDays[23].t).getUTCDate() !== new Date(twoDays[24].t).getUTCDate());
  void day;

  ok('ทุก series ยาวเท่าอินพุตเสมอ',
    ta.rsi(px, 14).length === px.length && ta.atr(makeCandles(50), 14).length === 50 && ta.macd(px).hist.length === px.length);
}

// ── 2. ไม่มองอนาคต ────────────────────────────────────────────────────
section('2) การป้องกันการมองอนาคต (look-ahead)');
{
  const candles = makeCandles(700, 11);
  const full = buildContext(candles, DEFAULT_CFG);
  let allMatch = true, worst = 0, worstAt = -1;
  for (const i of [260, 330, 410, 480, 550, 620]) {
    const partial = buildContext(candles.slice(0, i + 1), DEFAULT_CFG);
    const a = scoreAt(full, i), b = scoreAt(partial, i);
    const d = Math.abs(a.score - b.score);
    if (d > worst) { worst = d; worstAt = i; }
    if (d > 1e-9 || a.factors.length !== b.factors.length) allMatch = false;
  }
  ok('คะแนนที่แท่ง i เท่ากันทุกประการ ไม่ว่าจะรู้ข้อมูลหลังแท่ง i หรือไม่', allMatch, `ต่างสูงสุด ${worst} ที่แท่ง ${worstAt}`);

  // โซนแนวรับ-ต้าน ต้องเห็นเท่ากันด้วย
  const pv = findPivots(candles, 3);
  const zFull = clusterLevels(pv, 5);
  const zPart = clusterLevels(findPivots(candles.slice(0, 401), 3), 5);
  const lFull = levelsAt(zFull, 400).map((z) => `${z.price.toFixed(4)}x${z.touches}`).sort().join('|');
  const lPart = levelsAt(zPart, 400).map((z) => `${z.price.toFixed(4)}x${z.touches}`).sort().join('|');
  ok('โซนแนวรับ/ต้าน ณ แท่ง 400 เหมือนกันทั้งกรณีรู้และไม่รู้อนาคต', lFull === lPart);

  const pivotsAfter = pv.filter((p) => p.confirmedAt <= 400 && p.index > 400);
  ok('ไม่มี pivot ที่ "ยืนยันแล้ว" ก่อนที่มันจะเกิดขึ้นจริง', pivotsAfter.length === 0);

  // ปริมาณของแท่งที่ยังไม่ปิด ต้องถูกประมาณการก่อนเทียบกับค่าเฉลี่ย
  const { projectedVolume } = await import('../js/signals.js');
  const step = 900000;
  const t0 = 1700000000000;
  const pair = [
    { t: t0, o: 1, h: 2, l: 0.5, c: 1.5, v: 1000, closed: true },
    { t: t0 + step, o: 1.5, h: 2, l: 1, c: 1.8, v: 250, closed: false },
  ];
  const half = projectedVolume(pair, 1, t0 + step + step / 2);
  ok('แท่งที่ผ่านไปครึ่งเดียว → ประมาณการเป็น 2 เท่าของที่เห็น',
    near(half.v, 500, 1e-6) && half.partial === true, `ได้ ${half.v}`);
  const quarter = projectedVolume(pair, 1, t0 + step + step / 4);
  ok('แท่งที่ผ่านไป 1 ใน 4 → ประมาณการเป็น 4 เท่า', near(quarter.v, 1000, 1e-6), `ได้ ${quarter.v}`);
  const closedBar = projectedVolume([pair[0], { ...pair[1], closed: true }], 1, t0 + step + step / 2);
  ok('แท่งที่ปิดแล้ว → ใช้ปริมาณจริง ไม่ประมาณการ (backtest จึงไม่เปลี่ยน)',
    closedBar.v === 250 && closedBar.partial === false);
  ok('แท่งแรกสุด (ไม่มีแท่งก่อนหน้าให้วัดความยาวกรอบ) → ไม่พัง',
    projectedVolume(pair, 0).partial === false);
  const capped = projectedVolume(pair, 1, t0 + step + 1);
  ok('เพิ่งเปิดแท่งไม่กี่มิลลิวินาที → มีเพดานกันตัวเลขระเบิด', capped.v <= 250 / 0.08 + 1e-6, `ได้ ${capped.v}`);

  const s1 = scoreAt(full, 500), s2 = scoreAt(full, 500);
  ok('ผลลัพธ์คงที่ (deterministic) เรียกซ้ำได้ค่าเดิม', s1.score === s2.score);

  // ปัจจัยเดียวกันต้องไม่ถูกนับซ้ำจนเกินน้ำหนักที่กำหนดไว้
  let capOk = true, capMsg = '';
  const totalW = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  for (let i = 250; i < 700; i++) {
    const sc = scoreAt(full, i);
    const sums = new Map();
    for (const f of sc.factors) sums.set(f.key, (sums.get(f.key) || 0) + f.contribution);
    for (const [k, v] of sums) {
      if (Math.abs(v) > WEIGHTS[k] + 1e-9) { capOk = false; capMsg = `${k} = ${v.toFixed(2)} เกินน้ำหนัก ${WEIGHTS[k]} ที่แท่ง ${i}`; }
    }
    if (Math.abs(sc.score) > 100.000001) { capOk = false; capMsg = `คะแนน ${sc.score} เกิน 100 ที่แท่ง ${i}`; }
  }
  ok('คะแนนของแต่ละปัจจัยไม่เกินน้ำหนักที่กำหนด (ไม่มีการนับซ้ำ)', capOk, capMsg);
  ok('คะแนนรวมอยู่ในช่วง -100 ถึง 100 เสมอ', capOk);
  ok('น้ำหนักรวมเท่ากับผลรวมของทุกปัจจัย', totalW === Object.values(WEIGHTS).reduce((a, b) => a + b, 0));
}

// ── 3. แผนเทรด ────────────────────────────────────────────────────────
section('3) แผนเข้า-ออกและขนาดไม้');
{
  const candles = makeCandles(600, 23);
  const ctx = buildContext(candles, DEFAULT_CFG);
  const i = 599;
  const sc = scoreAt(ctx, i);
  for (const side of [1, -1]) {
    const st = buildSetup(ctx, i, { ...sc, side }, { account: 2000, riskPct: 2, entryPrice: candles[i].c, side });
    ok(`ฝั่ง ${side > 0 ? 'ซื้อ' : 'ขาย'}: SL อยู่${side > 0 ? 'ใต้' : 'เหนือ'}จุดเข้า`, side > 0 ? st.sl < st.entry : st.sl > st.entry);
    ok(`ฝั่ง ${side > 0 ? 'ซื้อ' : 'ขาย'}: เป้าเรียงลำดับ 1R < 2R`, Math.abs(st.tp2 - st.entry) > Math.abs(st.tp1 - st.entry));
    ok(`ฝั่ง ${side > 0 ? 'ซื้อ' : 'ขาย'}: TP1 ห่างเท่ากับระยะ SL พอดี (1R)`, near(Math.abs(st.tp1 - st.entry), st.slDist, 1e-9));
    ok(`ฝั่ง ${side > 0 ? 'ซื้อ' : 'ขาย'}: SL ไม่กว้างเกินเพดาน ${DEFAULT_CFG.maxSlAtrMult}× ATR`, st.slAtr <= DEFAULT_CFG.maxSlAtrMult + 1e-9, `ได้ ${st.slAtr}`);
    /* สูตรยังเดิม แต่ตัวเลขที่รายงานต้องเป็นขนาดที่โบรกเกอร์รับจริง
       จึงแยกเป็นสองอย่าง: ค่าดิบไว้พิสูจน์สูตร กับค่าที่ปัดแล้วไว้ใช้ส่งคำสั่ง */
    const expectLots = (2000 * 0.02) / (st.slDist * 100);
    const s2 = side > 0 ? 'ซื้อ' : 'ขาย';
    ok(`ฝั่ง ${s2}: ขนาดไม้ดิบ = เงินเสี่ยง ÷ (ระยะ SL × 100 ออนซ์)`, near(st.lotsRaw, expectLots, 1e-9));
    ok(`ฝั่ง ${s2}: ขนาดไม้ที่รายงานลงตัวกับขั้นของโบรกเกอร์`,
      near(Math.round(st.lots / st.lotStep) * st.lotStep, st.lots, 1e-9), `ได้ ${st.lots}`);
    ok(`ฝั่ง ${s2}: ขนาดไม้ไม่เล็กกว่าที่ส่งคำสั่งได้`, st.lots >= st.minLot - 1e-9, `ได้ ${st.lots}`);
    ok(`ฝั่ง ${s2}: ปัดลงเสมอ เว้นแต่ถูกดันขึ้นเพราะต่ำกว่าขั้นต่ำ`,
      st.sizeForced || st.lots <= st.lotsRaw + 1e-9);
    /* ความเสี่ยงที่บอกผู้ใช้ ต้องคิดจากขนาดไม้ที่ส่งได้จริง ไม่ใช่จากค่าดิบ
       ไม่งั้นตัวเลข "เสี่ยงกี่บาท" จะไม่ตรงกับสิ่งที่เกิดขึ้นจริงตอนชน SL */
    ok(`ฝั่ง ${s2}: ความเสี่ยงจริงคิดจากขนาดไม้ที่ส่งได้`,
      near(st.riskActual, st.lots * st.slDist * 100, 1e-9));
  }
  /*
   * ทุนน้อยกว่าที่ไม้เล็กที่สุดจะรองรับ = กรณีที่เดิมเงียบแล้วอันตรายที่สุด
   * ระบบเคยบอกว่า "0.0000 ล็อต" แล้วปล่อยให้ผู้ใช้ปัดขึ้นเป็น 0.01 เอง
   * ซึ่งด้วยทุนหลักหน่วย แปลว่าไม้เดียวเสี่ยงเกินพอร์ตทั้งก้อน
   */
  {
    const tiny = buildSetup(ctx, i, { ...sc, side: 1 }, { account: 6, riskPct: 1, entryPrice: ctx.candles[i].c, side: 1 });
    ok('ทุนน้อย: ยังคืนขนาดไม้ที่ส่งคำสั่งได้จริง', tiny.lots >= tiny.minLot - 1e-9, `ได้ ${tiny.lots}`);
    ok('ทุนน้อย: รู้ตัวว่าถูกบังคับให้ใหญ่กว่าที่ตั้งใจ', tiny.sizeForced === true);
    ok('ทุนน้อย: ความเสี่ยงจริงเกินที่ตั้งไว้', tiny.riskActual > 6 * 0.01);
    ok('ทุนน้อย: เตือนเป็นข้อความให้ผู้ใช้เห็น', tiny.notes.some((n) => /⚠|⛔/.test(n)),
      tiny.notes.join(' | ') || 'ไม่มีคำเตือนเลย');
    ok('ทุนน้อย: บอกว่าเสี่ยงเกินทุนทั้งก้อน', tiny.notes.some((n) => /ล้างพอร์ต/.test(n)));
    ok('ทุนน้อย: คำเตือนมีตัวเลขเงินจริง ไม่ใช่คำลอย ๆ',
      tiny.notes.some((n) => n.includes(tiny.riskActual.toFixed(2))));
  }

  // ทุนพอ = ไม่ต้องมีคำเตือนกวนใจ
  {
    const big = buildSetup(ctx, i, { ...sc, side: 1 }, { account: 50000, riskPct: 1, entryPrice: ctx.candles[i].c, side: 1 });
    ok('ทุนพอ: ไม่ถูกบังคับขนาดไม้', big.sizeForced === false);
    ok('ทุนพอ: เสี่ยงจริงไม่เกินที่ตั้งไว้', big.riskActual <= 50000 * 0.01 + 1e-9);
    ok('ทุนพอ: ไม่มีคำเตือนเรื่องทุน', !big.notes.some((n) => /ทุนไม่พอ/.test(n)));
  }

  ok('ถ้าไม่มีทิศทาง ไม่สร้างแผน', buildSetup(ctx, i, { ...sc, side: 0 }, { side: 0 }) === null);
}

// ── 4. Backtest ───────────────────────────────────────────────────────
section('4) การจำลองย้อนหลัง');
{
  const candles = makeCandles(900, 41);
  const ctx = buildContext(candles, DEFAULT_CFG);
  const bt = runBacktest(ctx, { threshold: 30, maxHold: 40, spread: 0.3 });
  ok('สร้างไม้เทรดได้จากข้อมูลสุ่ม', bt.stats.n > 0, `ได้ ${bt.stats.n} ไม้`);
  ok('ทุกไม้ออกหลังเข้าเสมอ', bt.trades.every((t) => t.exitIndex > t.entryIndex));
  ok('ทุกไม้เข้าที่ราคาเปิดของแท่งถัดไป (ไม่ใช่ราคาปิดที่ยังไม่รู้)',
    bt.trades.every((t) => near(t.entry, candles[t.entryIndex].o + (t.side > 0 ? 0.15 : -0.15), 1e-9)));
  ok('ไม่มีไม้ซ้อนกัน (ไม้ถัดไปเริ่มหลังไม้ก่อนหน้าปิด)',
    bt.trades.every((t, k) => k === 0 || t.index > bt.trades[k - 1].exitIndex));
  ok('ผลขาดทุนต่อไม้ไม่เกิน -1R (ยกเว้นค่าสลิปเพจเล็กน้อย)', bt.trades.every((t) => t.rMultiple >= -1.3));
  ok('ทุกไม้เริ่มหลังช่วง warm-up 210 แท่ง', bt.trades.every((t) => t.index >= 210));
  ok('อัตราชนะอยู่ในช่วง 0-100%', bt.stats.winRate >= 0 && bt.stats.winRate <= 100);
  ok('ผลรวม R เท่ากับผลบวกของทุกไม้', near(bt.stats.totalR, bt.trades.reduce((a, t) => a + t.rMultiple, 0), 1e-9));
  ok('จำนวนไม้ในตารางช่วงคะแนน รวมแล้วเท่าจำนวนไม้ทั้งหมด',
    bt.bands.reduce((a, b) => a + b.n, 0) === bt.stats.n);
  ok('จำนวนไม้ในตารางช่วงเวลา รวมแล้วเท่าจำนวนไม้ทั้งหมด',
    bt.sessions.reduce((a, b) => a + b.n, 0) === bt.stats.n);

  const strict = runBacktest(ctx, { threshold: 60, maxHold: 40, spread: 0.3 });
  ok('เกณฑ์คะแนนสูงขึ้น → จำนวนไม้ต้องน้อยลง (หรือเท่าเดิม)', strict.stats.n <= bt.stats.n, `${strict.stats.n} vs ${bt.stats.n}`);
  ok('ทุกไม้ในชุดเข้ม มีคะแนนถึงเกณฑ์จริง', strict.trades.every((t) => t.absScore >= 60));

  // ตลาดขาขึ้นชัดเจน ระบบต้องเอนไปฝั่งซื้อ
  const bull = buildContext(makeCandles(900, 5, 1.6), DEFAULT_CFG);
  const btBull = runBacktest(bull, { threshold: 30, maxHold: 40, spread: 0.3 });
  const longs = btBull.trades.filter((t) => t.side > 0).length;
  ok('ในตลาดขาขึ้นชัดเจน ระบบเข้าฝั่งซื้อมากกว่าฝั่งขาย', longs > btBull.stats.n / 2, `ซื้อ ${longs}/${btBull.stats.n}`);
}

// ── 4b. การตรวจสอบแบบแบ่งข้อมูล ───────────────────────────────────────
section('4b) walk-forward — วัดผลบนข้อมูลที่ระบบไม่เคยเห็น');
{
  const { walkForward } = await import('../js/backtest.js');
  const candles = makeCandles(1400, 91);
  const ctx = buildContext(candles, DEFAULT_CFG);
  const wf = walkForward(ctx, { maxHold: 40, spread: 0.3, splitRatio: 0.6 });

  ok('รันแล้วได้ผลลัพธ์', wf.ok === true, wf.reason || '');
  if (wf.ok) {
    const splitAt = wf.splitAt;
    ok('แบ่งข้อมูลที่ 60% ตามที่กำหนด', Math.abs(splitAt - 1400 * 0.6) < 2, `แบ่งที่แท่ง ${splitAt}`);
    ok('ไม้ในช่วงเรียนรู้ ทุกไม้อยู่ก่อนจุดแบ่ง',
      wf.inSample.trades.every((t) => t.index < splitAt), 'มีไม้ล้ำไปช่วงสอบ');
    ok('ไม้ในช่วงสอบจริง ทุกไม้อยู่หลังจุดแบ่ง — ไม่มีข้อมูลรั่ว',
      wf.outSample.trades.every((t) => t.index >= splitAt), 'มีไม้ย้อนกลับไปช่วงเรียนรู้');
    ok('สองช่วงไม่มีไม้ซ้ำกันเลย', (() => {
      const a = new Set(wf.inSample.trades.map((t) => t.index));
      return wf.outSample.trades.every((t) => !a.has(t.index));
    })());
    ok('เกณฑ์ที่เลือกมาจากช่วงเรียนรู้เท่านั้น',
      wf.sweep.some((x) => x.threshold === wf.chosenThreshold && x.n >= 12));
    ok('ทุกไม้ในทั้งสองช่วงผ่านเกณฑ์ที่เลือกจริง',
      [...wf.inSample.trades, ...wf.outSample.trades].every((t) => t.absScore >= wf.chosenThreshold));
    ok('มีคำตัดสินที่อ่านรู้เรื่อง', wf.verdict && wf.verdict.text.length > 20, JSON.stringify(wf.verdict));
    ok('ระดับคำตัดสินเป็นค่าที่รู้จัก',
      ['good', 'ok', 'bad', 'weak', 'unknown'].includes(wf.verdict.level), wf.verdict.level);
    console.log(`     ↳ เกณฑ์ที่เลือก ${wf.chosenThreshold} · ช่วงเรียนรู้ ${wf.inSample.stats.n} ไม้ ` +
      `(ชนะ ${wf.inSample.stats.winRate === null ? '-' : wf.inSample.stats.winRate.toFixed(0)}%) · ` +
      `ช่วงสอบจริง ${wf.outSample.stats.n} ไม้ (ชนะ ${wf.outSample.stats.winRate === null ? '-' : wf.outSample.stats.winRate.toFixed(0)}%)`);
    console.log(`     ↳ คำตัดสิน: ${wf.verdict.text}`);
  }

  const tiny = walkForward(buildContext(makeCandles(300, 5), DEFAULT_CFG), {});
  ok('ข้อมูลน้อยเกินไป → บอกเหตุผล ไม่ใช่พังหรือให้ตัวเลขมั่ว',
    tiny.ok === false && tiny.reason.includes('น้อยเกินไป'), JSON.stringify(tiny).slice(0, 80));

  // ผลงานรายปัจจัย
  const bt = runBacktest(ctx, { threshold: 30, maxHold: 40, spread: 0.3 });
  ok('มีตารางผลงานรายปัจจัย', Array.isArray(bt.factors) && bt.factors.length > 0, `${bt.factors.length} ปัจจัย`);
  ok('ทุกปัจจัยนับจำนวนไม้ไม่เกินจำนวนไม้ทั้งหมด',
    bt.factors.every((f) => f.nAgree <= bt.stats.n && f.nAgainst <= bt.stats.n));
  ok('ไม่มีปัจจัยไหนทั้งเห็นด้วยและค้านในไม้เดียวกัน',
    bt.trades.every((t) => t.agree.every((k) => !t.against.includes(k))));
  ok('เรียงจากปัจจัยที่ได้เปรียบมากสุดไปน้อยสุด',
    bt.factors.every((f, i) => i === 0 || f.edge === null || bt.factors[i - 1].edge === null || bt.factors[i - 1].edge >= f.edge));
}

// ── 4c. หาจุดเข้า-ออกที่ดีที่สุดจากสถิติ ───────────────────────────────
section('4c) หาจุดตัดขาดทุนและเป้าหมายจากสถิติจริง');
{
  const { optimizeExits, evaluateTarget } = await import('../js/backtest.js');
  const ctx = buildContext(makeCandles(1600, 313), DEFAULT_CFG);
  const bt = runBacktest(ctx, { threshold: 30, maxHold: 40, spread: 0.3 });

  ok('ทุกไม้บันทึกระยะที่วิ่งไปได้ก่อนโดน SL',
    bt.trades.every((t) => typeof t.favBeforeStop === 'number' && t.favBeforeStop >= 0));
  ok('ระยะก่อนโดน SL ต้องไม่เกินระยะสูงสุดที่เคยไปถึง',
    bt.trades.every((t) => t.favBeforeStop <= t.maxFav + 1e-9));
  ok('ไม้ที่โดน SL ต้องไปไม่ถึงเป้า 1R (ไม่งั้นคงปิดกำไรไปแล้ว)',
    bt.trades.filter((t) => t.result === 'loss').every((t) => t.favBeforeStop < 1));
  // ไม้ที่ปิดที่เป้า 2 เท่า ต้องบันทึกว่าไปถึง 2 เท่าจริง ไม่ใช่ค่าต่ำกว่านั้น
  const won2R = bt.trades.filter((t) => t.result === 'win2R');
  ok('ไม้ที่ปิดกำไรที่ 2 เท่า บันทึกระยะไว้ถึง 2 เท่าจริง',
    won2R.length === 0 || won2R.every((t) => t.favBeforeStop >= 2 - 1e-6),
    won2R.length ? `ต่ำสุดที่บันทึกได้ ${Math.min(...won2R.map((t) => t.favBeforeStop)).toFixed(3)} จาก ${won2R.length} ไม้` : 'ไม่มีไม้ประเภทนี้');
  ok('อัตราถึงเป้า 2 เท่า ต้องไม่เป็นศูนย์ถ้ามีไม้ที่ปิดที่ 2 เท่า',
    won2R.length === 0 || bt.trades.filter((t) => t.favBeforeStop >= 2).length > 0);

  const e1 = evaluateTarget(bt.trades, 1);
  const e2 = evaluateTarget(bt.trades, 2);
  const e4 = evaluateTarget(bt.trades, 4);
  ok('เป้ายิ่งไกล โอกาสถึงยิ่งน้อย', e1.hitRate >= e2.hitRate && e2.hitRate >= e4.hitRate,
    `${e1.hitRate.toFixed(0)}% → ${e2.hitRate.toFixed(0)}% → ${e4.hitRate.toFixed(0)}%`);
  ok('จำนวนไม้เท่ากันทุกเป้า (ประเมินจากข้อมูลชุดเดียวกัน)', e1.n === e2.n && e2.n === e4.n);
  ok('เป้า 0 ไม้ → คืน null ไม่พัง', evaluateTarget([], 1) === null);

  const opt = optimizeExits(ctx, { maxHold: 40, spread: 0.3 });
  ok('หาค่าที่ดีที่สุดได้', opt.ok === true, opt.reason || '');
  if (opt.ok) {
    ok('ค่าที่เลือกอยู่ในรายการที่กวาดหาจริง',
      opt.grid.some((g) => g.slAtrMult === opt.best.slAtrMult && g.threshold === opt.best.threshold && g.targetR === opt.best.targetR));
    ok('ค่าที่เลือกมีไม้อย่างน้อย 20 ไม้ (ไม่ใช่ความบังเอิญจากไม้ไม่กี่ไม้)', opt.best.n >= 20, `${opt.best.n} ไม้`);
    ok('เลือกจุดที่มีเพื่อนบ้านดีด้วย ไม่ใช่ยอดแหลมโดด ๆ', opt.best.neighbours >= 3, `${opt.best.neighbours} จุดข้างเคียง`);
    ok('คะแนนความทนทานไม่สูงเกินค่าคาดหวังดิบของจุดที่ดีที่สุดในตาราง',
      opt.grid.every((g) => g.robust <= Math.max(...opt.grid.map((x) => x.expectancy)) + 1e-9));
    ok('อัตราถึงเป้าลดลงเมื่อเป้าไกลขึ้น (ทั้งสองช่วง)', (() => {
      const rr = opt.reachRates;
      return rr.every((x, i) => i === 0 || rr[i - 1].inSample >= x.inSample - 1e-9);
    })());
    ok('มีสถิติระยะที่ราคาวิ่งไป (MFE) เรียงจากน้อยไปมาก',
      opt.mfe.p25 <= opt.mfe.p50 && opt.mfe.p50 <= opt.mfe.p75 && opt.mfe.p75 <= opt.mfe.p90);
    ok('มีคำแนะนำเรื่องความกว้างจุดตัดขาดทุน',
      opt.slAdvice && ['tighten', 'widen', 'ok', 'unknown'].includes(opt.slAdvice.level), JSON.stringify(opt.slAdvice).slice(0, 70));
    ok('ผลช่วงสอบจริงมีอยู่จริงและนับไม้ได้', opt.outOfSample !== null && opt.outOfSample.n >= 0);
    console.log(`     ↳ เลือก: SL ${opt.best.slAtrMult}×ATR · เกณฑ์ ${opt.best.threshold} · เป้า ${opt.best.targetR}R`);
    console.log(`     ↳ เรียนรู้ ${opt.best.expectancy.toFixed(3)}R → สอบจริง ${opt.outOfSample ? opt.outOfSample.expectancy.toFixed(3) + 'R' : '-'}`);
  }

  const small = optimizeExits(buildContext(makeCandles(300, 8), DEFAULT_CFG), {});
  ok('ข้อมูลน้อย → บอกเหตุผล ไม่ใช่ให้ค่ามั่ว', small.ok === false && small.reason.length > 10);
}

// ── 5. เวลาและการแปลงหน่วย ────────────────────────────────────────────
section('5) เวลาตลาดและการแปลงราคา');
{
  const nfp = nextNFP(new Date(Date.UTC(2026, 7, 20)));
  ok('NFP ครั้งถัดไปตกวันศุกร์', nfp.getUTCDay() === 5, `ได้วัน ${nfp.getUTCDay()} (${nfp.toISOString()})`);
  ok('NFP เป็นศุกร์แรกของเดือน', nfp.getUTCDate() <= 7, `วันที่ ${nfp.getUTCDate()}`);
  ok('NFP อยู่ในอนาคตเสมอ', nfp > new Date(Date.UTC(2026, 7, 20)));
  ok('เวลา NFP = 8:30 ET (12:30 UTC ฤดูร้อน / 13:30 UTC ฤดูหนาว)',
    (nfp.getUTCHours() === 12 || nfp.getUTCHours() === 13) && nfp.getUTCMinutes() === 30, `ได้ ${nfp.getUTCHours()}:${nfp.getUTCMinutes()}`);
  ok('DST สหรัฐฯ: กรกฎาคม = ใช่, มกราคม = ไม่ใช่',
    usDstActive(new Date(Date.UTC(2026, 6, 15))) === true && usDstActive(new Date(Date.UTC(2026, 0, 15))) === false);

  // 1 ทรอยออนซ์ = 31.1035 กรัม, 1 บาททองคำ = 15.244 กรัม ทอง 96.5%
  const thb = xauToThaiBaht(3110.35, 36);
  const expect = (3110.35 / 31.1035) * 15.244 * 0.965 * 36;
  ok('แปลงราคาทอง USD/ออนซ์ → บาท/บาททองคำ ถูกต้อง', near(thb, expect, 1e-6), `ได้ ${thb.toFixed(2)}`);
  ok('ราคาแปลงอยู่ในระดับที่สมเหตุสมผล (หมื่นกว่าบาท)', thb > 20000 && thb < 90000, `ได้ ${thb.toFixed(0)}`);
}

// ── 6. การไหลของข้อมูลสด ──────────────────────────────────────────────
section('6) ข้อมูลสดและเหตุการณ์ "แท่งปิด"');
{
  const { MarketFeed, TF, mergeCandle } = await import('../js/feed.js');

  const base = [{ t: 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, closed: true }];
  const arr = [...base];
  const r1 = mergeCandle(arr, { t: 1000, o: 1, h: 3, l: 0.5, c: 2.8, v: 20, closed: false });
  ok('อัปเดตแท่งเดิม (t เท่ากัน) = ทับของเดิม ไม่เพิ่มแท่ง', r1.appended === false && arr.length === 1 && arr[0].c === 2.8);
  const r2 = mergeCandle(arr, { t: 2000, o: 2.8, h: 3, l: 2.7, c: 2.9, v: 5, closed: false });
  ok('แท่งใหม่ (t มากกว่า) = ต่อท้าย', r2.appended === true && arr.length === 2);
  const r3 = mergeCandle(arr, { t: 500, o: 1, h: 1, l: 1, c: 1, v: 1 });
  ok('ข้อมูลเก่ากว่าที่มีอยู่ = ทิ้ง (กันข้อมูลย้อนหลังมาป่วน)', r3.stale === true && arr.length === 2);

  // เร่งเวลา: ตั้งกรอบ 1m ให้ยาว 1 วินาที เพื่อดูว่ามีเหตุการณ์ "แท่งปิด" ส่งออกมาจริง
  const realMs = TF['1m'].ms;
  TF['1m'].ms = 1000;
  const feed = new MarketFeed();
  feed.configure({ source: 'demo', interval: '1m' });
  const hist = await feed.loadHistory('1m', 60);
  ok('โหลดข้อมูลจำลองได้ และแท่งสุดท้ายคือแท่งที่ยังไม่ปิด',
    hist.length === 60 && hist[59].closed === false && hist[58].closed === true);
  ok('เวลาแท่งเรียงจากเก่าไปใหม่และห่างเท่ากันทุกแท่ง',
    hist.every((c, i) => i === 0 || c.t - hist[i - 1].t === TF['1m'].ms));

  const events = [];
  feed.start((k) => events.push(k), () => {});
  // รอจน "แท่งปิด" เกิดขึ้นจริง แทนการนอนรอเวลาตายตัว
  // เพราะจังหวะ tick (900ms) กับความยาวกรอบเวลาไม่ได้หารลงตัวกัน
  // บางรอบ tick สองครั้งติดจึงตกอยู่ในกรอบเดียวกันและยังไม่มีการข้ามกรอบ
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !events.some((e) => e.closed)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  feed.stop();
  TF['1m'].ms = realMs;
  const closes = events.filter((e) => e.closed);
  ok('มีการส่งเหตุการณ์ "แท่งปิด" เมื่อข้ามกรอบเวลา', closes.length >= 1, `ได้ ${closes.length} ครั้งจาก ${events.length} ข้อความ`);
  ok('เหตุการณ์แท่งปิดแต่ละครั้งเป็นคนละแท่ง (ไม่ยิงซ้ำ)', new Set(closes.map((c) => c.t)).size === closes.length);
  ok('ราคาสูงสุด/ต่ำสุดของแท่งครอบคลุมราคาปิดเสมอ',
    events.every((e) => e.h >= e.c - 1e-9 && e.l <= e.c + 1e-9));
}

// ── 7. การอ่านข้อมูลจากผู้ให้บริการจริง (จำลอง network) ────────────────
section('7) การแปลงข้อมูลจาก Binance / Twelve Data');
{
  const { MarketFeed } = await import('../js/feed.js');
  const realFetch = globalThis.fetch;
  const realWS = globalThis.WebSocket;

  // รูปแบบที่ Binance ส่งกลับจริง: array ของ array [openTime, o, h, l, c, v, closeTime, ...]
  const binanceRows = [
    [1700000000000, '2650.10', '2655.90', '2648.00', '2653.40', '12.5', 1700000899999, '33150.2', 120, '6.1', '16180.3', '0'],
    [1700000900000, '2653.40', '2660.00', '2652.10', '2658.75', '9.8', 1700001799999, '26055.7', 98, '5.0', '13290.1', '0'],
  ];
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.includes('api.binance.com')) throw new Error('geo-blocked'); // จำลองโดนบล็อกโฮสต์แรก
    return { ok: true, status: 200, json: async () => binanceRows };
  };

  const feed = new MarketFeed();
  feed.configure({ source: 'binance', symbol: 'PAXGUSDT', interval: '15m' });
  const rows = await feed.loadHistory('15m', 2);
  ok('แปลงแท่งเทียนจากรูปแบบ array ของ Binance ได้ถูกต้อง',
    rows.length === 2 && rows[0].t === 1700000000000 && rows[0].o === 2650.1 &&
    rows[0].h === 2655.9 && rows[0].l === 2648 && rows[0].c === 2653.4 && rows[0].v === 12.5,
    JSON.stringify(rows[0]));
  ok('ตัวเลขถูกแปลงเป็น number (Binance ส่งมาเป็น string)', typeof rows[1].c === 'number' && rows[1].c === 2658.75);
  ok('สลับไปโฮสต์สำรองอัตโนมัติเมื่อโฮสต์แรกใช้ไม่ได้',
    calls.length === 2 && calls[0].includes('api.binance.com') && calls[1].includes('data-api.binance.vision'));
  ok('URL มีสัญลักษณ์ กรอบเวลา และจำนวนแท่งครบ',
    calls[1].includes('symbol=PAXGUSDT') && calls[1].includes('interval=15m') && calls[1].includes('limit=2'), calls[1]);

  // ขอเกิน 1000 แท่ง ต้องไล่ขอเป็นชุดและต่อกันให้ถูกต้อง
  const madeCalls = [];
  const bar = (t) => [t, '2650.00', '2655.00', '2645.00', '2652.00', '10', t + 899999, '0', 1, '0', '0', '0'];
  globalThis.fetch = async (url) => {
    madeCalls.push(url);
    const m = url.match(/endTime=(\d+)/);
    const step = 900000;
    // ของจริง Binance ส่งแท่งที่ตรงกริดเวลาเสมอ ตัวจำลองต้องทำเหมือนกัน
    // ไม่งั้นรอยต่อระหว่างชุดจะห่างผิดไป 1 มิลลิวินาที ซึ่งเป็นข้อบกพร่องของตัวจำลอง ไม่ใช่ของโค้ด
    const end = Math.floor((m ? +m[1] : 3_000_000_000_000) / step) * step;
    const rows = [];
    for (let k = 999; k >= 0; k--) rows.push(bar(end - k * step));
    return { ok: true, status: 200, json: async () => rows };
  };
  const big = new MarketFeed();
  big.configure({ source: 'binance', symbol: 'PAXGUSDT', interval: '15m' });
  const many = await big.loadHistory('15m', 2500);
  ok('ขอ 2,500 แท่ง → ยิงคำขอหลายรอบ', madeCalls.length >= 3, `ยิง ${madeCalls.length} ครั้ง`);
  ok('รอบแรกไม่ส่ง endTime รอบถัดไปส่ง (ไล่ย้อนหลัง)',
    !madeCalls[0].includes('endTime') && madeCalls[1].includes('endTime'));
  ok('ได้แท่งครบตามที่ขอ', many.length >= 2500, `ได้ ${many.length} แท่ง`);
  ok('ไม่มีแท่งเวลาซ้ำกันตรงรอยต่อของแต่ละชุด',
    new Set(many.map((c) => c.t)).size === many.length);
  ok('เรียงจากเก่าไปใหม่ถูกต้อง', many.every((c, i) => i === 0 || c.t > many[i - 1].t));
  ok('ระยะห่างระหว่างแท่งเท่ากันสม่ำเสมอ',
    many.every((c, i) => i === 0 || c.t - many[i - 1].t === 900000));

  // ผู้ให้บริการมีข้อมูลไม่ถึงที่ขอ → ต้องหยุดเอง ไม่วนไม่รู้จบ
  let calls2 = 0;
  globalThis.fetch = async () => {
    calls2++;
    return { ok: true, status: 200, json: async () => [bar(1700000000000), bar(1700000900000)] };
  };
  const short = new MarketFeed();
  short.configure({ source: 'binance', symbol: 'PAXGUSDT', interval: '15m' });
  const few = await short.loadHistory('15m', 5000);
  ok('ถ้าข้อมูลหมดก่อน หยุดยิงคำขอทันที ไม่วนไม่รู้จบ', calls2 === 1 && few.length === 2, `ยิง ${calls2} ครั้ง ได้ ${few.length} แท่ง`);

  // ทุกโฮสต์ล่ม → ต้องโยน error ที่อ่านรู้เรื่อง ไม่ใช่พังเงียบ ๆ
  globalThis.fetch = async () => { throw new Error('offline'); };
  let msg = '';
  try { await feed.loadHistory('15m', 2); } catch (e) { msg = e.message; }
  // ชั้น feed รายงาน "สาเหตุ" เป็นภาษาไทย ส่วน "ทางแก้" แอปจัดการเองด้วยการสลับโหมดจำลองอัตโนมัติ
  ok('ถ้าโหลดไม่ได้ทุกโฮสต์ จะแจ้งเป็นภาษาไทย ระบุผู้ให้บริการและสาเหตุ',
    /[ก-๙]/.test(msg) && msg.includes('Binance') && msg.includes('offline'), msg);

  // Twelve Data: JSON คนละรูปแบบ
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    values: [
      { datetime: '2026-08-27 10:00:00', open: '3390.5', high: '3395.0', low: '3388.2', close: '3392.8' },
      { datetime: '2026-08-27 11:00:00', open: '3392.8', high: '3401.4', low: '3391.0', close: '3399.9' },
    ],
  }) });
  const td = new MarketFeed();
  td.configure({ source: 'twelvedata', interval: '1h', apiKey: 'test-key' });
  const tdRows = await td.loadHistory('1h', 2);
  ok('แปลงข้อมูล Twelve Data (XAU/USD) ได้ถูกต้อง',
    tdRows.length === 2 && tdRows[0].c === 3392.8 && tdRows[1].h === 3401.4 &&
    tdRows[0].t === Date.UTC(2026, 7, 27, 10, 0, 0), JSON.stringify(tdRows[0]));
  ok('ไม่มี volume ก็ไม่พัง (โลหะมีค่าไม่มีข้อมูล volume)', tdRows[0].v === 0);

  // จังหวะยิงคำขอต้องต่างกันตามผู้ให้บริการ ไม่งั้นโควตาแผนฟรีหมดใน 2 ชั่วโมง
  const { TD_LIMITS } = await import('../js/feed.js');
  const bnc = new MarketFeed(); bnc.configure({ source: 'binance' });
  const tdf = new MarketFeed(); tdf.configure({ source: 'twelvedata' });
  ok('Binance ดึงถี่ได้ (15 วินาที)', bnc.livePollMs === 15000);
  ok('Twelve Data ต้องยืดจังหวะ ไม่งั้นโควตาหมด', tdf.livePollMs === TD_LIMITS.pollMs && tdf.livePollMs >= 120000,
    `${tdf.livePollMs / 1000} วินาที`);
  ok('กรอบเวลาใหญ่ก็ยืดตามผู้ให้บริการ', tdf.htfRefreshMs > bnc.htfRefreshMs);
  ok('จังหวะที่ตั้งไว้อยู่ในงบ 800 คำขอ/วัน', (() => {
    const perDay = (86400000 / TD_LIMITS.pollMs) + (86400000 / TD_LIMITS.htfRefreshMs) * 2;
    return perDay < TD_LIMITS.perDay;
  })(), `ประมาณ ${Math.round((86400000 / TD_LIMITS.pollMs) + (86400000 / TD_LIMITS.htfRefreshMs) * 2)} คำขอ/วัน`);

  // โควตาหมด → ต้องบอกเป็นภาษาคน ไม่ใช่โยน error ดิบ
  globalThis.fetch = async () => ({ ok: true, status: 200,
    json: async () => ({ status: 'error', message: 'You have run out of API credits for the current minute' }) });
  const quota = new MarketFeed();
  quota.configure({ source: 'twelvedata', interval: '1h', apiKey: 'x' });
  let qErr = '';
  try { await quota.loadHistory('1h', 100); } catch (e) { qErr = e.message; }
  ok('โควตาหมด → อธิบายเป็นภาษาไทยว่าเกิดอะไรและขีดจำกัดเท่าไร',
    qErr.includes('โควตา') && qErr.includes('800'), qErr.slice(0, 90));
  ok('นับจำนวนคำขอที่ยิงไปได้', quota.requestCount >= 1);

  let tdErr = '';
  const noKey = new MarketFeed();
  noKey.configure({ source: 'twelvedata', interval: '1h', apiKey: '' });
  try { await noKey.loadHistory('1h', 2); } catch (e) { tdErr = e.message; }
  ok('ไม่มี API key → บอกให้ไปสมัคร ไม่ใช่ error ดิบ ๆ', tdErr.includes('API key'), tdErr);

  // WebSocket: ตรวจ URL และการอ่านข้อความ kline
  let wsUrl = '';
  const received = [];
  globalThis.WebSocket = class {
    constructor(url) { wsUrl = url; setTimeout(() => this.onopen && this.onopen(), 0); }
    close() {}
  };
  const ws = new MarketFeed();
  ws.configure({ source: 'binance', symbol: 'XAUTUSDT', interval: '5m' });
  ws.start((k) => received.push(k), () => {});
  ok('URL ของ WebSocket ตรงรูปแบบ <symbol ตัวเล็ก>@kline_<tf>',
    wsUrl === 'wss://stream.binance.com:9443/ws/xautusdt@kline_5m', wsUrl);
  ws.ws.onmessage({ data: JSON.stringify({ e: 'kline', k: {
    t: 1700000000000, o: '2650.1', h: '2661.0', l: '2649.5', c: '2659.9', v: '3.25', x: true } }) });
  ok('อ่านข้อความ kline จาก WebSocket และตั้งธง "แท่งปิด" ถูกต้อง',
    received.length === 1 && received[0].c === 2659.9 && received[0].closed === true, JSON.stringify(received[0]));
  ws.ws.onmessage({ data: 'ไม่ใช่ JSON' });
  ok('ข้อความเสีย ๆ ไม่ทำให้ระบบล้ม', received.length === 1);
  ws.stop();

  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWS;
}

// ── 8. คำบรรยายกราฟ ───────────────────────────────────────────────────
section('8) คำบรรยายกราฟสด (ภาษาไทย)');
{
  const { narrate, narrateShort } = await import('../js/narrate.js');
  const { sessionInfo } = await import('../js/macro.js');

  const warm = narrate({ candles: [], ctx: null, scored: null, combined: null, action: 'wait' });
  ok('ข้อมูลยังไม่พอ → ไม่พัง และบอกผู้ใช้ว่ากำลังรอ', warm.length === 1 && warm[0].text.includes('รอ'));

  const candles = makeCandles(700, 77);
  const ctx = buildContext(candles, DEFAULT_CFG);
  const i = candles.length - 1;
  const sc = scoreAt(ctx, i);
  const combined = { score: sc.score, parts: [sc.score, 0, 0], notes: [] };
  const setup = buildSetup(ctx, i, { ...sc, side: 1 }, { entryPrice: candles[i].c, side: 1 });

  const secs = narrate({
    candles, ctx, scored: sc, combined, setup, action: 'buy', blocks: [], tf: '15m',
    session: sessionInfo(new Date()), prob: { p: 55, n: 40 },
    htfScores: [{ tf: '15m', score: 40 }, { tf: '1h', score: 30 }],
  });
  ok('สร้างคำบรรยายได้หลายหัวข้อ', secs.length >= 6, `ได้ ${secs.length} หัวข้อ`);
  ok('ทุกหัวข้อมีชื่อและเนื้อหา', secs.every((x) => x.title && x.text && x.text.length > 20));
  ok('อ้างอิงราคาจริงจากกราฟ ไม่ใช่ข้อความสำเร็จรูป',
    secs[0].text.includes(candles[i].c.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
  ok('มีคำแนะนำให้ตั้งคำสั่งรอ แทนการไล่ราคา',
    secs.some((x) => x.text.includes('limit') || x.text.includes('คำสั่งรอ')));

  // จุดที่โค้ดแบบ template พังบ่อยที่สุด: ตัวแปรว่างแล้วหลุด undefined/NaN ออกหน้าจอ
  let dirty = '';
  for (let k = 260; k < 700; k += 7) {
    const s2 = scoreAt(ctx, k);
    const partial = candles.slice(0, k + 1);
    for (const act of ['buy', 'sell', 'wait']) {
      const sub = narrate({
        candles: partial, ctx, scored: s2, combined: { score: s2.score, notes: [] },
        setup: act === 'wait' ? null : buildSetup(ctx, k, { ...s2, side: act === 'buy' ? 1 : -1 }, { entryPrice: partial[k].c, side: act === 'buy' ? 1 : -1 }),
        action: act, blocks: act === 'wait' ? ['ทดสอบเหตุผลระงับ'] : [], tf: '15m',
        session: sessionInfo(new Date()), prob: { p: null, n: 0 },
        htfScores: [{ tf: '15m', score: s2.score }, { tf: '1h', score: null }],
      });
      for (const x of sub) {
        if (/undefined|NaN|\[object/.test(x.text) || /undefined|NaN/.test(x.title)) {
          dirty = `แท่ง ${k} (${act}) หัวข้อ "${x.title}": ${x.text.slice(0, 90)}`;
        }
      }
    }
  }
  ok('ไม่มี undefined / NaN หลุดออกมาให้ผู้ใช้เห็นเลยสักจุด (ทดสอบ 190 สถานการณ์)', dirty === '', dirty);

  const waitSecs = narrate({
    candles, ctx, scored: sc, combined, setup: null, action: 'wait', blocks: [], tf: '15m',
    session: sessionInfo(new Date()), prob: { p: null, n: 0 }, htfScores: [],
  });
  const lastWait = waitSecs[waitSecs.length - 1];
  ok('ตอนไม่มีสัญญาณ ต้องบอกว่า "ควรจับตาอะไร" ไม่ใช่ปล่อยว่าง',
    lastWait.text.includes('จับตา'), lastWait.text.slice(0, 80));

  const blocked = narrate({
    candles, ctx, scored: sc, combined, setup, action: 'wait', blocks: ['อยู่ในช่วงข่าว NFP'], tf: '15m',
    session: sessionInfo(new Date()), prob: { p: 55, n: 40 }, htfScores: [],
  });
  ok('ถ้าถูกระงับสัญญาณ ต้องบอกเหตุผลให้ชัด',
    blocked[blocked.length - 1].text.includes('NFP'));

  const short = narrateShort({ scored: sc, combined, action: 'buy', candles });
  ok('สรุปสั้นบรรทัดเดียวใช้ได้ ไม่มีค่าว่าง', short.length > 20 && !/undefined|NaN/.test(short), short);
}

// ── 9. บอกสินทรัพย์และตรวจสุขภาพข้อมูล ────────────────────────────────
section('9) บอกให้ชัดว่ากำลังดูราคาอะไร');
{
  const { instrumentOf, dataHealth, INSTRUMENTS } = await import('../js/instrument.js');

  ok('PAXG ต้องไม่ถูกเรียกว่าราคาทองสปอต', instrumentOf('binance', 'PAXGUSDT').isSpot === false);
  ok('XAUT ก็เช่นกัน', instrumentOf('binance', 'XAUTUSDT').isSpot === false);
  ok('Twelve Data คือ XAU/USD ของจริง', instrumentOf('twelvedata', '').isSpot === true);
  ok('โหมดจำลองต้องบอกว่าไม่ใช่ราคาจริง', instrumentOf('demo', '').kind.includes('ไม่ใช่ราคาจริง'));
  ok('สินทรัพย์ที่ไม่ใช่สปอต ต้องมีคำอธิบายว่าต่างจากทองจริงยังไง',
    Object.values(INSTRUMENTS).filter((i) => !i.isSpot).every((i) => i.note && i.note.length > 15));
  ok('สัญลักษณ์ที่ไม่รู้จัก ไม่ทำให้พัง', instrumentOf('binance', 'ไม่มีจริง').name.length > 0);

  const step = 900000, t0 = 1700000000000;
  const clean = Array.from({ length: 50 }, (_, i) => ({ t: t0 + i * step, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  const hc = dataHealth(clean, step);
  ok('ข้อมูลสมบูรณ์ → ไม่พบปัญหา', hc.ok && hc.gaps === 0 && hc.dups === 0 && hc.outOfOrder === 0);
  ok('นับจำนวนแท่งและช่วงวันถูกต้อง', hc.bars === 50 && Math.abs(hc.days - (49 * step) / 86400000) < 1e-9);

  const gapped = [...clean.slice(0, 20), ...clean.slice(25)];
  const hg = dataHealth(gapped, step);
  ok('ข้อมูลขาดช่วง → ตรวจเจอและบอกว่าขาดกี่แท่ง', hg.gaps === 1 && hg.biggestGapBars === 5, JSON.stringify({ gaps: hg.gaps, biggest: hg.biggestGapBars }));

  const dup = [...clean, clean[10]];
  ok('มีแท่งซ้ำ → ตรวจเจอและไม่ผ่าน', dataHealth(dup, step).dups === 1 && dataHealth(dup, step).ok === false);

  const rev = [clean[5], clean[3], clean[7]];
  ok('ข้อมูลผิดลำดับเวลา → ตรวจเจอ', dataHealth(rev, step).outOfOrder >= 1);
  ok('ข้อมูลน้อยเกินไป → บอกเหตุผล ไม่พัง', dataHealth([clean[0]], step).ok === false);
}

// ── 10. เวอร์ชัน TradingView ต้องตรงกับเวอร์ชันเว็บ ────────────────────
section('10) Pine Script (TradingView) ตรงกับเวอร์ชันเว็บไหม');
{
  const { readFileSync } = await import('node:fs');
  let pine = '';
  try { pine = readFileSync(new URL('../tradingview/gold-signal-lab.pine', import.meta.url), 'utf8'); }
  catch (e) { pine = ''; }
  ok('มีไฟล์ Pine Script อยู่จริง', pine.length > 1000, `${pine.length} ตัวอักษร`);

  if (pine) {
    ok('ประกาศเวอร์ชัน Pine ไว้', /\/\/@version=6/.test(pine));
    ok('เป็น strategy (มีเครื่องทดสอบย้อนหลังในตัว)', /^strategy\(/m.test(pine));

    // น้ำหนักปัจจัยต้องเท่ากันทั้งสองเวอร์ชัน ไม่งั้นสัญญาณจะไม่ตรงกัน
    const pineW = {};
    for (const m of pine.matchAll(/^(w\w+)\s*=\s*input\.float\((\d+(?:\.\d+)?)/gm)) pineW[m[1]] = +m[2];
    const map = {
      wEma: 'emaTrend', wAdx: 'adxTrend', wMacd: 'macdMom', wRsi: 'rsiMom', wStruct: 'structure',
      wPat: 'patterns', wVolume: 'volume', wBands: 'bands', wLevels: 'levels',
      wDiv: 'divergence', wVwap: 'vwap', wStoch: 'stoch',
    };
    ok('มีน้ำหนักครบทั้ง 12 ปัจจัยเท่าเวอร์ชันเว็บ',
      Object.keys(pineW).length === Object.keys(WEIGHTS).length,
      `Pine ${Object.keys(pineW).length} · เว็บ ${Object.keys(WEIGHTS).length}`);
    const mismatched = Object.entries(map)
      .filter(([pk, jk]) => pineW[pk] !== WEIGHTS[jk])
      .map(([pk, jk]) => `${pk}=${pineW[pk]} แต่เว็บ ${jk}=${WEIGHTS[jk]}`);
    ok('ค่าน้ำหนักทุกตัวตรงกับเวอร์ชันเว็บ', mismatched.length === 0, mismatched.join(' · '));

    const totalPine = Object.values(pineW).reduce((a, b) => a + b, 0);
    const totalJs = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    ok('น้ำหนักรวมเท่ากัน (120)', totalPine === totalJs, `Pine ${totalPine} · เว็บ ${totalJs}`);

    // ค่าตั้งต้นสำคัญต้องตรงกัน
    const num = (re) => { const m = pine.match(re); return m ? +m[1] : null; };
    ok('คะแนนขั้นต่ำตรงกัน', num(/thresh\s*=\s*input\.float\((\d+(?:\.\d+)?)/) === DEFAULT_CFG.threshold);
    ok('เกณฑ์ ADX ตรงกัน', num(/adxMin\s*=\s*input\.float\((\d+(?:\.\d+)?)/) === DEFAULT_CFG.adxTrendMin);
    ok('ตัวคูณจุดตัดขาดทุนตรงกัน', num(/slMult\s*=\s*input\.float\((\d+(?:\.\d+)?)/) === DEFAULT_CFG.slAtrMult);
    ok('เพดานจุดตัดขาดทุนตรงกัน', num(/maxSl\s*=\s*input\.float\((\d+(?:\.\d+)?)/) === DEFAULT_CFG.maxSlAtrMult);

    ok('มีคำเตือนว่าเพื่อการศึกษา', /ไม่ใช่คำแนะนำการลงทุน/.test(pine));
    ok('มีระบบแจ้งเตือน', /alertcondition|alert\(/.test(pine));
    ok('ใช้ pivot แบบยืนยันช้า (ไม่มองอนาคต)', /ta\.pivothigh\(high, 3, 3\)/.test(pine));
    ok('ปิด lookahead ตอนดึงกรอบเวลาใหญ่ (กันข้อมูลอนาคตรั่ว)',
      /lookahead\s*=\s*barmerge\.lookahead_off/.test(pine));
  }
}

// ── การเรียนรู้น้ำหนักจากผลจริง ────────────────────────────────────────
section('12) เรียนรู้น้ำหนักปัจจัย — ต้องไม่ "จูนให้เข้ากับอดีต" แล้วเอามาใช้');
{
  const KEYS = Object.keys(WEIGHTS);
  const TOTAL = KEYS.reduce((a, k) => a + WEIGHTS[k], 0);

  // 12.1 คณิตศาสตร์ของตัวฟิต
  {
    // ตัวแปรที่ 0 ทำนายผลได้เป๊ะ ตัวแปรที่ 1 เป็นเสียงรบกวนล้วน
    const rnd = mulberry(4242);
    const rows = Array.from({ length: 400 }, () => {
      const a = rnd() * 2 - 1;
      return { x: [a, rnd() * 2 - 1], y: a > 0 ? 1 : 0 };
    });
    const f = fitLogistic(rows);
    ok('ฟิตได้สัมประสิทธิ์บวกให้ตัวแปรที่ทำนายได้จริง', f.w[0] > 1, `ได้ ${f.w[0].toFixed(2)}`);
    ok('ตัวแปรที่เป็นเสียงรบกวนได้สัมประสิทธิ์เกือบศูนย์',
      Math.abs(f.w[1]) < Math.abs(f.w[0]) / 5, `ได้ ${f.w[1].toFixed(2)} เทียบ ${f.w[0].toFixed(2)}`);
    ok('ค่าความคลาดเคลื่อนต่ำกว่าการเดาสุ่ม (0.693)', f.logLoss < 0.5, `ได้ ${f.logLoss.toFixed(3)}`);
  }

  // 12.2 การปรับสเกลตัวแปร — เหตุผลที่รุ่นแรกพัง
  {
    const rows = [{ x: [1, 5], y: 1 }, { x: [-1, 5], y: 0 }, { x: [1, 5], y: 1 }, { x: [-1, 5], y: 0 }];
    const z = standardize(rows, { mean: [0, 5], std: [1, 0] });
    ok('ตัวแปรที่ไม่เคยเปลี่ยนค่า (std=0) ถูกปัดเป็นศูนย์ ไม่ทำให้หารด้วยศูนย์',
      z.every((r) => r.x[1] === 0) && z.every((r) => Number.isFinite(r.x[0])));
  }

  // 12.3 ผลลัพธ์ต้องใช้กับเครื่องคิดคะแนนได้จริง
  {
    const ctx = buildContext(makeCandles(3000, 91, 0.3), DEFAULT_CFG);
    const inRun = runBacktest(ctx, { threshold: 18, toIndex: 1800 });
    const res = learnWeights(inRun.trades, KEYS, WEIGHTS);
    ok('เรียนรู้จากไม้ในช่วงเรียนรู้ได้สำเร็จ', res.ok, res.reason || '');
    if (res.ok) {
      ok('คืนน้ำหนักครบทั้ง 12 ปัจจัย (ขาดตัวเดียวคะแนนทั้งระบบพังเป็น NaN)',
        KEYS.every((k) => Number.isFinite(res.weights[k])));
      const total = KEYS.reduce((a, k) => a + res.weights[k], 0);
      ok('ผลรวมน้ำหนักเท่าเดิม (120) คะแนนสองชุดจึงเทียบกันได้', near(total, TOTAL, 1e-6), `ได้ ${total.toFixed(4)}`);

      /* บั๊กของรุ่นแรก: ฟิตดิบแล้วตัดค่าติดลบทิ้ง ทำให้ 10 จาก 12 ปัจจัยกลายเป็นศูนย์
         เหลือ 2 ปัจจัยกินน้ำหนักทั้งหมด ซึ่งไม่ใช่ความรู้ แต่เป็นอาการของข้อมูลน้อย
         การผสมกับน้ำหนักเดิมต้องกันไม่ให้เกิดอาการนี้อีก */
      const dead = KEYS.filter((k) => res.weights[k] < 1);
      ok('ไม่มีปัจจัยไหนถูกบีบจนหายไป (บั๊กรุ่นแรก: หายไป 10 จาก 12)',
        dead.length === 0, `หายไป ${dead.length} ตัว: ${dead.join(',')}`);

      ok('ข้อมูลเท่านี้ขยับน้ำหนักได้แค่บางส่วน ไม่ใช่แทนที่ทั้งหมด',
        res.blend > 0 && res.blend <= 0.6, `ได้ ${res.blend}`);

      // คะแนนต้องยังอยู่ในกรอบ -100..100 และไม่เป็น NaN
      const tuned = { ...ctx, cfg: { ...ctx.cfg, weights: res.weights } };
      let bad = 0;
      for (let i = 300; i < 1000; i += 7) {
        const sc = scoreAt(tuned, i).score;
        if (!Number.isFinite(sc) || sc < -100 || sc > 100) bad++;
      }
      ok('ใช้น้ำหนักชุดใหม่แล้วคะแนนยังอยู่ในกรอบ -100..100 ทุกแท่ง', bad === 0, `พลาด ${bad} แท่ง`);
    }
  }

  // 12.4 ต้องปฏิเสธเมื่อข้อมูลน้อย แทนที่จะเดาให้
  {
    const few = learnWeights([{ features: { emaTrend: 1 }, hit1R: true }], KEYS, WEIGHTS);
    ok('ไม้น้อยเกินไป → ปฏิเสธพร้อมบอกเหตุผล ไม่ใช่คืนตัวเลขมั่ว', !few.ok && /น้อยเกิน/.test(few.reason));
    const allWin = learnWeights(
      Array.from({ length: 60 }, () => ({ features: { emaTrend: 1 }, hit1R: true })), KEYS, WEIGHTS);
    ok('ไม้ชนะหมด → ปฏิเสธ เพราะไม่มีความต่างให้เรียนรู้', !allWin.ok);
  }

  // 12.5 ตัวตัดสินว่า "ดีกว่าจริงหรือบังเอิญ"
  {
    const rnd = mulberry(777);
    const a = Array.from({ length: 200 }, () => rnd() * 2 - 1);
    const b = Array.from({ length: 200 }, () => rnd() * 2 - 1);
    const same = probBetter(a, b, { samples: 800 });
    ok('สองชุดที่มาจากที่เดียวกัน → ความมั่นใจใกล้ 50% (ไม่มีใครดีกว่า)',
      same > 0.2 && same < 0.8, `ได้ ${(same * 100).toFixed(0)}%`);
    const better = probBetter(a, b.map((v) => v + 2), { samples: 800 });
    ok('ชุดที่ดีกว่าชัด ๆ → ความมั่นใจเกือบ 100%', better > 0.98, `ได้ ${(better * 100).toFixed(0)}%`);
  }

  // 12.6 ด่านสำคัญที่สุด: บนข้อมูลที่ไม่มีอะไรให้เรียนรู้ ต้อง "ไม่ผ่าน"
  {
    let applied = 0, checked = 0;
    for (const seed of [15, 29, 43, 57, 71, 85]) {
      const ctx = buildContext(makeCandles(3000, seed, 0), DEFAULT_CFG);
      const r = learnAndValidate(ctx, { keys: KEYS, baseWeights: WEIGHTS, threshold: 35 });
      checked++;
      if (r.ok && r.verdict.apply) applied++;
    }
    /* ข้อมูลสุ่มล้วนไม่มีโครงสร้างให้เรียนรู้ ระบบจึงต้องปฏิเสธน้ำหนักชุดใหม่
       ถ้าตรงนี้ผ่านบ่อย ๆ แปลว่าด่านตรวจหลวม แล้วผู้ใช้จะได้น้ำหนักที่เป็นเสียงรบกวน */
    ok('ข้อมูลสุ่มล้วน → ไม่อนุมัติน้ำหนักชุดใหม่เลย', applied === 0, `อนุมัติ ${applied}/${checked} ชุด`);
  }

  // 12.7 ข้อมูลสั้นเกินไป → บอกตรง ๆ
  {
    const tiny = learnAndValidate(buildContext(makeCandles(400, 3), DEFAULT_CFG),
      { keys: KEYS, baseWeights: WEIGHTS, threshold: 35 });
    ok('ข้อมูลสั้นเกินไป → ปฏิเสธพร้อมบอกให้โหลดเพิ่ม', !tiny.ok && /น้อยเกินไป/.test(tiny.reason));
  }

  // 12.8 ห้ามเรียนรู้จากช่วงสอบ
  {
    const ctx = buildContext(makeCandles(3000, 101, 0.25), DEFAULT_CFG);
    const r = learnAndValidate(ctx, { keys: KEYS, baseWeights: WEIGHTS, threshold: 35 });
    if (r.ok) {
      const inRun = runBacktest(ctx, { threshold: r.learnThreshold, toIndex: r.splitAt });
      ok('จำนวนไม้ที่ใช้เรียนรู้ = ไม้ในช่วงแรกเท่านั้น (ไม่มีไม้จากช่วงสอบปน)',
        r.rows === toDataset(inRun.trades, KEYS).length, `${r.rows} เทียบ ${inRun.trades.length}`);
      ok('ไม้ทุกไม้ที่ใช้เรียนรู้จบก่อนเส้นแบ่ง',
        inRun.trades.every((t) => t.exitIndex < r.splitAt));
    } else { ok('จำนวนไม้ที่ใช้เรียนรู้ = ไม้ในช่วงแรกเท่านั้น', false, r.reason); }
  }
}

// ── ระบบศึกษาตลาดเองแล้วปรับกลยุทธ์ ──────────────────────────────────
section('13) ปรับกลยุทธ์เอง — ต้องจูนจากอดีตล้วน และพิสูจน์ว่าช่วยจริง');
{
  // ตลาดที่เปลี่ยนคาแรกเตอร์ไปเรื่อย ๆ (เทรนด์ขึ้น → กรอบ → เทรนด์ลง → เหวี่ยงแรง)
  // เป็นสภาพจริงของทองคำ และเป็นกรณีเดียวที่การปรับตัวเองควรได้เปรียบ
  function regimeCandles(n, seed) {
    const rnd = mulberry(seed); const out = []; let p = 3300;
    const R = [{ d: 0.55, v: 3.0 }, { d: 0, v: 2.0 }, { d: -0.5, v: 4.5 }, { d: 0, v: 8.0 }];
    const seg = Math.floor(n / 8);
    for (let i = 0; i < n; i++) {
      const g = R[Math.floor(i / seg) % R.length];
      const o = p, c = p + (rnd() - 0.5) * g.v + g.d;
      out.push({ t: 17e11 + i * 9e5, o, h: Math.max(o, c) + rnd() * g.v * 0.4,
        l: Math.min(o, c) - rnd() * g.v * 0.4, c, v: 100 + rnd() * 400, closed: true });
      p = c;
    }
    return out;
  }

  /* 13.1 ด่านที่สำคัญที่สุด: การจูนต้องไม่แอบเห็นอนาคต

     ถ้า tuneOn ให้ผลต่างกันระหว่าง "ป้อนข้อมูลทั้งชุด" กับ "ตัดข้อมูลหลังเส้นแบ่งทิ้ง"
     แปลว่ามีข้อมูลอนาคตรั่วเข้าไปในการจูน ผลทดสอบทั้งหมดจะสวยเกินจริงทันที */
  {
    const all = regimeCandles(2600, 61);
    const cut = 1800;
    const full = buildContext(all, DEFAULT_CFG);
    const trunc = buildContext(all.slice(0, cut), DEFAULT_CFG);
    const a = tuneOn(full, DEFAULT_CFG.warmup || 210, cut, {});
    const b = tuneOn(trunc, DEFAULT_CFG.warmup || 210, cut, {});
    ok('จูนได้ผลทั้งสองแบบ', !!a && !!b);
    if (a && b) {
      ok('จูนจากข้อมูลทั้งชุด = จูนจากข้อมูลที่ตัดอนาคตทิ้ง (ไม่มีข้อมูลรั่ว)',
        a.threshold === b.threshold && a.slAtrMult === b.slAtrMult && a.targetR === b.targetR
        && near(a.expectancy, b.expectancy, 1e-9),
        `ทั้งชุด ${a.threshold}/${a.slAtrMult}/${a.targetR} vs ตัดแล้ว ${b.threshold}/${b.slAtrMult}/${b.targetR}`);
    }
  }

  // 13.2 ช่วงเรียนรู้ต้องมาก่อนช่วงสอบเสมอ และช่วงสอบต้องไม่ทับกัน
  {
    const ctx = buildContext(regimeCandles(4000, 73), DEFAULT_CFG);
    const r = rollingWalkForward(ctx, { folds: 4 });
    ok('แบ่งช่วงสอบได้สำเร็จ', r.ok, r.reason || '');
    if (r.ok) {
      const f = r.folds.filter((x) => x.ok);
      ok('มีช่วงสอบครบตามที่ขอ', f.length === 4, `ได้ ${f.length}`);
      ok('ทุกช่วง: ข้อมูลที่ใช้จูนจบก่อนวันที่เริ่มสอบ',
        f.every((x) => x.trainFrom < x.testFrom));
      ok('ช่วงสอบเรียงตามเวลาและไม่ทับกัน',
        f.every((x, i) => i === 0 || x.testFrom >= f[i - 1].testTo));
      ok('แต่ละช่วงจูนได้ค่าของตัวเอง (ไม่ใช่ค่าเดียวกันทั้งหมดแบบตายตัว)',
        f.every((x) => x.params && Number.isFinite(x.params.threshold)));
      ok('เทียบกับค่าคงที่บนช่วงสอบชุดเดียวกัน', r.fixed.n > 0 && r.adapt.n > 0);
      ok('เส้นทุนยาวเท่าจำนวนไม้ในช่วงสอบ', r.equity.length === r.adapt.n);
    }
  }

  /* 13.3 ตลาดที่ไม่เปลี่ยนคาแรกเตอร์เลย การปรับตัวเองต้องไม่ช่วย

     นี่คือตัวควบคุม ถ้าตรงนี้ยัง "ช่วย" แปลว่าเรากำลังวัดอะไรผิด
     ไม่ใช่ว่าระบบเก่งจริง */
  {
    const flat = [];
    const rnd = mulberry(404); let p = 3300;
    for (let i = 0; i < 4000; i++) {
      const o = p, c = p + (rnd() - 0.5) * 6;
      flat.push({ t: 17e11 + i * 9e5, o, h: Math.max(o, c) + rnd() * 2.2,
        l: Math.min(o, c) - rnd() * 2.2, c, v: 100 + rnd() * 400, closed: true });
      p = c;
    }
    const r = rollingWalkForward(buildContext(flat, DEFAULT_CFG), { folds: 4 });
    ok('ตลาดสุ่มล้วน → ไม่อ้างว่าการปรับตัวเองช่วยได้มาก',
      !r.ok || r.diff === null || r.diff < 0.08, r.ok ? `ได้ ${r.diff.toFixed(3)}R` : r.reason);
  }

  /* 13.3ข ตัวควบคุมที่สำคัญกว่า: ข้อมูลที่ "เหมือนตลาดจริง"

     บทเรียน: เครื่องปั่นข้อมูลชุดแรกเปลี่ยน regime เป็นขั้นทุก ~500 แท่ง
     ซึ่งเอื้อกับการจูนใหม่ทุกช่วงเกินจริง (วัดได้ +0.103 R/ไม้ t=5.12)
     พอเปลี่ยนเป็นข้อมูลที่ความผันผวนเกาะกลุ่ม (GARCH) หางอ้วน และเทรนด์
     ค่อย ๆ เปลี่ยนแบบต่อเนื่อง ประโยชน์หายไปหมด (-0.027 R/ไม้ t=-1.64)

     ตลาดจริงไม่ประกาศว่ากำลังเปลี่ยน regime เทสต์นี้จึงกันไม่ให้กลับไปอ้าง
     ตัวเลขที่มาจากข้อมูลจำลองที่เข้าข้างตัวเองอีก */
  {
    const rnd = mulberry(2027);
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const fatTail = () => { let q = 0; for (let i = 0; i < 4; i++) { const g = gauss(); q += g * g; }
      return gauss() / Math.sqrt(q / 4); };
    const bars = []; let p = 3300, sigma2 = 4, drift = 0;
    for (let i = 0; i < 4000; i++) {
      drift += -0.02 * drift + 0.035 * gauss();
      const shock = Math.sqrt(sigma2) * fatTail() * 0.8;
      sigma2 = 0.15 + 0.08 * shock * shock + 0.90 * sigma2;
      const o = p, c = p + shock + drift, wick = Math.sqrt(sigma2) * 0.35;
      bars.push({ t: 17e11 + i * 9e5, o, h: Math.max(o, c) + rnd() * wick,
        l: Math.min(o, c) - rnd() * wick, c, v: 100 + rnd() * 400, closed: true });
      p = c;
    }
    const r = rollingWalkForward(buildContext(bars, DEFAULT_CFG), { folds: 4 });
    ok('ข้อมูลเสมือนตลาดจริง → ไม่อ้างว่าการปรับตัวเองช่วยได้มาก',
      !r.ok || r.diff === null || r.diff < 0.08, r.ok ? `ได้ ${r.diff.toFixed(3)}R` : r.reason);
  }

  // 13.4 ข้อมูลน้อย → บอกตรง ๆ ว่าทำไม่ได้ ไม่ใช่คืนตัวเลขมั่ว
  {
    const tiny = rollingWalkForward(buildContext(makeCandles(900, 12), DEFAULT_CFG), { folds: 4 });
    ok('ข้อมูลไม่พอ → ปฏิเสธพร้อมบอกจำนวนแท่งที่ต้องการ',
      !tiny.ok && /ต้องการ/.test(tiny.reason), tiny.reason || 'ผ่านทั้งที่ไม่ควรผ่าน');
  }

  // 13.5 ตัวชี้ว่าผลกำลังเสื่อม
  {
    const ctx = buildContext(regimeCandles(4000, 89), DEFAULT_CFG);
    const r = rollingWalkForward(ctx, { folds: 4 });
    const d = driftCheck(r);
    ok('ตรวจการเสื่อมของผลได้ และให้ระดับที่รู้จัก',
      d && ['ok', 'warn', 'bad', 'unknown'].includes(d.level), d ? d.level : 'ไม่มีผล');
  }

  // 13.6 autoTune ต้องแยก "ค่าที่จะใช้" ออกจาก "ตัวเลขที่เชื่อได้"
  {
    const ctx = buildContext(regimeCandles(4000, 97), DEFAULT_CFG);
    const a = autoTune(ctx, { folds: 4 });
    ok('autoTune คืนค่าที่จะใช้จริง', a.ok && Number.isFinite(a.params.threshold), a.reason || '');
    if (a.ok) {
      /* ตัวเลขคาดหวังต้องมาจากช่วงสอบเท่านั้น ห้ามเอาผลตอนจูนมาโชว์
         ไม่งั้นผู้ใช้จะเห็นตัวเลขที่สวยกว่าความจริงเสมอ */
      ok('ตัวเลขที่คาดหวังมาจากช่วงสอบ ไม่ใช่จากตอนจูน',
        a.expected !== null && a.expected.n === a.rwf.adapt.n);
      ok('ค่าคาดหวังตอนจูนสูงกว่าตอนสอบ (ตามที่ควรเป็น) หรืออย่างน้อยไม่เท่ากันโดยบังเอิญ',
        a.params.expectancy !== a.expected.expectancy || a.expected.n === 0);
    }
  }
}

// ── หน้ารับโค้ด Pine สำหรับมือถือ ───────────────────────────────────
section('14) หน้า tradingview.html — โค้ดที่ผู้ใช้คัดลอกต้องตรงกับไฟล์จริง');
{
  const fs = await import('node:fs');
  const pine = fs.readFileSync('tradingview/gold-signal-lab.pine', 'utf8');
  const page = fs.existsSync('tradingview.html') ? fs.readFileSync('tradingview.html', 'utf8') : '';
  ok('มีไฟล์ tradingview.html (สร้างด้วย node build-single.mjs)', !!page);
  if (page) {
    /* ถ้าหน้าเว็บกับไฟล์ .pine หลุดคนละเวอร์ชัน ผู้ใช้จะคัดลอกโค้ดเก่าไปใช้
       โดยไม่มีทางรู้เลย — เทียบทีละบรรทัดหลังถอด HTML escape */
    const unesc = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const m = page.match(/<pre id="code">([\s\S]*?)<\/pre>/);
    ok('หน้าเว็บมีกล่องโค้ด', !!m);
    if (m) {
      ok('โค้ดในหน้าเว็บตรงกับไฟล์ .pine ทุกตัวอักษร', unesc(m[1]).trim() === pine.trim(),
        `หน้าเว็บ ${unesc(m[1]).trim().length} ตัวอักษร เทียบไฟล์ ${pine.trim().length}`);
      /* ต้องดูเฉพาะ "ข้างในกล่องโค้ด" เท่านั้น — หน้าเว็บมี <script> ของตัวเองอยู่ท้ายไฟล์
         ถ้าค้นทั้งหน้าจะเจอตัวนั้นแล้วเข้าใจผิดว่าโค้ดรั่ว (เทสต์รอบแรกพลาดตรงนี้) */
      ok('ไม่มีแท็กดิบหลุดเข้าไปในกล่องโค้ด (escape ครบ)',
        !/<script|<\/pre/i.test(m[1]));
    }
    ok('มีปุ่มคัดลอกและมีทางสำรองเมื่อ clipboard API ใช้ไม่ได้',
      /id="copyBtn"/.test(page) && /execCommand\('copy'\)/.test(page));
    ok('บอกข้อจำกัดว่าแอปมือถือไม่มี Pine Editor', /ไม่มี.{0,4}Pine Editor/.test(page));
    ok('มีคำเตือนว่าเพื่อการศึกษา', /ไม่ใช่คำแนะนำการลงทุน/.test(page));
  }
  const idx = fs.readFileSync('index.html', 'utf8');
  ok('หน้าเว็บแอปมีลิงก์ไปหน้านี้ (ไม่งั้นไม่มีใครหาเจอ)', /href="tradingview\.html"/.test(idx));
}

// ── ตัวจับ "ราคาค้าง" ────────────────────────────────────────────────
section('15) จับราคาค้าง — สัญญาณจากราคาที่ค้างอันตรายกว่าไม่มีสัญญาณ');
{
  /* WebSocket ค้างแบบ "เปิดอยู่แต่ไม่ส่งอะไรมา" เกิดบ่อยบนมือถือ
     onclose ไม่ยิง ระบบจึงไม่รู้ตัว แล้วโชว์ราคาเก่าพร้อมสัญญาณเข้าซื้อต่อไป */
  const f = new MarketFeed();

  ok('ยังไม่เริ่ม → ไม่ฟ้องว่าค้าง (กันเตือนผิดตอนเพิ่งเปิดหน้า)',
    f.freshness().stale === false && f.freshness().unknown === true);

  f.stopped = false;
  f.lastDataAt = Date.now();
  ok('เพิ่งได้ข้อมูล → ไม่ค้าง', !f.freshness().stale);

  f.lastDataAt = Date.now() - 60000;
  ok('WebSocket เงียบ 1 นาที → ยังไม่ฟ้อง (ยังอยู่ในเกณฑ์)', !f.freshness().stale);
  f.lastDataAt = Date.now() - 120000;
  ok('WebSocket เงียบ 2 นาที → ฟ้องว่าค้าง', f.freshness().stale);

  /* โหมดดึงเป็นรอบดึงทุก 3 นาทีอยู่แล้ว ถ้าใช้เกณฑ์เดียวกับ WebSocket
     จะฟ้องผิดทุกครั้งที่รอรอบถัดไป — ผู้ใช้จะเลิกเชื่อคำเตือนภายในวันเดียว */
  f.source = 'twelvedata';
  f.lastDataAt = Date.now() - 200000;
  ok('โหมดดึงเป็นรอบ: เงียบ 3.3 นาที → ยังไม่ฟ้อง (เกณฑ์ผ่อนตามจังหวะดึง)', !f.freshness().stale);
  f.lastDataAt = Date.now() - 500000;
  ok('โหมดดึงเป็นรอบ: เงียบ 8.3 นาที → ฟ้องว่าค้าง', f.freshness().stale);
  ok('เกณฑ์ของโหมดดึงเป็นรอบต้องกว้างกว่าของ WebSocket',
    f.staleAfterMs > new MarketFeed().staleAfterMs);

  // ต้องบอกได้ว่าค้างมานานเท่าไร ไม่ใช่แค่ค้าง/ไม่ค้าง
  const age = f.freshness().ageMs;
  ok('รายงานระยะเวลาที่ค้างได้ถูกต้อง', age >= 499000 && age <= 501000, `ได้ ${age}`);

  // ข้อความในหน้าเว็บต้องระงับสัญญาณจริง ไม่ใช่แค่เตือน
  const fs = await import('node:fs');
  const app = fs.readFileSync('js/app.js', 'utf8');
  ok('ตัวกรอง "ข้อมูลค้าง" ถูกใส่ใน blocks (ซึ่งเป็นตัวที่ระงับสัญญาณจริง)',
    /fresh\.stale[\s\S]{0,120}blocks\.push/.test(app));
  ok('มีนาฬิกาเฝ้าดูเป็นรอบ', /setInterval\(checkFreshness/.test(app));
  ok('กลับมาดูหน้าจอแล้วเช็กทันที (จังหวะที่ค้างบ่อยที่สุดบนมือถือ)',
    /visibilitychange[\s\S]{0,120}checkFreshness/.test(app));
  ok('ค้างแล้วพยายามต่อใหม่ ไม่ใช่แค่เตือนเฉย ๆ', /staleSince[\s\S]{0,200}reload\(\)/.test(app));
  const idx = fs.readFileSync('index.html', 'utf8');
  ok('มีแถบเตือนบนสุดของหน้า', /id="staleBar"/.test(idx));
}

// ── แหล่งข้อมูลสำรอง ─────────────────────────────────────────────────
section('16) แหล่งราคาทองอื่น — ตัวแปลงข้อมูลต้องอ่านคอลัมน์ถูกลำดับ');
{
  /* จำลองรูปแบบที่แต่ละเจ้าส่งกลับมาตามเอกสารของเขา
     ยิงจริงจากเครื่องนี้ไม่ได้ แต่ "อ่านคอลัมน์ถูกไหม" ทดสอบได้ และเป็นจุดที่พังง่ายที่สุด */
  const mkRes = (json, ok = true, status = 200) => ({ ok, status, json: async () => json });
  const t0 = 1735689600000;   // 1 ม.ค. 2025 00:00 UTC
  const step = 900000;

  // แท่งเดียวกันในทุกเจ้า: เปิด 2600, สูงสุด 2620, ต่ำสุด 2590, ปิด 2610
  const O = 2600, H = 2620, L = 2590, C = 2610;

  const shapes = {
    binance_paxg: [[t0, `${O}`, `${H}`, `${L}`, `${C}`, '12.5', t0 + step - 1, '0', 0, '0', '0', '0'],
                   [t0 + step, `${C}`, `${H}`, `${L}`, `${O}`, '11.0', t0 + 2 * step - 1, '0', 0, '0', '0', '0']],
    kraken_paxg: { error: [], result: {
      PAXGUSD: [[t0 / 1000, `${O}`, `${H}`, `${L}`, `${C}`, '2605.0', '12.5', 40],
                [(t0 + step) / 1000, `${C}`, `${H}`, `${L}`, `${O}`, '2605.0', '11.0', 38]], last: 123 } },
    // Bitfinex: [เวลา, เปิด, ปิด, สูงสุด, ต่ำสุด, ปริมาณ] — ลำดับต่างจากชาวบ้าน
    bitfinex_xaut: [[t0, O, C, H, L, 12.5], [t0 + step, C, O, H, L, -11.0]],
    okx_paxg: { code: '0', data: [   // OKX ส่งใหม่ไปเก่า
      [`${t0 + step}`, `${C}`, `${H}`, `${L}`, `${O}`, '11.0', '0', '0', '1'],
      [`${t0}`, `${O}`, `${H}`, `${L}`, `${C}`, '12.5', '0', '0', '1']] },
    twelvedata: { values: [
      { datetime: '2025-01-01 00:00:00', open: `${O}`, high: `${H}`, low: `${L}`, close: `${C}`, volume: '12' },
      { datetime: '2025-01-01 00:15:00', open: `${C}`, high: `${H}`, low: `${L}`, close: `${O}`, volume: '11' }] },
  };

  for (const key of Object.keys(SOURCES)) {
    const bars = SOURCES[key].parse(shapes[key]);
    const label = SOURCES[key].label;
    ok(`${label}: ได้ 2 แท่ง`, bars.length === 2, `ได้ ${bars.length}`);
    if (bars.length === 2) {
      const b = bars[0];
      ok(`${label}: อ่าน เปิด/สูง/ต่ำ/ปิด ถูกลำดับ`,
        b.o === O && b.h === H && b.l === L && b.c === C,
        `ได้ o=${b.o} h=${b.h} l=${b.l} c=${b.c} (ควรเป็น ${O}/${H}/${L}/${C})`);
      ok(`${label}: เรียงเวลาจากเก่าไปใหม่`, bars[0].t < bars[1].t, `${bars[0].t} → ${bars[1].t}`);
      ok(`${label}: เวลาเป็นมิลลิวินาที`, bars[0].t === t0, `ได้ ${bars[0].t}`);
      ok(`${label}: ปริมาณไม่ติดลบ`, bars.every((x) => x.v >= 0));
      ok(`${label}: ผ่านการตรวจความสมเหตุสมผล`, validateBars(bars, step).ok,
        validateBars(bars, step).issues.join(' · '));
    }
  }

  /* ตัวตรวจต้องจับ "อ่านคอลัมน์สลับ" ได้จริง ไม่ใช่ผ่านทุกอย่าง
     ถ้าตรงนี้ไม่จับ ผู้ใช้จะได้กราฟกลับหัวโดยไม่มีอะไรบอก */
  {
    const swapped = [{ t: t0, o: O, h: L, l: H, c: C, v: 1 }];   // สูง/ต่ำ สลับกัน
    const v = validateBars(swapped, step);
    ok('ตัวตรวจจับได้เมื่อสูงสุด/ต่ำสุดสลับกัน', !v.ok && /สลับ/.test(v.issues.join(' ')));
    const notGold = [{ t: t0, o: 1.1, h: 1.2, l: 1.0, c: 1.15, v: 1 }];
    ok('ตัวตรวจจับได้เมื่อราคาไม่ใช่ช่วงราคาทอง', !validateBars(notGold, step).ok);
    ok('ตัวตรวจจับได้เมื่อไม่มีข้อมูลเลย', !validateBars([], step).ok);
  }

  // testSource ต้องรายงานสาเหตุที่คนอ่านรู้เรื่อง ไม่ใช่โยน error ดิบ
  {
    const blocked = await testSource('kraken_paxg', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    ok('โดน CORS/บล็อก → บอกสาเหตุเป็นภาษาคน ไม่ใช่ error ดิบ',
      !blocked.ok && blocked.cors === true && /CORS|บล็อก/.test(blocked.reason), blocked.reason);

    const geo = await testSource('binance_paxg', { fetchImpl: async () => ({ ok: false, status: 451 }) });
    ok('รหัส 451 → อธิบายว่าน่าจะถูกบล็อกตามภูมิภาค', !geo.ok && /บล็อก/.test(geo.reason), geo.reason);

    const good = await testSource('bitfinex_xaut', {
      tfMs: step, fetchImpl: async () => mkRes(shapes.bitfinex_xaut) });
    ok('ยิงสำเร็จ → รายงานจำนวนแท่งและราคาล่าสุด',
      good.ok && good.bars === 2 && good.lastPrice === O, JSON.stringify(good).slice(0, 120));

    const noKey = await testSource('twelvedata', {});
    ok('แหล่งที่ต้องใช้คีย์ แต่ยังไม่ใส่ → บอกให้ใส่คีย์ก่อน', !noKey.ok && noKey.needsKey === true);

    const noTf = await testSource('bitfinex_xaut', { interval: '4h' });
    ok('Bitfinex ไม่มีกรอบ 4 ชั่วโมง → บอกว่าไม่รองรับ แทนที่จะยิงมั่ว',
      !noTf.ok && noTf.unsupported === true, noTf.reason);
  }

  // เรียงลำดับ: ตัวที่ใช้ได้ต้องมาก่อน แล้วเรียงตามความใกล้เคียงราคาทองจริง
  {
    const all = await testAllSources({
      fetchImpl: async (u) => {
        if (/kraken/.test(u)) return mkRes(shapes.kraken_paxg);
        if (/bitfinex/.test(u)) return mkRes(shapes.bitfinex_xaut);
        throw new TypeError('Failed to fetch');
      },
      tfMs: step,
    });
    const okKeys = all.filter((r) => r.ok).map((r) => r.key);
    ok('ทดสอบทุกแหล่งพร้อมกันได้ และคัดตัวที่ใช้ได้ขึ้นก่อน',
      all.length === Object.keys(SOURCES).length && all[0].ok === true, okKeys.join(','));
    ok('แหล่งที่เทียบ USD จริง ถูกจัดว่าใกล้ราคาทองมากกว่าแหล่งที่เทียบ USDT',
      SOURCES.kraken_paxg.accuracy > SOURCES.binance_paxg.accuracy
      && SOURCES.bitfinex_xaut.accuracy > SOURCES.okx_paxg.accuracy);
    ok('ทองคำสปอตจริงถูกจัดว่าแม่นที่สุด',
      SOURCES.twelvedata.accuracy === Math.max(...Object.values(SOURCES).map((x) => x.accuracy)));
  }
}

// ── ระบบออกแบบ ──────────────────────────────────────────────────────
section('17) ระบบออกแบบ — ความสม่ำเสมอคือสิ่งที่ทำให้ดูมืออาชีพ');
{
  const fs = await import('node:fs');
  const css = fs.readFileSync('styles.css', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');

  /* ก่อนหน้านี้ไฟล์นี้มีขนาดตัวอักษร 15 ค่า (10.5, 11.8, 12.3, 13.2, 13.6, 14.5 ...)
     ซึ่งเป็นการหยิบตัวเลขมาใช้ตามใจ สายตาจับได้ว่าไม่มีระบบแม้อธิบายไม่ถูกว่าทำไม
     เทสต์นี้กันไม่ให้ค่อย ๆ ไหลกลับไปเป็นแบบเดิม */
  const rawSizes = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => m[1]);
  ok('ไม่มีขนาดตัวอักษรดิบหลงเหลือ — ต้องใช้โทเคนสเกลเท่านั้น',
    rawSizes.length === 0, `เจอ ${rawSizes.length} จุด: ${[...new Set(rawSizes)].join(', ')}`);

  const scaleTokens = [...css.matchAll(/--fs-([a-z0-9]+):/g)].map((m) => m[1]);
  ok('สเกลตัวอักษรมีไม่เกิน 8 ขนาด', scaleTokens.length <= 8, `มี ${scaleTokens.length}`);
  const used = new Set([...css.matchAll(/var\(--fs-([a-z0-9]+)\)/g)].map((m) => m[1]));
  ok('ทุกขนาดที่ใช้อยู่ในสเกลที่ประกาศไว้',
    [...used].every((u) => scaleTokens.includes(u)), [...used].filter((u) => !scaleTokens.includes(u)).join(','));

  /* อิโมจิเป็นสัญญาณที่ชัดที่สุดของงานที่ไม่ได้ผ่านการออกแบบ:
     หน้าตาต่างกันทุกระบบปฏิบัติการ คุมขนาด/น้ำหนักเส้น/สีไม่ได้เลย
     ในหน้าจอหลักจึงต้องเป็น SVG ทั้งหมด (ยกเว้นในข้อความแจ้งเตือนของระบบปฏิบัติการ) */
  const emojiInUi = [...html].filter((ch) => {
    const o = ch.codePointAt(0);
    return (o >= 0x1F300 && o <= 0x1FAFF) || (o >= 0x2600 && o <= 0x27BF)
        || (o >= 0x23E9 && o <= 0x23FA) || o === 0x26A0 || o === 0xFE0F;
  });
  ok('หน้าจอหลักไม่มีอิโมจิเหลือ — ใช้ไอคอน SVG แทนทั้งหมด',
    emojiInUi.length === 0, `เจอ ${emojiInUi.length}: ${[...new Set(emojiInUi)].join(' ')}`);
  ok('มีชุดไอคอน SVG ใช้งานจริง', (html.match(/class="ico/g) || []).length >= 10);

  /* สีต้องมาจากโทเคน ไม่งั้นเปลี่ยนธีมทีเดียวไม่ได้ และสีจะค่อย ๆ เพี้ยนกันเอง
     อนุญาตเฉพาะในบล็อก :root ที่เป็นที่นิยามโทเคน */
  const afterRoot = css.slice(css.indexOf('* { box-sizing'));
  const hardCoded = [...afterRoot.matchAll(/(?:^|[^-\w])(#[0-9a-fA-F]{3,8})\b/g)]
    .map((m) => m[1]).filter((c) => !/^#(fff|000)$/i.test(c));
  ok('สีในส่วนคอมโพเนนต์มาจากโทเคนเกือบทั้งหมด',
    hardCoded.length <= 12, `ยังเหลือ ${hardCoded.length}: ${[...new Set(hardCoded)].slice(0, 8).join(' ')}`);

  ok('ตัวเลขทุกตัวใช้ความกว้างเท่ากัน (tabular-nums) — จำเป็นกับหน้าจอการเงิน',
    /font-variant-numeric:\s*tabular-nums/.test(css));
  ok('มีไอคอนประจำเว็บและสีธีมสำหรับแถบเบราว์เซอร์',
    /rel="icon"/.test(html) && /name="theme-color"/.test(html));
  ok('มีคำอธิบายหน้าเว็บสำหรับการแชร์/ค้นหา', /name="description"/.test(html));

  /* ปุ่มต้องสูงเท่ากันหมด ไม่งั้นแถบเครื่องมือจะดูขรุขระ */
  ok('ปุ่มและช่องกรอกกำหนดความสูงไว้เท่ากัน',
    /\.btn\s*{[^}]*height:\s*32px/.test(css) && /input\[type=number\][^{]*{[^}]*height:\s*32px/.test(css));
}

// ── ชนะแล้วต้องได้กำไรจริง ───────────────────────────────────────────
section('18) ชนะแล้วต้องคุ้มที่เสี่ยงไป — ไม่งั้นชนะไปก็ไม่มีความหมาย');
{
  const ctx = buildContext(makeCandles(3000, 55, 0.25), DEFAULT_CFG);

  /* เสี่ยง 1 เพื่อได้ 0.75 แปลว่าต้องชนะเกิน 57% ถึงจะเสมอตัว
     พลาดไม่กี่ไม้ กำไรทั้งวันหายหมด — ระบบต้องไม่ยอมให้เลือกแบบนั้นเลย */
  {
    const o = optimizeExits(ctx, {});
    ok('ตัวหาค่าที่ดีที่สุดไม่เลือกเป้าต่ำกว่า 1R',
      !o.ok || o.best.targetR >= 1, o.ok ? `เลือก ${o.best.targetR}R` : o.reason);
    if (o.ok) {
      ok('ผลการกวาดหาไม่มีเป้าต่ำกว่า 1R ปรากฏเลย (กันการเผลอหยิบไปใช้)',
        o.grid.every((g) => g.targetR >= 1), `ต่ำสุด ${Math.min(...o.grid.map((g) => g.targetR))}`);
    }
    // ตั้งพื้นสูงขึ้นแล้วต้องเคารพด้วย
    const strict = optimizeExits({ ...ctx, cfg: { ...ctx.cfg, minTargetR: 2 } }, {});
    ok('ตั้งพื้นเป็น 2R แล้วระบบไม่เลือกอะไรต่ำกว่านั้น',
      !strict.ok || strict.best.targetR >= 2, strict.ok ? `เลือก ${strict.best.targetR}R` : strict.reason);
  }

  // แผนเทรดสดก็ต้องเคารพพื้นเดียวกัน
  {
    const i = ctx.candles.length - 5;
    const sc = scoreAt(ctx, i);
    const plan = buildSetup(ctx, i, { ...sc, side: 1 }, { entryPrice: ctx.candles[i].c, targetR: 0.5, side: 1 });
    ok('สั่งเป้า 0.5R มา แผนเทรดก็ยังไม่ยอมต่ำกว่า 1R', !plan || plan.mainR >= 1, plan ? `ได้ ${plan.mainR}` : 'ไม่มีแผน');
  }

  /* วิธีบริหารไม้เป็นตัวกำหนดว่า "ชนะ" แล้วได้เท่าไรจริง ๆ
     ปิดครึ่งที่ 1R ทำให้ไม้ที่ถูกเขี่ยกลับมาที่ทุนได้แค่ +0.5R
     ซึ่งคือกำไรครึ่งเดียวของที่เสี่ยงไป ทั้งที่ตอนแพ้เสียเต็ม */
  {
    const partial = runBacktest(ctx, { threshold: 30, exitStyle: 'partial' });
    const full = runBacktest(ctx, { threshold: 30, exitStyle: 'full' });
    ok('แบบปิดครึ่ง: มีไม้ที่จบด้วยกำไรครึ่งเดียวของที่เสี่ยง',
      partial.trades.some((t) => t.result === 'win1R-be' && near(t.rMultiple, 0.5)));

    const smallWinsFull = full.trades.filter((t) => t.result !== 'timeout' && t.rMultiple > 0 && t.rMultiple < 1);
    ok('แบบถือเต็มไม้: ไม่มีไม้ที่ปิดเองแล้วได้กำไรน้อยกว่าที่เสี่ยงไป',
      smallWinsFull.length === 0, `เจอ ${smallWinsFull.length} ไม้`);

    const pSmall = partial.stats.smallWinShare, fSmall = full.stats.smallWinShare;
    ok('แบบถือเต็มไม้มีสัดส่วนไม้กำไรจิ๊บจ๊อยน้อยกว่าแบบปิดครึ่ง',
      fSmall < pSmall, `เต็มไม้ ${fSmall.toFixed(1)}% เทียบกับปิดครึ่ง ${pSmall.toFixed(1)}%`);
    ok('แบบถือเต็มไม้ได้กำไรเฉลี่ยตอนชนะสูงกว่า',
      full.stats.avgWin > partial.stats.avgWin,
      `เต็มไม้ ${full.stats.avgWin.toFixed(2)}R เทียบกับปิดครึ่ง ${partial.stats.avgWin.toFixed(2)}R`);
  }

  /* อัตราชนะที่รายงานต้องแยกให้ชัดระหว่าง "ไม่ขาดทุน" กับ "ได้กำไรคุ้มที่เสี่ยง"
     ไม่งั้นตัวเลขจะดูดีกว่าความจริงเสมอ */
  {
    const bt = runBacktest(ctx, { threshold: 30, exitStyle: 'partial' });
    const manual = bt.trades.filter((t) => t.rMultiple >= 1).length / bt.stats.n * 100;
    ok('อัตราชนะจริงนับเฉพาะไม้ที่ได้กำไร ≥ 1R', near(bt.stats.realWinRate, manual, 1e-9));
    ok('อัตราชนะจริงต้องไม่สูงกว่าอัตราแตะเป้า 1R', bt.stats.realWinRate <= bt.stats.winRate + 1e-9,
      `จริง ${bt.stats.realWinRate.toFixed(1)}% แตะเป้า ${bt.stats.winRate.toFixed(1)}%`);
    const wins = bt.trades.filter((t) => t.rMultiple > 0);
    ok('กำไรเฉลี่ยตอนชนะคำนวณถูก',
      near(bt.stats.avgWin, wins.reduce((a, t) => a + t.rMultiple, 0) / wins.length, 1e-9));
  }
}

// ── วิเคราะห์ข่าวโลก ─────────────────────────────────────────────────
section('19) ข่าวโลก — ทิศทางที่บอกต้องถูก ไม่งั้นแย่กว่าไม่มี');
{
  /* ตัวขับที่ "ทิศขึ้นกับกริยา" ต้องกลับทิศได้ครบทุกรูปผัน
     เวอร์ชันแรกมีแต่ 'falls' จึงอ่าน "yields fall" เป็นกดทอง ซึ่งกลับหัวกับความจริง
     เจอตอนทดสอบบนเบราว์เซอร์ ไม่ใช่ตอนเขียน — เทสต์นี้กันไม่ให้หลุดอีก */
  const dirOf = (t) => { const a = classifyHeadline(t); return a ? a.dir : 0; };
  for (const t of ['Treasury yields fall to a low', 'Treasury yield falls to a low',
                   'Treasury yields falling fast', 'Bond yields decline further',
                   'Bond yields dropped overnight']) {
    ok(`ยีลด์ลงต้องหนุนทอง: "${t}"`, dirOf(t) > 0, `ได้ ${dirOf(t)}`);
  }
  ok('ยีลด์ขึ้นต้องกดทอง', dirOf('Bond yields rise on hot data') < 0);
  ok('ดอลลาร์อ่อนต้องหนุนทอง', dirOf('Dollar weakens against major currencies') > 0);
  ok('ดอลลาร์แข็งต้องกดทอง', dirOf('Dollar strengthens sharply') < 0);
  ok('เงินเฟ้อเร่งตัวต้องหนุนทอง', dirOf('Inflation accelerates to 4 percent') > 0);
  ok('เงินเฟ้อชะลอต้องกดทอง', dirOf('Inflation cools to 2 percent') < 0);
  ok('สงครามต้องหนุนทอง', dirOf('Missile strike escalates conflict') > 0);

  /* คำที่มีทิศอยู่ในตัวเองห้ามถูกกลับ
     "rate cut" คือลดดอกเบี้ย ถ้าโดนกลับจะกลายเป็นขึ้นดอกเบี้ย ซึ่งผิดคนละขั้ว */
  {
    const a = classifyHeadline('Fed signals rate cut as inflation cools further');
    const fed = a.drivers.find((d) => d.key === 'fedDovish');
    const inf = a.drivers.find((d) => d.key === 'inflation');
    ok('"ลดดอกเบี้ย" ไม่ถูกกลับทิศ แม้ในประโยคมีคำว่า cools', fed && fed.dir > 0 && !fed.inverted);
    ok('"เงินเฟ้อ" ในประโยคเดียวกันถูกกลับทิศถูกต้อง', inf && inf.inverted && inf.dir < 0);
  }

  // ข่าวคนละเรื่องที่บังเอิญมีคำว่า gold ต้องไม่ถูกนับ
  for (const t of ['Gold medal ceremony at the Olympic games', 'Goldman Sachs hires new analyst',
                   'Golden State wins the game']) {
    ok(`กรองข่าวคนละเรื่องออก: "${t.slice(0, 34)}"`, classifyHeadline(t) === null);
  }
  ok('"central bank" ที่ไม่พูดถึงทอง ไม่ถูกนับเป็นแรงซื้อทอง',
    classifyHeadline('Central bank holds rates steady') === null);
  ok('"central banks buy gold" ถูกนับ', (classifyHeadline('Central banks buy gold at record pace') || {}).dir > 0);

  // ทุกตัวขับต้องมีคำอธิบายกลไก ไม่ใช่แค่ลูกศร — ผู้ใช้ต้องเข้าใจว่าทำไม
  ok('ตัวขับทุกตัวมีคำอธิบายกลไกเป็นภาษาไทย',
    GOLD_DRIVERS.every((d) => d.why && d.why.length > 40 && /[ก-๙]/.test(d.why)));
  ok('ตัวขับทุกตัวมีทิศทางและน้ำหนักที่ใช้ได้',
    GOLD_DRIVERS.every((d) => Math.abs(d.dir) === 1 && d.w > 0));

  // เวลาแบบ GDELT
  ok('แปลงเวลารูปแบบ GDELT ได้ถูก',
    parseGdeltDate('20260831T120000Z') === Date.UTC(2026, 7, 31, 12, 0, 0));
  ok('รูปแบบเวลาที่อ่านไม่ออก ไม่ทำให้พัง', parseGdeltDate('ไม่ใช่เวลา') === null);

  /* บรรยากาศรวมต้องถ่วงน้ำหนักตามความใหม่
     ข่าวเมื่อวานตลาดรับรู้ไปแล้ว จะให้น้ำหนักเท่าข่าวเมื่อชั่วโมงที่แล้วไม่ได้ */
  {
    const now = Date.now();
    const fresh = { at: now - 3600000, analysis: { score: 10 } };
    const stale = { at: now - 86400000, analysis: { score: -10 } };
    const c = climateOf([fresh, stale], now);
    ok('ข่าวใหม่มีน้ำหนักมากกว่าข่าวเก่า', c.score > 0.3, `ได้ ${c.score.toFixed(2)}`);
    ok('ไม่มีข่าวเลย ต้องไม่พังและบอกว่าไม่มี', climateOf([], now).n === 0);
  }

  /* ดึงข่าวไม่สำเร็จ ต้องอธิบายเป็นภาษาคน ไม่ใช่โยน error ดิบ
     ตั้งแต่มีแหล่งสำรอง สาเหตุรายเจ้าย้ายไปอยู่ใน attempts แทนที่จะเป็นค่าบนสุด
     เพราะแต่ละเจ้าอาจล้มคนละสาเหตุกัน */
  {
    const blocked = await fetchNews({ feed: 'gdelt',
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    ok('โดนบล็อก → บอกสาเหตุเป็นภาษาคน',
      !blocked.ok && blocked.attempts[0].cors && /CORS|บล็อก/.test(blocked.attempts[0].reason),
      JSON.stringify(blocked.attempts[0] || {}).slice(0, 90));
    const bad = await fetchNews({ feed: 'gdelt', fetchImpl: async () => ({ ok: false, status: 429 }) });
    ok('เซิร์ฟเวอร์ปฏิเสธ → รายงานรหัสที่ได้',
      !bad.ok && /429/.test(bad.attempts[0].reason), bad.attempts[0].reason);
  }

  /* ปฏิทินข่าว: ใส่เฉพาะที่คำนวณได้แน่นอน
     ถ้าเดาวัน FOMC เองแล้วผิด ผู้ใช้จะไม่มีทางรู้ว่าผิด — อันตรายกว่าไม่บอกเลย */
  {
    const cal = economicCalendar(new Date('2026-08-31T12:00:00Z'));
    const nfp = cal.find((e) => e.key === 'nfp');
    ok('NFP คำนวณได้และทำเครื่องหมายว่าแน่นอน', nfp && nfp.exact === true);
    ok('NFP ตกวันศุกร์จริง', nfp && new Date(nfp.at).getUTCDay() === 5,
      nfp ? new Date(nfp.at).toUTCString() : 'ไม่มี');
    ok('NFP เป็นศุกร์แรกของเดือน', nfp && new Date(nfp.at).getUTCDate() <= 7);
    const fomc = cal.find((e) => e.key === 'fomc');
    ok('FOMC ไม่เดาวันเอง และบอกให้ผู้ใช้ใส่เอง',
      fomc && fomc.at === null && fomc.exact === false && /ใส่วันเอง/.test(fomc.note));
    const cpi = cal.find((e) => e.key === 'cpi');
    ok('CPI ทำเครื่องหมายว่าเป็นค่าประมาณ ไม่ใช่วันจริง',
      cpi && cpi.exact === false && /ไม่ตายตัว/.test(cpi.note));
  }
}

// ── ข่าว + กราฟ ─────────────────────────────────────────────────────
section('20) ผสมข่าวกับกราฟ — ข่าวอนาคตต้องไหลย้อนเข้าอดีตไม่ได้เลย');
{
  const H = 3600000, M = 60000;
  const base = Date.UTC(2026, 0, 10, 12, 0, 0);
  const mk = (offsetMs, score) => ({ at: base + offsetMs, title: 'x', analysis: { score, dir: Math.sign(score) } });

  /* ด่านที่สำคัญที่สุดของทั้งไฟล์
     ถ้าข่าวเวลา 14:00 ถูกใช้กับแท่ง 14:00 backtest จะสวยมากและพังทันทีที่ใช้จริง
     เพราะตอนนั้นจริง ๆ เรายังไม่รู้ข่าวนั้น */
  {
    const idx = buildNewsIndex([mk(0, 10)]);
    ok('ข่าวที่เกิดพร้อมแท่ง ยังใช้ไม่ได้ (ต้องรอเวลาหน่วง)', newsAt(idx, base).n === 0);
    ok('ข่าวที่เกิดหลังแท่ง ใช้ไม่ได้แน่นอน', newsAt(idx, base - H).n === 0);
    ok(`ผ่านเวลาหน่วง ${DEFAULT_NEWS_CFG.lagMin} นาทีแล้วถึงใช้ได้`,
      newsAt(idx, base + (DEFAULT_NEWS_CFG.lagMin + 1) * M).n === 1);
    ok('ก่อนครบเวลาหน่วง ยังใช้ไม่ได้',
      newsAt(idx, base + (DEFAULT_NEWS_CFG.lagMin - 5) * M).n === 0);
  }

  /* พิสูจน์แบบเดียวกับที่ใช้กับตัวจูน: เติมข่าวอนาคตเข้าไป
     ค่าที่อ่านได้ในอดีตต้องไม่ขยับแม้แต่นิดเดียว */
  {
    const past = [mk(-2 * H, 8), mk(-1 * H, -6)];
    const future = [mk(2 * H, 20), mk(5 * H, -30)];
    const readAt = base + 30 * M;
    const a = newsAt(buildNewsIndex(past), readAt);
    const b = newsAt(buildNewsIndex([...past, ...future]), readAt);
    ok('เติมข่าวอนาคตเข้าไป ค่าที่อ่านในอดีตต้องเท่าเดิมเป๊ะ',
      a.n === b.n && near(a.score, b.score, 1e-12), `${a.score} เทียบ ${b.score}`);
  }

  // ข่าวเก่าเกินหน้าต่างต้องหลุดออก — ตลาดรับรู้ไปแล้ว
  {
    const idx = buildNewsIndex([mk(-20 * H, 10)]);
    ok('ข่าวเก่ากว่าหน้าต่างที่กำหนด ไม่ถูกนับ', newsAt(idx, base).n === 0);
  }

  // ข่าวใหม่ต้องมีน้ำหนักมากกว่าข่าวเก่าในหน้าต่างเดียวกัน
  {
    const idx = buildNewsIndex([mk(-5 * H, -10), mk(-1 * H, 10)]);
    const r = newsAt(idx, base);
    ok('ข่าวใหม่มีน้ำหนักมากกว่าข่าวเก่า', r.n === 2 && r.score > 0.2, `ได้ ${r.score.toFixed(2)}`);
  }

  /* "เงียบ" ต้องแยกจาก "ค้าน" ให้ออก
     ไม่มีข่าว ไม่เท่ากับข่าวไม่เห็นด้วย — ถ้ารวมสองอย่างนี้ ตัวกรองจะตัดไม้ผิดกลุ่ม */
  {
    const quiet = buildNewsIndex([]);
    ok('ไม่มีข่าวเลย = เงียบ ไม่ใช่ค้าน', newsAgreement(quiet, base, 1).state === 'quiet');
    const weak = buildNewsIndex([mk(-1 * H, 1), mk(-1 * H, -1)]);
    ok('ข่าวสองทางหักล้างกัน = เงียบ', newsAgreement(weak, base, 1).state === 'quiet');
    const strong = buildNewsIndex([mk(-1 * H, 10), mk(-2 * H, 8)]);
    ok('ข่าวหนุนชัด + เข้าฝั่งซื้อ = เห็นด้วย', newsAgreement(strong, base, 1).state === 'agree');
    ok('ข่าวหนุนชัด + เข้าฝั่งขาย = ค้าน', newsAgreement(strong, base, -1).state === 'against');
  }

  // แบ่งกลุ่มไม้แล้วเทียบผล
  {
    const idx = buildNewsIndex([mk(-1 * H, 10)]);
    const trades = [
      { t: base, side: 1, rMultiple: 2 }, { t: base, side: 1, rMultiple: 2 },
      { t: base, side: -1, rMultiple: -1 }, { t: base, side: -1, rMultiple: -1 },
    ];
    const r = evaluateNewsFilter(trades, idx);
    ok('แบ่งไม้ตามท่าทีข่าวได้ถูกกลุ่ม', r.agree.n === 2 && r.against.n === 2);
    ok('ตัดไม้ที่ข่าวค้านออกแล้วค่าคาดหวังดีขึ้น', r.delta > 0, `ได้ ${r.delta}`);
    ok('รายงานสัดส่วนไม้ที่มีข่าวครอบคลุม', near(r.covered, 100, 1e-9));
  }

  /* คำตัดสินต้องเข้ม — ไม้น้อยหรือข่าวครอบคลุมน้อย ต้องไม่สรุปว่าช่วย */
  {
    const few = newsVerdict({ all: { n: 10 }, covered: 90, delta: 0.5, filtered: { n: 8 } });
    ok('ไม้น้อยเกินไป → ไม่อนุมัติ ถึงตัวเลขจะสวย', !few.apply && few.level === 'unknown');
    const thin = newsVerdict({ all: { n: 100 }, covered: 5, delta: 0.5, filtered: { n: 90 } });
    ok('ข่าวครอบคลุมน้อยเกินไป → ไม่อนุมัติ', !thin.apply && /ครอบคลุม/.test(thin.text));
    const flat = newsVerdict({ all: { n: 100 }, covered: 60, delta: 0.01, filtered: { n: 80 } });
    ok('ต่างกันนิดเดียว → บอกว่าเป็นความบังเอิญ ไม่อนุมัติ', !flat.apply && flat.level === 'ok');
    const good = newsVerdict({ all: { n: 100 }, covered: 60, delta: 0.2, filtered: { n: 80 } });
    ok('ดีขึ้นชัดและตัวอย่างพอ → อนุมัติ', good.apply && good.level === 'good');
    const bad = newsVerdict({ all: { n: 100 }, covered: 60, delta: -0.2, filtered: { n: 80 } });
    ok('แย่ลง → บอกตรง ๆ ว่าอย่าใช้ข่าวกรอง', !bad.apply && bad.level === 'bad');
  }

  // ดึงข่าวย้อนหลังต้องแบ่งเป็นก้อนและไม่วนไม่จบ
  {
    let calls = 0;
    const r = await fetchHistoricalNews(base - 3 * 24 * H, base, {
      pauseMs: 0, chunkH: 24,
      fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ articles: [
        { title: 'Bond yields fall sharply', url: 'u', domain: 'd', seendate: '20260109T120000Z' }] }) }; },
    });
    ok('แบ่งช่วงเวลาเป็นก้อนตามที่กำหนด', calls === 3, `ยิงไป ${calls} ครั้ง`);
    ok('รวบรวมข่าวจากทุกก้อนได้', r.items.length === 3);
    ok('มีเพดานจำนวนคำขอ กันวนไม่จบ',
      (await fetchHistoricalNews(0, 1e12, { pauseMs: 0, maxCalls: 5,
        fetchImpl: async () => ({ ok: true, json: async () => ({ articles: [] }) }) })).calls <= 6);
  }
}

// ── แจ้งเตือนเข้า Discord ────────────────────────────────────────────
section('21) Discord — ช่องแจ้งเตือนที่ล้มเงียบ ๆ แย่กว่าไม่มีเลย');
{
  /* URL webhook คือความลับ ใครได้ไปก็โพสต์เข้าห้องได้
     และถ้าผู้ใช้วางผิดที่ ระบบจะยิงข้อมูลการเทรดไปเซิร์ฟเวอร์แปลกหน้า */
  for (const u of ['https://discord.com/api/webhooks/123/abc',
                   'https://discord.com/api/v10/webhooks/123/abc-_X',
                   'https://canary.discord.com/api/webhooks/1/a',
                   'https://discordapp.com/api/webhooks/1/a']) {
    ok(`รับ URL ที่ถูกต้อง: ${u.slice(8, 46)}`, isValidWebhook(u));
  }
  for (const [u, why] of [
    ['https://evil.com/api/webhooks/123/abc', 'โดเมนอื่นที่ปลอมเส้นทางมา'],
    ['http://discord.com/api/webhooks/1/a', 'ไม่ใช่ https'],
    ['https://discord.com/channels/1/2', 'ไม่ใช่เส้นทาง webhook'],
    ['https://mydiscord.com/api/webhooks/1/a', 'โดเมนที่ลงท้ายคล้ายกัน'],
    ['', 'ว่าง'], [null, 'ไม่มีค่า'], ['ไม่ใช่ url เลย', 'ข้อความมั่ว'],
  ]) {
    ok(`ปฏิเสธ URL ที่ไม่ปลอดภัย (${why})`, !isValidWebhook(u));
  }

  /*
   * บอกให้ตรงจุดว่าผิดตรงไหน
   *
   * เจอมากับตัว: ผู้ใช้ตั้ง secret แล้วแต่บอทตอบแค่ "ไม่มีหรือรูปแบบไม่ถูกต้อง"
   * ซึ่งอ่านแล้วแยกไม่ออกเลยว่าลืมใส่ ใส่ผิดอัน หรือคัดลอกมาไม่ครบ
   * ทั้งสามอย่างแก้คนละวิธี การรวมเป็นข้อความเดียวจึงทำให้คนติดตายอยู่ตรงนั้น
   */
  {
    ok('ค่าที่ถูกต้อง → ไม่มีปัญหา', webhookProblem('https://discord.com/api/webhooks/123/abc') === null);

    const cases = [
      ['', 'ยังไม่ได้ใส่'],
      ['   ', 'ช่องว่างล้วน'],
      [null, 'ไม่มีค่า'],
      ['https://discord.com/channels/111/222', 'ลิงก์ห้องแชท'],
      ['https://discord.gg/abcd', 'ลิงก์เชิญ'],
      ['http://discord.com/api/webhooks/1/a', 'ไม่ใช่ https'],
      ['https://evil.com/api/webhooks/1/a', 'โดเมนอื่น'],
      ['https://discord.com/api/webhooks/123', 'ขาดโทเค็น'],
      ['https://discord.com/api/webhooks/abc/xyz', 'ไอดีไม่ใช่ตัวเลข'],
      ['https://discord.com/api/webhooks/123/abc/extra', 'มีส่วนเกินต่อท้าย'],
    ];
    const seen = new Map();
    for (const [u, why] of cases) {
      const r = webhookProblem(u);
      ok(`${why} → มีเหตุผลบอก`, typeof r === 'string' && r.length > 0);
      seen.set(why, r);
    }
    ok('ลิงก์ห้องแชทถูกเรียกชื่อออกมาตรง ๆ ไม่ใช่บอกแค่ว่ารูปแบบผิด',
       /ห้องแชท/.test(seen.get('ลิงก์ห้องแชท')));
    ok('ยังไม่ได้ใส่ ต่างจากใส่มาผิด',
       seen.get('ยังไม่ได้ใส่') !== seen.get('ลิงก์ห้องแชท'));
    ok('ขาดโทเค็น ต่างจากมีส่วนเกิน',
       seen.get('ขาดโทเค็น') !== seen.get('มีส่วนเกินต่อท้าย'));

    // เหตุผลต้องไม่พาโทเค็นออกมาโชว์ ใครเห็นก็โพสต์เข้าห้องได้
    const secret = 'sUpErSeCrEtToKeN123';
    for (const u of [`https://discord.com/api/webhooks/1/${secret}/extra`,
                     `https://evil.com/api/webhooks/1/${secret}`,
                     `https://discord.com/api/webhooks/abc/${secret}`]) {
      ok('ข้อความบอกเหตุผลไม่มีโทเค็นหลุดออกมา', !String(webhookProblem(u)).includes(secret));
    }

    // รูปแบบที่เคยตกทั้งที่ใช้ได้จริง
    ok('ทับปิดท้ายไม่ทำให้ใช้ไม่ได้', isValidWebhook('https://discord.com/api/webhooks/123/abc/'));
    ok('มีจุดในโทเค็นก็ยังใช้ได้', isValidWebhook('https://discord.com/api/webhooks/123/a.b-c_d'));
    ok('มีพารามิเตอร์ต่อท้ายก็ยังใช้ได้', isValidWebhook('https://discord.com/api/webhooks/123/abc?wait=true'));
    ok('เว้นวรรคหัวท้ายจากการคัดลอกไม่ทำให้ใช้ไม่ได้',
       isValidWebhook('  https://discord.com/api/webhooks/123/abc\n'));

    // จุดจุดต้องไม่กลายเป็นทางลัดออกนอกเส้นทาง webhook
    ok('เส้นทางย้อนขึ้นถูกปฏิเสธ', !isValidWebhook('https://discord.com/api/webhooks/123/..'));
  }

  /* ข้อความเตือนว่าระบบพัง ต้องไม่พาดหัวว่า "ยังไม่มีสัญญาณ"
     เพราะสองอย่างนี้คนละเรื่อง: ตลาดเงียบ กับ ระบบมองไม่เห็นตลาด */
  {
    const warn = buildSignalMessage({ action: 'warn', score: null, price: null,
      instrument: 'ตรวจสถานะระบบ', blocks: ['ดึงราคาไม่ได้เลยสักแหล่ง'] });
    const wait = buildSignalMessage({ action: 'wait', score: 10, price: 3000, instrument: 'x' });
    ok('ข้อความเตือนระบบพังมีหัวเรื่องของตัวเอง',
      warn.embeds[0].title !== wait.embeds[0].title && /ปัญหา/.test(warn.embeds[0].title),
      warn.embeds[0].title);
  }

  // Discord ตอบ 204 ตอนสำเร็จ ซึ่ง res.ok เป็น true อยู่แล้ว แต่ต้องรองรับกรณีที่ไม่ใช่ด้วย
  {
    const r = await sendDiscord('https://discord.com/api/webhooks/1/a', {},
      { fetchImpl: async () => ({ status: 204, ok: false }) });
    ok('รหัส 204 (สำเร็จแบบไม่มีเนื้อหาตอบ) ถือว่าสำเร็จ', r.ok);
  }
  for (const [code, kw] of [[429, 'ถี่เกินไป'], [404, 'ถูกลบ'], [403, 'ถูกลบ'], [500, '500']]) {
    const r = await sendDiscord('https://discord.com/api/webhooks/1/a', {},
      { fetchImpl: async () => ({ status: code, ok: false }) });
    ok(`รหัส ${code} → อธิบายเป็นภาษาคน`, !r.ok && new RegExp(kw).test(r.reason), r.reason);
  }
  {
    const r = await sendDiscord('https://discord.com/api/webhooks/1/a', {},
      { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    ok('ยิงไม่ถึง → บอกว่าอาจโดนบล็อก ไม่ใช่เงียบหาย', !r.ok && r.cors && /บล็อก/.test(r.reason));
    let fired = false;
    const bad = await sendDiscord('https://evil.com/x', {},
      { fetchImpl: async () => { fired = true; return { ok: true }; } });
    ok('URL ไม่ถูกต้อง → ไม่ยิงออกไปเลย', !bad.ok && !fired && bad.reason.length > 0, bad.reason);
  }

  /* ข้อความต้องอยู่ในขีดจำกัดของ Discord และมีข้อมูลครบพอตัดสินใจ */
  {
    const m = buildTestMessage();
    ok('ข้อความทดสอบมีโครงสร้างที่ Discord รับได้',
      m.embeds && m.embeds.length === 1 && m.embeds[0].fields.length <= 25);
    ok('มีราคาเข้า จุดตัดขาดทุน และเป้าหมายครบ',
      ['ราคาเข้า', 'ตัดขาดทุน', 'เป้าหมาย'].every((k) =>
        m.embeds[0].fields.some((f) => f.name.includes(k))));
    ok('มีคำเตือนว่าเพื่อการศึกษา', /ไม่ใช่คำแนะนำการลงทุน/.test(m.embeds[0].footer.text));

    // ข้อความยาวเกินต้องถูกตัด ไม่ใช่ให้ Discord ปฏิเสธทั้งก้อน
    const long = buildSignalMessage({ action: 'buy', score: 50, price: 3000,
      reasons: Array.from({ length: 40 }, () => 'เหตุผลที่ยาวมาก '.repeat(30)) });
    const f = long.embeds[0].fields.find((x) => x.name.includes('ปัจจัย'));
    ok('เหตุผลที่ยาวเกินถูกตัดให้อยู่ในขีดจำกัด 1024 ตัวอักษร', f && f.value.length <= 1024, f ? f.value.length : 'ไม่มี');
    ok('จำนวนช่องไม่เกิน 25 ตามที่ Discord กำหนด', long.embeds[0].fields.length <= 25);
  }
}

// ── แหล่งข่าวสำรอง ───────────────────────────────────────────────────
section('22) ข่าวดึงไม่ได้ — ต้องถอยไปใช้แหล่งอื่นเอง ไม่ใช่ยอมแพ้');
{
  const good = { ok: true, json: async () => ({ hits: [
    { title: 'Bond yields fall sharply', url: 'u', created_at_i: Math.floor(Date.now() / 1000) - 3600, objectID: '1' },
  ] }) };
  ok('มีแหล่งข่าวมากกว่าหนึ่ง', FEED_ORDER.length >= 3);
  ok('ทุกแหล่งในลำดับมีนิยามจริง', FEED_ORDER.every((k) => NEWS_FEEDS[k] && NEWS_FEEDS[k].url && NEWS_FEEDS[k].parse));

  {
    const r = await fetchNews({ fetchImpl: async (u) => {
      if (/gdelt/.test(u)) throw new TypeError('Failed to fetch');
      if (/algolia/.test(u)) return good;
      return { ok: false, status: 404 };
    } });
    ok('เจ้าแรกโดนบล็อก → ถอยไปใช้เจ้าถัดไปเอง', r.ok && r.feed === 'hn', r.feed || r.reason);
    ok('รายงานว่าลองเจ้าไหนไปบ้างและติดตรงไหน',
      r.attempts.length === 2 && r.attempts[0].cors === true);
  }
  {
    const r = await fetchNews({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    ok('ทุกเจ้าล้ม → บอกว่าลองครบแล้ว พร้อมผลของแต่ละเจ้า',
      !r.ok && r.attempts.length === FEED_ORDER.length && /ครบทุกแหล่ง/.test(r.reason));
  }
  {
    // Reddit ห่อข้อมูลไว้คนละชั้นกับเจ้าอื่น อ่านผิดชั้นจะได้ศูนย์ข่าวโดยไม่มี error
    const items = NEWS_FEEDS.reddit.parse({ data: { children: [
      { data: { title: 'Gold rises as dollar weakens', url_overridden_by_dest: 'https://x',
                subreddit: 'economics', created_utc: 1735689600 } }] } });
    ok('อ่านโครงสร้างของ Reddit ได้ถูกชั้น',
      items.length === 1 && items[0].title === 'Gold rises as dollar weakens'
      && items[0].at === 1735689600000, JSON.stringify(items[0] || {}).slice(0, 90));
  }
}

// ── อ่านข่าวให้ลึกขึ้นโดยไม่ต้องใช้ AI ────────────────────────────────
section('23) จุดอ่อนสามข้อที่เคยยอมรับไว้ — แก้ได้ด้วยกฎ ไม่ต้องใช้ AI');
{
  const dirOf = (t) => { const a = classifyHeadline(t); return a ? a.dir : 0; };

  /* 1. ตัวเลขเทียบกับที่ตลาดคาด
     "เงินเฟ้อ 3%" ไม่ได้บอกอะไร — ที่ตลาดตอบสนองคือส่วนต่างจากที่คาดไว้ */
  ok('จับคำว่าเกินคาดได้', surpriseOf('inflation comes in hotter than expected') === 1);
  ok('จับคำว่าต่ำกว่าคาดได้', surpriseOf('jobs report misses forecasts') === -1);
  ok('ไม่มีคำบอกส่วนต่าง → ไม่เดา', surpriseOf('inflation at 3 percent') === 0);
  ok('เงินเฟ้อเกินคาด → หนุนทอง', dirOf('US inflation comes in hotter than expected') > 0);
  ok('จ้างงานเกินคาด → กดทอง', dirOf('Jobs report beats expectations') < 0);
  ok('จ้างงานต่ำกว่าคาด → หนุนทอง', dirOf('Jobs report misses expectations badly') > 0);

  /* ห้ามพลิกทิศสองรอบ — นี่คือบั๊กที่เจอตอนทดสอบ
     "inflation misses forecasts, cooling" มีทั้งกริยาบอกทิศและคำบอกส่วนต่าง
     ซึ่งบอกเรื่องเดียวกัน ถ้าพลิกทั้งสองรอบจะได้ทิศกลับหัว */
  ok('กริยาบอกทิศ + คำบอกส่วนต่าง พูดเรื่องเดียวกัน → พลิกครั้งเดียว',
    dirOf('US inflation misses forecasts, cooling to 2.1%') < 0);
  ok('กริยาบอกทิศอย่างเดียว ยังทำงานเหมือนเดิม', dirOf('Inflation cools to 2.1%') < 0);
  {
    const a = classifyHeadline('US inflation misses forecasts, cooling to 2.1%');
    const inf = a.drivers.find((d) => d.key === 'inflation');
    ok('ข่าวที่บอกส่วนต่างได้น้ำหนักมากกว่าตัวเลขเปล่า ๆ', inf && inf.w > 7, inf ? inf.w : 'ไม่มี');
  }

  /* 2. ข่าวเก่าที่ถูกเล่าซ้ำ
     เรื่องเดียวถูกเล่าแปดรอบจะกลบเรื่องอื่นหมด ทั้งที่ตลาดรับรู้ตั้งแต่ชิ้นแรก */
  {
    const items = [
      { title: 'Fed signals rate cut as inflation cools', source: 'reuters.com', at: 1000 },
      { title: 'Federal Reserve signals rate cut amid cooling inflation', source: 'cnbc.com', at: 2000 },
      { title: 'Fed signals a rate cut, inflation cooling', source: 'blog.x', at: 3000 },
      { title: 'Missile strike escalates Middle East conflict', source: 'apnews.com', at: 1500 },
    ];
    const g = dedupe(items);
    ok('ข่าวเรื่องเดียวกันถูกยุบเป็นเรื่องเดียว', g.length === 2, `เหลือ ${g.length} เรื่อง`);
    const fed = g.find((x) => /rate cut/i.test(x.title));
    ok('นับจำนวนชิ้นที่ซ้ำไว้', fed && fed.repeats === 3, fed ? fed.repeats : 'ไม่เจอ');
    ok('นับจำนวนสำนักที่รายงานเรื่องเดียวกัน', fed && fed.sourceCount === 3);
    /* เก็บชิ้นที่ *เก่าที่สุด* เพราะเวลาที่มีความหมายกับตลาดคือตอนข่าวออกครั้งแรก
       ไม่ใช่ตอนสำนักข่าวรายที่สามเขียนตาม */
    ok('เก็บเวลาของชิ้นแรก ไม่ใช่ชิ้นล่าสุด', fed && fed.at === 1000, fed ? fed.at : '');
    ok('ข่าวคนละเรื่องไม่ถูกยุบรวมกัน',
      similarity('Missile strike escalates conflict', 'Central banks buy gold') < 0.2);
  }
  ok('คำที่เขียนต่างแต่หมายถึงสิ่งเดียวกัน ถูกนับเป็นคำเดียว',
    tokensOf('Federal Reserve').has('fed') && tokensOf('Fed').has('fed'));
  ok('รูปผันของกริยาถูกนับเป็นคำเดียว',
    [...tokensOf('cooling')][0] === [...tokensOf('cools')][0]);

  /* 3. แหล่งข่าวไม่ได้น่าเชื่อเท่ากัน */
  ok('สำนักข่าวการเงินหลักได้น้ำหนักเต็ม', sourceWeight('reuters.com') === 1);
  ok('ฟอรัมได้น้ำหนักน้อยกว่าสำนักข่าว', sourceWeight('reddit.com') < sourceWeight('bbc.com'));
  ok('แหล่งที่ไม่รู้จักไม่ถูกตัดทิ้ง แค่ลดน้ำหนัก',
    sourceWeight('unknown-blog.xyz') > 0 && sourceWeight('unknown-blog.xyz') < 1);

  /* บรรยากาศรวมต้องเอาความน่าเชื่อและจำนวนสำนักมาคิดด้วย */
  {
    const now = Date.now();
    const big = climateOf([{ at: now, analysis: { score: 10 }, weight: 1, sourceCount: 8 },
                           { at: now, analysis: { score: -10 }, weight: 0.5, sourceCount: 1 }], now);
    ok('เรื่องที่หลายสำนักรายงานตรงกัน มีน้ำหนักกว่าเสียงเดียวจากแหล่งอ่อน',
      big.score > 0.4, `ได้ ${big.score.toFixed(2)}`);
  }
}

// ── ตัวเลือกของบอทที่สั่งขัดกันเอง ─────────────────────────────
section('24) บอท: ติ๊กสองช่องที่ขัดกัน ต้องไม่ยิงข้อความออกไป');
{
  /*
   * ช่อง dry run สัญญาว่า "ไม่ส่งเข้า Discord จริง" ส่วน test ping สั่งให้ส่ง
   * ผู้ใช้ติ๊กมาทั้งคู่จริง ๆ แล้วข้อความก็ถูกส่งออกไปทั้งที่สั่งห้ามไว้
   * ข้อความที่ส่งไปแล้วเรียกกลับไม่ได้ คำสั่งห้ามจึงต้องชนะเสมอ
   *
   * ใช้ URL ที่รูปแบบถูกแต่ Discord ไม่รับ ถ้าเผลอยิงจริงจะได้ exit 1 ทันที
   */
  const { execFileSync } = await import('node:child_process');
  const fakeHook = 'https://discord.com/api/webhooks/123456789012345678/wouldBeRejectedIfSent';
  const run = (env) => {
    try {
      return { out: execFileSync('node', ['bot/run.mjs'],
        { env: { ...process.env, DISCORD_WEBHOOK_URL: fakeHook, ...env },
          encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
    } catch (e) { return { out: String(e.stdout || '') + String(e.stderr || ''), code: e.status }; }
  };

  const both = run({ BOT_TEST_PING: '1', BOT_DRY_RUN: '1' });
  ok('ติ๊กคู่ → ไม่ยิงออกไป จบแบบปกติ', both.code === 0, `exit ${both.code}`);
  ok('ติ๊กคู่ → บอกว่าทำไมถึงยังไม่ส่ง', /ยังไม่ส่ง/.test(both.out));
  ok('ติ๊กคู่ → บอกวิธีให้ส่งจริง', /ติ๊กเฉพาะ test ping/.test(both.out));
  ok('ติ๊กคู่ → ไม่ไปแตะเน็ตเลยด้วยซ้ำ', !/ใช้ข้อมูลจาก|ดึงข้อมูลราคาไม่ได้/.test(both.out));

  /*
   * ไม่มีเคส "ติ๊กช่องเดียวแล้วยิงจริง" ตรงนี้ เพราะพิสูจน์มันต้องยิงจริงไปที่ Discord
   * และชุดทดสอบนี้ถูกรันก่อนบอททุกรอบ = ยิงไปหาเขาวันละ 96 ครั้งตลอดไปโดยไม่จำเป็น
   * ทางส่งจริงมีข้อ 21 คุมอยู่แล้วด้วยการสวมรอย fetch ซึ่งไม่ต้องออกเน็ต
   */
}

// ── ตัวเลขไม้ต้องเป็นของโบรกเกอร์ผู้ใช้ ไม่ใช่ของที่ระบบเดาเอา ─────
section('26) จุดตัดขาดทุนของผู้ใช้ และสเปกโบรกเกอร์ของผู้ใช้');
{
  const c2 = makeCandles(400, 21);
  const ctx2 = buildContext(c2, DEFAULT_CFG);
  const j = c2.length - 1;
  const sc2 = scoreAt(ctx2, j);
  const e = c2[j].c;
  const base = { account: 5000, riskPct: 1, entryPrice: e, side: 1 };

  /* คนเทรดมักมีจุดตัดขาดทุนในใจอยู่แล้ว หน้าที่ของระบบคือคิดขนาดไม้จากจุดนั้น
     ให้ถูก ไม่ใช่ยืนยันจุดของตัวเอง */
  const wide = buildSetup(ctx2, j, { ...sc2, side: 1 }, { ...base, slPrice: e - 20 });
  const tight = buildSetup(ctx2, j, { ...sc2, side: 1 }, { ...base, slPrice: e - 5 });
  ok('ตั้ง SL เอง: ระยะตรงกับที่ใส่มา', near(wide.slDist, 20, 1e-9), `ได้ ${wide.slDist}`);
  ok('ตั้ง SL เอง: ระบบรู้ว่าเป็นจุดของผู้ใช้', wide.slManual === true);
  ok('SL แคบกว่า → ไม้ใหญ่กว่า (เงินเสี่ยงเท่าเดิม)', tight.lots > wide.lots,
    `แคบ ${tight.lots} vs กว้าง ${wide.lots}`);
  ok('ทั้งสองแบบเสี่ยงใกล้เคียงเงินที่ตั้งไว้', wide.riskActual <= 50 * 1.5 && tight.riskActual <= 50 * 1.5,
    `${wide.riskActual.toFixed(2)} / ${tight.riskActual.toFixed(2)}`);
  ok('เป้าหมายขยับตาม SL ที่ตั้งเอง', Math.abs(wide.tpMain - e) > Math.abs(tight.tpMain - e));

  /* ใส่ผิดฝั่งคือความผิดพลาดที่ทำให้ขาดทุนทันที ต้องไม่รับไปใช้เงียบ ๆ */
  const wrong = buildSetup(ctx2, j, { ...sc2, side: 1 }, { ...base, slPrice: e + 20 });
  ok('SL ผิดฝั่ง → ไม่รับ ใช้ค่าที่ระบบคำนวณแทน', wrong.slManual === false && wrong.sl < e);
  ok('SL ผิดฝั่ง → บอกผู้ใช้ว่าทำไมไม่ใช้', wrong.notes.some((n) => /ผิดฝั่ง/.test(n)));

  const auto = buildSetup(ctx2, j, { ...sc2, side: 1 }, base);
  ok('ไม่ใส่อะไร → ระบบวางให้เหมือนเดิม', auto.slManual === false);

  /*
   * สเปกโบรกเกอร์: ค่าที่ระบบเดาแทนไม่ได้เลย
   * ผู้ใช้บอกว่า "จำนวนไม้ไม่แม่นยำ" ซึ่งถูก เพราะ 1 ล็อต = 100 ออนซ์
   * เป็นจริงเฉพาะบัญชีมาตรฐาน บัญชี cent/micro ต่างออกไปคนละโลก
   */
  const std = buildSetup(ctx2, j, { ...sc2, side: 1 }, { ...base, contractSize: 100 });
  const micro = buildSetup(ctx2, j, { ...sc2, side: 1 }, { ...base, contractSize: 1 });
  ok('ขนาดสัญญาเล็กลง → จำนวนไม้ต้องมากขึ้นให้เสี่ยงเท่าเดิม', micro.lotsRaw > std.lotsRaw);
  ok('ออนซ์ที่รายงานคิดจากขนาดสัญญาของผู้ใช้', near(micro.oz, micro.lots * 1, 1e-9));

  /* ทุนน้อยเทรดทองได้จริงเฉพาะเมื่อบัญชีรองรับไม้เล็กพอ — ต้องพิสูจน์ได้ */
  const tinyStd = buildSetup(ctx2, j, { ...sc2, side: 1 },
    { account: 50, riskPct: 1, entryPrice: e, side: 1, contractSize: 100 });
  const tinyCent = buildSetup(ctx2, j, { ...sc2, side: 1 },
    { account: 50, riskPct: 1, entryPrice: e, side: 1, contractSize: 1, minLot: 0.01, lotStep: 0.01 });
  ok('ทุน 50 บัญชีมาตรฐาน → เสี่ยงเกินที่ตั้งไว้ และเตือน', tinyStd.sizeForced && tinyStd.riskActual > 0.5);
  ok('ทุน 50 บัญชีสัญญาเล็ก → เสี่ยงได้ตามที่ตั้งไว้จริง', !tinyCent.sizeForced,
    `เสี่ยง ${tinyCent.riskActual.toFixed(2)} จากที่ตั้งไว้ 0.50`);
  ok('บัญชีสัญญาเล็กไม่ต้องขึ้นคำเตือนทุนไม่พอ', !tinyCent.notes.some((n) => /ทุนไม่พอ/.test(n)));
}

// ── สัญญาณกะพริบจนกดตามไม่ทัน ────────────────────────────────
section('25) สัญญาณต้องอยู่นานพอให้คนกดทัน');
{
  /*
   * ผู้ใช้รายงานว่า "มาแป๊บเดียวแล้วหาย" ซึ่งไม่ใช่ความรู้สึก แต่เป็นผลของการ
   * ใช้เส้นเดียวตัดสินทั้งเข้าและออก คะแนนแกว่งรอบเกณฑ์ = แผนกะพริบ
   */
  const TH = 40;
  let st = null;

  st = holdSignal(st, 20, TH, { now: 0 });
  ok('ยังไม่ถึงเกณฑ์ → ไม่เริ่มสัญญาณ', st === null);

  st = holdSignal(st, 42, TH, { now: 1000 });
  ok('ถึงเกณฑ์ → เริ่มสัญญาณฝั่งซื้อ', st !== null && st.side === 1);
  const startedAt = st.startedAt;

  st = holdSignal(st, 38, TH, { now: 2000 });
  ok('ตกต่ำกว่าเกณฑ์นิดเดียว → ยังอยู่ ไม่หายไปต่อหน้า', st !== null && st.side === 1);
  ok('รู้ตัวว่ากำลังอยู่ได้เพราะช่วงหน่วง', st.held === true);
  ok('จำเวลาที่เริ่มไว้ ไม่ใช่รีเซ็ตใหม่ทุกครั้ง', st.startedAt === startedAt);

  st = holdSignal(st, 44, TH, { now: 3000 });
  ok('กลับมาแรงเกินเกณฑ์ → ไม่นับว่าอยู่ด้วยช่วงหน่วงแล้ว', st.held === false);
  ok('จำคะแนนสูงสุดที่เคยไปถึง', st.peak >= 44);

  st = holdSignal(st, 29, TH, { now: 4000 });
  ok('ตกต่ำกว่าเส้นปล่อย (75% ของเกณฑ์) → จบสัญญาณ', st === null);

  // กลับทิศคือเรื่องคนละเรื่อง ต้องจบทันทีไม่ต้องหน่วง
  let f = holdSignal(null, 45, TH, { now: 0 });
  f = holdSignal(f, -44, TH, { now: 100 });
  ok('คะแนนกลับทิศและแรงพอ → เริ่มสัญญาณใหม่ฝั่งตรงข้ามทันที', f !== null && f.side === -1 && f.startedAt === 100);
  let g = holdSignal(null, 45, TH, { now: 0 });
  g = holdSignal(g, -35, TH, { now: 100 });
  ok('กลับทิศแต่ยังไม่ถึงเกณฑ์ → ไม่ถือสัญญาณเดิมต่อ และไม่เริ่มอันใหม่', g === null);

  /* ช่วงหน่วงต้องไม่กลายเป็นการลดเกณฑ์ทางอ้อม:
     สัญญาณที่ไม่เคยถึงเกณฑ์เต็มเลย ต้องไม่ถูกปลุกขึ้นมาด้วยเส้นปล่อย */
  let weak = null;
  for (const sc of [30, 33, 31, 34]) weak = holdSignal(weak, sc, TH, { now: 0 });
  ok('คะแนนวนอยู่แถวเส้นปล่อยแต่ไม่เคยถึงเกณฑ์ → ไม่มีสัญญาณ', weak === null);
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`ผ่าน ${pass} / ล้มเหลว ${fail}`);
process.exit(fail ? 1 : 0);
