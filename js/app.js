/**
 * app.js — ตัวเชื่อมทุกส่วนเข้าด้วยกัน: ข้อมูลสด → วิเคราะห์ → กราฟ/เหตุผล → แจ้งเตือน
 */

import { MarketFeed, TF, mergeCandle } from './feed.js';
import { buildContext, scoreAt, buildSetup, combineTimeframes, explain, scoreLabel, DEFAULT_CFG, WEIGHTS } from './signals.js';
import { runBacktest, walkForward, optimizeExits, probabilityFor, wilsonInterval, sessionBucketAt } from './backtest.js';
import { learnAndValidate } from './learn.js';
import { autoTune, explainAdaptation } from './adapt.js';
import { Chart } from './chart.js';
import { AlertCenter } from './alerts.js';
import { sessionInfo, riskWindow, nextNFP, thTime, xauToThaiBaht } from './macro.js';
import { levelsAt, fibLevels } from './levels.js';
import { narrate, narrateShort } from './narrate.js';
import { Tour } from './tour.js';
import { toThai } from './glossary.js';
import { instrumentOf, dataHealth } from './instrument.js';

const $ = (id) => document.getElementById(id);
const LS_SETTINGS = 'goldtrader.settings.v1';

const state = {
  tf: '15m',
  candles: [],
  ctx: null,
  scored: null,
  combined: null,
  setup: null,
  action: 'wait',
  htf: {},          // { '1h': {candles, ctx, scored} }
  bt: null,
  lastAnalyze: 0,
  lastClosedT: null,
  htfTimer: null,
  warnedAt: 0,          // เตือนล่วงหน้าครั้งล่าสุดเมื่อไร
  warnedSide: 0,
  narrationOpen: true,
  planDetailsOpen: false,
  analyzeTimer: null,
  events: [],
  prevClose: null,
  reasonTab: 'pro',
};

const settings = {
  source: 'binance', symbol: 'PAXGUSDT', tf: '15m', htf1: '1h', htf2: '4h',
  threshold: 35, slAtr: 1.5, adxMin: 22,
  account: 1000, riskPct: 1,
  newsFilter: true, volFilter: true, sessionFilter: false,
  usdThb: 36.5, apiKey: '',
  alertMode: 'early', maxHold: 60, spread: 0.30, simpleMode: true,
  smartSession: true, historyBars: 3000,
  learnedWeights: null,   // น้ำหนักที่ผ่านการพิสูจน์กับข้อมูลนอกช่วงเรียนรู้แล้วเท่านั้น
  adaptParams: null,      // ค่าที่ระบบจูนเองจากตลาดที่โหลดมา (คะแนน/SL/เป้า)
};

const feed = new MarketFeed();
const alerts = new AlertCenter();
let chart, equityCtx;

// ── ตั้งค่า ──────────────────────────────────────────────────────────────
function loadSettings() {
  try { Object.assign(settings, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); } catch (e) { /* ค่าเริ่มต้น */ }
  try { state.events = JSON.parse(localStorage.getItem('goldtrader.events') || '[]'); } catch (e) { state.events = []; }
}
function saveSettings() {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) { /* ignore */ }
}
function saveEvents() {
  try { localStorage.setItem('goldtrader.events', JSON.stringify(state.events)); } catch (e) { /* ignore */ }
}
function cfg() {
  const base = { ...DEFAULT_CFG, slAtrMult: settings.slAtr, threshold: settings.threshold, adxTrendMin: settings.adxMin };
  // ใส่น้ำหนักที่เรียนรู้มาก็ต่อเมื่อ "ครบทุกปัจจัย" เท่านั้น
  // ถ้าใส่ไม่ครบ ปัจจัยที่ขาดจะกลายเป็น undefined แล้วคะแนนทั้งระบบพังเป็น NaN เงียบ ๆ
  const lw = settings.learnedWeights;
  if (lw && Object.keys(WEIGHTS).every((k) => Number.isFinite(lw[k]))) base.weights = lw;
  return base;
}

/**
 * เป้าหมายที่ใช้จริง
 * ค่าที่ระบบศึกษาตลาดแล้วจูนเองมาก่อน เพราะมันถูกวัดผลกับหลายช่วงเวลา
 * ส่วน optimizeExits วัดกับการแบ่งครั้งเดียว จึงเป็นตัวสำรอง
 */
function activeTargetR() {
  if (settings.adaptParams && Number.isFinite(settings.adaptParams.targetR)) return settings.adaptParams.targetR;
  return state.opt && state.opt.ok ? state.opt.best.targetR : null;
}

// ── เริ่มระบบ ────────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  state.tf = settings.tf;
  chart = new Chart($('chart'));
  equityCtx = $('equityCanvas').getContext('2d');
  buildStaticUI();
  bindEvents();
  window.addEventListener('resize', () => { chart.resize(); drawEquity(); });
  chart.resize();
  alerts.onUpdate = (entry) => { renderLog(); toast(entry); };
  renderAlertUI();
  renderWeights();
  renderLearn();   // ถ้าเคยยืนยันน้ำหนักชุดใหม่ไว้ ต้องบอกให้เห็นตั้งแต่เปิดหน้า
  renderAdapt();
  renderContextTab();
  setInterval(renderContextTab, 30000);
  setInterval(tickCountdown, 1000);
  setInterval(checkFreshness, 5000);
  /*
   * ที่จับสำหรับตรวจสอบและทดสอบ
   *
   * เหตุผลที่ยอมเปิดออกมา: ตัวจับ "ราคาค้าง" เป็นกลไกความปลอดภัย ถ้าทดสอบไม่ได้
   * มันจะพังเงียบ ๆ วันหนึ่งโดยไม่มีใครรู้ ซึ่งแย่กว่าการไม่มีเลย
   * ไม่ได้เปิดอะไรใหม่ให้ใคร — API key อยู่ใน localStorage ซึ่งเปิดคอนโซลก็เห็นอยู่แล้ว
   *
   * ผู้ใช้ทั่วไปใช้ตรวจอาการได้: เปิดคอนโซลแล้วพิมพ์ __gsl.feed.freshness()
   */
  window.__gsl = { feed, state, settings, checkFreshness, analyze };
  /*
   * มือถือพักจอแล้วกลับมา เป็นจังหวะที่ข้อมูลค้างบ่อยที่สุด
   * ต้องเช็กทันทีที่กลับมาดู ไม่ใช่รอรอบถัดไปอีก 5 วินาที
   */
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkFreshness(true); });
  window.addEventListener('online', () => checkFreshness(true));
  await reload();

  // คนเปิดครั้งแรกยังไม่รู้ว่าต้องมองตรงไหน พาชมให้รอบหนึ่งก่อน
  if (!Tour.seen()) setTimeout(() => new Tour().start(), 1200);
}

function buildStaticUI() {
  const tfs = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  $('tfGroup').innerHTML = tfs.map((t) => `<button class="tf-btn${t === state.tf ? ' active' : ''}" data-tf="${t}">${t}</button>`).join('');
  const opts = tfs.map((t) => `<option value="${t}">${t} — ${TF[t].label}</option>`).join('');
  $('setHtf1').innerHTML = opts; $('setHtf2').innerHTML = opts;
  $('setHtf1').value = settings.htf1; $('setHtf2').value = settings.htf2;
  $('sourceSel').value = settings.source;
  $('symbolSel').value = settings.symbol;
  $('accountInput').value = settings.account;
  $('riskInput').value = settings.riskPct;
  $('thresholdInput').value = settings.threshold;
  $('setThreshold').value = settings.threshold;
  $('setSlAtr').value = settings.slAtr;
  $('setAdx').value = settings.adxMin;
  $('setUsdThb').value = settings.usdThb;
  $('setApiKey').value = settings.apiKey;
  $('maxHoldInput').value = settings.maxHold;
  $('spreadInput').value = settings.spread;
  $('setNewsFilter').checked = settings.newsFilter;
  $('setVolFilter').checked = settings.volFilter;
  $('setSessionFilter').checked = settings.sessionFilter;
  $('setSmartSession').checked = settings.smartSession !== false;
  $('historyBars').value = String(settings.historyBars || 3000);
  $('alertMode').value = settings.alertMode || 'early';
  setMode(settings.simpleMode !== false);
}

/**
 * โหมดง่าย = ซ่อนทุกอย่างที่ไม่จำเป็นสำหรับคนเปิดครั้งแรก
 * เหลือแค่ ราคา · กราฟ · "ตอนนี้ควรทำอะไร" · คำอธิบายกราฟ
 * คนที่อยากดูละเอียดค่อยกดเปิดโหมดเต็มเอง
 */
function setMode(simple) {
  settings.simpleMode = simple;
  saveSettings();
  document.body.classList.toggle('simple', simple);
  if (chart) {
    // โหมดง่ายเหลือกราฟราคาอย่างเดียว แผง RSI/MACD เป็นของคนที่อ่านเป็นแล้ว
    chart.panels.rsi = simple ? false : $('togRSI').checked;
    chart.panels.macd = simple ? false : $('togMACD').checked;
    chart.showBB = simple ? false : $('togBB').checked;
  }
  $('modeToggle').textContent = simple ? '🔧 โหมดเต็ม' : '🙂 โหมดง่าย';
  $('modeToggle').title = simple
    ? 'เปิดผลทดสอบย้อนหลัง ตั้งค่า และตัวชี้วัดทั้งหมด'
    : 'ซ่อนเครื่องมือขั้นสูง เหลือเฉพาะสิ่งที่ต้องดู';
  if (chart) chart.resize();
}

function bindEvents() {
  $('tfGroup').addEventListener('click', (e) => {
    const b = e.target.closest('.tf-btn');
    if (!b) return;
    state.tf = settings.tf = b.dataset.tf;
    saveSettings();
    document.querySelectorAll('.tf-btn').forEach((x) => x.classList.toggle('active', x === b));
    reload();
  });
  $('sourceSel').addEventListener('change', (e) => {
    settings.source = e.target.value; saveSettings();
    $('symbolSel').disabled = settings.source !== 'binance';
    reload();
  });
  $('symbolSel').addEventListener('change', (e) => { settings.symbol = e.target.value; saveSettings(); reload(); });
  $('reloadBtn').addEventListener('click', () => reload());
  $('modeToggle').addEventListener('click', () => setMode(!settings.simpleMode));
  $('tourBtn').addEventListener('click', () => new Tour().start());
  $('resetZoom').addEventListener('click', () => chart.scrollToEnd());

  $('togBB').addEventListener('change', (e) => { chart.showBB = e.target.checked; chart.render(); });
  $('togLevels').addEventListener('change', (e) => { chart.showLevels = e.target.checked; chart.render(); });
  $('togRSI').addEventListener('change', (e) => { chart.panels.rsi = e.target.checked; chart.render(); });
  $('togMACD').addEventListener('change', (e) => { chart.panels.macd = e.target.checked; chart.render(); });
  $('togMarkers').addEventListener('change', (e) => {
    chart.setData({ markers: e.target.checked && state.bt ? state.bt.trades.map((t) => ({ index: t.index, side: t.side })) : [] });
    chart.render();
  });

  ['accountInput', 'riskInput'].forEach((id) => $(id).addEventListener('input', () => {
    settings.account = +$('accountInput').value || 1000;
    settings.riskPct = +$('riskInput').value || 1;
    saveSettings();
    if (state.scored) { renderPlan(); }
  }));

  $('runBt').addEventListener('click', () => doBacktest());
  $('runAdapt').addEventListener('click', () => doAdapt());
  $('applyAdapt').addEventListener('click', () => applyAdapt(state.adapt && state.adapt.params));
  $('resetAdapt').addEventListener('click', () => applyAdapt(null));
  $('runLearn').addEventListener('click', () => doLearn());
  $('applyLearn').addEventListener('click', () => applyLearned(state.learn && state.learn.weights));
  $('resetLearn').addEventListener('click', () => applyLearned(null));
  ['thresholdInput', 'maxHoldInput', 'spreadInput'].forEach((id) => $(id).addEventListener('change', () => {
    settings.threshold = +$('thresholdInput').value || 35;
    settings.maxHold = +$('maxHoldInput').value || 60;
    settings.spread = +$('spreadInput').value || 0;
    $('setThreshold').value = settings.threshold;
    saveSettings();
  }));
  ['setThreshold', 'setSlAtr', 'setAdx'].forEach((id) => $(id).addEventListener('change', () => {
    settings.threshold = +$('setThreshold').value || 35;
    settings.slAtr = +$('setSlAtr').value || 1.5;
    settings.adxMin = +$('setAdx').value || 22;
    $('thresholdInput').value = settings.threshold;
    saveSettings(); analyze(true, false);
  }));
  $('setHtf1').addEventListener('change', (e) => { settings.htf1 = e.target.value; saveSettings(); reload(); });
  $('setHtf2').addEventListener('change', (e) => { settings.htf2 = e.target.value; saveSettings(); reload(); });
  $('setSmartSession').addEventListener('change', (e) => { settings.smartSession = e.target.checked; saveSettings(); analyze(true, false); });
  $('historyBars').addEventListener('change', (e) => { settings.historyBars = +e.target.value || 3000; saveSettings(); reload(); });
  ['setNewsFilter', 'setVolFilter', 'setSessionFilter'].forEach((id) => $(id).addEventListener('change', () => {
    settings.newsFilter = $('setNewsFilter').checked;
    settings.volFilter = $('setVolFilter').checked;
    settings.sessionFilter = $('setSessionFilter').checked;
    saveSettings(); analyze(true, false);
  }));
  $('setUsdThb').addEventListener('change', (e) => { settings.usdThb = +e.target.value || 36.5; saveSettings(); updatePriceHeader(); });
  $('setApiKey').addEventListener('change', (e) => { settings.apiKey = e.target.value.trim(); saveSettings(); });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'backtest') drawEquity();
  }));
  document.querySelectorAll('.rtab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.rtab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    state.reasonTab = t.dataset.r;
    renderReasons();
  }));

  // แจ้งเตือน
  $('enableNotif').addEventListener('click', async () => {
    const res = await alerts.requestDesktopPermission();
    toast({ kind: 'info', title: res === 'granted' ? 'เปิดแจ้งเตือนแล้ว' : 'ไม่ได้รับอนุญาต', body: res === 'granted' ? 'จะเด้งแจ้งเตือนแม้สลับแท็บอยู่' : 'อนุญาตได้ที่ไอคอนกุญแจข้าง URL' });
    alerts.playSound('info');
  });
  $('togSound').addEventListener('change', (e) => { alerts.sound = e.target.checked; alerts.save(); if (e.target.checked) alerts.playSound('info'); });
  $('togSpeak').addEventListener('change', (e) => { alerts.speak = e.target.checked; alerts.save(); });
  $('alertMode').addEventListener('change', (e) => { settings.alertMode = e.target.value; saveSettings(); alerts.resetCooldown(); });
  $('toggleNarration').addEventListener('click', () => {
    state.narrationOpen = !state.narrationOpen;
    $('narrationBody').style.display = state.narrationOpen ? '' : 'none';
    $('toggleNarration').textContent = state.narrationOpen ? 'ย่อ' : 'ขยาย';
  });
  $('cooldownInput').addEventListener('change', (e) => { alerts.cooldownMs = (+e.target.value || 0) * 60000; alerts.save(); });
  $('webhookInput').addEventListener('change', (e) => { alerts.webhookUrl = e.target.value.trim(); alerts.save(); });
  $('addRule').addEventListener('click', () => {
    const value = +$('ruleValue').value;
    if (!value) return;
    alerts.addRule({ type: $('ruleType').value, value, once: $('ruleOnce').checked });
    $('ruleValue').value = '';
    renderRules();
  });
  $('clearLog').addEventListener('click', () => { alerts.clearLog(); renderLog(); });
  $('addEvent').addEventListener('click', () => {
    const title = $('evTitle').value.trim();
    const time = $('evTime').value;
    if (!title || !time) return;
    state.events.push({ title, time: new Date(time).toISOString(), impact: 'high' });
    saveEvents(); $('evTitle').value = ''; $('evTime').value = '';
    renderContextTab();
  });
}

