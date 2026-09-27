/**
 * bot/run.mjs — บอทเฝ้าสัญญาณ รันบน GitHub Actions แล้วส่งเข้า Discord
 *
 * หน้าเว็บเตือนได้เฉพาะตอนเปิดค้างไว้ บอทตัวนี้รันบนเครื่องของ GitHub จึงเตือนได้แม้ปิดเครื่อง
 * ฟรีสำหรับรีโปสาธารณะ · URL ของ webhook เก็บเป็น Secret ไม่โผล่ในหน้าเว็บ
 *
 * ใช้กติกาจาก js/system.js ตัวเดียวกับหน้าเว็บเป๊ะ ๆ ไม่มีสูตรคำนวณของตัวเอง
 * ระบบเก่าเคยให้บอทคิดคะแนนคนละสูตรกับเว็บ ตัวเลขในสองที่จึงไม่ตรงกัน — ห้ามเกิดอีก
 *
 * ข้อจำกัด: ตัวตั้งเวลาของ GitHub ไม่ตรงเป๊ะ บางช่วงช้าหรือข้ามรอบ
 * กติกาใช้กราฟ 4 ชม. สัญญาณมีอายุหนึ่งแท่ง (4 ชม.) จึงยังทันแม้บอทมาช้าไปหลายสิบนาที
 */
import {
  RULE, COSTS, H4, D1, resample, markClosed, spotBarsOnly, buildSystem, currentState, sizePlan, planAt,
} from '../js/system.js';
import { REFERENCE } from '../js/reference.js';
import { SOURCES } from '../js/sources.js';
import { sendDiscord, buildSignalMessage, webhookProblem } from '../js/discord.js';
import { goldMarketOpen, thTime } from '../js/macro.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const CFG = {
  // เรียงตามความใกล้เคียงราคาทองจริง เจ้าแรกที่ตอบครบทั้งกราฟรายวันและ 4 ชม. ก็ใช้เจ้านั้น
  sources: env('BOT_SOURCES', 'kraken_paxg,bitfinex_xaut,binance_paxg,okx_paxg').split(',').map((s) => s.trim()).filter(Boolean),
  account: +env('BOT_ACCOUNT', 1000),
  riskPct: +env('BOT_RISK_PCT', 2),
  contractSize: +env('BOT_CONTRACT_SIZE', 100),
  minLot: +env('BOT_MIN_LOT', 0.01),
  lotStep: +env('BOT_LOT_STEP', 0.01),
  spread: +env('BOT_SPREAD', COSTS.spread),
  sides: env('BOT_SIDES', 'both'),
  statePath: env('BOT_STATE', 'bot/.state.json'),
  webhook: env('DISCORD_WEBHOOK_URL', ''),
  dryRun: process.env.BOT_DRY_RUN === '1',
  testPing: process.env.BOT_TEST_PING === '1',
};
/* ค่ารุ่นเก่าที่ไม่มีความหมายแล้ว — ถ้ายังตั้งไว้ต้องบอก ไม่ใช่เมินเงียบ ๆ */
const RETIRED = ['BOT_INTERVAL', 'BOT_THRESHOLD', 'BOT_EXIT_STYLE', 'BOT_ENTRY_MODE', 'BOT_BARS'];

const log = (...a) => console.log(new Date().toISOString(), ...a);
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');

