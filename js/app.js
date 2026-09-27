/**
 * app.js — หน้าจอหลัก
 *
 * หน้าที่ของไฟล์นี้มีแค่ "ต่อสาย": ดึงราคา → ส่งให้ system.js ตัดสิน → วาดผลออกมา
 * ไม่มีสูตรคำนวณสัญญาณอยู่ในไฟล์นี้เลย ถ้าเจอตัวเลขตัดสินใจที่นี่ แปลว่าผิดที่
 *
 * ลำดับความสำคัญบนจอ (มือถือ): ตอนนี้ควรทำอะไร → แผน → กราฟ → หลักฐานว่ากติกาได้ผล
 */
import { MarketFeed, mergeCandle } from './feed.js';
import { SOURCES } from './sources.js';
import {
  RULE, COSTS, H4, D1, resample, markClosed, spotBarsOnly, buildSystem, currentState,
  statsOf, sizePlan, planAt,
} from './system.js';
import { REFERENCE } from './reference.js';
import { ema } from './indicators.js';
import { Chart } from './chart.js';
import { AlertCenter } from './alerts.js';
import { buildSignalMessage, buildTestMessage, webhookProblem } from './discord.js';
import { goldMarketOpen, thTime, xauToThaiBaht, nextNFP } from './macro.js';
import { positionStatus, positionAdvice, checkPosition } from './position.js';
import { instrumentOf } from './instrument.js';

const $ = (id) => document.getElementById(id);
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const money = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
const sgn = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '—');
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── ค่าตั้ง ──────────────────────────────────────────────────────────
 * ใช้คีย์เดิมของแอปรุ่นก่อน ทุน ความเสี่ยง สเปกโบรก และไม้ที่บันทึกไว้จึงตามมาด้วย
 * ค่าทุกตัวต้องผ่านการตรวจช่วงก่อนใช้ — ค่าเสียใน localStorage เคยทำให้ระบบพังเงียบมาแล้ว
 */
const LS_SET = 'goldtrader.settings.v1';
const LS_POS = 'goldtrader.position.v1';
const LS_SEEN = 'gsl.v2.alerted';
const DEFAULTS = {
  account: 1000, riskPct: 2, contractSize: 100, minLot: 0.01, lotStep: 0.01, spread: 0.30,
  sides: 'both', source: 'kraken_paxg', apiKey: '', sound: true, theme: 'auto', usdThb: 36.5,
};
const RANGE = {
  account: [1, 1e9], riskPct: [0.1, 10], contractSize: [0.01, 1000], minLot: [0.0001, 100],
  lotStep: [0.0001, 100], spread: [0, 20], usdThb: [10, 100],
};
const settings = loadSettings();

function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(LS_SET) || '{}') || {}; } catch (e) { raw = {}; }
  const out = { ...DEFAULTS };
  for (const [k, [lo, hi]] of Object.entries(RANGE)) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
  }
  if (raw.sides === 'long' || raw.sides === 'both') out.sides = raw.sides;
  if (typeof raw.source === 'string' && (SOURCES[raw.source] || raw.source === 'demo')) out.source = raw.source;
  if (typeof raw.apiKey === 'string') out.apiKey = raw.apiKey;
  if (typeof raw.sound === 'boolean') out.sound = raw.sound;
  if (['auto', 'dark', 'light'].includes(raw.theme)) out.theme = raw.theme;
  return out;
}
function saveSettings() {
  try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch (e) { /* โหมดส่วนตัว */ }
}
const costs = () => ({ spread: settings.spread, slip: COSTS.slip });
const broker = () => ({ contractSize: settings.contractSize, minLot: settings.minLot, lotStep: settings.lotStep });

/* ── สถานะของหน้า ─────────────────────────────────────────────────── */
const state = {
  key: null,        // แหล่งที่ใช้จริงรอบล่าสุด
  baseTf: '4h',     // กรอบที่ดึงสด (แหล่งที่ไม่มี 4 ชม. ใช้ 1 ชม. แล้วรวมเอง)
  base: [],
  d1raw: [],
  h4: [], d1: [],
  sys: null, cur: null,
  price: null,
  loadedAt: 0,
  loading: false,
  error: null,
  tf: '4h',
  firstCalc: true,
  lastAlertKey: null,
};

const feed = new MarketFeed();
const alerts = new AlertCenter();
const chart = new Chart($('chart'));

/* ── โหลดข้อมูล ───────────────────────────────────────────────────── */
async function loadAll() {
  if (state.loading) return;
  state.loading = true;
  setLive('loading', 'กำลังโหลด');
  try {
    feed.stop();
    feed.configure({ source: settings.source, apiKey: settings.apiKey, interval: '4h' });
    let d1raw, base, baseTf;
    if (settings.source === 'demo') {
      /* โหมดจำลอง: สร้างกราฟ 4 ชม. ชุดเดียวแล้วรวมเป็นรายวันเอง
         ถ้าสุ่มสองชุดแยกกัน เทรนด์รายวันจะไม่เกี่ยวกับราคา 4 ชม. เลย */
      base = await feed.loadFrom('demo', '4h', 1300);
      baseTf = '4h';
      d1raw = resample(base, D1);
      feed.activeSource = 'demo';
    } else {
      /* กราฟรายวันเลือกแหล่งที่ใช้ได้ก่อน (ไล่ลองแหล่งสำรองให้) แล้วกราฟ 4 ชม. ต้องมาจากเจ้าเดียวกัน */
      d1raw = await feed.loadHistory('1d', 400);
      const key = feed.activeSource || settings.source;
      const src = SOURCES[key];
      baseTf = !src || src.tf['4h'] !== undefined ? '4h' : '1h';
      base = await feed.loadFrom(key, baseTf, baseTf === '4h' ? 720 : 1000);
    }
    state.key = feed.activeSource || settings.source;
    state.baseTf = baseTf;
    state.base = base.slice();
    state.d1raw = d1raw.slice();
    state.loadedAt = Date.now();
    state.error = null;
    feed.configure({ interval: baseTf });
    feed.start(onCandle, onStatus);
    recompute();
  } catch (e) {
    state.error = e.message || String(e);
    setLive('error', 'โหลดราคาไม่ได้');
    renderError();
  } finally {
    state.loading = false;
  }
}