// ── โหลดข้อมูล ───────────────────────────────────────────────────────────
async function reload() {
  feed.stop();
  feed.configure({ source: settings.source, symbol: settings.symbol, interval: state.tf, apiKey: settings.apiKey });
  setStatus('loading', `กำลังโหลด ${settings.symbol} ${state.tf}…`);
  try {
    state.candles = await feed.loadHistory(state.tf, settings.historyBars || 3000);
    if (!state.candles.length) throw new Error('ไม่มีข้อมูลย้อนหลัง');
    state.htf = {};
    for (const tf of [settings.htf1, settings.htf2]) {
      if (tf === state.tf) continue;
      try {
        const c = await feed.loadHistory(tf, 400);
        state.htf[tf] = { candles: c };
      } catch (e) { /* กรอบใหญ่โหลดไม่ได้ก็ยังวิเคราะห์กรอบหลักได้ */ }
    }
    state.prevClose = state.candles.length > 1 ? state.candles[state.candles.length - 2].c : null;
    const lastClosed = [...state.candles].reverse().find((c) => c.closed !== false);
    state.lastClosedT = lastClosed ? lastClosed.t : null;
    // วิเคราะห์ครั้งแรกแบบไม่แจ้งเตือน — สัญญาณที่ค้างอยู่ตั้งแต่ก่อนเปิดหน้าไม่ใช่ "สัญญาณใหม่"
    analyze(true, false);
    doBacktest();
    renderContextTab();
    feed.start(onLiveCandle, (s) => setStatus(s.state, s.message));
    clearInterval(state.htfTimer);   // ไม่งั้นโหลดใหม่ทุกครั้งจะเพิ่มตัวจับเวลาซ้อนกันเรื่อย ๆ
    state.htfTimer = setInterval(refreshHtf, feed.htfRefreshMs);
  } catch (e) {
    // ต่อข้อมูลจริงไม่ได้ (เน็ตล่ม / โดนบล็อก / โบรกเกอร์ล่ม)
    // ไม่ปล่อยให้เจอหน้าจอว่าง ๆ — สลับไปโหมดจำลองให้ใช้งานต่อได้ พร้อมบอกสาเหตุให้ชัด
    if (settings.source !== 'demo') {
      settings.source = 'demo';           // เปลี่ยนเฉพาะรอบนี้ ไม่บันทึก ครั้งหน้าจะลองต่อของจริงอีก
      $('sourceSel').value = 'demo';
      toast({ kind: 'info', title: '⚠ ต่อข้อมูลราคาจริงไม่ได้ — สลับไปโหมดจำลองให้ชั่วคราว',
        body: `${e.message}\n\nสาเหตุที่พบบ่อย: ไม่ได้ต่อเน็ต · ตัวบล็อกโฆษณาบล็อก Binance · เน็ตองค์กร/มหาวิทยาลัยบล็อกไว้\nแก้แล้วกด "↻ โหลดใหม่" เพื่อกลับไปใช้ราคาจริง` });
      await reload();
      setStatus('demo', '⚠ กำลังแสดงข้อมูลจำลอง (ไม่ใช่ราคาจริง) — ต่อ Binance ไม่ได้ กด "โหลดใหม่" เพื่อลองอีกครั้ง');
      return;
    }
    setStatus('error', e.message);
    toast({ kind: 'info', title: 'โหลดข้อมูลไม่สำเร็จ', body: e.message });
  }
}

async function refreshHtf() {
  for (const tf of Object.keys(state.htf)) {
    try { state.htf[tf].candles = await feed.loadHistory(tf, 400); } catch (e) { /* ครั้งหน้าค่อยลองใหม่ */ }
  }
}

function onLiveCandle(k) {
  const res = mergeCandle(state.candles, k);
  if (res.stale) return;
  if (res.appended && state.candles.length > 1) state.prevClose = state.candles[state.candles.length - 2].c;
  updatePriceHeader();
  if (chart) chart.invalidate();   // ให้กราฟไหลตามราคาทุกครั้ง ไม่ต้องรอรอบวิเคราะห์
  alerts.checkRules({ price: k.c, rsi: state.ctx && state.scored ? state.scored.rsi : null, score: state.combined ? state.combined.score : 0 });

  // "แท่งปิด" คือเหตุการณ์ที่ข้อมูลของแท่งนั้นสมบูรณ์แล้ว — ต้องให้คะแนนตอนนี้
  // ไม่ใช่ตอนแท่งใหม่เพิ่งเปิด (แท่งที่เพิ่งเปิดมีแค่ราคาเดียว รูปแบบแท่งเทียนยังอ่านไม่ได้)
  if (k.closed && k.t !== state.lastClosedT) {
    state.lastClosedT = k.t;
    analyze(true);
    return;
  }
  scheduleAnalyze(false);
}

function scheduleAnalyze() {
  const now = Date.now();
  if (now - state.lastAnalyze > 2000) { analyze(false); return; }
  clearTimeout(state.analyzeTimer);
  state.analyzeTimer = setTimeout(() => analyze(false), 2000);
}

// ── วิเคราะห์ ────────────────────────────────────────────────────────────
function analyze(candleClosed, allowAlert = true) {
  if (!state.candles.length) return;
  state.lastAnalyze = Date.now();
  const conf = cfg();
  state.ctx = buildContext(state.candles, conf);
  const last = state.candles.length - 1;
  state.scored = scoreAt(state.ctx, last);

  for (const tf of Object.keys(state.htf)) {
    const h = state.htf[tf];
    if (!h.candles || h.candles.length < 60) continue;
    h.ctx = buildContext(h.candles, conf);
    h.scored = scoreAt(h.ctx, h.candles.length - 1);
  }
  const h1 = state.htf[settings.htf1] ? state.htf[settings.htf1].scored : null;
  const h2 = state.htf[settings.htf2] ? state.htf[settings.htf2].scored : null;
  state.combined = combineTimeframes(state.scored, h1, h2);

  // ตัวกรองความปลอดภัย
  const blocks = [];
  const sess = sessionInfo(new Date());
  /*
   * ข้อมูลค้าง = ห้ามให้สัญญาณ ต้องมาก่อนตัวกรองอื่นทั้งหมด
   *
   * ถ้าราคาหยุดอัปเดตแล้วระบบยังบอก "เข้าซื้อ" ต่อไป นั่นอันตรายกว่าการไม่มีสัญญาณเลย
   * เพราะผู้ใช้จะเข้าไม้ตามราคาที่ไม่มีอยู่จริงแล้ว
   */
  const fresh = feed.freshness();
  if (fresh.stale) {
    blocks.push(`ราคาหยุดอัปเดตมา ${Math.round(fresh.ageMs / 1000)} วินาที (ปกติไม่ควรเกิน `
      + `${Math.round(fresh.limitMs / 1000)} วินาที) — ตัวเลขบนจออาจไม่ใช่ราคาปัจจุบันแล้ว `
      + 'ระบบจึงระงับสัญญาณไว้จนกว่าข้อมูลจะกลับมา');
  }

  const risk = riskWindow(new Date(), state.events, 30);
  if (settings.newsFilter && risk.blocked) {
    blocks.push(`อยู่ในช่วง ±30 นาทีรอบข่าว: ${risk.active.map((e) => e.title).join(', ')} — สเปรดถ่างและราคาสวิงสองทาง สถิติของสัญญาณเทคนิคใช้ไม่ได้ในช่วงนี้`);
  }
  if (settings.volFilter && state.scored.ready) {
    if (state.scored.atrPct < conf.minAtrPct) blocks.push(`ความผันผวนต่ำผิดปกติ (ATR ${state.scored.atrPct.toFixed(3)}% ของราคา) — ระยะทางกำไรอาจไม่คุ้มสเปรด`);
    if (state.scored.atrPct > conf.maxAtrPct) blocks.push(`ความผันผวนสูงผิดปกติ (ATR ${state.scored.atrPct.toFixed(2)}% ของราคา) — มักเกิดตอนข่าวแรง ความเสี่ยงต่อไม้สูงกว่าที่คำนวณ`);
  }
  if (settings.sessionFilter && sess.quality < 0.6) {
    blocks.push(`อยู่นอกช่วงตลาดหลัก (${sess.label}) — สภาพคล่องบาง สัญญาณเบรกหลอกบ่อย`);
  }
  // เอาสถิติที่ระบบวัดได้เองมาใช้จริง ไม่ใช่แค่แสดงให้ดู
  // ถ้าช่วงเวลานี้เคยขาดทุนซ้ำ ๆ ในอดีต ก็ไม่มีเหตุผลจะเทรดในช่วงนี้
  if (settings.smartSession !== false && state.bt && state.bt.stats.n) {
    const now = sessionBucketAt(new Date());
    const stat = now ? state.bt.sessions.find((x) => x.key === now.key) : null;
    if (stat && stat.n >= 8 && stat.avgR !== null && stat.avgR < 0) {
      blocks.push(`ช่วง${stat.label} เคยขาดทุนในอดีต (${stat.n} ไม้ · เฉลี่ย ${stat.avgR.toFixed(2)} เท่าของความเสี่ยงต่อไม้) — ระบบจึงข้ามช่วงนี้`);
    }
  }
  state.blocks = blocks;

  const score = state.combined.score;
  const passes = Math.abs(score) >= settings.threshold && blocks.length === 0 && state.scored.ready;
  state.action = passes ? (score > 0 ? 'buy' : 'sell') : 'wait';

  const livePrice = state.candles[last].c;
  state.setup = state.scored.ready && Math.abs(score) >= settings.threshold
    ? buildSetup(state.ctx, last, { ...state.scored, side: Math.sign(score) }, {
        account: settings.account, riskPct: settings.riskPct, entryPrice: livePrice, side: Math.sign(score),
        targetR: activeTargetR(),
        slAtrMult: settings.slAtr,
      })
    : null;

  renderAll();
  renderNarration();
  if (candleClosed) renderContextTab();
  chart.setData({
    candles: state.candles, ind: state.ctx, setup: state.setup,
    levels: buildLevelList(),
  });
  chart.render();

  if (allowAlert) handleAlerting(candleClosed);
}

/**
 * ตัดสินใจว่าจะเตือนเมื่อไร
 *
 * ปัญหาที่ต้องแก้: ถ้ารอให้แท่งปิดก่อนค่อยเตือน บนกรอบ 15 นาทีอาจช้าไป 15 นาที
 * แต่ถ้าเตือนทุกครั้งที่คะแนนถึงเกณฑ์ระหว่างแท่งยังไม่ปิด สัญญาณจะกลับไปกลับมา
 *
 * ทางออก (โหมด early): เตือน 2 จังหวะ
 *   1. "เตรียมตัว" — คะแนนเข้าใกล้เกณฑ์ระหว่างแท่งกำลังก่อตัว → ให้เวลาไปเปิดจอ ตั้งออเดอร์รอ
 *   2. "ยืนยัน"   — แท่งปิดแล้วคะแนนยังถึงเกณฑ์จริง → สัญญาณที่เชื่อถือได้
 */