function loadState() {
  try { return JSON.parse(readFileSync(CFG.statePath, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) {
  try {
    mkdirSync(CFG.statePath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(CFG.statePath, JSON.stringify(s, null, 2));
  } catch (e) { log('บันทึกสถานะไม่ได้:', e.message); }
}

async function fetchBars(key, tf, limit) {
  const src = SOURCES[key];
  const res = await fetch(src.url(src.tf[tf], limit));
  if (!res.ok) throw new Error(`รหัส ${res.status}`);
  return src.parse(await res.json());
}

/**
 * ดึงกราฟรายวันและกราฟ 4 ชม. จากแหล่งเดียวกัน — ไม่เอาราคาคนละตลาดมาเทียบกัน
 * แหล่งที่ไม่มีกราฟ 4 ชม. ให้ตรง ๆ ใช้กราฟ 1 ชม. มารวมเอง (ตั้งเวลาแท่งเหมือนกันทุกแหล่ง)
 */
async function loadData() {
  const attempts = [];
  for (const key of CFG.sources) {
    const src = SOURCES[key];
    if (!src || src.needsKey) { attempts.push({ key, reason: src ? 'ต้องใช้คีย์' : 'ไม่รู้จักแหล่งนี้' }); continue; }
    if (src.tf['1d'] === undefined) { attempts.push({ key, reason: 'ไม่มีกราฟรายวัน' }); continue; }
    try {
      const d1 = await fetchBars(key, '1d', 400);
      const h4 = src.tf['4h'] !== undefined ? await fetchBars(key, '4h', 720) : resample(await fetchBars(key, '1h', 1000), H4);
      if (d1.length < 80 || h4.length < 60) { attempts.push({ key, reason: `ข้อมูลน้อยไป (รายวัน ${d1.length} · 4 ชม. ${h4.length})` }); continue; }
      log(`ใช้ข้อมูลจาก ${src.label} · รายวัน ${d1.length} แท่ง · 4 ชม. ${h4.length} แท่ง`);
      return { d1, h4, key, label: src.label, attempts };
    } catch (e) { attempts.push({ key, reason: e.message }); }
  }
  return { attempts };
}

/*
 * ตรวจค่าตั้งค่าก่อนเริ่ม — ค่าจาก Variables ของ GitHub พิมพ์ผิดง่าย ("1,000" กลายเป็น NaN)
 * บอทที่ตั้งผิดจะเงียบทั้งวันโดยทุกรอบขึ้นติกเขียว แยกไม่ออกจาก "ตลาดยังไม่มีจังหวะ"
 */
function checkConfig() {
  const bad = [];
  const pos = (label, v, name) => { if (!Number.isFinite(v) || v <= 0) bad.push(`${name} (${label}) = ${JSON.stringify(process.env[name])} → ใช้เป็นตัวเลขไม่ได้`); };
  pos('ทุน', CFG.account, 'BOT_ACCOUNT');
  pos('ความเสี่ยงต่อไม้', CFG.riskPct, 'BOT_RISK_PCT');
  pos('ออนซ์ต่อล็อต', CFG.contractSize, 'BOT_CONTRACT_SIZE');
  pos('ล็อตเล็กสุด', CFG.minLot, 'BOT_MIN_LOT');
  pos('ขั้นล็อต', CFG.lotStep, 'BOT_LOT_STEP');
  if (!Number.isFinite(CFG.spread) || CFG.spread < 0) bad.push(`BOT_SPREAD = ${JSON.stringify(process.env.BOT_SPREAD)} → ใช้เป็นตัวเลขไม่ได้`);
  if (CFG.riskPct > 10) bad.push(`BOT_RISK_PCT = ${CFG.riskPct} → เกิน 10% ต่อไม้ แพ้ติดกันไม่กี่ไม้ก็หมดพอร์ต`);
  if (!['both', 'long'].includes(CFG.sides)) bad.push(`BOT_SIDES = ${JSON.stringify(CFG.sides)} → ใช้ได้แค่ both หรือ long`);
  if (!CFG.sources.some((k) => SOURCES[k])) bad.push(`BOT_SOURCES = ไม่รู้จักสักแหล่ง (${CFG.sources.join(', ')})`);
  return bad;
}

/* ส่งออกแล้วรายงานผลตามจริง — บันทึกสถานะก็ต่อเมื่อส่งถึงจริงเท่านั้น */
async function deliver(msg, what) {
  if (CFG.dryRun) { log(`โหมดทดสอบ ไม่ส่ง${what}จริง:\n` + JSON.stringify(msg, null, 2)); return { ok: true, dry: true }; }
  const r = await sendDiscord(CFG.webhook, msg);
  log(`${what} → Discord ${r.ok ? `สำเร็จ (${r.ms} มิลลิวินาที)` : `ไม่สำเร็จ: ${r.reason}`}`);
  return r;
}

function describe(cur) {
  const t = cur.trade;
  switch (cur.kind) {
    case 'entry': return `สัญญาณ${(t ? t.side : cur.signal.side) > 0 ? 'ซื้อ' : 'ขาย'}ใหม่`;
    case 'holding': return `ระบบถือ${t.side > 0 ? 'ซื้อ' : 'ขาย'}อยู่ (เข้า ${f2(t.entry)} · ตอนนี้ ${t.rNow >= 0 ? '+' : ''}${t.rNow.toFixed(2)}R)`;
    case 'cooldown': return 'พักหลังออกไม้';
    case 'wait': return `เทรนด์${cur.signal.trend > 0 ? 'ขาขึ้น รอราคาย่อ' : 'ขาลง รอราคาเด้ง'}ถึง ${f2(cur.signal.ema)}`;
    case 'no-trend': return 'เทรนด์ใหญ่ไม่ชัด ไม่เทรด';
    default: return 'ข้อมูลยังไม่พอ';
  }
}

async function main() {
  const retired = RETIRED.filter((k) => process.env[k]);
  if (retired.length) log(`หมายเหตุ: ${retired.join(', ')} ไม่มีผลแล้วในระบบใหม่ (ลบออกจาก Variables ได้)`);

  const bad = checkConfig();
  if (bad.length) {
    log('ตั้งค่าผิด จึงไม่เริ่มทำงาน — ถ้าปล่อยผ่าน บอทจะเงียบทั้งวันโดยไม่มีอะไรฟ้อง:');
    for (const b of bad) log('  •', b);
    log('แก้ที่ Settings → Secrets and variables → Actions → Variables');
    process.exit(1);
  }
  if (!CFG.dryRun) {
    const problem = webhookProblem(CFG.webhook);
    if (problem) {
      log(`DISCORD_WEBHOOK_URL ใช้ไม่ได้: ${problem}`);
      log('แก้ที่ Settings → Secrets and variables → Actions → Secrets');
      process.exit(1);
    }
  }
  /* ติ๊กมาทั้งสองช่อง = สั่งขัดกันเอง ยึดข้างที่ห้ามส่งไว้ก่อน เพราะข้อความที่ส่งแล้วเรียกคืนไม่ได้ */
  if (CFG.testPing && CFG.dryRun) {
    log('ติ๊กมาทั้ง dry run และ test ping — dry run แปลว่าห้ามส่ง จึงยังไม่ส่ง · อยากให้เด้งเข้า Discord ให้ติ๊ก test ping ช่องเดียว');
    return;
  }

  const data = await loadData();
  if (!data.d1) {
    log('ดึงข้อมูลราคาไม่ได้จากทุกแหล่ง:', JSON.stringify(data.attempts));
    /* ดึงราคาไม่ได้คือข่าวที่ต้องรู้ คนกดตรวจสถานะแล้วไม่มีอะไรเด้ง จะแยกไม่ออกว่าปกติหรือพัง */
    if (CFG.testPing) {
      await deliver(buildSignalMessage({ action: 'warn', price: null, instrument: 'ตรวจสถานะระบบ',
        blocks: ['ดึงราคาไม่ได้เลยสักแหล่ง จึงคำนวณอะไรไม่ได้', ...data.attempts.map((a) => `${a.key}: ${a.reason}`)] }), 'แจ้งว่าดึงราคาไม่ได้');
    }
    process.exit(1);
  }

  const now = Date.now();
  const h4 = spotBarsOnly(markClosed(data.h4, H4, now), H4);
  const d1 = spotBarsOnly(markClosed(data.d1, D1, now), D1);
  const sys = buildSystem(h4, d1);
  const costs = { spread: CFG.spread, slip: COSTS.slip };
  const cur = currentState(sys, { costs, longOnly: CFG.sides === 'long' });
  const last = data.h4[data.h4.length - 1];
  const instName = data.label;

  log(`ราคาล่าสุด ${f2(last.c)} · สถานะ: ${describe(cur)}`);
  for (const c of cur.signal.checks || []) log(`  ${c.ok === true ? '✓' : c.ok === false ? '✗' : '…'} ${c.text}`);

  /*
   * ด่านตายตัว ก่อนจะคิดเรื่องส่งสัญญาณ:
   *  - ตลาดทองปิด (แหล่งราคาเป็นเหรียญทองที่ซื้อขาย 24 ชม. ราคาจึงยังขยับตลอดเสาร์-อาทิตย์)
   *  - แท่งล่าสุดเก่าเกินไป (แหล่งค้าง ส่งของเก่ามา)
   */
  const blocks = [];
  const mk = goldMarketOpen(new Date(now));
  if (!mk.open) blocks.push(`ตลาดทอง spot ปิดอยู่${mk.opensAt ? ` · เปิดอีกครั้ง ${thTime(mk.opensAt)} น. (เวลาไทย)` : ''}`);
  const ageH = (now - last.t) / 3600000;
  const liveTf = SOURCES[data.key].tf['4h'] !== undefined ? 4 : 1;
  if (ageH > liveTf * 3 && mk.open) blocks.push(`แท่งล่าสุดเก่าไป ${ageH.toFixed(1)} ชม. — แหล่งข้อมูลอาจค้าง`);
  for (const b of blocks) log('⛔', b);

  if (CFG.testPing) {
    /* รายงานตามสั่ง: บอกภาพตลาดจริงตอนนี้ ไม่ว่าจะมีสัญญาณหรือไม่ — พิสูจน์ได้ทั้งสาย ไม่ใช่แค่ท่อ Discord */
    const r = await deliver(buildSignalMessage({
      action: 'wait', price: last.c, instrument: `${instName} (รายงานสถานะ)`,
      checks: cur.signal.checks, blocks: [describe(cur), ...blocks],
      notes: ['นี่คือรายงานตามที่กดสั่ง ไม่ใช่สัญญาณเข้าเทรด — ตัวเลขทุกตัวเป็นของจริงจากตลาดตอนนี้'],
      stats: REFERENCE.stats,
    }), 'รายงานสถานะ');
    if (!r.ok) process.exit(1);
    return;
  }

  const state = loadState();
  saveState({ ...state, lastRun: now, lastKind: cur.kind, lastPrice: last.c });
  if (cur.kind !== 'entry') { log('ยังไม่ใช่จังหวะเข้า — ไม่เตือน'); return; }
  if (blocks.length) { log('มีสัญญาณ แต่ติดด่านความปลอดภัย — ไม่เตือน'); return; }

  const side = cur.trade ? cur.trade.side : cur.signal.side;
  const key = `${h4[cur.closedIndex].t}:${side}`;
  if (state.lastSignal === key) { log('สัญญาณนี้เตือนไปแล้ว — ข้าม'); return; }

  const plan = planAt(side, last.c, cur.signal.atr, RULE, costs);
  const size = sizePlan({ ...plan, account: CFG.account, riskPct: CFG.riskPct,
    broker: { contractSize: CFG.contractSize, minLot: CFG.minLot, lotStep: CFG.lotStep } });

  /* ทุนไม่พอ = ส่งไปบอกว่ามีสัญญาณ แต่ไม่ส่งราคาเข้า/SL/TP — ข้อความที่มีตัวเลขครบอ่านแล้วเหมือนไฟเขียว */
  const msg = size.tradeable
    ? buildSignalMessage({ action: side > 0 ? 'buy' : 'sell', price: last.c, instrument: instName,
      plan, size, checks: cur.signal.checks, stats: REFERENCE.stats })
    : buildSignalMessage({ action: 'nocap', price: last.c, instrument: instName, checks: cur.signal.checks,
      blocks: [`มีสัญญาณ${side > 0 ? 'ซื้อ' : 'ขาย'} แต่ไม้เล็กสุดเสี่ยง ${f2(size.riskUsd)} ดอลลาร์ = ${size.riskPctActual.toFixed(0)}% ของทุน (เพดาน ${size.ceilingPct}%)`,
        `ทุนที่ควรมีสำหรับไม้ขนาดนี้คือ ${size.capitalFor2pct} ดอลลาร์ หรือใช้บัญชีที่ 1 ล็อต = 1 ออนซ์`],
      notes: ['ไม่ส่งราคาเข้า/SL/TP มาให้ เพราะที่ความเสี่ยงระดับนี้ ตัวเลขที่แม่นแค่ไหนก็ช่วยไม่ได้'], stats: REFERENCE.stats });

  const r = await deliver(msg, 'สัญญาณ');
  if (r.ok) {
    /* จำว่าเตือนแล้วก็ต่อเมื่อส่งถึงจริง ไม่งั้นรอบหน้าจะข้ามไม้นี้ทั้งที่ผู้ใช้ไม่เคยได้รับ */
    if (!r.dry) saveState({ ...loadState(), lastSignal: key, lastSignalAt: now });
  } else {
    log('ส่งไม่สำเร็จ — ไม่บันทึกว่าเตือนแล้ว จะลองใหม่รอบหน้า');
    process.exit(1);
  }
}

main().catch((e) => { log('ผิดพลาด:', e.stack || e.message); process.exit(1); });