function onCandle(k) {
  mergeCandle(state.base, k);
  state.price = k.c;
  renderPrice();
  scheduleRecompute();
}
function onStatus(st) {
  if (st.state === 'error') setLive('error', 'เชื่อมต่อสะดุด');
}

let recomputeTimer = null;
function scheduleRecompute() {
  if (recomputeTimer) return;
  recomputeTimer = setTimeout(() => { recomputeTimer = null; recompute(); }, 900);
}

/** เตรียมข้อมูลให้หน้าตาเหมือนทอง spot แล้วส่งให้กติกาตัดสิน */
function recompute() {
  if (!state.base.length) return;
  const now = Date.now();
  const h4src = state.baseTf === '4h' ? state.base : resample(state.base, H4, now);
  state.h4 = spotBarsOnly(markClosed(h4src, H4, now), H4);
  state.d1 = spotBarsOnly(markClosed(state.d1raw, D1, now), D1);
  if (!state.h4.length) return;
  state.sys = buildSystem(state.h4, state.d1);
  state.cur = currentState(state.sys, { costs: costs(), longOnly: settings.sides === 'long' });
  if (state.price === null) state.price = state.base[state.base.length - 1].c;
  renderAll();
  maybeAlert();
  state.firstCalc = false;
}

/* ── ตัวกรองความปลอดภัย: ข้อมูลเก่า ตลาดปิด ─────────────────────────── */
function blocks() {
  const out = [];
  const mk = goldMarketOpen(new Date());
  if (!mk.open) {
    out.push({ key: 'closed', text: `ตลาดทอง spot ปิดอยู่${mk.opensAt ? ` · เปิดอีกครั้ง ${thTime(mk.opensAt)} น.` : ''} — ราคาที่ยังขยับมาจากเหรียญทองที่ซื้อขาย 24 ชม. ซึ่งเป็นคนละตลาดกับที่ส่งคำสั่งได้` });
  }
  const fr = feed.freshness();
  if (!fr.unknown && fr.stale) out.push({ key: 'stale', text: `ราคาไม่อัปเดตมา ${Math.round(fr.ageMs / 1000)} วินาที — ตัวเลขบนจออาจไม่ใช่ราคาตอนนี้ กำลังเชื่อมต่อใหม่` });
  else if (!fr.unknown && fr.frozen && mk.open) out.push({ key: 'frozen', text: `ราคาไม่ขยับเลยมา ${Math.round(fr.moveMs / 60000)} นาที ทั้งที่ยังดึงข้อมูลได้ — แหล่งข้อมูลอาจส่งค่าเดิมซ้ำ ลองเปลี่ยนแหล่งราคาในตั้งค่า` });
  if (settings.source === 'demo') out.push({ key: 'demo', text: 'นี่คือโหมดจำลอง ราคาไม่ใช่ของจริง — ห้ามเทรดตาม' });
  return out;
}

/* ── วาดทุกส่วน ───────────────────────────────────────────────────── */
function renderAll() {
  renderLiveState();
  renderPrice();
  renderDecision();
  renderChart();
  renderLiveRecord();
  renderPosition();
  renderBanner();
}

function setLive(st, text) {
  $('live').dataset.state = st;
  $('liveText').textContent = text;
}
function renderLiveState() {
  const mk = goldMarketOpen(new Date());
  const fr = feed.freshness();
  if (settings.source === 'demo') setLive('demo', 'จำลอง');
  else if (!fr.unknown && fr.stale) setLive('stale', 'ข้อมูลค้าง');
  else if (!mk.open) setLive('closed', 'ตลาดปิด');
  else setLive('live', 'สด');
}

function renderPrice() {
  const px = state.price;
  if (!Number.isFinite(px)) return;
  $('price').textContent = money(px);
  /* เทียบกับราคาปิดของวันทำการล่าสุดของตลาดจริง ไม่ใช่แท่งวันอาทิตย์ของเหรียญทอง */
  const closedD1 = state.d1.filter((b) => b.closed !== false);
  const ref = closedD1.length ? closedD1[closedD1.length - 1].c : null;
  const el = $('priceChg');
  if (ref) {
    const d = px - ref, pct = (d / ref) * 100;
    el.textContent = `${sgn(d)} (${sgn(pct)}%)`;
    el.className = 'chg ' + (d >= 0 ? 'up' : 'down');
  }
  const baht = xauToThaiBaht(px, settings.usdThb);
  $('priceThb').textContent = `≈ ${Math.round(baht).toLocaleString('th-TH')} บาท/บาททองคำ`;
  const inst = instrumentOf(state.key || settings.source, '');
  const src = SOURCES[state.key];
  $('priceSrc').textContent = `${inst ? inst.name : ''}${src ? ' · ' + src.label.split('·')[0].trim() : settings.source === 'demo' ? ' · จำลอง' : ''}`;
  document.title = `${money(px)} · Gold Signal Lab`;
}

/*
 * การ์ดตัดสินใจ — คำตอบเดียวว่าตอนนี้ควรทำอะไร
 * สถานะมาจาก currentState() ซึ่งเดินกติกาเดียวกับทดสอบย้อนหลังมาจนถึงแท่งล่าสุด
 */