function handleAlerting(candleClosed) {
  const mode = settings.alertMode || 'early';
  const side = state.action === 'buy' ? 1 : state.action === 'sell' ? -1 : 0;

  if (mode === 'instant') {
    if (side && alerts.shouldFireSignal(side)) fireSignalAlert();
    return;
  }
  if (mode === 'closed') {
    if (side && candleClosed && alerts.shouldFireSignal(side)) fireSignalAlert();
    return;
  }

  // โหมด early
  if (side && candleClosed && alerts.shouldFireSignal(side)) { fireSignalAlert(); return; }
  if (candleClosed) return;

  // ระหว่างแท่งกำลังก่อตัว: เตือนล่วงหน้าเมื่อคะแนนเข้าใกล้เกณฑ์แล้ว
  if (!state.combined || !state.scored || !state.scored.ready) return;
  const score = state.combined.score;
  const near = settings.threshold * 0.8;
  const warnSide = Math.abs(score) >= near ? Math.sign(score) : 0;
  if (!warnSide) return;
  if ((state.blocks || []).length) return;
  const now = Date.now();
  if (warnSide === state.warnedSide && now - state.warnedAt < Math.max(60000, alerts.cooldownMs)) return;
  state.warnedSide = warnSide;
  state.warnedAt = now;

  const price = state.candles[state.candles.length - 1].c;
  const remain = candleRemainMs();
  alerts.fire({
    kind: 'warn',
    title: `⚡ เตรียมตัว: อาจมีสัญญาณ${warnSide > 0 ? 'ซื้อ' : 'ขาย'} ${settings.symbol}`,
    body: `คะแนนตอนนี้ ${score.toFixed(1)} (เกณฑ์ ${settings.threshold}) ที่ราคา ${price.toFixed(2)}\n` +
          `แท่งจะปิดในอีก ${remain !== null ? fmtRemain(remain) : '-'} — ถ้าปิดแล้วคะแนนยังถึงเกณฑ์ ระบบจะยืนยันอีกครั้ง\n` +
          `นี่ยังไม่ใช่สัญญาณยืนยัน แต่ให้เวลาคุณเตรียมตั้งคำสั่งรอไว้ก่อน`,
    price, score,
  });
}

/** เหลืออีกกี่มิลลิวินาทีแท่งปัจจุบันจะปิด */
function candleRemainMs() {
  if (!state.candles.length) return null;
  const last = state.candles[state.candles.length - 1];
  const step = TF[state.tf].ms;
  const closeAt = last.t + step;
  return Math.max(0, closeAt - Date.now());
}

