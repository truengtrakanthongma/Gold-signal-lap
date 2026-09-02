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
import { confidenceScale } from '../js/learn.js';
import { SOURCES } from '../js/sources.js';
import { fetchNews } from '../js/news.js';
import { sendDiscord, buildSignalMessage, webhookProblem } from '../js/discord.js';
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
  /* เพิ่มขนาดไม้เมื่อสัญญาณชัด — ตั้งเป็น 1 เพื่อปิด */
  boostMax: +(process.env.BOT_BOOST_MAX || 2),
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

/** ตัวกรองความผันผวน ชุดเดียวกับหน้าเว็บ */
function blocked(ctx, scored) {
  return scored.atrPct < ctx.cfg.minAtrPct || scored.atrPct > ctx.cfg.maxAtrPct;
}

/** ปัจจัยที่ดันไปทางเดียวกับคะแนน เรียงจากแรงสุด */
function topFactors(scored, side, newsLine) {
  return [
    ...scored.factors.filter((f) => Math.sign(f.contribution) === side)
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 4).map((f) => `${f.name}: ${f.reason}`),
    ...(newsLine ? [`ข่าว: ${newsLine}`] : []),
  ];
}

/** เหตุผลที่ยังไม่เตือน — ต้องบอกให้ครบว่าติดข้อไหนบ้าง ไม่ใช่ข้อแรกที่เจอ */
function statusBlocks(ctx, scored, strong, noSetup) {
  const out = [];
  if (!strong) {
    out.push(`คะแนน ${scored.score.toFixed(1)} ยังไม่ถึงเกณฑ์ ${CFG.threshold} จึงยังไม่เตือน`);
  }
  if (blocked(ctx, scored)) {
    out.push(`ความผันผวนผิดปกติ — ATR ${scored.atrPct.toFixed(3)}% อยู่นอกช่วงที่รับได้ `
      + `(${ctx.cfg.minAtrPct}–${ctx.cfg.maxAtrPct}%)`);
  }
  if (noSetup) out.push('คะแนนถึงเกณฑ์แล้ว แต่วางจุดตัดขาดทุนกับเป้าหมายให้คุ้มความเสี่ยงไม่ได้');
  out.push('นี่คือรายงานตามที่กดสั่ง ไม่ใช่สัญญาณเข้าเทรด — ตัวเลขทุกตัวเป็นของจริงจากตลาดตอนนี้');
  return out;
}

/** ข้อมูลประกอบที่ทั้งสัญญาณจริงและรายงานสถานะใช้ร่วมกัน */
async function gatherContext(ctx, scored, key, label) {
  // สถิติย้อนหลังของกรอบเวลานี้ ใช้บอกอัตราชนะที่เคยเกิดจริง
  // และใช้ตัดสินด้วยว่าไม้คะแนนสูงเคยทำเงินได้ดีกว่าจริงหรือเปล่า
  let prob = null;
  let boost = { mult: 1, boosted: false, why: 'คำนวณสถิติย้อนหลังไม่ได้ จึงไม่เพิ่มขนาดไม้' };
  try {
    const bt = runBacktest(ctx, { threshold: CFG.threshold, exitStyle: 'full' });
    prob = probabilityFor(scored.score, bt);
    boost = CFG.boostMax > 1
      ? confidenceScale(bt, scored.score, { threshold: CFG.threshold, maxMult: CFG.boostMax })
      : { mult: 1, boosted: false, why: 'ปิดการเพิ่มขนาดไม้ไว้ (BOT_BOOST_MAX = 1)' };
  } catch (e) { log('คำนวณสถิติย้อนหลังไม่ได้:', e.message); }

  // บรรยากาศข่าว (ถ้าดึงได้) — ไม่ใช่เงื่อนไขบังคับ แค่ใส่เป็นบริบท
  let newsLine = null;
  try {
    const news = await fetchNews({ hours: 12 });
    if (news.ok && news.climate.n) newsLine = `${news.climate.label} (${news.climate.n} ข่าว จาก ${news.label})`;
  } catch (e) { /* ข่าวดึงไม่ได้ไม่ควรทำให้สัญญาณราคาหายไป */ }

  return { prob, boost, newsLine, inst: instrumentOf(key, ''), label };
}

/** ข้อความสัญญาณจริง — คืน null เมื่อวางแผนเทรดไม่ได้ */
function signalMessage(ctx, i, scored, side, last, extra) {
  const setup = buildSetup(ctx, i, { ...scored, side }, {
    account: CFG.account, riskPct: CFG.riskPct, entryPrice: last.c, side,
    riskMult: extra.boost ? extra.boost.mult : 1,
  });
  if (!setup) return null;
  return buildSignalMessage({
    action: side > 0 ? 'buy' : 'sell',
    score: scored.score, price: last.c, tf: CFG.interval,
    instrument: `${extra.inst.name} · ${extra.label}`,
    setup, prob: extra.prob, sizing: extra.boost,
    reasons: topFactors(scored, side, extra.newsLine),
  });
}