function renderDecision() {
  const cur = state.cur, card = $('decision');
  if (!cur) return;
  const sig = cur.signal || {};
  const bl = blocks();
  const hard = bl.filter((b) => b.key !== 'demo');
  const side = cur.trade ? cur.trade.side : sig.side;
  let kind = cur.kind, chip = '', title = '', text = '';
  let plan = null, size = null;

  if (cur.kind === 'entry') {
    plan = planAt(side, state.price, sig.atr, RULE, costs());
    size = sizePlan({ ...plan, account: settings.account, riskPct: settings.riskPct, broker: broker() });
  }

  switch (cur.kind) {
    case 'entry':
      kind = side > 0 ? 'entry-buy' : 'entry-sell';
      chip = side > 0 ? '● สัญญาณซื้อ' : '● สัญญาณขาย';
      title = side > 0 ? 'เข้าซื้อได้ตอนนี้' : 'เข้าขายได้ตอนนี้';
      text = `${side > 0 ? 'เทรนด์ใหญ่ขาขึ้น และราคาย่อลงมาถึงจุดเข้าแล้ว' : 'เทรนด์ใหญ่ขาลง และราคาเด้งขึ้นมาถึงจุดเข้าแล้ว'} · สัญญาณนี้ใช้ได้ถึงแท่ง 4 ชม. ถัดไปปิด`;
      break;
    case 'holding': {
      const t = cur.trade;
      kind = t.side > 0 ? 'holding-buy' : 'holding-sell';
      chip = t.side > 0 ? 'ระบบถือซื้ออยู่' : 'ระบบถือขายอยู่';
      title = 'ระบบอยู่ในไม้แล้ว — ถ้ายังไม่ได้เข้า อย่าไล่ราคา';
      text = `ระบบ${t.side > 0 ? 'ซื้อ' : 'ขาย'}ที่ <b>${f2(t.entry)}</b> เมื่อ ${thTime(t.t)} น. · ตอนนี้ <b>${sgn(t.rNow)}R</b> · ตัดขาดทุน ${f2(t.stop)} · ทำกำไร ${f2(t.target)} · `
        + (t.barsLeft > 0 ? `ถ้าไม่ถึงไหน ระบบจะปิดทิ้งในอีก ${t.barsLeft * 4} ชม. ตลาดเปิด` : 'ครบกำหนดถือ 6 วันแล้ว ระบบจะปิดทิ้งตอนแท่งนี้ปิด');
      break;
    }
    case 'cooldown': {
      const lt = cur.lastTrade;
      chip = 'พักหลังออกไม้';
      title = 'เพิ่งออกไม้ รอให้ครบ 24 ชม. ก่อนหาจังหวะใหม่';
      text = lt ? `ไม้ล่าสุด${lt.side > 0 ? 'ซื้อ' : 'ขาย'} ${lt.why === 'target' ? 'ถึงเป้า' : lt.why === 'stop' ? 'โดนตัดขาดทุน' : 'ปิดเพราะครบเวลา'} <b>${sgn(lt.r)}R</b> · พร้อมหาจังหวะใหม่ประมาณ ${thTime(cur.readyAt)} น.` : '';
      break;
    }
    case 'wait': {
      chip = 'รอราคา' + (sig.trend > 0 ? 'ย่อ' : 'เด้ง');
      const lvl = sig.ema;
      const dist = Number.isFinite(lvl) && Number.isFinite(state.price) ? Math.abs(state.price - lvl) : null;
      title = sig.trend > 0 ? 'เทรนด์ใหญ่ขาขึ้น — รอราคาย่อก่อนซื้อ' : 'เทรนด์ใหญ่ขาลง — รอราคาเด้งก่อนขาย';
      text = `จะเป็นสัญญาณเมื่อแท่ง 4 ชม. <b>ปิด${sig.trend > 0 ? 'ต่ำกว่า' : 'สูงกว่า'} ${f2(lvl)}</b> (เส้นค่าเฉลี่ย 20 แท่ง)${dist !== null ? ` · ตอนนี้ห่างอยู่ ${f2(dist)} ดอลลาร์` : ''}`;
      break;
    }
    case 'no-trend':
      chip = 'ไม่เทรด';
      title = settings.sides === 'long' && sig.trend < 0 ? 'เทรนด์ใหญ่ขาลง — ตั้งไว้ให้เทรดเฉพาะฝั่งซื้อ' : 'เทรนด์ใหญ่ยังไม่ชัด — อยู่เฉย ๆ';
      text = 'ระบบจะเทรดเฉพาะตอนที่กราฟรายวันยืนยันเทรนด์ครบทั้งสองข้อ การไม่เข้าเทรดในช่วงนี้คือส่วนหนึ่งของกติกาที่ทำให้ระบบได้เปรียบ';
      break;
    default:
      chip = 'กำลังเตรียม';
      title = 'ข้อมูลยังไม่พอให้เส้นค่าเฉลี่ยนิ่ง';
      text = 'ต้องมีกราฟรายวันอย่างน้อยราว 60 วันและกราฟ 4 ชม. อย่างน้อย 20 แท่ง';
  }

  /* ด่านตายตัว: ตลาดปิด / ข้อมูลค้าง — สัญญาณกลายเป็นข้อมูลอ้างอิง ไม่ใช่สิ่งที่ให้กด */
  let blockedTrade = false;
  if ((cur.kind === 'entry') && hard.length) { blockedTrade = true; kind = 'blocked'; chip = 'ระงับสัญญาณ'; title = 'มีสัญญาณ แต่ตอนนี้ห้ามเข้า'; }
  /* ทุนไม่พอ = ไม่มีแผนให้กด ไม่ใช่แผนพร้อมป้ายเตือน */
  if (cur.kind === 'entry' && !blockedTrade && size && !size.tradeable) {
    kind = 'blocked'; chip = 'ทุนไม่พอ'; blockedTrade = true;
    title = `มีสัญญาณ${side > 0 ? 'ซื้อ' : 'ขาย'} แต่ไม้เล็กสุดเสี่ยงเกินทุน`;
    text = `ไม้เล็กสุดที่ส่งได้ (${size.lots} ล็อต = ${size.oz.toFixed(2)} ออนซ์) ต้องเสี่ยง <b>${money(size.riskUsd)} ดอลลาร์ = ${size.riskPctActual.toFixed(0)}% ของทุน</b> ซึ่งเกินเพดาน ${size.ceilingPct}%`
      + ` · แพ้ติดกัน ${size.lossesToHalf} ไม้ ทุนหายครึ่ง (ระบบเคยแพ้ติดกัน ${REFERENCE.stats.maxLossStreak} ไม้)`
      + ` · ทุนที่ควรมีสำหรับไม้ขนาดนี้คือ <b>${money(size.capitalFor2pct)} ดอลลาร์</b> หรือใช้บัญชีที่ 1 ล็อต = 1 ออนซ์`;
  }

  card.dataset.kind = kind;
  $('decChip').textContent = chip;
  $('decTitle').textContent = title;
  $('decText').innerHTML = text;
  const capt = cur.kind === 'holding' || cur.kind === 'cooldown' ? '<li class="cap">เงื่อนไขสำหรับไม้ถัดไป</li>' : '';
  $('decChecks').innerHTML = capt + (sig.checks || []).map((c) =>
    `<li class="${c.ok === true ? 'ok' : c.ok === false ? 'no' : 'wait'}">${esc(c.text)}</li>`).join('');
  const bb = $('decBlocks');
  const showBlocks = bl.filter((b) => b.key !== 'demo' || cur.kind === 'entry');
  bb.hidden = !showBlocks.length;
  bb.innerHTML = showBlocks.map((b) => `<p>${esc(b.text)}</p>`).join('');

  // ปุ่มลัด: รอย่อ → ตั้งเตือนราคา · ถือไม้อยู่ → เอาระดับของระบบมาบันทึก
  const act = $('decActions');
  act.innerHTML = '';
  if (cur.kind === 'wait' && Number.isFinite(sig.ema)) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = `เตือนฉันเมื่อราคา${sig.trend > 0 ? 'ลง' : 'ขึ้น'}ถึง ${f2(sig.ema)}`;
    b.onclick = () => {
      alerts.addRule({ type: sig.trend > 0 ? 'price_below' : 'price_above', value: +sig.ema.toFixed(2),
        note: 'ราคาใกล้จุดเข้าแล้ว — ต้องรอให้แท่ง 4 ชม. ปิดเลยเส้นก่อน ถึงจะนับเป็นสัญญาณ' });
      toast('ตั้งเตือนแล้ว — ต้องเปิดหน้านี้ค้างไว้ถึงจะเตือนได้');
      unlockAudio();
    };
    act.appendChild(b);
  }

  const next = cur.nextCloseAt;
  $('decNext').textContent = next ? `แท่ง 4 ชม. ปิดถัดไป ${thClock(next)} น. (${untilText(next)})` : '';

  renderPlan(cur.kind === 'entry' && !blockedTrade ? { plan, size, side } : null);
}

