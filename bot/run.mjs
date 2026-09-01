/**
 * bot/run.mjs — บอทเฝ้าสัญญาณ 24 ชั่วโมง รันบน GitHub Actions
 *
 * ปัญหาที่แก้: หน้าเว็บต้องเปิดค้างไว้ถึงจะเตือนได้ ปิดจอปิดแท็บก็จบ
 * เพราะมันเป็นไฟล์นิ่ง ๆ ไม่มีอะไรรันอยู่เบื้องหลัง
 *
 * ทำไม GitHub Actions ถึงเป็นคำตอบที่ฟรีจริง:
 *   - รีโปสาธารณะได้นาทีรันไม่จำกัด ไม่มีค่าใช้จ่าย
 *   - ตั้งเวลาให้รันเองได้ (cron) ไม่ต้องมีเซิร์ฟเวอร์ ไม่ต้องเปิดเครื่องทิ้งไว้
 *   - URL ของ webhook เก็บเป็น Secret อยู่ฝั่งเซิร์ฟเวอร์ ไม่โผล่ในหน้าเว็บสาธารณะ
 *   - ใช้เอนจินตัวเดียวกับหน้าเว็บเป๊ะ ๆ สัญญาณจึงตรงกันเสมอ ไม่มีโค้ดสองชุดให้หลุดกัน
 *
 * *** ข้อจำกัดที่ต้องรู้ ***
 * ตัวตั้งเวลาของ GitHub ไม่ตรงเป๊ะ ช่วงที่คนใช้เยอะอาจช้าไป 5-20 นาที
 * จึงเหมาะกับกรอบเวลา 15 นาทีขึ้นไป ไม่เหมาะกับการเก็งกำไรรายนาที
 */