function fmtRemain(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h} ชม. ${String(m).padStart(2, '0')} น.`;
  return `${m}:${String(sec).padStart(2, '0')} นาที`;
}

function tickCountdown() {
  const el = $('countdown');
  if (!el) return;
  const remain = candleRemainMs();
  if (remain === null) return;
  const b = el.querySelector('b');
  if (b) b.textContent = fmtRemain(remain);
  el.classList.toggle('soon', remain < 60000);
}

/** อัปเดตคำบรรยายกราฟ */
function renderNarration() {
  if (!state.ctx || !state.scored) return;
  const htfScores = [{ tf: state.tf, score: state.scored.ready ? state.scored.score : null }];
  for (const tf of [settings.htf1, settings.htf2]) {
    if (tf === state.tf) continue;
    const h = state.htf[tf];
    htfScores.push({ tf, score: h && h.scored && h.scored.ready ? h.scored.score : null });
  }
  const sections = narrate({
    candles: state.candles, ctx: state.ctx, scored: state.scored, combined: state.combined,
    setup: state.setup, action: state.action, blocks: state.blocks || [], tf: state.tf,
    session: sessionInfo(new Date()), prob: probabilityFor(state.combined ? state.combined.score : 0, probSource().bt),
    htfScores,
    instrument: instrumentOf(settings.source, settings.symbol),
  });
  $('narrationBody').innerHTML = sections.map((sec) => `
    <div class="narr ${sec.tone}">
      <h3>${sec.title}</h3>
      <p>${sec.text}</p>
    </div>`).join('');
  $('narrationTime').textContent = `อัปเดตล่าสุด ${new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })}`;
}

/**
 * แหล่งสถิติที่ใช้อ้างอิงความน่าจะเป็น
 * ถ้าผ่านการตรวจแบบแบ่งข้อมูลและมีไม้พอ ให้ใช้ผลจาก "ช่วงสอบจริง" เสมอ
 * เพราะสถิติจากข้อมูลชุดเดียวกับที่ใช้ตั้งกฎ มักสวยเกินความจริง
 */
function probSource() {
  const wf = state.wf;
  if (wf && wf.ok && wf.outSample.stats.n >= 15) return { bt: wf.outSample, outOfSample: true };
  return { bt: state.bt, outOfSample: false };
}

function buildLevelList() {
  if (!state.ctx) return [];
  const i = state.candles.length - 1;
  const price = state.candles[i].c;
  const span = state.scored && state.scored.atr ? state.scored.atr * 12 : price * 0.05;
  return levelsAt(state.ctx.zones, i)
    .filter((z) => z.touches >= 2 && Math.abs(z.price - price) < span)
    .map((z) => ({ price: z.price, touches: z.touches, type: z.price <= price ? 'support' : 'resistance' }))
    .sort((a, b) => b.touches - a.touches)
    .slice(0, 8);
}

function fireSignalAlert() {
  const s = state.setup;
  const prob = probabilityFor(state.combined.score, probSource().bt);
  const ex = explain({ ...state.scored, side: Math.sign(state.combined.score) });
  const top = ex.pro.slice(0, 3).map((f) => `• ${f.name}`).join('\n');
  const body = [
    `${state.action === 'buy' ? '🟢 สัญญาณซื้อ' : '🔴 สัญญาณขาย'} ${settings.symbol} ${state.tf}`,
    `คะแนน ${state.combined.score.toFixed(1)} · โอกาสถึง 1R ${prob.p !== null ? prob.p.toFixed(0) + '%' : 'ยังไม่มีสถิติ'}`,
    s ? s.plan : '',
    s ? 'แนะนำ: ตั้งคำสั่งรอ (limit) ที่ราคาเข้า ไม่ต้องไล่ราคาตลาด' : '',
    narrateShort({ scored: state.scored, combined: state.combined, action: state.action, candles: state.candles }),
    top,
  ].filter(Boolean).join('\n');
  alerts.fire({
    kind: state.action,
    title: `${state.action === 'buy' ? '🟢 เข้าซื้อ' : '🔴 เข้าขาย'} ${settings.symbol} @ ${state.candles[state.candles.length - 1].c.toFixed(2)}`,
    body,
    price: state.candles[state.candles.length - 1].c,
    score: state.combined.score,
  });
}

// ── แสดงผล ──────────────────────────────────────────────────────────────
function renderAll() {
  updatePriceHeader();
  renderSignal();
  renderPlan();
  renderReasons();
  renderMTF();
}

function updatePriceHeader() {
  const last = state.candles[state.candles.length - 1];
  if (!last) return;
  const inst = instrumentOf(settings.source, settings.symbol);
  $('livePrice').textContent = last.c.toFixed(2);
  $('priceUnit').textContent = inst.isSpot ? 'USD / ออนซ์' : `USD · ${inst.name}`;
  const base = state.prevClose || last.o;
  const chg = last.c - base;
  const pct = (chg / base) * 100;
  const el = $('priceChange');
  el.textContent = `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)} (${pct.toFixed(2)}%)`;
  el.className = 'chg ' + (chg >= 0 ? 'up' : 'down');
  $('thbPrice').textContent = `≈ ${Math.round(xauToThaiBaht(last.c, settings.usdThb)).toLocaleString('th-TH')} บาท/บาททองคำ (คิดที่ ${settings.usdThb} บาท/ดอลลาร์)`;
  renderInstrumentLine(inst);
}

/** บรรทัดบอกว่ากำลังดูราคาอะไร และมันต่างจากทองสปอตยังไง */
function renderInstrumentLine(inst) {
  const el = $('instrumentLine');
  if (!el) return;
  const h = state.candles.length ? dataHealth(state.candles, TF[state.tf].ms) : null;
  const warn = inst.isSpot ? '' : ' · <b>ไม่ใช่ราคาทองสปอต</b>';
  const health = h
    ? ` · ${h.bars.toLocaleString('th-TH')} แท่ง ย้อนหลัง ${h.days.toFixed(1)} วัน`
      + (h.gaps ? ` · <span style="color:var(--gold)">มีช่วงข้อมูลขาด ${h.gaps} จุด</span>` : '')
      + (h.ok ? '' : ' · <span style="color:var(--down)">ข้อมูลผิดลำดับ</span>')
    : '';
  el.innerHTML = `<span title="${inst.long}">กำลังดู <b>${inst.name}</b> (${inst.kind})${warn}</span>${health}`;
  el.className = 'instrument-line' + (inst.isSpot ? '' : ' proxy');
}

function renderSignal() {
  const score = state.combined ? state.combined.score : 0;
  const lbl = scoreLabel(score, settings.threshold);
  const card = $('signalCard');
  card.className = 'card signal-card ' + (state.action === 'wait' ? '' : state.action);
  const act = $('actionText');
  act.className = 'action ' + state.action;
  act.textContent = state.action === 'buy' ? '🟢 เข้าซื้อ (BUY)' : state.action === 'sell' ? '🔴 เข้าขาย (SELL)' : '⏸ รอจังหวะ';
  $('gradeText').className = 'grade ' + lbl.cls;
  $('gradeText').textContent = lbl.text;
  $('scoreText').textContent = score.toFixed(1);
  const fill = $('gaugeFill');
  const pct = Math.min(50, Math.abs(score) / 2);
  fill.className = 'gauge-fill ' + (score > 0 ? 'buy' : score < 0 ? 'sell' : '');
  fill.style.left = score >= 0 ? '50%' : `${50 - pct}%`;
  fill.style.width = `${pct}%`;

  const hasSignal = Math.abs(score) >= settings.threshold;
  const src = probSource();
  const prob = probabilityFor(score, src.bt);
  if (!hasSignal) {
    $('probValue').textContent = '—';
    $('probValue').style.color = 'var(--muted)';
    $('probNote').textContent = `คะแนนยังไม่ถึงเกณฑ์ ${settings.threshold} จึงยังไม่มีสถิติของ "ไม้นี้" ให้อ้างอิง`;
  } else {
    $('probValue').textContent = prob.p !== null ? `${prob.p.toFixed(0)}%` : '—';
    $('probValue').style.color = prob.p === null ? 'var(--muted)' : prob.p >= 55 ? 'var(--up)' : prob.p >= 45 ? 'var(--gold)' : 'var(--down)';
    $('probNote').textContent = (src.outOfSample ? 'วัดจากช่วงข้อมูลที่ระบบไม่เคยเห็น — ' : '')
      + prob.note + (prob.avgR != null ? ` · ค่าคาดหวังต่อไม้ ${prob.avgR.toFixed(2)}R` : '');
  }

  const last = state.candles[state.candles.length - 1];
  const closedInfo = last && last.closed === false ? 'แท่งปัจจุบันยังไม่ปิด — คะแนนอาจเปลี่ยนได้จนกว่าแท่งจะปิด' : 'คำนวณจากแท่งที่ปิดแล้ว';
  const parts = [];
  parts.push(`⏱ ${closedInfo}`);
  if (state.scored && state.scored.ready) {
    parts.push(`สภาพตลาด: <b>${state.scored.regime === 'trend' ? 'มีเทรนด์ (ใช้กลยุทธ์ตามแนวโน้ม)' : 'ออกข้าง (ใช้กลยุทธ์เด้งกลับค่าเฉลี่ย)'}</b> · ADX ${state.scored.adx ? state.scored.adx.toFixed(1) : '-'} · ATR ${state.scored.atr.toFixed(2)} (${state.scored.atrPct.toFixed(2)}%)`);
  }
  if (state.blocks && state.blocks.length) {
    parts.push(`<span style="color:var(--gold)">⛔ ระงับสัญญาณ: ${state.blocks.join(' · ')}</span>`);
  }
  if (state.wf && state.wf.ok && state.wf.verdict.level === 'bad') {
    parts.push('<span style="color:var(--down)">⚠ ระบบสอบไม่ผ่านบนข้อมูลที่ไม่เคยเห็น — กฎชุดนี้ยังไม่มีความได้เปรียบจริงกับตลาดช่วงนี้ ดูรายละเอียดในแท็บผลทดสอบย้อนหลัง</span>');
  }
  $('candleState').innerHTML = parts.join('<br>');
  renderPlainAdvice();
}

/**
 * คำแนะนำภาษาชาวบ้านสำหรับโหมดง่าย
 * ไม่ใช้ศัพท์เทคนิค ตอบแค่ว่า "ตอนนี้ควรทำอะไร" และ "ทำไม"
 */
function renderPlainAdvice() {
  const el = $('plainAdvice');
  if (!el || !state.scored) return;
  if (!state.scored.ready) {
    el.innerHTML = '<div class="headline">กำลังโหลดข้อมูล…</div>';
    return;
  }
  const side = Math.sign(state.combined.score);
  const ex = explain({ ...state.scored, side: side || 1 });
  const top3 = ex.pro.slice(0, 3).map((f) => `<li>${f.reason}</li>`).join('');

  const failWarn = state.wf && state.wf.ok && state.wf.verdict.level === 'bad'
    ? `<div class="next-step" style="background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.4)">
        <b>⚠ อ่านก่อนตัดสินใจ:</b> ระบบทดสอบตัวเองกับข้อมูลที่ไม่เคยเห็นแล้ว<b>ขาดทุน</b>
        แปลว่ากฎชุดนี้ยังไม่มีความได้เปรียบจริงกับตลาดช่วงนี้ — ใช้ดูเพื่อเรียนรู้ได้ แต่ยังไม่ควรเทรดตาม</div>`
    : '';

  if (state.action === 'buy' || state.action === 'sell') {
    const prob = probabilityFor(state.combined.score, probSource().bt);
    const s = state.setup;
    el.innerHTML = failWarn + `
      <div class="headline" style="color:${state.action === 'buy' ? 'var(--up)' : 'var(--down)'}">
        ${state.action === 'buy' ? '🟢 ตอนนี้เข้าซื้อได้' : '🔴 ตอนนี้เข้าขายได้'}
      </div>
      <div>เพราะปัจจัยหลัก ๆ ชี้ไปทางเดียวกัน${prob.p !== null ? ` และสัญญาณแบบนี้ในอดีตทำกำไรได้ ${prob.p.toFixed(0)} จาก 100 ครั้ง` : ''}:</div>
      <ul>${top3}</ul>
      ${s ? `<div class="next-step"><b>ทำต่อยังไง:</b> เปิดโปรแกรมเทรด ตั้งคำสั่งรอที่ราคา <b>${s.entry.toFixed(2)}</b>
        ตั้งจุดตัดขาดทุนที่ <b>${s.sl.toFixed(2)}</b> แล้วตั้งขายทำกำไรที่ <b>${s.tp1.toFixed(2)}</b>
        <br>ตั้งเสร็จแล้วปิดจอไปทำอย่างอื่นได้เลย ไม่ต้องเฝ้า</div>` : ''}`;
    return;
  }

  const blocked = (state.blocks || []).length > 0;
  const watch = [];
  if (state.scored.resistance) watch.push(`ราคาขึ้นทะลุ <b>${state.scored.resistance.toFixed(2)}</b> → มีโอกาสไปต่อขาขึ้น`);
  if (state.scored.support) watch.push(`ราคาหลุดลงต่ำกว่า <b>${state.scored.support.toFixed(2)}</b> → มีโอกาสไปต่อขาลง`);
  el.innerHTML = failWarn + `
    <div class="headline" style="color:var(--muted)">⏸ ตอนนี้ยังไม่ต้องทำอะไร</div>
    <div>${blocked
      ? 'ระบบระงับสัญญาณไว้เพราะ: ' + state.blocks.join(' · ')
      : 'สัญญาณยังไม่ชัดพอ การอยู่เฉย ๆ ก็คือการตัดสินใจที่ถูกต้องอย่างหนึ่ง'}</div>
    ${watch.length ? `<div class="next-step"><b>รออะไรอยู่:</b><ul style="margin-top:4px">${watch.map((w) => `<li>${w}</li>`).join('')}</ul>
      ถ้ามีสัญญาณ ระบบจะส่งเสียงเตือนให้เอง ไม่ต้องนั่งเฝ้า</div>` : ''}`;
}

function renderPlan() {
  const box = $('planBox');
  const sizeBox = $('sizeBox');
  const card = $('planCard');
  if (card) card.classList.toggle('no-plan', !state.setup);
  if (!state.setup) {
    box.className = 'plan-empty';
    box.textContent = state.scored && state.scored.ready
      ? `คะแนนปัจจุบัน ${state.combined.score.toFixed(1)} ยังไม่ถึงเกณฑ์ ${settings.threshold} — การไม่เข้าเทรดคือการตัดสินใจอย่างหนึ่ง`
      : 'ข้อมูลยังไม่พอสำหรับคำนวณ (ต้องการอย่างน้อย ~200 แท่ง)';
    sizeBox.innerHTML = '';
    sizeBox.style.display = 'none';
    return;
  }
  const s = state.setup;
  const riskMoney = settings.account * (settings.riskPct / 100);
  const lots = s.slDist > 0 ? riskMoney / (s.slDist * 100) : 0;
  const opt = state.opt && state.opt.ok ? state.opt : null;
  const dir = s.side > 0 ? 'ซื้อ' : 'ขาย';
  const sign = s.side > 0 ? '+' : '-';
  const rr = Math.abs(s.tpMain - s.entry) / s.slDist;
  const reach = opt ? opt.reachRates.find((x) => Math.abs(x.targetR - s.mainR) < 1e-9) : null;

  box.className = 'plan-v2';
  const orderType = s.side > 0 ? 'Buy' : 'Sell';
  const hasPullback = s.entryIdeal !== null;
  const gapToIdeal = hasPullback ? Math.abs(s.entry - s.entryIdeal) : 0;
  const idealIsClose = hasPullback && gapToIdeal < s.slDist * 0.25;

  box.innerHTML = `
    ${state.action === 'wait' ? '<div class="plan-gate">⚠ แผนอ้างอิงเท่านั้น — ยังไม่ใช่ไฟเขียวให้เข้า</div>' : ''}
    <div class="plan-main">
      <div class="pm-row entry"><span class="pm-label">เข้า${dir}ที่</span>
        <span class="pm-val">${s.entry.toFixed(2)}</span><span class="pm-note">ราคาตลาดตอนนี้</span></div>
      <div class="pm-row sl"><span class="pm-label">ตัดขาดทุน</span>
        <span class="pm-val">${s.sl.toFixed(2)}</span>
        <span class="pm-note">${sign === '+' ? '-' : '+'}${s.slDist.toFixed(2)} · เสีย $${riskMoney.toFixed(0)}</span></div>
      <div class="pm-row tp"><span class="pm-label">เป้าทำกำไร</span>
        <span class="pm-val">${s.tpMain.toFixed(2)}</span>
        <span class="pm-note">${sign}${Math.abs(s.tpMain - s.entry).toFixed(2)} · ได้ $${(riskMoney * rr).toFixed(0)}</span></div>
    </div>

    <div class="entry-guide">
      <h3>วิธีเข้าไม้ — ทำตามทีละขั้น</h3>

      <div class="step"><span class="step-n">1</span><div>
        <b>ตั้งคำสั่งที่ราคาไหน</b>
        ${hasPullback && !idealIsClose ? `
          <div class="opt best"><span class="opt-tag">ดีที่สุด</span>
            ตั้ง <b>${orderType} Limit</b> ที่ <b class="num">${s.entryIdeal.toFixed(2)}</b> — รอราคาย่อกลับมาที่${s.entryIdealWhy}
            <span class="opt-why">ได้ระยะดีกว่า แต่ถ้าราคาไม่ย่อกลับมาก็อดเข้า ซึ่งไม่เสียหายอะไร</span></div>
          <div class="opt"><span class="opt-tag alt">หรือ</span>
            เข้าเลยที่ราคาตลาด <b class="num">${s.entry.toFixed(2)}</b>
            <span class="opt-why">ได้เข้าแน่นอน แต่ระยะแย่กว่าประมาณ ${gapToIdeal.toFixed(2)} ดอลลาร์</span></div>` : `
          <div class="opt best"><span class="opt-tag">เข้าได้เลย</span>
            ตั้ง <b>${orderType}</b> ที่ราคาตลาด <b class="num">${s.entry.toFixed(2)}</b>
            <span class="opt-why">${hasPullback ? 'ราคาอยู่ในโซนที่ดีอยู่แล้ว ไม่ต้องรอย่อ' : 'ไม่มีแนวใกล้ ๆ ให้รอย่อ เข้าที่ราคาตลาดได้'}</span></div>`}
        <div class="opt stop"><span class="opt-tag no">ห้ามเข้า</span>
          ถ้าราคา${s.side > 0 ? 'วิ่งขึ้นเกิน' : 'วิ่งลงต่ำกว่า'} <b class="num">${s.entryLimit.toFixed(2)}</b>
          <span class="opt-why">เลยจุดนี้ไป ได้:เสีย จะต่ำกว่า ${s.minRR} : 1 — ไม่คุ้มเสี่ยงแล้ว ปล่อยไม้นี้ผ่านไป</span></div>
      </div></div>

      <div class="step"><span class="step-n">2</span><div>
        <b>ใส่ตัวเลขให้ครบก่อนกดยืนยัน</b>
        <table class="order-table"><tbody>
          <tr><td>Stop Loss</td><td class="num">${s.sl.toFixed(2)}</td><td class="hint">ห้ามข้ามเด็ดขาด</td></tr>
          <tr><td>Take Profit</td><td class="num">${s.tpMain.toFixed(2)}</td><td class="hint">${s.mainR} เท่าของความเสี่ยง</td></tr>
          <tr><td>ขนาด (Lot)</td><td class="num">${lots.toFixed(3)}</td><td class="hint">≈ ${(lots * 100).toFixed(1)} ออนซ์</td></tr>
        </tbody></table>
      </div></div>

      <div class="step"><span class="step-n">3</span><div>
        <b>กดยืนยันแล้วปิดจอไปได้เลย</b>
        <span class="opt-why">ตั้ง SL/TP ไว้แล้ว โปรแกรมของโบรกเกอร์จะปิดไม้ให้เองทั้งกรณีกำไรและขาดทุน
        ไม่ต้องนั่งเฝ้าจอ และไม่ต้องกดแข่งกับความเร็วตลาด</span>
      </div></div>

      <div class="invalidate"><b>แผนนี้ยกเลิกเมื่อไร</b>
        <ul>
          <li>ราคา${s.side > 0 ? 'ขึ้นเกิน' : 'ลงต่ำกว่า'} <b>${s.entryLimit.toFixed(2)}</b> ก่อนที่คุณจะได้เข้า</li>
          <li>ราคา${s.side > 0 ? 'หลุด' : 'ทะลุ'} <b>${s.sl.toFixed(2)}</b> — สัญญาณนี้ผิดแล้ว ยอมรับแล้วไปไม้ถัดไป</li>
          <li>สัญญาณบนหน้าจอเปลี่ยนทิศ หรือกลับไปเป็น "รอจังหวะ"</li>
        </ul>
      </div>
    </div>

    <div class="plan-size">
      ได้:เสีย <b>${rr.toFixed(2)} : 1</b>
      ${reach && reach.outSample !== null ? `· โอกาสถึงเป้า <b>${reach.outSample.toFixed(0)}%</b>` : ''}
      ${(() => {
        const be = (1 / (1 + rr)) * 100;
        const p = reach && reach.outSample !== null ? reach.outSample : null;
        return `<br><span class="be-line">ที่อัตราส่วนนี้ <b>ชนะเกิน ${be.toFixed(0)}% ก็กำไรแล้ว</b>`
          + (p === null ? ''
            : p > be ? ` — ตอนนี้ ${p.toFixed(0)}% <b style="color:var(--up)">ผ่านจุดคุ้มทุน</b>`
                     : ` — ตอนนี้ ${p.toFixed(0)}% <b style="color:var(--down)">ยังไม่ถึงจุดคุ้มทุน</b>`)
          + '</span>';
      })()}
    </div>
    <details class="plan-why"${state.planDetailsOpen ? ' open' : ''}>
      <summary>ดูที่มาของตัวเลขทั้งหมด</summary>
      <div class="why-body">
        ${opt ? `
        <h4>ทำไมตัดขาดทุนตรงนี้</h4>
        <p>ระบบกวาดหาความกว้างหลายค่าแล้วพบว่า <b>${opt.best.slAtrMult} เท่าของระยะแกว่งเฉลี่ยต่อแท่ง</b>
          ให้ผลดีที่สุดในบรรดาค่าที่ลอง</p>
        ${opt.slAdvice && opt.slAdvice.level !== 'unknown'
          ? `<p class="why-hint"><b>หมายเหตุจากข้อมูลทั้งหมด:</b> ${opt.slAdvice.text}</p>` : ''}
        ${opt.maeWinners.n >= 10 ? `<p class="why-stat">ไม้ที่สุดท้ายชนะ เคยติดลบลึกสุดเท่าไร (เทียบกับระยะ SL):
          ครึ่งหนึ่งไม่เกิน <b>${opt.maeWinners.p50.toFixed(2)}</b> ·
          90% ไม่เกิน <b>${opt.maeWinners.p90.toFixed(2)}</b> ·
          ลึกสุดที่เคยเจอ <b>${opt.maeWinners.max.toFixed(2)}</b>
          <span class="why-hint">(ถ้าเกิน 1.00 แปลว่าไม้นั้นเกือบโดนเขี่ยออกก่อนวิ่ง)</span></p>` : ''}

        <h4>ทำไมเป้าอยู่ตรงนี้</h4>
        <p>ไม่ได้ตั้งเป็น 2 เท่าตายตัว แต่ลองทุกระยะแล้วเลือกระยะที่ให้ผลตอบแทนคาดหวังดีที่สุด
          — ได้ <b>${s.mainR} เท่าของความเสี่ยง</b></p>
        ${(() => {
          const inE = opt.best.expectancy, outE = opt.outOfSample ? opt.outOfSample.expectancy : null;
          const bad = outE !== null ? outE <= 0 : inE <= 0;
          return `<p class="why-stat" style="${bad ? 'border-left:3px solid var(--down)' : 'border-left:3px solid var(--up)'}">
            ผลตอบแทนคาดหวังต่อไม้ของชุดค่านี้: ช่วงเรียนรู้ <b>${inE >= 0 ? '+' : ''}${inE.toFixed(3)}</b> เท่าของเงินที่เสี่ยง
            ${outE !== null ? `· ช่วงสอบจริง <b style="color:${outE > 0 ? 'var(--up)' : 'var(--down)'}">${outE >= 0 ? '+' : ''}${outE.toFixed(3)}</b>` : ''}
            ${bad ? `<br><b style="color:var(--down)">⚠ ติดลบ = แม้จะเป็นชุดค่าที่ดีที่สุดเท่าที่หาได้ แต่ยังไม่มีชุดไหนทำกำไรได้กับข้อมูลช่วงนี้
              — ตัวเลขในแผนใช้เรียนรู้ได้ แต่ยังไม่ควรเอาเงินจริงเข้าไป</b>` : ''}</p>`;
        })()}
        <table class="why-table"><thead><tr><th>ถ้าตั้งเป้าที่</th><th>ช่วงเรียนรู้</th><th>ช่วงสอบจริง</th></tr></thead><tbody>
          ${opt.reachRates.map((x) => `<tr class="${Math.abs(x.targetR - s.mainR) < 1e-9 ? 'chosen' : ''}">
            <td>${x.targetR} เท่า</td>
            <td class="num">${x.inSample.toFixed(0)}%</td>
            <td class="num">${x.outSample === null ? '—' : x.outSample.toFixed(0) + '%'}</td></tr>`).join('')}
        </tbody></table>
        <p class="why-hint">ตัวเลขคือ "กี่ % ของไม้ที่ราคาวิ่งไปถึงระยะนั้นก่อนโดนตัดขาดทุน"
          เป้าใกล้ถึงบ่อยแต่ได้น้อย เป้าไกลได้เยอะแต่ถึงยาก — จุดที่คุ้มที่สุดคือจุดที่คูณกันแล้วสูงสุด</p>

        <p class="why-stat">ระยะที่ราคาวิ่งไปได้จริง: ครึ่งหนึ่งของไม้ไปถึง <b>${opt.mfe.p50.toFixed(2)} เท่า</b> ·
          หนึ่งในสี่ไปได้เกิน <b>${opt.mfe.p75.toFixed(2)} เท่า</b> ·
          ไม้ที่วิ่งไกลสุด 10% ไปได้เกิน <b>${opt.mfe.p90.toFixed(2)} เท่า</b> (จาก ${opt.mfe.n} ไม้)</p>
        ` : `<h4>ตัวเลขนี้มาจากไหน</h4>
          <p>ยังหาค่าที่ดีที่สุดจากสถิติไม่ได้ จึงใช้ค่าตั้งต้น (จุดตัดขาดทุน 1.5 เท่าของระยะแกว่ง · เป้า 2 เท่าของความเสี่ยง)</p>
          <p class="why-hint"><b>เหตุผล:</b> ${state.opt && state.opt.reason ? state.opt.reason : 'ยังไม่ได้ทดสอบย้อนหลัง'}</p>`}

        <h4>บันไดเป้าหมายแบบอื่น</h4>
        <table class="why-table"><tbody>
          <tr><td>เป้าที่ 1 (1 เท่า)</td><td class="num">${s.tp1.toFixed(2)}</td></tr>
          <tr><td>เป้าที่ 2 (2 เท่า)</td><td class="num">${s.tp2.toFixed(2)}</td></tr>
          <tr><td>เป้าที่ 3 (${(Math.abs(s.tp3 - s.entry) / s.slDist).toFixed(1)} เท่า)</td><td class="num">${s.tp3.toFixed(2)}</td></tr>
        </tbody></table>
        <p class="why-hint">ถ้าชอบทยอยปิด: ปิดครึ่งที่เป้าที่ 1 แล้วเลื่อนจุดตัดขาดทุนมาที่ราคาเข้า
          ที่เหลือปล่อยไปเป้าที่ 2</p>

        ${s.notes.length ? `<h4>ข้อสังเกตของไม้นี้</h4><ul class="plan-notes">${s.notes.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
      </div>
    </details>`;

  sizeBox.style.display = 'none';

  // การ์ดนี้ถูกวาดใหม่ทุกรอบวิเคราะห์ ถ้าไม่จำไว้ รายละเอียดที่ผู้ใช้กางอ่านอยู่จะหุบเอง
  const det = box.querySelector('.plan-why');
  if (det) det.addEventListener('toggle', () => { state.planDetailsOpen = det.open; });
}