function renderPlan(p) {
  const card = $('planCard');
  card.hidden = !p;
  state.plan = p;
  if (!p) return;
  const { plan, size, side } = p;
  $('planTitle').textContent = side > 0 ? 'แผนซื้อ (Buy)' : 'แผนขาย (Sell)';
  $('planSub').textContent = `ตาม ${RULE.stopAtr}×ATR · เป้า ${RULE.targetR}R`;
  const dStop = Math.abs(plan.entry - plan.stop), dTgt = Math.abs(plan.target - plan.entry);
  $('planGrid').innerHTML = `
    <div class="${side > 0 ? 'buy' : 'sell'}"><span>${side > 0 ? 'ซื้อที่ราคา' : 'ขายที่ราคา'}</span><b>${f2(plan.entry)}</b><small>ราคาตอนนี้</small></div>
    <div class="stop"><span>ตัดขาดทุน</span><b>${f2(plan.stop)}</b><small>ห่าง ${f2(dStop)}</small></div>
    <div class="tgt"><span>ทำกำไร</span><b>${f2(plan.target)}</b><small>ห่าง ${f2(dTgt)}</small></div>`;
  $('planSize').innerHTML = `
    <div>ขนาดไม้ <b>${size.lots} ล็อต</b> (${size.oz.toFixed(2)} ออนซ์)</div>
    <div>ถ้าผิดทาง เสีย <b>${money(size.riskUsd)} ดอลลาร์</b> (${size.riskPctActual.toFixed(1)}% ของทุน) · ถ้าถูกทาง ได้ <b>${money(size.rewardUsd)} ดอลลาร์</b></div>`;
  const w = $('planWarn');
  const warn = [];
  if (size.forced) warn.push(`ทุนน้อยกว่าที่ความเสี่ยง ${settings.riskPct}% จะรองรับ ไม้เล็กสุดจึงเสี่ยง ${size.riskPctActual.toFixed(1)}% แทน`);
  const nfp = nextNFP(new Date());
  if (nfp && nfp - Date.now() < 36 * 3600000 && nfp > Date.now()) warn.push(`ตัวเลขจ้างงานสหรัฐ (NFP) ออก ${thTime(nfp)} น. — ราคาอาจกระโดดข้ามจุดตัดขาดทุน`);
  w.hidden = !warn.length;
  w.innerHTML = warn.map(esc).join('<br>');
}

/* ── กราฟ ─────────────────────────────────────────────────────────── */
function renderChart() {
  if (!state.sys) return;
  const C = getComputedStyle(document.documentElement);
  const brand = C.getPropertyValue('--brand').trim(), accent = C.getPropertyValue('--accent').trim();
  const plan = state.plan ? { side: state.plan.side, entry: state.plan.plan.entry, stop: state.plan.plan.stop, target: state.plan.plan.target } : null;
  const position = readPosition();
  if (state.tf === '4h') {
    const run = state.cur ? state.cur.run : null;
    const trades = run ? [...run.trades, ...(run.open ? [run.open] : [])] : [];
    chart.setData({
      candles: state.h4, tfMs: H4, plan, position, trades,
      lines: [{ values: state.sys.ema, color: brand, label: 'EMA20', width: 1.8 }],
    });
    $('chartLegend').innerHTML = `<span><i style="background:${brand}"></i>เส้นค่าเฉลี่ย 20 แท่ง (จุดเข้า)</span>`;
  } else {
    const c = state.d1.map((b) => b.c);
    chart.setData({
      candles: state.d1, tfMs: D1, plan: null, position, trades: [],
      lines: [
        { values: ema(c, RULE.trendFast), color: brand, label: 'EMA20', width: 1.8 },
        { values: ema(c, RULE.trendSlow), color: accent, label: 'EMA50', width: 1.8 },
      ],
    });
    $('chartLegend').innerHTML = `<span><i style="background:${brand}"></i>เส้น 20 วัน</span><span><i style="background:${accent}"></i>เส้น 50 วัน</span>`;
  }
}