import { buildContext, scoreAt, buildSetup, combineTimeframes, DEFAULT_CFG } from '../js/signals.js';
import { runBacktest, probabilityFor, sessionBucketAt } from '../js/backtest.js';
import { SOURCES } from '../js/sources.js';
import { fetchNews } from '../js/news.js';
import { sendDiscord, buildSignalMessage, buildTestMessage, webhookProblem } from '../js/discord.js';
import { instrumentOf } from '../js/instrument.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const CFG = {
  // เรียงตามความใกล้เคียงราคาทองจริง เจ้าแรกที่ตอบก็ใช้เจ้านั้น
  sources: (process.env.BOT_SOURCES || 'kraken_paxg,bitfinex_xaut,binance_paxg,okx_paxg').split(','),
  interval: process.env.BOT_INTERVAL || '15m',
  threshold: +(process.env.BOT_THRESHOLD || 45),
  account: +(process.env.BOT_ACCOUNT || 1000),
  riskPct: +(process.env.BOT_RISK_PCT || 1),
  bars: +(process.env.BOT_BARS || 720),
  statePath: process.env.BOT_STATE || 'bot/.state.json',
  webhook: process.env.DISCORD_WEBHOOK_URL || '',
  dryRun: process.env.BOT_DRY_RUN === '1',
  testPing: process.env.BOT_TEST_PING === '1',
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** โหลดสถานะรอบก่อน — กันเตือนซ้ำแท่งเดิมเมื่อ GitHub รันช้าจนคาบเกี่ยวกัน */
function loadState() {
  try { return JSON.parse(readFileSync(CFG.statePath, 'utf8')); }
  catch (e) { return { lastCandle: 0, lastSide: 0, lastAt: 0 }; }
}
function saveState(s) {
  try {
    mkdirSync(CFG.statePath.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(CFG.statePath, JSON.stringify(s, null, 2));
  } catch (e) { log('บันทึกสถานะไม่ได้:', e.message); }
}

/** ดึงแท่งเทียนจากเจ้าแรกที่ตอบ */
async function loadCandles() {
  const attempts = [];
  for (const key of CFG.sources) {
    const src = SOURCES[key];
    if (!src) { attempts.push({ key, reason: 'ไม่รู้จักแหล่งนี้' }); continue; }
    const tf = src.tf[CFG.interval];
    if (tf === undefined) { attempts.push({ key, reason: `ไม่มีกรอบเวลา ${CFG.interval}` }); continue; }
    try {
      const res = await fetch(src.url(tf, CFG.bars));
      if (!res.ok) { attempts.push({ key, reason: `รหัส ${res.status}` }); continue; }
      const bars = src.parse(await res.json());
      if (bars.length < 260) { attempts.push({ key, reason: `ได้แค่ ${bars.length} แท่ง` }); continue; }
      log(`ใช้ข้อมูลจาก ${src.label} · ${bars.length} แท่ง`);
      return { bars, key, label: src.label, attempts };
    } catch (e) { attempts.push({ key, reason: e.message }); }
  }
  return { bars: null, attempts };
}

async function main() {
  const problem = CFG.dryRun ? null : webhookProblem(CFG.webhook);
  if (problem) {
    log(`ใช้ DISCORD_WEBHOOK_URL ไม่ได้: ${problem}`);
    log('แก้ที่ Settings → Secrets and variables → Actions → DISCORD_WEBHOOK_URL');
    process.exit(1);
  }

  /*
   * ปุ่มพิสูจน์ว่าท่อถึง Discord จริง
   *
   * ทำไมต้องมี: บอทจะส่งข้อความก็ต่อเมื่อมีสัญญาณแรงพอเท่านั้น
   * คนที่เพิ่งใส่ webhook เสร็จแล้วกดรันเอง มักเจอผลลัพธ์ "คะแนนยังไม่ถึงเกณฑ์"
   * คือรันเขียวแต่ Discord เงียบสนิท ซึ่งแยกไม่ออกเลยว่าตั้งค่าถูกหรือผิด
   * โหมดนี้ยิงข้อความตัวอย่างออกไปตรง ๆ จะได้รู้ผลทันทีตั้งแต่ยังไม่มีสัญญาณจริง
   */
  if (CFG.testPing) {
    const res = await sendDiscord(CFG.webhook, buildTestMessage());
    if (!res.ok) { log('ส่งข้อความทดสอบไม่สำเร็จ:', res.reason); process.exit(1); }
    log(`ส่งข้อความทดสอบเข้า Discord สำเร็จ (${res.ms} มิลลิวินาที) — ไปดูในห้องได้เลย`);
    return;
  }

  const { bars, label, key, attempts } = await loadCandles();
  if (!bars) {
    log('ดึงข้อมูลราคาไม่ได้จากทุกแหล่ง:', JSON.stringify(attempts));
    process.exit(1);
  }

  /*
   * ใช้เฉพาะแท่งที่ปิดแล้ว
   * แท่งที่ยังก่อตัวอยู่เปลี่ยนค่าได้ตลอด สัญญาณจากมันจึงกลับไปกลับมา
   * และจะเตือนผิดบ่อยมาก — รอให้ปิดก่อนเสมอ
   */
  const closed = bars.filter((b) => b.closed !== false);
  const ctx = buildContext(closed, { ...DEFAULT_CFG, threshold: CFG.threshold });
  const i = closed.length - 1;
  const last = closed[i];

  const scored = scoreAt(ctx, i);
  if (!scored.ready) { log('ข้อมูลยังไม่พอให้ตัวชี้วัดนิ่ง'); return; }

  const state = loadState();
  const side = Math.sign(scored.score);
  const strong = Math.abs(scored.score) >= CFG.threshold;

  log(`แท่งล่าสุด ${new Date(last.t).toISOString()} ราคา ${last.c.toFixed(2)} คะแนน ${scored.score.toFixed(1)} (เกณฑ์ ${CFG.threshold})`);

  if (!strong) { log('คะแนนยังไม่ถึงเกณฑ์ — ไม่เตือน'); saveState({ ...state, lastSeen: last.t }); return; }

  // เตือนซ้ำแท่งเดิมและทิศเดิม = สแปม
  if (state.lastCandle === last.t && state.lastSide === side) {
    log('แท่งนี้เตือนไปแล้ว — ข้าม'); return;
  }

  // ตัวกรองความผันผวน ชุดเดียวกับหน้าเว็บ
  if (scored.atrPct < ctx.cfg.minAtrPct || scored.atrPct > ctx.cfg.maxAtrPct) {
    log(`ความผันผวนผิดปกติ (ATR ${scored.atrPct.toFixed(3)}%) — ไม่เตือน`); return;
  }

  const setup = buildSetup(ctx, i, { ...scored, side }, {
    account: CFG.account, riskPct: CFG.riskPct, entryPrice: last.c, side,
  });
  if (!setup) { log('สร้างแผนเทรดไม่ได้ — ไม่เตือน'); return; }

  // สถิติย้อนหลังของกรอบเวลานี้ ใช้บอกอัตราชนะที่เคยเกิดจริง
  let prob = null;
  try {
    const bt = runBacktest(ctx, { threshold: CFG.threshold, exitStyle: 'full' });
    prob = probabilityFor(scored.score, bt);
  } catch (e) { log('คำนวณสถิติย้อนหลังไม่ได้:', e.message); }

  // บรรยากาศข่าว (ถ้าดึงได้) — ไม่ใช่เงื่อนไขบังคับ แค่ใส่เป็นบริบท
  let newsLine = null;
  try {
    const news = await fetchNews({ hours: 12 });
    if (news.ok && news.climate.n) newsLine = `${news.climate.label} (${news.climate.n} ข่าว จาก ${news.label})`;
  } catch (e) { /* ข่าวดึงไม่ได้ไม่ควรทำให้สัญญาณราคาหายไป */ }

  const inst = instrumentOf(key, '');
  const msg = buildSignalMessage({
    action: side > 0 ? 'buy' : 'sell',
    score: scored.score, price: last.c, tf: CFG.interval,
    instrument: `${inst.name} · ${label}`,
    setup, prob,
    reasons: [
      ...scored.factors.filter((f) => Math.sign(f.contribution) === side)
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 4).map((f) => `${f.name}: ${f.reason}`),
      ...(newsLine ? [`ข่าว: ${newsLine}`] : []),
    ],
  });

  if (CFG.dryRun) { log('โหมดทดสอบ ไม่ส่งจริง:\n' + JSON.stringify(msg, null, 2)); return; }

  const res = await sendDiscord(CFG.webhook, msg);
  if (res.ok) {
    log(`ส่งเข้า Discord สำเร็จ (${res.ms} มิลลิวินาที)`);
    saveState({ lastCandle: last.t, lastSide: side, lastAt: Date.now() });
  } else {
    log('ส่งไม่สำเร็จ:', res.reason);
    process.exit(1);
  }
}

main().catch((e) => { log('บอทล้มเหลว:', e.stack || e.message); process.exit(1); });