async function main() {
  const problem = CFG.dryRun ? null : webhookProblem(CFG.webhook);
  if (problem) {
    log(`ใช้ DISCORD_WEBHOOK_URL ไม่ได้: ${problem}`);
    log('แก้ที่ Settings → Secrets and variables → Actions → DISCORD_WEBHOOK_URL');
    process.exit(1);
  }

  /*
   * ติ๊กมาทั้งสองช่อง = สั่งขัดกันเอง ช่องหนึ่งบอกว่าห้ามส่ง อีกช่องบอกว่าให้ส่ง
   * ยึดช่องที่ห้ามไว้ก่อน เพราะข้อความที่ส่งไปแล้วเรียกกลับไม่ได้
   * แต่ต้องบอกให้ชัดว่าทำไมไม่มีอะไรเด้งเข้า Discord ไม่งั้นดูเหมือนพัง
   */
  if (CFG.testPing && CFG.dryRun) {
    log('ติ๊กมาทั้ง dry run และ test ping — dry run แปลว่าห้ามส่งออก จึงยังไม่ส่ง');
    log('อยากให้รายงานสถานะเด้งเข้า Discord จริง ให้ติ๊กเฉพาะ test ping ช่องเดียว');
    return;
  }

  const { bars, label, key, attempts } = await loadCandles();
  if (!bars) {
    log('ดึงข้อมูลราคาไม่ได้จากทุกแหล่ง:', JSON.stringify(attempts));
    /*
     * ดึงราคาไม่ได้คือข่าวที่ต้องรู้ ไม่ใช่ความเงียบ
     * คนกดตรวจสถานะแล้วไม่มีอะไรเด้ง จะแยกไม่ออกว่าระบบปกติหรือพัง
     */
    if (CFG.testPing) {
      await sendDiscord(CFG.webhook, buildSignalMessage({
        action: 'warn', score: null, price: null, tf: CFG.interval,
        instrument: 'ตรวจสถานะระบบ',
        blocks: ['ดึงราคาไม่ได้เลยสักแหล่ง จึงคำนวณอะไรไม่ได้',
                 ...attempts.map((a) => `${a.key}: ${a.reason}`)],
      }));
    }
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

  /*
   * ตรวจสถานะตามสั่ง: รายงานภาพตลาด "จริง" ตอนนี้ ไม่ว่าจะมีสัญญาณหรือไม่
   *
   * เดิมโหมดนี้ยิงข้อความตัวอย่างที่มีตัวเลขตายตัวออกไป ซึ่งพิสูจน์ได้แค่ว่า
   * ท่อถึง Discord เท่านั้น ไม่ได้บอกเลยว่าอ่านราคาจริงได้ไหม คิดคะแนนได้ไหม
   * และคนอ่านก็แยกไม่ออกว่าเลขที่เห็นเป็นของจริงหรือของปลอม ซึ่งแย่กว่าไม่ส่ง
   *
   * ตอนนี้มันเดินทางเดียวกับสัญญาณจริงทุกขั้น ต่างแค่ส่งออกเสมอแม้คะแนนไม่ถึง
   * เห็นราคาที่ตรงกับตลาด = พิสูจน์ทั้งสายว่าใช้ได้จริง ไม่ใช่แค่ท่อ Discord
   */
  if (CFG.testPing) {
    const extra = await gatherContext(ctx, scored, key, label);
    const live = strong && !blocked(ctx, scored)
      ? signalMessage(ctx, i, scored, side, last, extra) : null;
    const msg = live || buildSignalMessage({
      action: 'wait', score: scored.score, price: last.c, tf: CFG.interval,
      instrument: `${extra.inst.name} · ${label} (ตรวจสถานะ)`,
      blocks: statusBlocks(ctx, scored, strong, strong && !blocked(ctx, scored)),
      reasons: topFactors(scored, Math.sign(scored.score) || 1, extra.newsLine),
    });
    const res = await sendDiscord(CFG.webhook, msg);
    if (!res.ok) { log('ส่งรายงานสถานะไม่สำเร็จ:', res.reason); process.exit(1); }
    log(`ส่งรายงานสถานะเข้า Discord สำเร็จ (${res.ms} มิลลิวินาที) — ราคาในข้อความคือราคาจริงจาก ${label}`);
    return;
  }

  if (!strong) { log('คะแนนยังไม่ถึงเกณฑ์ — ไม่เตือน'); saveState({ ...state, lastSeen: last.t }); return; }

  // เตือนซ้ำแท่งเดิมและทิศเดิม = สแปม
  if (state.lastCandle === last.t && state.lastSide === side) {
    log('แท่งนี้เตือนไปแล้ว — ข้าม'); return;
  }

  if (blocked(ctx, scored)) {
    log(`ความผันผวนผิดปกติ (ATR ${scored.atrPct.toFixed(3)}%) — ไม่เตือน`); return;
  }

  const extra = await gatherContext(ctx, scored, key, label);
  const msg = signalMessage(ctx, i, scored, side, last, extra);
  if (!msg) { log('สร้างแผนเทรดไม่ได้ — ไม่เตือน'); return; }

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