/* ── ผลบนข้อมูลสด: ไม้ล่าสุดของระบบ ─────────────────────────────────── */
function renderLiveRecord() {
  const run = state.cur && state.cur.run;
  if (!run) return;
  const trades = run.trades;
  const days = state.h4.length ? Math.round((state.h4[state.h4.length - 1].t - state.h4[0].t) / D1) : 0;
  $('liveSub').textContent = `บนข้อมูลที่โหลดมา ${days} วัน`;
  const st = statsOf(trades);
  let html = '';
  if (run.open) {
    const t = run.open;
    html += `<div class="note info">ตอนนี้ระบบ<b>${t.side > 0 ? 'ถือซื้อ' : 'ถือขาย'}</b>อยู่ที่ ${f2(t.entry)} · ${sgn(t.rNow)}R</div>`;
  }
  if (!st.n) {
    html += '<p class="muted small">ช่วงข้อมูลที่โหลดมายังไม่มีไม้ที่ปิดแล้ว — ระบบนี้เทรดราว 3-4 ไม้ต่อเดือนเท่านั้น</p>';
  } else {
    html += `<p class="small muted">${st.n} ไม้ · ชนะ ${st.win.toFixed(0)}% · รวม ${sgn(st.totalR)}R — ตัวอย่างแค่นี้ยังสรุปอะไรไม่ได้ ใช้ดูว่าระบบทำงานถูกต้อง ไม่ใช่วัดฝีมือ</p>`;
    html += '<table><thead><tr><th>เข้าเมื่อ</th><th>ฝั่ง</th><th>ออกเพราะ</th><th style="text-align:right">ผล</th></tr></thead><tbody>'
      + trades.slice(-8).reverse().map((t) => `<tr><td>${thTime(t.t)}</td><td><span class="tag ${t.side > 0 ? 'buy' : 'sell'}">${t.side > 0 ? 'ซื้อ' : 'ขาย'}</span></td>`
        + `<td>${t.why === 'target' ? 'ถึงเป้า' : t.why === 'stop' ? 'ตัดขาดทุน' : 'ครบเวลา'}</td><td class="num ${t.r > 0 ? 'up' : 'down'}">${sgn(t.r)}R</td></tr>`).join('')
      + '</tbody></table>';
  }
  $('liveRecord').innerHTML = html;
}

/* ── ผลอ้างอิง 4 ปี (วาดครั้งเดียว) ───────────────────────────────── */
function renderReference() {
  const R = REFERENCE, S = R.stats;
  const thYear = (d) => { const [y, m] = d.split('-'); return `${['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'][+m - 1]} ${+y + 543}`; };
  $('refPeriod').textContent = `${thYear(R.from)} – ${thYear(R.to)} · ${S.n} ไม้`;
  $('refKpis').innerHTML = [
    { k: 'กำไรรวม', v: `${sgn(S.totalR, 1)}R`, s: 'หลังหักค่าสเปรด', cls: 'good' },
    { k: 'ได้เฉลี่ยต่อไม้', v: `${sgn(S.avgR)}R`, s: `โอกาสเป็นบวกจริง ${(S.pPos * 100).toFixed(1)}%`, cls: 'good' },
    { k: 'อัตราชนะ', v: `${S.win.toFixed(0)}%`, s: `ช่วงที่เป็นไปได้ ${S.ciLow.toFixed(0)}–${S.ciHigh.toFixed(0)}%` },
    { k: 'แพ้ติดกันมากสุด', v: `${S.maxLossStreak} ไม้`, s: `ติดลบลึกสุด ${S.maxDD.toFixed(1)}R`, cls: 'bad' },
  ].map((x) => `<div class="kpi ${x.cls || ''}"><span>${x.k}</span><b>${x.v}</b><small>${x.s}</small></div>`).join('');

  // เส้นกำไรสะสม (หน่วย R)
  const pts = [0, ...R.trades.reduce((a, t) => { a.push((a.length ? a[a.length - 1] : 0) + t[2]); return a; }, [])];
  const W = 600, Hh = 150, lo = Math.min(...pts), hi = Math.max(...pts);
  const X = (i) => (i / (pts.length - 1)) * W, Y = (v) => Hh - 8 - ((v - lo) / (hi - lo || 1)) * (Hh - 16);
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  $('refCurve').innerHTML = `<p class="cap">กำไรสะสมทีละไม้ (หน่วยเป็นเท่าของเงินที่เสี่ยง)</p>
    <svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="กราฟกำไรสะสม">
      <line x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--line-2)" stroke-dasharray="4 4"/>
      <path d="${path} L${W},${Hh} L0,${Hh} Z" fill="var(--up-soft)"/>
      <path d="${path}" fill="none" stroke="var(--up)" stroke-width="2.2" stroke-linejoin="round"/>
    </svg>`;

  $('refYears').innerHTML = `<p class="cap">แยกรายปี</p><div class="year-grid">${R.byYear.map((y) => `
    <div class="year"><span>${y.year + 543}</span><b class="${y.avgR >= 0 ? 'up' : 'down'}">${sgn(y.avgR)}R</b><small>${y.n} ไม้<br>ชนะ ${y.win.toFixed(0)}%</small></div>`).join('')}</div>`;

  const sell = R.bySide.find((s) => s.side === 'sell'), buy = R.bySide.find((s) => s.side === 'buy');
  $('refExplain').innerHTML = `
    <p><b>ชนะไม่ถึงครึ่ง แต่ได้กำไร</b> — เพราะตอนชนะได้ ${RULE.targetR} เท่าของตอนแพ้ ระบบนี้ต้องชนะแค่ราว 35% ก็เท่าทุนแล้ว ไม่มีระบบไหนชนะทุกไม้</p>
    <p><b>ต้องทนช่วงแย่ให้ได้</b> — ${S.monthsNegative} จาก ${S.monthsTraded} เดือนเป็นเดือนขาดทุน และเคยนานถึง ${S.longestFlatDays} วันกว่าจะทำกำไรสูงสุดใหม่ ถ้าหยุดกลางทาง จะได้แต่ส่วนที่ขาดทุน</p>
    <p><b>เทรดน้อย</b> — เฉลี่ย ${S.perMonth.toFixed(1)} ไม้ต่อเดือน ถือไม้ละ ~${Math.round(S.avgHoldBars * 4 / 24 * 10) / 10} วัน</p>
    <p><b>ฝั่งซื้อเป็นตัวทำเงิน</b> — ซื้อ ${buy.n} ไม้ ${sgn(buy.avgR)}R ต่อไม้ · ขาย ${sell.n} ไม้ ${sgn(sell.avgR)}R ต่อไม้ (4 ปีนี้ทองขึ้นแรง ฝั่งขายยังไม่มีหลักฐานว่าได้เปรียบ)</p>
    <p class="muted">ข้อมูล: ${esc(R.source)} · ค่าสเปรด $${R.costs.spread} + สลิปเพจ $${R.costs.slip} ต่อไม้ · ผลในอดีต ไม่ใช่คำสัญญาของอนาคต ให้คาดไว้ต่ำกว่านี้</p>`;

  $('refCompare').innerHTML = '<table><thead><tr><th>วิธี</th><th style="text-align:right">ไม้</th><th style="text-align:right">ต่อไม้</th></tr></thead><tbody>'
    + R.compare.map((c) => `<tr><td>${esc(c.label)}<br><span class="muted small">${esc(c.note)}</span></td><td class="num">${c.n}</td><td class="num ${c.avgR >= 0 ? 'up' : 'down'}">${sgn(c.avgR, 3)}R</td></tr>`).join('')
    + '</tbody></table><p class="muted small">ระบบเดิมขาดทุนเพราะไม่สนเทรนด์ใหญ่ — เปิดขายสวนตลาดขาขึ้น 1,927 ครั้ง เสียไป 176R และกราฟ 15 นาทีค่าสเปรดกินกำไรหมด</p>';

  const all = R.robust.flatMap((g) => g.rows);
  $('refRobust').innerHTML = `<p class="small">เปลี่ยนค่าทีละอย่าง ${all.length} แบบ: <b>กำไร ${all.filter((r) => r.avgR > 0).length} แบบ</b> · กำไรทุกปี ${all.filter((r) => r.allYears).length} แบบ — ถ้ากำไรมาจากค่าที่บังเอิญเข้าล็อกพอดี เปลี่ยนนิดเดียวผลจะพัง</p>`
    + R.robust.map((g) => `<p class="small" style="margin:10px 0 4px"><b>${esc(g.group)}</b></p><table><tbody>${g.rows.map((r) =>
      `<tr><td>${esc(r.label)}</td><td class="num">${r.n} ไม้</td><td class="num ${r.avgR >= 0 ? 'up' : 'down'}">${sgn(r.avgR, 3)}R</td><td class="small muted">${r.allYears ? 'กำไรทุกปี' : ''}</td></tr>`).join('')}</tbody></table>`).join('');

  $('refTrades').innerHTML = '<table><thead><tr><th>เข้าเมื่อ</th><th>ฝั่ง</th><th>ออกเพราะ</th><th style="text-align:right">ผล</th></tr></thead><tbody>'
    + R.trades.slice().reverse().map(([t, side, r, why]) => `<tr><td>${thTime(t)}</td><td><span class="tag ${side > 0 ? 'buy' : 'sell'}">${side > 0 ? 'ซื้อ' : 'ขาย'}</span></td>`
      + `<td>${why === 'p' ? 'ถึงเป้า' : why === 's' ? 'ตัดขาดทุน' : 'ครบเวลา'}</td><td class="num ${r > 0 ? 'up' : 'down'}">${sgn(r)}R</td></tr>`).join('')
    + '</tbody></table>';
  $('sidesHelp').textContent = `ใน 4 ปีที่ทดสอบ ฝั่งซื้อ ${buy.n} ไม้ ${sgn(buy.avgR)}R/ไม้ · ฝั่งขาย ${sell.n} ไม้ ${sgn(sell.avgR)}R/ไม้ — เลือก "เฉพาะฝั่งซื้อ" ถ้าอยากเทรดน้อยลงและใช้เฉพาะฝั่งที่มีหลักฐาน`;
}