function renderReasons() {
  const list = $('reasonList');
  if (!state.scored || !state.scored.ready) { list.innerHTML = ''; return; }
  const side = Math.sign(state.combined.score) || 1;
  const ex = explain({ ...state.scored, side });
  $('reasonCount').textContent = `(${ex.pro.length} สนับสนุน / ${ex.con.length} ค้าน)`;

  let items = [];
  if (state.reasonTab === 'pro') items = ex.pro.map((f) => ({ ...f, cls: 'pos' }));
  else if (state.reasonTab === 'con') items = ex.con.map((f) => ({ ...f, cls: 'neg' }));
  else {
    const sess = sessionInfo(new Date());
    const risk = riskWindow(new Date(), state.events, 30);
    items = [
      { name: `ช่วงตลาด: ${sess.label}`, reason: sess.detail, weight: null, cls: '' },
      { name: `โครงสร้างราคา: ${state.scored.structure.label}`, reason: state.scored.structure.detail, weight: null, cls: '' },
      ...state.combined.notes.map((n) => ({ name: 'หลายกรอบเวลา', reason: n, weight: null, cls: '' })),
      ...ex.neutral.map((f) => ({ name: f.name, reason: f.reason, weight: null, cls: '' })),
      ...(risk.upcoming.length ? [{ name: 'ข่าวที่กำลังจะมา', reason: risk.upcoming.map((e) => `${e.title} — ${thTime(e.time)}`).join(' · '), weight: null, cls: '' }] : []),
      ...(state.blocks || []).map((b) => ({ name: '⛔ เหตุผลที่ยังไม่ควรเข้า', reason: b, weight: null, cls: 'neg' })),
    ];
  }
  list.innerHTML = items.map((f) => {
    const n = toThai(f.name);
    return `
    <div class="reason ${f.cls}">
      <div class="reason-head"><span>${n.th}${n.en ? ` <span class="en">${n.en}</span>` : ''}</span>${f.weight ? `<span class="w">${f.contribution > 0 ? '+' : ''}${f.contribution.toFixed(1)} / ${f.weight}</span>` : ''}</div>
      <p>${f.reason}</p>
    </div>`;
  }).join('');
}

