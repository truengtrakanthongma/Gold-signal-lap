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

  return { prob, newsLine, inst: instrumentOf(key, ''), label };
}

/** ข้อความสัญญาณจริง — คืน null เมื่อวางแผนเทรดไม่ได้ */
function signalMessage(ctx, i, scored, side, last, extra) {
  const setup = buildSetup(ctx, i, { ...scored, side }, {
    account: CFG.account, riskPct: CFG.riskPct, entryPrice: last.c, side,
  });
  if (!setup) return null;
  return buildSignalMessage({
    action: side > 0 ? 'buy' : 'sell',
    score: scored.score, price: last.c, tf: CFG.interval,
    instrument: `${extra.inst.name} · ${extra.label}`,
    setup, prob: extra.prob,
    reasons: topFactors(scored, side, extra.newsLine),
  });
}

/*
 * ตรวจค่าตั้งค่าก่อนเริ่มทำงาน
 *
 * ค่าพวกนี้มาจาก Variables ของ GitHub ซึ่งพิมพ์ผิดได้ง่าย เช่นใส่ "1,000"
 * แล้ว +"1,000" ได้ NaN ผลคือ Math.abs(score) >= NaN เป็นเท็จตลอด
 * บอทจึงไม่เตือนเลยสักครั้ง โดยที่ทุกรอบขึ้นติกเขียวสวยงาม
 * ความเงียบแบบนั้นแยกไม่ออกจาก "ตลาดยังไม่มีจังหวะ" — เสียเวลาเป็นวันกว่าจะรู้
 */
function checkConfig() {
  const bad = [];
  const pos = (name, v, envName) => { if (!Number.isFinite(v) || v <= 0) bad.push(`${envName} (${name}) = ${JSON.stringify(process.env[envName])} → ใช้เป็นตัวเลขไม่ได้`); };
  pos('เกณฑ์คะแนน', CFG.threshold, 'BOT_THRESHOLD');
  pos('ทุน', CFG.account, 'BOT_ACCOUNT');
  pos('ความเสี่ยงต่อไม้', CFG.riskPct, 'BOT_RISK_PCT');
  pos('จำนวนแท่งที่ดึง', CFG.bars, 'BOT_BARS');
  const unknown = CFG.sources.filter((k) => !SOURCES[k]);
  if (unknown.length === CFG.sources.length) bad.push(`BOT_SOURCES = ไม่รู้จักสักแหล่ง (${CFG.sources.join(', ')})`);
  return bad;
}

/*
 * ส่งข้อความออก แล้วรายงานผลตามจริง
 *
 * แยกเป็นฟังก์ชันเดียวเพราะมีที่เรียกหลายแห่ง (สัญญาณ รายงานสถานะ แจ้งว่าดึงราคาไม่ได้)
 * และทุกแห่งต้องบันทึกสถานะก็ต่อเมื่อส่งถึงจริงเท่านั้น
 */
async function deliver(msg, what) {
  const results = [];
  if (CFG.webhook) {
    const r = await sendDiscord(CFG.webhook, msg);
    results.push({ ch: 'Discord', ...r });
  }
  for (const r of results) {
    if (r.ok) log(`${what} → ${r.ch} สำเร็จ (${r.ms} มิลลิวินาที)`);
    else log(`${what} → ${r.ch} ไม่สำเร็จ: ${r.reason}`);
  }
  return { ok: results.some((r) => r.ok), results };
}

async function main() {
  const badCfg = checkConfig();
  if (badCfg.length) {
    log('ตั้งค่าผิด จึงไม่เริ่มทำงาน — ถ้าปล่อยผ่าน บอทจะเงียบทั้งวันโดยไม่มีอะไรฟ้อง:');
    for (const b of badCfg) log('  •', b);
    log('แก้ที่ Settings → Secrets and variables → Actions → Variables');
    process.exit(1);
  }

  /*
   * ต้องมีช่องทางที่ใช้ได้อย่างน้อยหนึ่งช่อง
   *
   * ตรวจเฉพาะช่องที่ผู้ใช้ตั้งค่ามา ไม่บังคับให้มีครบทั้งสอง
   * แต่ถ้าตั้งมาแล้วตั้งผิด ต้องหยุดและบอก ไม่ใช่ปล่อยให้เงียบทั้งวัน
   */
  if (!CFG.dryRun) {
    const chans = [];
    if (CFG.webhook) chans.push(['Discord', webhookProblem(CFG.webhook), 'DISCORD_WEBHOOK_URL']);

    if (!chans.length) {
      log('ยังไม่ได้ตั้ง DISCORD_WEBHOOK_URL จึงไม่มีที่ให้ส่งสัญญาณ');
      log('แก้ที่ Settings → Secrets and variables → Actions → Secrets');
      process.exit(1);
    }
    const broken = chans.filter(([, why]) => why);
    if (broken.length === chans.length) {
      log('ช่องทางแจ้งเตือนที่ตั้งไว้ใช้ไม่ได้ทั้งหมด จึงไม่เริ่มทำงาน:');
      for (const [ch, why, env] of broken) log(`  • ${ch} (${env}): ${why}`);
      process.exit(1);
    }
    for (const [ch, why, env] of broken) log(`ข้าม ${ch} (${env}): ${why}`);
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
      await deliver(buildSignalMessage({
        action: 'warn', score: null, price: null, tf: CFG.interval,
        instrument: 'ตรวจสถานะระบบ',
        blocks: ['ดึงราคาไม่ได้เลยสักแหล่ง จึงคำนวณอะไรไม่ได้',
                 ...attempts.map((a) => `${a.key}: ${a.reason}`)],
      }), 'แจ้งว่าดึงราคาไม่ได้');
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
    const res = await deliver(msg, 'รายงานสถานะ');
    if (!res.ok) { log('ส่งรายงานสถานะไม่สำเร็จสักช่อง'); process.exit(1); }
    log(`ราคาในข้อความคือราคาจริงจาก ${label}`);
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

  const res = await deliver(msg, 'สัญญาณ');
  if (res.ok) {
    /* จำว่าเตือนแท่งนี้ไปแล้วก็ต่อเมื่อถึงมืออย่างน้อยหนึ่งช่อง
       ไม่งั้นรอบหน้าจะข้ามไม้นี้ทั้งที่ผู้ใช้ไม่เคยได้รับอะไรเลย */
    saveState({ lastCandle: last.t, lastSide: side, lastAt: Date.now() });
  } else {
    log('ส่งไม่สำเร็จสักช่อง — ไม่บันทึกว่าเตือนแล้ว จะได้ลองใหม่รอบหน้า');
    process.exit(1);
  }
}

main().catch((e) => { log('บอทล้มเหลว:', e.stack || e.message); process.exit(1); });