/* ── ไม้ของฉัน ───────────────────────────────────────────────────── */
function readPosition() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(LS_POS) || 'null'); } catch (e) { raw = null; }
  if (!raw || checkPosition(raw).length) return null;
  return raw;
}
function writePosition(p) {
  try { p ? localStorage.setItem(LS_POS, JSON.stringify(p)) : localStorage.removeItem(LS_POS); } catch (e) { /* เขียนไม่ได้ */ }
}
let posSide = 1;
function renderPosition() {
  const p = readPosition();
  const out = $('posOut');
  if (!p) { out.innerHTML = ''; return; }
  const st = positionStatus(p, state.price, settings.account);
  if (!st.ok) { out.innerHTML = `<p class="small">${esc(st.problems.join(' · '))}</p>`; return; }
  const adv = positionAdvice(st);
  out.innerHTML = `
    <div class="small muted">${p.side > 0 ? 'ซื้อ' : 'ขาย'} ${p.size} ล็อต ที่ ${f2(p.entry)}</div>
    <div class="pos-pl ${st.pl >= 0 ? 'up' : 'down'}">${st.pl >= 0 ? '+' : ''}${money(st.pl)} <span class="small">USD</span></div>
    <div class="pos-line">${st.r !== null ? `${sgn(st.r)}R · ` : ''}${st.plPct !== null ? `${sgn(st.plPct)}% ของทุน` : ''}</div>
    ${st.progress !== null ? `<div class="bar"><i style="left:${(st.progress * 100).toFixed(1)}%"></i></div>
      <div class="bar-labels"><span>SL ${f2(p.sl)}</span><span>TP ${f2(p.tp)}</span></div>` : ''}
    <p class="pos-line">${esc(adv.text)}</p>`;
}
function fillPositionForm(p) {
  posSide = p ? p.side : 1;
  document.querySelectorAll('#posForm .seg button').forEach((b) => b.classList.toggle('on', +b.dataset.side === posSide));
  $('posEntry').value = p ? p.entry : '';
  $('posSL').value = p && p.sl ? p.sl : '';
  $('posTP').value = p && p.tp ? p.tp : '';
  $('posSize').value = p ? p.size : settings.minLot;
}