function renderMTF() {
  const rows = [{ tf: state.tf, s: state.scored, main: true }];
  for (const tf of [settings.htf1, settings.htf2]) {
    if (tf === state.tf) continue;
    rows.push({ tf, s: state.htf[tf] ? state.htf[tf].scored : null });
  }
  $('mtfBox').innerHTML = rows.map((r) => {
    const sc = r.s && r.s.ready ? r.s.score : 0;
    const w = Math.min(50, Math.abs(sc) / 2);
    const color = sc > 0 ? 'var(--up)' : sc < 0 ? 'var(--down)' : 'var(--muted)';
    return `<div class="mtf-row">
      <span>${r.tf}${r.main ? ' ★' : ''}</span>
      <div class="mtf-bar"><i style="background:${color}; ${sc >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`}"></i></div>
      <span class="mtf-val" style="color:${color}">${r.s && r.s.ready ? sc.toFixed(0) : '—'}</span>
    </div>`;
  }).join('') + `<div class="tiny">คะแนนรวมถ่วงน้ำหนัก 55% / 30% / 15% = <b style="color:${state.combined && state.combined.score > 0 ? 'var(--up)' : 'var(--down)'}">${state.combined ? state.combined.score.toFixed(1) : '—'}</b></div>`;
}

// ── Backtest ────────────────────────────────────────────────────────────
function doBacktest() {
  if (!state.ctx || state.candles.length < 260) {
    $('btStatus').textContent = 'ข้อมูลน้อยเกินไปสำหรับทดสอบย้อนหลัง (ต้องการ ~260 แท่งขึ้นไป)';
    return;
  }
  $('btStatus').textContent = 'กำลังคำนวณ…';
  setTimeout(() => {
    const t0 = performance.now();
    state.opt = optimizeExits(state.ctx, {
      maxHold: settings.maxHold, spread: settings.spread, useFilters: settings.volFilter,
    });
    state.wf = walkForward(state.ctx, {
      maxHold: settings.maxHold, spread: settings.spread, useFilters: settings.volFilter,
    });
    state.bt = runBacktest(state.ctx, {
      threshold: settings.threshold, maxHold: settings.maxHold,
      spread: settings.spread, useFilters: settings.volFilter,
    });
    $('btStatus').textContent = `เสร็จใน ${(performance.now() - t0).toFixed(0)} มิลลิวินาที · ข้อมูล ${state.candles.length} แท่ง (${TF[state.tf].label})`;
    renderBacktest();
    renderWalkForward();
    renderSignal();
    renderPlan();   // แผนต้องใช้ค่าที่เพิ่งหาได้ ไม่ใช่รอรอบวิเคราะห์ถัดไป
    if ($('togMarkers').checked) {
      chart.setData({ markers: state.bt.trades.map((t) => ({ index: t.index, side: t.side })) });
      chart.render();
    }
  }, 20);
}

/**
 * ผลตรวจสอบแบบแบ่งข้อมูล — ตัวเลขที่ควรเชื่อจริง ๆ
 * วางไว้เหนือสถิติรวม เพราะสถิติรวมเป็นการวัดผลบนข้อมูลชุดเดียวกับที่ใช้ตั้งกฎ
 */
function renderWalkForward() {
  const el = $('wfBox');
  const wf = state.wf;
  if (!wf) { el.innerHTML = ''; return; }
  if (!wf.ok) {
    el.innerHTML = `<div class="wf-card weak"><div class="wf-verdict">ยังตรวจสอบแบบแบ่งข้อมูลไม่ได้</div>
      <div class="tiny" style="margin:0">${wf.reason}</div></div>`;
    return;
  }
  const io = wf.inSample.stats, oo = wf.outSample.stats;
  const pct = (v) => (v === null ? '—' : `${v.toFixed(1)}%`);
  const r = (v) => (v === null ? '—' : `${v.toFixed(3)}R`);
  el.innerHTML = `
    <div class="wf-card ${wf.verdict.level}">
      <div class="wf-verdict">${wf.verdict.text}</div>
      <div class="tiny" style="margin:0">
        แบ่งข้อมูลเป็นสองท่อน: ใช้ท่อนแรกหาว่าเกณฑ์คะแนนเท่าไรดีที่สุด (ได้ <b>${wf.chosenThreshold}</b>)
        แล้วเอาเกณฑ์นั้นไปวัดผลกับท่อนหลังที่ระบบไม่เคยเห็น — ตัวเลขจากท่อนหลังคือตัวเลขที่ควรเชื่อ
      </div>
      <div class="wf-compare">
        <div class="wf-side">
          <h4>ช่วงเรียนรู้ (ตัวเลขมักสวยเกินจริง)</h4>
          <div class="big">${pct(io.winRate)}</div>
          <div class="sub">${io.n} ไม้ · ค่าคาดหวัง ${r(io.expectancy)}</div>
        </div>
        <div class="wf-side trusted">
          <h4>⭐ ช่วงสอบจริง (ข้อมูลที่ไม่เคยเห็น)</h4>
          <div class="big" style="color:${oo.expectancy > 0 ? 'var(--up)' : 'var(--down)'}">${pct(oo.winRate)}</div>
          <div class="sub">${oo.n} ไม้ · ค่าคาดหวัง ${r(oo.expectancy)}</div>
        </div>
        <div class="wf-side">
          <h4>ผลตกลงเท่าไร</h4>
          <div class="big" style="color:${wf.drop === null ? 'var(--muted)' : wf.drop > 15 ? 'var(--down)' : 'var(--up)'}">${wf.drop === null ? '—' : (wf.drop > 0 ? '-' : '+') + Math.abs(wf.drop).toFixed(1) + '%'}</div>
          <div class="sub">ตกเกิน 15% = ระบบจำข้อมูลเก่า มากกว่าเข้าใจตลาด</div>
        </div>
      </div>
    </div>`;
}

/**
 * ให้ระบบศึกษาตลาดที่โหลดมา แล้วจูนกลยุทธ์เอง
 *
 * งานหนักพอจะทำให้หน้าจอค้างได้ (จำลองการเทรดหลายร้อยรอบ)
 * จึงหน่วงหนึ่งเฟรมให้เบราว์เซอร์วาดข้อความ "กำลังศึกษา" ก่อน
 */
function doAdapt() {
  if (!state.ctx || state.candles.length < 1200) {
    $('adaptStatus').textContent = `ต้องมีข้อมูลอย่างน้อย ~1,200 แท่งถึงจะแบ่งหลายช่วงได้ (ตอนนี้ ${state.candles.length}) — `
      + 'ไปที่แท็บตั้งค่าแล้วเพิ่มจำนวนแท่งย้อนหลัง หรือเปลี่ยนไปกรอบเวลาที่เล็กลง';
    return;
  }
  $('adaptStatus').textContent = 'กำลังศึกษาตลาด… จูนใหม่ทีละช่วงแล้วสอบทุกช่วง ใช้เวลาสักครู่';
  $('applyAdapt').hidden = true;
  setTimeout(() => {
    const t0 = performance.now();
    state.adapt = autoTune(state.ctx, {
      folds: 4,
      anchored: $('togAnchored').checked,
      maxHold: settings.maxHold, spread: settings.spread, useFilters: settings.volFilter,
    });
    $('adaptStatus').textContent = `ศึกษาเสร็จใน ${((performance.now() - t0) / 1000).toFixed(1)} วินาที`;
    renderAdapt();
  }, 30);
}

function applyAdapt(params) {
  if (params) {
    // จำค่าที่ผู้ใช้ตั้งไว้ก่อนหน้า เพื่อให้กด "กลับไปใช้ค่าตั้งต้น" แล้วได้ของเดิมจริง ๆ
    // ไม่ใช่ค่ากลางที่ผู้ใช้ไม่เคยเลือก
    if (!settings.adaptPrev) settings.adaptPrev = { threshold: settings.threshold, slAtr: settings.slAtr };
    settings.threshold = params.threshold;
    settings.slAtr = params.slAtrMult;
    settings.adaptParams = { threshold: params.threshold, slAtrMult: params.slAtrMult, targetR: params.targetR };
  } else {
    const prev = settings.adaptPrev;
    if (prev) { settings.threshold = prev.threshold; settings.slAtr = prev.slAtr; }
    settings.adaptParams = null;
    settings.adaptPrev = null;
  }
  // ช่องกรอกต้องขยับตาม ไม่งั้นผู้ใช้เห็นเลขเก่าแต่ระบบใช้เลขใหม่
  $('thresholdInput').value = settings.threshold;
  $('setThreshold').value = settings.threshold;
  $('setSlAtr').value = settings.slAtr;
  saveSettings();
  analyze(false, false);
  doBacktest();
  renderAdapt();
}

function renderAdapt() {
  const el = $('adaptBox');
  const A = state.adapt;
  const using = !!settings.adaptParams;
  $('resetAdapt').hidden = !using;
  if (!A) {
    el.innerHTML = using
      ? `<div class="wf-card ok"><div class="wf-verdict">กำลังใช้ค่าที่ระบบเรียนรู้มา</div>
         <div class="tiny" style="margin:0">คะแนนขั้นต่ำ ${settings.adaptParams.threshold} ·
         จุดตัดขาดทุน ${settings.adaptParams.slAtrMult} เท่าของ ATR · เป้า ${settings.adaptParams.targetR} เท่าของความเสี่ยง</div></div>`
      : '';
    return;
  }
  if (!A.ok || !A.rwf.ok) {
    $('applyAdapt').hidden = true;
    el.innerHTML = `<div class="wf-card weak"><div class="wf-verdict">ยังศึกษาตลาดไม่ได้</div>
      <div class="tiny" style="margin:0">${A.reason || A.rwf.reason}</div></div>`;
    return;
  }
  const rwf = A.rwf;
  /*
   * ให้ใช้ได้เฉพาะเมื่อ "วัดแล้วดีกว่าจริง" เท่านั้น — เสมอก็ไม่ให้ใช้
   *
   * เดิมยอมให้ใช้ตอนผลเสมอด้วย ซึ่งผิด: การทดสอบกับข้อมูลที่เหมือนตลาดจริง
   * (ความผันผวนเกาะกลุ่ม หางอ้วน เทรนด์ค่อย ๆ เปลี่ยน) พบว่าการจูนใหม่ทุกช่วง
   * ไม่ได้ช่วย และมีแนวโน้มเสียนิดหน่อยด้วยซ้ำ (-0.027 R/ไม้)
   * เพราะเมื่อตลาดเปลี่ยนแบบค่อยเป็นค่อยไป ค่าที่ดีที่สุดแทบไม่เปลี่ยน
   * การจูนใหม่จึงเพิ่มแต่ความแปรปรวน
   *
   * ดังนั้นเมื่อเสมอ ให้ค่าตั้งต้นชนะเสมอ — ของใหม่ต้องพิสูจน์ตัวเอง ไม่ใช่ของเดิม
   */
  const usable = rwf.verdict.level === 'good' && rwf.stability.level !== 'unstable';
  $('applyAdapt').hidden = !usable || using;
  $('applyAdapt').className = rwf.verdict.level === 'good' ? 'btn primary' : 'btn';

  const r = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(3)}R`);
  const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);
  const d = (ts) => (ts ? new Date(ts).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }) : '—');
  const good = rwf.folds.filter((f) => f.ok);

  const foldRows = good.map((f) => `<tr>
      <td>${f.fold}</td>
      <td class="tiny">${d(f.t0)} – ${d(f.t1)}</td>
      <td class="num">${f.params.threshold}</td>
      <td class="num">${f.params.slAtrMult}</td>
      <td class="num">${f.params.targetR}</td>
      <td class="num">${f.adapt.n}</td>
      <td class="num" style="color:${f.adapt.expectancy > 0 ? 'var(--up)' : 'var(--down)'}">${r(f.adapt.expectancy)}</td>
      <td class="num" style="color:var(--muted)">${r(f.fixed.expectancy)}</td>
    </tr>`).join('');

  const stabLabel = { stable: 'นิ่ง ✓', mixed: 'แกว่งปานกลาง', unstable: 'แกว่งมาก ✗', unknown: 'บอกไม่ได้' }[rwf.stability.level];
  const stabColor = { stable: 'var(--up)', mixed: 'var(--gold)', unstable: 'var(--down)', unknown: 'var(--muted)' }[rwf.stability.level];

  const story = explainAdaptation(A).map((sec) => `
    <div class="adapt-sec">
      <h4>${sec.title}</h4>
      <p>${sec.body.replace(/\n\n/g, '<br><br>')}</p>
    </div>`).join('');

  el.innerHTML = `
    <div class="wf-card ${rwf.verdict.level === 'good' ? 'good' : rwf.verdict.level === 'bad' ? 'bad' : 'ok'}">
      <div class="wf-verdict">${rwf.verdict.text}</div>
      <div class="wf-compare">
        <div class="wf-side ${rwf.verdict.level === 'good' ? 'trusted' : ''}">
          <h4>ระบบปรับตัวเอง (ทุกช่วงจูนจากอดีตล้วน)</h4>
          <div class="big" style="color:${rwf.adapt.expectancy > 0 ? 'var(--up)' : 'var(--down)'}">${r(rwf.adapt.expectancy)}</div>
          <div class="sub">${rwf.adapt.n} ไม้ · ชนะ ${pct(rwf.adapt.winRate)} · รวม ${r(rwf.adapt.totalR)}</div>
        </div>
        <div class="wf-side">
          <h4>ค่าคงที่ (ช่วงเวลาเดียวกันเป๊ะ)</h4>
          <div class="big">${r(rwf.fixed.expectancy)}</div>
          <div class="sub">${rwf.fixed.n} ไม้ · ชนะ ${pct(rwf.fixed.winRate)} · รวม ${r(rwf.fixed.totalR)}</div>
        </div>
        <div class="wf-side">
          <h4>สิ่งที่เรียนรู้นิ่งแค่ไหน</h4>
          <div class="big" style="color:${stabColor}">${stabLabel}</div>
          <div class="sub">ค่าที่จูนได้ต่างกันระหว่างช่วงเฉลี่ย ${rwf.stability.avgCv === null ? '—' : (rwf.stability.avgCv * 100).toFixed(0) + '%'}</div>
        </div>
      </div>
    </div>

    <table class="learn-table"><thead><tr>
      <th>ช่วงสอบ</th><th>ช่วงเวลา</th><th>คะแนนขั้นต่ำ</th><th>SL (×ATR)</th><th>เป้า (×เสี่ยง)</th>
      <th>ไม้</th><th>ผล (ปรับเอง)</th><th>ผล (คงที่)</th>
    </tr></thead><tbody>${foldRows}</tbody></table>
    <p class="tiny">
      ทุกแถวคือช่วงที่ระบบ<b>ไม่เคยเห็นตอนจูน</b> — ค่าในคอลัมน์กลางจูนจากข้อมูลก่อนหน้าช่วงนั้นเท่านั้น
      และหยุดรับไม้ก่อนถึงเส้นแบ่ง ${settings.maxHold} แท่ง เพื่อให้ไม้ทุกไม้ที่ใช้จูนปิดก่อนเส้นแบ่งแน่นอน
    </p>

    <div class="adapt-story">${story}</div>`;
}

/**
 * เรียนรู้น้ำหนักปัจจัยจากข้อมูลจริงของผู้ใช้ แล้วสอบกับช่วงที่ไม่เคยเห็น
 *
 * เหตุผลที่ต้องทำในเบราว์เซอร์ ไม่ใช่ฝังตัวเลขมาให้:
 * น้ำหนักที่ "ดีที่สุด" ขึ้นกับสินทรัพย์ กรอบเวลา และช่วงตลาดที่คุณโหลดมา
 * ตัวเลขที่ฟิตจากข้อมูลชุดอื่นแล้วฝังมา ก็คือการเดาอีกแบบหนึ่ง
 */
function doLearn() {
  if (!state.ctx || state.candles.length < 600) {
    $('learnStatus').textContent = 'ต้องมีข้อมูลอย่างน้อย ~600 แท่งถึงจะแบ่งช่วงเรียนรู้/ช่วงสอบได้ (ตอนนี้ ' + state.candles.length + ')';
    return;
  }
  $('learnStatus').textContent = 'กำลังเรียนรู้และสอบ… (สุ่มทดสอบซ้ำหลายพันรอบ ใช้เวลาสักครู่)';
  $('applyLearn').hidden = true;
  setTimeout(() => {
    const t0 = performance.now();
    // ฟิตกับน้ำหนัก "ตั้งต้นจากตำรา" เสมอ ไม่ใช่กับน้ำหนักที่เพิ่งใช้อยู่
    // ไม่งั้นกดซ้ำ ๆ น้ำหนักจะไหลไปเรื่อย ๆ โดยไม่มีอะไรพิสูจน์รอบใหม่
    const baseCtx = { ...state.ctx, cfg: { ...state.ctx.cfg, weights: undefined } };
    state.learn = learnAndValidate(baseCtx, {
      keys: Object.keys(WEIGHTS), baseWeights: WEIGHTS, threshold: settings.threshold,
      backtest: { maxHold: settings.maxHold, spread: settings.spread, useFilters: settings.volFilter },
    });
    $('learnStatus').textContent = `เสร็จใน ${(performance.now() - t0).toFixed(0)} มิลลิวินาที`;
    renderLearn();
  }, 20);
}

function applyLearned(weights) {
  settings.learnedWeights = weights || null;
  saveSettings();
  analyze(false, false);   // คำนวณใหม่ทั้งระบบด้วยน้ำหนักชุดใหม่
  doBacktest();
  renderLearn();
}

const FACTOR_NAMES = {
  emaTrend: 'เส้นค่าเฉลี่ย', adxTrend: 'ความแรงแนวโน้ม', macdMom: 'แรงส่งของราคา',
  rsiMom: 'แรงซื้อ-แรงขาย', structure: 'โครงสร้างราคา', patterns: 'รูปแบบแท่งเทียน',
  volume: 'ปริมาณซื้อขาย', bands: 'กรอบความผันผวน', levels: 'แนวรับ-แนวต้าน',
  divergence: 'สัญญาณแรงหมด', vwap: 'เทียบต้นทุนเฉลี่ย', stoch: 'จุดตัดระยะสั้น',
};