/* ── แจ้งเตือน ────────────────────────────────────────────────────── */
function seenKeys() {
  try { return JSON.parse(localStorage.getItem(LS_SEEN) || '[]'); } catch (e) { return []; }
}
function maybeAlert() {
  const cur = state.cur;
  if (!cur || cur.kind !== 'entry') return;
  const side = cur.trade ? cur.trade.side : cur.signal.side;
  const barT = state.h4[cur.closedIndex] ? state.h4[cur.closedIndex].t : 0;
  const key = `${barT}:${side}`;
  const seen = seenKeys();
  if (seen.includes(key)) return;
  try { localStorage.setItem(LS_SEEN, JSON.stringify([key, ...seen].slice(0, 50))); } catch (e) { /* ignore */ }
  /* สัญญาณที่ค้างอยู่ตั้งแต่ก่อนเปิดหน้า ไม่ต้องส่งเสียง — ผู้ใช้เห็นบนจออยู่แล้ว */
  if (state.firstCalc) return;
  const hard = blocks().filter((b) => b.key !== 'demo');
  if (hard.length || settings.source === 'demo') return;
  const plan = planAt(side, state.price, cur.signal.atr, RULE, costs());
  const size = sizePlan({ ...plan, account: settings.account, riskPct: settings.riskPct, broker: broker() });
  const inst = instrumentOf(state.key, '');
  const title = size.tradeable ? `${side > 0 ? '🟢 สัญญาณซื้อ' : '🔴 สัญญาณขาย'}ทองคำ` : 'มีสัญญาณ แต่ทุนไม่พอสำหรับไม้นี้';
  const body = size.tradeable
    ? `เข้า ${f2(plan.entry)} · ตัดขาดทุน ${f2(plan.stop)} · ทำกำไร ${f2(plan.target)} · ${size.lots} ล็อต`
    : `ไม้เล็กสุดเสี่ยง ${money(size.riskUsd)} ดอลลาร์ = ${size.riskPctActual.toFixed(0)}% ของทุน`;
  alerts.sound = settings.sound;
  alerts.fire({
    kind: side > 0 ? 'buy' : 'sell', title, body, price: state.price,
    discord: buildSignalMessage({
      action: size.tradeable ? (side > 0 ? 'buy' : 'sell') : 'nocap', price: state.price,
      instrument: inst ? inst.name : 'ทองคำ', plan: size.tradeable ? plan : null, size: size.tradeable ? size : null,
      checks: cur.signal.checks, notes: size.tradeable ? [] : [body], stats: REFERENCE.stats,
    }),
  });
}

/* ── แบนเนอร์ / ข้อผิดพลาด ───────────────────────────────────────── */
function renderBanner() {
  const b = $('banner');
  const msgs = [];
  if (feed.fellBackFrom && SOURCES[feed.fellBackFrom] && SOURCES[state.key]) {
    msgs.push(`ดึงราคาจาก ${SOURCES[feed.fellBackFrom].label} ไม่ได้ จึงใช้ ${SOURCES[state.key].label} แทนชั่วคราว`);
  }
  if (settings.source === 'demo') msgs.push('โหมดจำลอง — ราคาในหน้านี้ไม่ใช่ราคาจริง ใช้ดูว่าหน้าจอทำงานยังไงเท่านั้น');
  b.hidden = !msgs.length;
  b.className = 'banner';
  b.textContent = msgs.join(' · ');
}
function renderError() {
  const card = $('decision');
  card.dataset.kind = 'blocked';
  $('decChip').textContent = 'ต่อราคาไม่ได้';
  $('decTitle').textContent = 'ดึงราคาทองไม่ได้เลยสักแหล่ง';
  $('decText').textContent = 'มักเกิดจากเน็ตหลุด หรือเครือข่ายบล็อกเว็บราคาคริปโต ระบบจะลองใหม่เองทุก 30 วินาที';
  $('decChecks').innerHTML = '';
  $('decBlocks').hidden = false;
  $('decBlocks').innerHTML = `<p>${esc(state.error).replace(/\n/g, '<br>')}</p>`;
  const act = $('decActions');
  act.innerHTML = '';
  const retry = document.createElement('button');
  retry.className = 'btn primary'; retry.textContent = 'ลองใหม่ตอนนี้'; retry.onclick = () => loadAll();
  const demo = document.createElement('button');
  demo.className = 'btn'; demo.textContent = 'ดูแบบจำลองไปก่อน';
  demo.onclick = () => { settings.source = 'demo'; saveSettings(); loadAll(); };
  act.append(retry, demo);
  $('planCard').hidden = true;
  const b = $('banner');
  b.hidden = false; b.className = 'banner bad';
  b.textContent = 'ยังไม่มีราคาจริง — ตัวเลขทุกตัวในหน้านี้ยังใช้ไม่ได้';
}

/* ── ตั้งค่า ──────────────────────────────────────────────────────── */
function openSettings() {
  $('setAccount').value = settings.account;
  $('setRisk').value = settings.riskPct;
  $('setContract').value = String(settings.contractSize);
  if ($('setContract').value !== String(settings.contractSize)) {
    const o = document.createElement('option'); o.value = String(settings.contractSize); o.textContent = `${settings.contractSize} ออนซ์`;
    $('setContract').appendChild(o); $('setContract').value = String(settings.contractSize);
  }
  $('setMinLot').value = settings.minLot;
  $('setLotStep').value = settings.lotStep;
  $('setSpread').value = settings.spread;
  $('setSides').value = settings.sides;
  $('setUsdThb').value = settings.usdThb;
  const sel = $('setSource');
  sel.innerHTML = Object.entries(SOURCES).map(([k, s]) => `<option value="${k}">${esc(s.label)}${s.needsKey ? ' (ต้องมีคีย์)' : ''}</option>`).join('')
    + '<option value="demo">โหมดจำลอง (ไม่ใช่ราคาจริง)</option>';
  sel.value = settings.source;
  $('setApiKey').value = settings.apiKey;
  syncSourceHelp();
  $('setSound').checked = settings.sound;
  $('setDesktop').checked = alerts.desktop;
  $('setWebhook').value = alerts.webhookUrl;
  $('setTheme').value = settings.theme;
  $('settings').showModal();
}
function syncSourceHelp() {
  const k = $('setSource').value, s = SOURCES[k];
  $('apiKeyRow').hidden = !(s && s.needsKey);
  $('sourceHelp').textContent = s ? s.note : 'ราคาสุ่มขึ้นมาเพื่อดูว่าหน้าจอทำงานอย่างไร ห้ามใช้ตัดสินใจเทรด';
}
function saveFromForm() {
  const num = (id, key) => {
    const v = Number(String($(id).value).replace(/,/g, ''));
    const [lo, hi] = RANGE[key];
    if (Number.isFinite(v) && v >= lo && v <= hi) settings[key] = v;
  };
  num('setAccount', 'account'); num('setRisk', 'riskPct'); num('setContract', 'contractSize');
  num('setMinLot', 'minLot'); num('setLotStep', 'lotStep'); num('setSpread', 'spread'); num('setUsdThb', 'usdThb');
  settings.sides = $('setSides').value === 'long' ? 'long' : 'both';
  const prevSource = settings.source, prevKey = settings.apiKey;
  settings.source = $('setSource').value;
  settings.apiKey = $('setApiKey').value.trim();
  settings.sound = $('setSound').checked;
  settings.theme = $('setTheme').value;
  alerts.webhookUrl = $('setWebhook').value.trim();
  alerts.save();
  saveSettings();
  applyTheme();
  if (settings.source !== prevSource || settings.apiKey !== prevKey) loadAll(); else recompute();
  toast('บันทึกแล้ว');
}
function applyTheme() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  chart.setTheme();
  renderReference();
  if (state.sys) renderChart();
}

/* ── เบ็ดเตล็ด ────────────────────────────────────────────────────── */
let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function thClock(t) {
  const d = new Date(t + 7 * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function untilText(t) {
  const m = Math.max(0, Math.round((t - Date.now()) / 60000));
  if (m < 60) return `อีก ${m} นาที`;
  return `อีก ${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
}
/* เบราว์เซอร์บนมือถือไม่ยอมเล่นเสียงจนกว่าผู้ใช้จะแตะจอ — ปลดล็อกไว้ตั้งแต่แตะครั้งแรก */
function unlockAudio() {
  try {
    alerts.audioCtx = alerts.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (alerts.audioCtx.state === 'suspended') alerts.audioCtx.resume();
  } catch (e) { /* ไม่มีเสียงก็ข้าม */ }
}

function bind() {
  $('btnSettings').onclick = openSettings;
  $('setSource').onchange = syncSourceHelp;
  $('setForm').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'save') saveFromForm();
  });
  $('setDesktop').onchange = async (e) => {
    if (e.target.checked) {
      const r = await alerts.requestDesktopPermission();
      if (r !== 'granted') { e.target.checked = false; toast('เบราว์เซอร์ไม่อนุญาตให้แจ้งเตือน'); }
    } else { alerts.desktop = false; alerts.save(); }
  };
  $('btnTestWebhook').onclick = async () => {
    alerts.webhookUrl = $('setWebhook').value.trim();
    const problem = webhookProblem(alerts.webhookUrl);
    if (problem) { $('webhookStatus').textContent = problem; return; }
    $('webhookStatus').textContent = 'กำลังส่ง…';
    const r = await alerts.testWebhook(buildTestMessage());
    $('webhookStatus').textContent = r.ok ? 'ส่งสำเร็จ — ไปดูข้อความในห้อง Discord ได้เลย' : `ส่งไม่สำเร็จ: ${r.reason}`;
    alerts.save();
  };

  document.querySelectorAll('#tfSeg button').forEach((b) => {
    b.onclick = () => {
      state.tf = b.dataset.tf;
      document.querySelectorAll('#tfSeg button').forEach((x) => x.classList.toggle('on', x === b));
      chart.reset(state.tf === '4h' ? 90 : 120);
      renderChart();
    };
  });
  chart.onView = (away) => { $('btnLatest').hidden = !away; };
  $('btnLatest').onclick = () => chart.reset();

  $('btnCopyPlan').onclick = async () => {
    if (!state.plan) return;
    const { plan, size, side } = state.plan;
    const text = `${side > 0 ? 'BUY' : 'SELL'} XAUUSD ${size.lots} lot @ ${f2(plan.entry)} | SL ${f2(plan.stop)} | TP ${f2(plan.target)}`;
    try { await navigator.clipboard.writeText(text); toast('คัดลอกแล้ว'); } catch (e) { toast(text); }
  };
  $('btnSavePlan').onclick = () => {
    if (!state.plan) return;
    const { plan, size, side } = state.plan;
    const p = { side, entry: +plan.entry.toFixed(2), sl: +plan.stop.toFixed(2), tp: +plan.target.toFixed(2),
      size: size.lots, contractSize: settings.contractSize, openedAt: Date.now(), note: 'จากแผนของระบบ' };
    writePosition(p); fillPositionForm(p); renderPosition(); renderChart();
    toast('บันทึกเป็นไม้ของคุณแล้ว');
    $('posCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  document.querySelectorAll('#posForm .seg button').forEach((b) => {
    b.onclick = () => { posSide = +b.dataset.side; document.querySelectorAll('#posForm .seg button').forEach((x) => x.classList.toggle('on', x === b)); };
  });
  $('posForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = (id) => Number(String($(id).value).replace(/,/g, '')) || 0;
    const p = { side: posSide, entry: n('posEntry'), sl: n('posSL'), tp: n('posTP'), size: n('posSize'),
      contractSize: settings.contractSize, openedAt: Date.now(), note: '' };
    const bad = checkPosition(p);
    if (bad.length) { toast(bad[0]); return; }
    writePosition(p); renderPosition(); renderChart(); toast('บันทึกไม้แล้ว');
  });
  $('posClear').onclick = () => { writePosition(null); fillPositionForm(null); renderPosition(); renderChart(); };

  window.addEventListener('resize', () => chart.resize());
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => chart.resize()).observe($('chart'));
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('visibilitychange', () => {
    /* มือถือพักจอแล้วกลับมา = จังหวะที่ข้อมูลค้างบ่อยที่สุด โหลดใหม่ทั้งชุด */
    if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > 60000) loadAll();
  });
  if (matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme());
}

/* ── เริ่มทำงาน ───────────────────────────────────────────────────── */
bind();
applyTheme();
fillPositionForm(readPosition());
chart.resize();
loadAll();
setInterval(() => { if (state.error) loadAll(); }, 30000);
setInterval(() => { if (!state.error && Date.now() - state.loadedAt > 180000) loadAll(); }, 30000);
setInterval(() => {
  alerts.checkRules({ price: state.price });
  if (state.cur) { renderLiveState(); renderDecision(); }
}, 15000);

/* เปิดให้ตรวจอาการจากคอนโซลได้: __gsl.state, __gsl.feed.freshness() */
window.__gsl = { state, settings, feed, chart, recompute, loadAll, renderAll };