function renderLearn() {
  const el = $('learnBox');
  const L = state.learn;
  const using = !!settings.learnedWeights;
  $('resetLearn').hidden = !using;
  if (!L) {
    el.innerHTML = using ? '<div class="wf-card ok"><div class="wf-verdict">กำลังใช้น้ำหนักชุดที่เรียนรู้ไว้</div></div>' : '';
    return;
  }
  if (!L.ok) {
    $('applyLearn').hidden = true;
    el.innerHTML = `<div class="wf-card weak"><div class="wf-verdict">ยังเรียนรู้น้ำหนักไม่ได้</div>
      <div class="tiny" style="margin:0">${L.reason}</div></div>`;
    return;
  }
  $('applyLearn').hidden = !L.verdict.apply || using;

  const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);
  const r = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(3)}R`);
  const a = L.outBase, b = L.outNew;
  const rows = L.coefficients.map((c) => {
    const d = c.delta;
    const arrow = Math.abs(d) < 0.3 ? '=' : d > 0 ? '▲' : '▼';
    const col = Math.abs(d) < 0.3 ? 'var(--muted)' : d > 0 ? 'var(--up)' : 'var(--down)';
    return `<tr>
      <td>${FACTOR_NAMES[c.key] || c.key}</td>
      <td class="num">${c.base.toFixed(0)}</td>
      <td class="num" style="color:${col}">${c.weight.toFixed(1)} ${arrow}</td>
      <td class="num" title="สุ่มข้อมูลซ้ำแล้วปัจจัยนี้ยังช่วยทำนายไปทางเดิมกี่เปอร์เซ็นต์ของรอบ">
        ${c.live ? (c.posFrac * 100).toFixed(0) + '%' : '—'}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="wf-card ${L.verdict.level === 'better' ? 'good' : L.verdict.level === 'worse' ? 'bad' : 'ok'}">
      <div class="wf-verdict">${L.verdict.text}</div>
      <div class="wf-compare">
        <div class="wf-side">
          <h4>ช่วงสอบ · น้ำหนักเดิม</h4>
          <div class="big">${pct(a.winRate)}</div>
          <div class="sub">${a.n} ไม้ · ค่าคาดหวัง ${r(a.expectancy)}</div>
        </div>
        <div class="wf-side ${L.verdict.apply ? 'trusted' : ''}">
          <h4>ช่วงสอบ · น้ำหนักที่เรียนรู้</h4>
          <div class="big">${pct(b.winRate)}</div>
          <div class="sub">${b.n} ไม้ · ค่าคาดหวัง ${r(b.expectancy)}</div>
        </div>
        <div class="wf-side">
          <h4>เชื่อได้แค่ไหน</h4>
          <div class="big">${L.verdict.probBetter === null || L.verdict.probBetter === undefined ? '—' : (L.verdict.probBetter * 100).toFixed(0) + '%'}</div>
          <div class="sub">สุ่มทดสอบซ้ำ 2,000 รอบ ชุดใหม่ชนะกี่เปอร์เซ็นต์ของรอบ (ต้องการ ≥ 90%)</div>
        </div>
      </div>
      <div class="tiny" style="margin:.6rem 0 0">
        เรียนรู้จาก <b>${L.rows} ไม้</b> ในช่วงแรกของข้อมูล (ใช้เกณฑ์คะแนน ${L.learnThreshold} เพื่อเก็บตัวอย่างให้มากพอ)
        แล้วสอบด้วยเกณฑ์จริง ${L.threshold} · ข้อมูลเท่านี้มีสิทธิ์ขยับน้ำหนักได้ <b>${(L.blend * 100).toFixed(0)}%</b>
        ที่เหลือยังยึดน้ำหนักเดิม — ยิ่งเก็บไม้ได้มาก ข้อมูลยิ่งมีสิทธิ์มากขึ้นเอง
      </div>
    </div>
    <table class="learn-table"><thead><tr>
      <th>ปัจจัย</th><th>น้ำหนักเดิม</th><th>ที่เรียนรู้ได้</th><th>ความนิ่ง</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderFactorTable() {
  const el = $('btFactors');
  if (!el || !state.bt || !state.bt.factors) return;
  const names = {
    emaTrend: 'เส้นค่าเฉลี่ย', adxTrend: 'ความแรงแนวโน้ม', macdMom: 'แรงส่งของราคา',
    rsiMom: 'แรงซื้อ-แรงขาย', structure: 'โครงสร้างราคา', patterns: 'รูปแบบแท่งเทียน',
    volume: 'ปริมาณซื้อขาย', bands: 'กรอบความผันผวน', levels: 'แนวรับ-แนวต้าน',
    divergence: 'สัญญาณแรงหมด', vwap: 'เทียบต้นทุนเฉลี่ย', stoch: 'จุดตัดระยะสั้น',
  };
  const rows = state.bt.factors.filter((f) => f.nAgree + f.nAgainst >= 8);
  el.innerHTML = rows.length ? `<table><thead><tr>
      <th>ปัจจัย</th><th>ตอนมันเห็นด้วย</th><th>ตอนมันค้าน</th><th>ส่วนต่าง</th></tr></thead><tbody>
    ${rows.map((f) => `<tr>
      <td>${names[f.key] || f.key}</td>
      <td class="num">${f.winAgree === null ? '—' : f.winAgree.toFixed(0) + '%'} <span style="color:var(--muted)">(${f.nAgree})</span></td>
      <td class="num">${f.winAgainst === null ? '—' : f.winAgainst.toFixed(0) + '%'} <span style="color:var(--muted)">(${f.nAgainst})</span></td>
      <td class="num" style="color:${f.edge === null ? 'var(--muted)' : f.edge > 5 ? 'var(--up)' : f.edge < -5 ? 'var(--down)' : 'var(--muted)'}">
        ${f.edge === null ? '—' : (f.edge > 0 ? '+' : '') + f.edge.toFixed(0)}</td>
    </tr>`).join('')}</tbody></table>
    <p class="tiny">อ่านยังไง: ส่วนต่างเป็นบวกมาก = เวลาปัจจัยนี้เห็นด้วยกับทิศทางที่เข้า ไม้มักชนะกว่าตอนมันค้าน
    แปลว่าปัจจัยนี้ทำนายได้จริง · ส่วนต่างติดลบ = ปัจจัยนี้ให้สัญญาณสวนทางความจริงในข้อมูลชุดนี้
    ควรลดน้ำหนักลงในแท็บตั้งค่า (ตัวเลขในวงเล็บคือจำนวนไม้ ยิ่งน้อยยิ่งเชื่อได้น้อย)</p>`
    : '<p class="tiny">ยังมีไม้ไม่พอจะแยกผลงานรายปัจจัย</p>';
}

function renderBacktest() {
  const bt = state.bt;
  if (!bt) return;
  const s = bt.stats;
  if (!s.n) {
    $('btSummary').innerHTML = '<div class="stat"><b>0</b><span>ไม่พบสัญญาณที่ผ่านเกณฑ์ในข้อมูลชุดนี้ — ลองลดคะแนนขั้นต่ำ</span></div>';
    $('btBands').innerHTML = ''; $('btSessions').innerHTML = ''; $('btTrades').innerHTML = '';
    drawEquity();
    return;
  }
  const ci = wilsonInterval(bt.trades.filter((t) => t.hit1R).length, s.n);
  const stat = (label, value, cls = '') => `<div class="stat ${cls}"><b>${value}</b><span>${label}</span></div>`;
  $('btSummary').innerHTML = [
    stat('จำนวนไม้ที่ระบบเข้า', s.n),
    stat('อัตราถึงเป้า 1R', `${s.winRate.toFixed(1)}%`, s.expectancy > 0 ? 'good' : 'bad'),
    stat('ช่วงเชื่อมั่น 95%', ci ? `${ci.low.toFixed(0)}–${ci.high.toFixed(0)}%` : '—'),
    stat('ค่าคาดหวังต่อไม้', `${s.expectancy.toFixed(3)}R`, s.expectancy > 0 ? 'good' : 'bad'),
    stat('กำไรรวม', `${s.totalR.toFixed(1)}R`, s.totalR > 0 ? 'good' : 'bad'),
    stat('Profit Factor', s.profitFactor ? s.profitFactor.toFixed(2) : '∞', s.profitFactor >= 1.3 ? 'good' : 'bad'),
    stat('ขาดทุนสูงสุดสะสม', `-${s.maxDD.toFixed(1)}R`, s.maxDD > 8 ? 'bad' : ''),
    stat('แพ้ติดกันสูงสุด', `${s.maxLossStreak} ไม้`),
    stat('เฉลี่ยถือกี่แท่ง', s.avgBars.toFixed(0)),
    stat('ไม้ที่ชนะวิ่งไปเฉลี่ย', s.avgMaxFavWinners ? `${s.avgMaxFavWinners.toFixed(2)}R` : '—'),
  ].join('');

  const beNote = `<p class="tiny" style="grid-column:1/-1;margin-top:2px">
    <b>อัตราชนะต่ำไม่ได้แปลว่าแย่</b> — สิ่งที่ตัดสินว่ากำไรหรือขาดทุนคือ "ค่าคาดหวังต่อไม้"
    ที่อัตราส่วนได้:เสีย 1:1 ต้องชนะเกิน 50% · ที่ 2:1 ชนะแค่ 34% ก็กำไร · ที่ 3:1 ชนะแค่ 25% ก็พอ
    ระบบนี้ชนะ ${s.winRate.toFixed(0)}% และค่าคาดหวัง ${s.expectancy >= 0 ? '+' : ''}${s.expectancy.toFixed(3)} เท่าของเงินที่เสี่ยง —
    <b style="color:${s.expectancy > 0 ? 'var(--up)' : 'var(--down)'}">${s.expectancy > 0 ? 'เป็นบวก คือใช้ได้' : 'ติดลบ คือยังไม่ได้'}</b></p>`;

  const expl = s.expectancy > 0.05
    ? `<p class="tiny" style="color:var(--up)">ค่าคาดหวัง +${s.expectancy.toFixed(3)}R ต่อไม้ หมายความว่าถ้าเสี่ยง $${(settings.account * settings.riskPct / 100).toFixed(0)} ต่อไม้ ระบบนี้ให้ผลเฉลี่ย ~$${(settings.account * settings.riskPct / 100 * s.expectancy).toFixed(2)} ต่อไม้ในข้อมูลชุดนี้ — และเคยขาดทุนติดกันสูงสุด ${s.maxLossStreak} ไม้ ต้องมีทุนและใจพอทนช่วงนั้น</p>`
    : `<p class="tiny" style="color:var(--down)">ค่าคาดหวังติดลบในข้อมูลชุดนี้ — ยังไม่ควรเทรดตามเกณฑ์ปัจจุบัน ลองเพิ่มคะแนนขั้นต่ำ เปลี่ยนกรอบเวลา หรือดูตารางช่วงเวลาว่าควรเลี่ยงชั่วโมงไหน</p>`;
  $('btSummary').innerHTML += beNote + `<div style="grid-column:1/-1">${expl}</div>`;

  const maxN = Math.max(...bt.bands.map((b) => b.n), 1);
  $('btBands').innerHTML = `<table><thead><tr><th>ช่วงคะแนน</th><th>จำนวนไม้</th><th>อัตราชนะ</th><th>ค่าคาดหวัง</th></tr></thead><tbody>
    ${bt.bands.map((b) => `<tr class="${b.winRate !== null && b.winRate === Math.max(...bt.bands.filter((x) => x.n >= 10).map((x) => x.winRate || 0)) && b.n >= 10 ? 'best' : ''}">
      <td>${b.label}</td>
      <td class="num bar-cell"><i style="width:${(b.n / maxN) * 100}%"></i>${b.n}</td>
      <td class="num">${b.winRate !== null ? b.winRate.toFixed(1) + '%' : '—'}</td>
      <td class="num">${b.avgR !== null ? b.avgR.toFixed(2) + 'R' : '—'}</td>
    </tr>`).join('')}</tbody></table>
    <p class="tiny">ยิ่งคะแนนสูง อัตราชนะควรยิ่งสูงตาม — ถ้าไม่เป็นเช่นนั้นแปลว่าน้ำหนักปัจจัยยังไม่เหมาะกับตลาดช่วงนี้ (ตัวอย่างต่ำกว่า 20 ไม้ ยังสรุปไม่ได้)</p>`;

  const bestSess = bt.sessions.filter((x) => x.n >= 8).sort((a, b) => (b.winRate || 0) - (a.winRate || 0))[0];
  $('btSessions').innerHTML = `<table><thead><tr><th>ช่วงเวลา</th><th>ไม้</th><th>อัตราชนะ</th><th>ค่าคาดหวัง</th></tr></thead><tbody>
    ${bt.sessions.map((b) => `<tr class="${bestSess && b.key === bestSess.key ? 'best' : ''}">
      <td>${b.label}</td><td class="num">${b.n}</td>
      <td class="num">${b.winRate !== null ? b.winRate.toFixed(1) + '%' : '—'}</td>
      <td class="num">${b.avgR !== null ? b.avgR.toFixed(2) + 'R' : '—'}</td>
    </tr>`).join('')}</tbody></table>
    ${bestSess ? `<p class="tiny">ช่วงที่ระบบทำผลงานดีที่สุดในข้อมูลชุดนี้คือ <b>${bestSess.label}</b> (${bestSess.winRate.toFixed(0)}% จาก ${bestSess.n} ไม้) — ใช้เป็นแนวทางเลือก "จังหวะเวลา" เข้าเทรด</p>` : ''}
    <table style="margin-top:10px"><thead><tr><th>ทิศทาง</th><th>ไม้</th><th>อัตราชนะ</th><th>ค่าคาดหวัง</th></tr></thead><tbody>
    ${bt.bySide.map((b) => `<tr><td>${b.side > 0 ? 'ฝั่งซื้อ (Long)' : 'ฝั่งขาย (Short)'}</td><td class="num">${b.n}</td>
      <td class="num">${b.winRate !== null ? b.winRate.toFixed(1) + '%' : '—'}</td>
      <td class="num">${b.avgR !== null ? b.avgR.toFixed(2) + 'R' : '—'}</td></tr>`).join('')}</tbody></table>`;

  const recent = bt.trades.slice(-12).reverse();
  $('btTrades').innerHTML = `<h3 style="margin-top:16px">12 ไม้ล่าสุดที่ระบบเข้า</h3>
    <table><thead><tr><th>เวลา (ไทย)</th><th>ทิศทาง</th><th>คะแนน</th><th>เข้า</th><th>SL</th><th>ผล</th><th>R</th></tr></thead><tbody>
    ${recent.map((t) => `<tr>
      <td>${thTime(t.t)}</td>
      <td style="color:${t.side > 0 ? 'var(--up)' : 'var(--down)'}">${t.side > 0 ? 'ซื้อ' : 'ขาย'}</td>
      <td class="num">${t.score.toFixed(0)}</td>
      <td class="num">${t.entry.toFixed(2)}</td>
      <td class="num">${t.sl.toFixed(2)}</td>
      <td>${t.result === 'loss' ? 'โดน SL' : t.result === 'timeout' ? 'หมดเวลาถือ' : t.result === 'win2R' ? 'ถึง 2R' : 'ถึง 1R แล้วกลับมาทุน'}</td>
      <td class="num" style="color:${t.rMultiple > 0 ? 'var(--up)' : 'var(--down)'}">${t.rMultiple.toFixed(2)}</td>
    </tr>`).join('')}</tbody></table>`;
  renderFactorTable();
  drawEquity();
}

function drawEquity() {
  const cv = $('equityCanvas');
  const g = equityCtx;
  if (!g) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300, h = 150;
  cv.width = w * dpr; cv.height = h * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const eq = state.bt ? state.bt.equity : [];
  if (!eq.length) {
    g.fillStyle = '#94a3b8'; g.font = '12px system-ui'; g.textAlign = 'center';
    g.fillText('ยังไม่มีผลทดสอบ', w / 2, h / 2); g.textAlign = 'left';
    return;
  }
  const vals = eq.map((e) => e.eq);
  const min = Math.min(0, ...vals), max = Math.max(0.5, ...vals);
  const x = (i) => 8 + (i / Math.max(1, eq.length - 1)) * (w - 16);
  const y = (v) => 12 + ((max - v) / (max - min)) * (h - 28);
  g.strokeStyle = 'rgba(148,163,184,0.25)';
  g.beginPath(); g.moveTo(8, y(0)); g.lineTo(w - 8, y(0)); g.stroke();
  g.beginPath();
  g.moveTo(x(0), y(vals[0]));
  vals.forEach((v, i) => g.lineTo(x(i), y(v)));
  g.strokeStyle = vals[vals.length - 1] >= 0 ? '#22c55e' : '#ef4444';
  g.lineWidth = 1.8; g.stroke();
  g.lineTo(x(vals.length - 1), y(0)); g.lineTo(x(0), y(0)); g.closePath();
  g.fillStyle = vals[vals.length - 1] >= 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
  g.fill();
  g.fillStyle = '#94a3b8'; g.font = '10px ui-monospace, monospace';
  g.fillText(`${max.toFixed(1)}R`, 10, 12);
  g.fillText(`${min.toFixed(1)}R`, 10, h - 6);
}

// ── บริบทตลาด ───────────────────────────────────────────────────────────
function renderContextTab() {
  const now = new Date();
  const sess = sessionInfo(now);
  const risk = riskWindow(now, state.events, 30);
  $('sessionBox').innerHTML = `
    <div class="kv"><span>ช่วงตลาด</span><span>${sess.label}</span></div>
    <div class="kv"><span>คุณภาพสภาพคล่อง</span><span>${(sess.quality * 100).toFixed(0)}%</span></div>
    <div class="kv"><span>เวลาไทยตอนนี้</span><span>${now.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })}</span></div>
    <p class="tiny">${sess.detail}</p>`;

  const nfp = nextNFP(now);
  $('newsBox').innerHTML = [
    risk.blocked ? `<div class="news-item"><span class="badge hot">กำลังอยู่ในช่วงข่าว</span><span>${risk.active.map((e) => e.title).join(', ')}</span></div>` : '',
    `<div class="news-item"><span>US Non-Farm Payrolls (คำนวณอัตโนมัติ)</span><span>${nfp ? thTime(nfp) : '—'}</span></div>`,
    ...state.events.slice().sort((a, b) => new Date(a.time) - new Date(b.time)).map((e, i) => `
      <div class="news-item"><span>${e.title}</span><span>${thTime(e.time)} <button class="btn tiny-btn" data-ev="${i}">ลบ</button></span></div>`),
  ].join('');
  $('newsBox').querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => {
    const idx = +b.dataset.ev;
    const sorted = state.events.slice().sort((a, b2) => new Date(a.time) - new Date(b2.time));
    state.events = state.events.filter((e) => e !== sorted[idx]);
    saveEvents(); renderContextTab();
  }));

  if (state.scored && state.scored.ready) {
    const sc = state.scored;
    $('regimeBox').innerHTML = `
      <div class="kv"><span>โหมดตลาด</span><span>${sc.regime === 'trend' ? 'มีเทรนด์' : 'ออกข้าง'}</span></div>
      <div class="kv"><span>ADX(14)</span><span>${sc.adx ? sc.adx.toFixed(1) : '—'}</span></div>
      <div class="kv"><span>RSI(14)</span><span>${sc.rsi ? sc.rsi.toFixed(1) : '—'}</span></div>
      <div class="kv"><span>ATR(14)</span><span>${sc.atr.toFixed(2)} (${sc.atrPct.toFixed(2)}%)</span></div>
      <div class="kv"><span>โครงสร้าง</span><span>${sc.structure.label}</span></div>
      <div class="kv"><span>แนวรับใกล้สุด</span><span>${sc.support ? sc.support.toFixed(2) : '—'}</span></div>
      <div class="kv"><span>แนวต้านใกล้สุด</span><span>${sc.resistance ? sc.resistance.toFixed(2) : '—'}</span></div>
      ${fibHtml()}
      <p class="tiny">ATR คือระยะแกว่งเฉลี่ยต่อแท่ง ใช้ตั้ง SL ให้กว้างพอไม่โดน noise เขี่ยออก และใช้ประเมินว่าเป้าหมายที่ตั้งไว้ "ไปถึงได้จริงไหมในเวลาที่ถือ"</p>`;
  }

  if (state.candles.length) {
    const c = state.candles;
    const first = c[0], last = c[c.length - 1];
    const highs = c.map((x) => x.h), lows = c.map((x) => x.l);
    const hi = Math.max(...highs), lo = Math.min(...lows);
    const rets = c.slice(1).map((x, i) => Math.log(x.c / c[i].c));
    const sd = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length) * 100;
    $('statsBox').innerHTML = `
      <div class="kv"><span>ช่วงข้อมูล</span><span>${thTime(first.t)} → ${thTime(last.t)}</span></div>
      <div class="kv"><span>จำนวนแท่ง</span><span>${c.length} (${TF[state.tf].label})</span></div>
      <div class="kv"><span>สูงสุด / ต่ำสุด</span><span>${hi.toFixed(2)} / ${lo.toFixed(2)}</span></div>
      <div class="kv"><span>ผลตอบแทนรวม</span><span style="color:${last.c >= first.c ? 'var(--up)' : 'var(--down)'}">${(((last.c - first.c) / first.c) * 100).toFixed(2)}%</span></div>
      <div class="kv"><span>ผันผวนต่อแท่ง (SD)</span><span>${sd.toFixed(3)}%</span></div>
      <div class="kv"><span>ราคาทองไทยโดยประมาณ</span><span>${Math.round(xauToThaiBaht(last.c, settings.usdThb)).toLocaleString('th-TH')} บาท</span></div>
      <p class="tiny">ราคาทองไทยคำนวณจาก XAU/USD × ความบริสุทธิ์ 96.5% × น้ำหนัก 15.244 กรัม/บาท × อัตรา USD/THB ที่ตั้งไว้ — เป็นค่าอ้างอิงเชิงคำนวณ ไม่รวมค่ากันเหนียว/ส่วนต่างผู้ค้า จึงต่างจากราคาประกาศของสมาคมค้าทองคำได้</p>`;
  }
}

/** ระดับ Fibonacci ของขาล่าสุด — โซนที่ราคามักย่อมาแล้วไปต่อ (จังหวะเข้าไม้ที่ความเสี่ยงต่ำกว่าไล่ราคา) */
function fibHtml() {
  if (!state.ctx) return '';
  const i = state.candles.length - 1;
  const fib = fibLevels(state.ctx.pivots, i);
  if (!fib) return '';
  const price = state.candles[i].c;
  const rows = fib.levels.map((l) => {
    const hit = Math.abs(l.price - price) < (state.scored && state.scored.atr ? state.scored.atr * 0.4 : 0);
    return `<div class="kv"><span>${hit ? '➤ ' : ''}Fib ${(l.ratio * 100).toFixed(1)}%</span><span${hit ? ' style="color:var(--gold)"' : ''}>${l.price.toFixed(2)}</span></div>`;
  }).join('');
  return `<div style="margin-top:8px"><b style="font-size:11.5px;color:var(--muted)">แนวย่อ Fibonacci ของขา${fib.direction === 'up' ? 'ขึ้น' : 'ลง'}ล่าสุด (${fib.from.toFixed(2)} → ${fib.to.toFixed(2)})</b>${rows}</div>`;
}

function renderWeights() {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const names = {
    emaTrend: 'การเรียงตัวเส้นค่าเฉลี่ย', adxTrend: 'ความแรงเทรนด์ (ADX/DI)', macdMom: 'โมเมนตัม MACD',
    rsiMom: 'RSI ตามสภาพตลาด', structure: 'โครงสร้าง Swing (HH/HL)', patterns: 'รูปแบบแท่งเทียน',
    volume: 'ปริมาณซื้อขายยืนยัน', bands: 'Bollinger (บีบตัว/ขอบแบนด์)', levels: 'แนวรับ-แนวต้าน',
    divergence: 'RSI Divergence', vwap: 'ตำแหน่งเทียบ VWAP', stoch: 'Stochastic ตัดกัน',
  };
  $('weightBox').innerHTML = Object.entries(WEIGHTS).map(([k, w]) => `
    <div class="mtf-row"><span style="font-size:11px">${w}</span>
      <div class="mtf-bar"><i style="background:var(--accent);left:0;width:${(w / 20) * 100}%"></i></div>
      <span style="font-size:11px;text-align:left;white-space:nowrap">${names[k]}</span>
    </div>`).join('') + `<p class="tiny">น้ำหนักรวม ${total} — คะแนน 100 คือทุกปัจจัยเห็นตรงกันเต็มที่ (แทบไม่เกิดขึ้นจริง คะแนน 45+ ถือว่าแข็งแรงมากแล้ว)</p>`;
}

// ── แจ้งเตือน UI ────────────────────────────────────────────────────────
function renderAlertUI() {
  $('togSound').checked = alerts.sound;
  $('togSpeak').checked = alerts.speak;
  $('webhookInput').value = alerts.webhookUrl;
  $('cooldownInput').value = alerts.cooldownMs / 60000;
  renderRules();
  renderLog();
}

function renderRules() {
  const labels = { price_above: 'ราคา ≥', price_below: 'ราคา ≤', rsi_above: 'RSI ≥', rsi_below: 'RSI ≤' };
  $('ruleList').innerHTML = alerts.rules.length
    ? alerts.rules.map((r) => `<div class="rule-item">
        <span>${labels[r.type]} <b>${r.value}</b> ${r.once ? '(ครั้งเดียว)' : '(ทุกครั้ง)'} ${r.active ? '' : '<span class="badge">ทำงานแล้ว</span>'}</span>
        <button class="btn tiny-btn" data-rid="${r.id}">ลบ</button></div>`).join('')
    : '<p class="tiny">ยังไม่มีกฎ — เช่น ตั้งเตือนเมื่อราคาทะลุแนวต้านสำคัญ เพื่อไม่ต้องเฝ้าจอ</p>';
  $('ruleList').querySelectorAll('[data-rid]').forEach((b) => b.addEventListener('click', () => {
    alerts.removeRule(+b.dataset.rid); renderRules();
  }));
}

function renderLog() {
  $('logList').innerHTML = alerts.log.length
    ? alerts.log.map((l) => `<div class="log-item ${l.kind}">
        <div class="lh"><span>${l.title}</span><span class="lt">${new Date(l.ts).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })}</span></div>
        <div class="lb">${(l.body || '').replace(/\n/g, '<br>')}</div></div>`).join('')
    : '<p class="tiny">ยังไม่มีการแจ้งเตือน</p>';
}

function toast(entry) {
  const el = document.createElement('div');
  el.className = 'toast ' + (entry.kind || 'info');
  el.innerHTML = `<b>${entry.title}</b><p>${(entry.body || '').replace(/\n/g, '<br>')}</p>`;
  $('toastWrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 9000);
}

/**
 * เฝ้าดูว่าราคายังไหลอยู่หรือค้างไปแล้ว
 *
 * ไม่ใช่แค่เตือน — ถ้าค้างจริงต้องพยายามต่อใหม่ให้ด้วย
 * เพราะสาเหตุที่พบบ่อยที่สุด (WebSocket ครึ่งใบ) แก้ได้ด้วยการต่อใหม่เท่านั้น
 */
let staleSince = 0;
function checkFreshness(force = false) {
  const f = feed.freshness();
  const bar = $('staleBar');
  if (!bar) return;
  if (!f.stale) {
    if (staleSince) {   // เพิ่งกลับมาปกติ — คำนวณใหม่ทันที ไม่ต้องรอแท่งถัดไป
      staleSince = 0;
      bar.hidden = true;
      analyze(false, false);
    }
    if (force && f.unknown) return;
    return;
  }
  const secs = Math.round(f.ageMs / 1000);
  bar.hidden = false;
  bar.textContent = `⚠ ราคาหยุดอัปเดตมา ${secs > 90 ? Math.round(secs / 60) + ' นาที' : secs + ' วินาที'} — `
    + 'ตัวเลขบนจออาจไม่ใช่ราคาปัจจุบัน ระบบระงับสัญญาณไว้แล้ว กำลังต่อใหม่…';
  if (!staleSince) {
    staleSince = Date.now();
    analyze(false, false);   // ให้ตัวกรอง "ข้อมูลค้าง" มีผลทันที
  }
  // ต่อใหม่ทุก 20 วินาทีระหว่างที่ยังค้าง แต่ไม่ถี่กว่านั้น จะได้ไม่กระหน่ำเซิร์ฟเวอร์
  if (force || Date.now() - staleSince > 20000) {
    staleSince = Date.now();
    reload();
  }
}

function setStatus(stateName, msg) {
  const dot = $('statusDot');
  dot.className = 'dot ' + (stateName === 'live' ? 'live' : stateName === 'error' ? 'error' : stateName === 'demo' ? 'demo' : '');
  $('statusText').textContent = msg;
}

init();
