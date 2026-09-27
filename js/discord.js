/**
 * discord.js — ส่งสัญญาณเข้า Discord ผ่าน webhook
 *
 * ทำไมถึงคุ้มกว่าการแจ้งเตือนบนหน้าจอ: หน้าเว็บต้องเปิดค้างไว้ถึงจะเตือนได้
 * แต่ Discord เด้งเข้ามือถือแม้ปิดจอ และเก็บประวัติสัญญาณย้อนหลังให้เองด้วย
 *
 * *** URL ของ webhook คือความลับ ***
 * ใครได้ไปก็โพสต์เข้าห้องคุณได้ จึงเก็บใน localStorage ของเบราว์เซอร์เท่านั้น
 * ไม่เขียนลงไฟล์ ไม่ขึ้น GitHub — กฎเดียวกับ API key
 */

/** สีของแถบข้างซ้ายใน Discord (ตัวเลขฐานสิบ) */
const COLOR = { buy: 0x26a96a, sell: 0xdc4c4c, wait: 0x667085, warn: 0xc99a2e, nocap: 0xc99a2e };

/**
 * บอกว่า URL ของ webhook ผิดตรงไหน — คืน null ถ้าใช้ได้
 *
 * ทำไมต้องแยกเหตุผล: การตอบแค่ "รูปแบบไม่ถูกต้อง" ทำให้คนที่ติดอยู่
 * ไม่มีทางรู้เลยว่าต้องแก้อะไร ระหว่าง "ยังไม่ได้ใส่", "คัดลอกลิงก์ห้องมาแทน"
 * และ "คัดลอกมาไม่ครบ" ซึ่งวิธีแก้คนละเรื่องกันหมด
 *
 * *** ห้ามเอาโทเค็นมาแสดงในข้อความ *** ใครเห็นก็โพสต์เข้าห้องได้
 * จึงบอกได้เฉพาะโครงสร้าง เช่น ชื่อโดเมนกับส่วนแรกของเส้นทางเท่านั้น
 */
export function webhookProblem(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return 'ยังไม่ได้ใส่ค่า webhook';

  let u;
  try { u = new URL(raw); }
  catch (e) { return 'ไม่ใช่ลิงก์ที่ถูกต้อง — ต้องขึ้นต้นด้วย https://discord.com/api/webhooks/'; }

  if (u.protocol !== 'https:') return `ต้องเป็น https เท่านั้น (ที่ใส่มาเป็น ${u.protocol.replace(':', '')})`;

  if (!/^(canary\.|ptb\.)?discord(app)?\.com$/.test(u.hostname)) {
    return `ไม่ใช่ลิงก์ของ Discord (โดเมนที่ใส่มาคือ ${u.hostname})`;
  }

  // ยอมให้มีทับปิดท้าย บางที่คัดลอกมาแล้วติดมาด้วย
  const path = u.pathname.replace(/\/+$/, '');

  /*
   * ลิงก์ห้องคือของที่หยิบผิดบ่อยที่สุด เพราะปุ่มแชร์อยู่ใกล้กัน
   * และหน้าตาก็เป็น discord.com เหมือนกัน จึงต้องเรียกชื่อมันออกมาตรง ๆ
   */
  if (/^\/channels\//.test(path)) {
    return 'นี่คือลิงก์ห้องแชท ไม่ใช่ลิงก์ webhook — ต้องเข้า แก้ไขช่อง → การเชื่อมต่อ → เว็บฮุค แล้วกดคัดลอกลิงก์เว็บฮุค';
  }
  if (/^\/invite\//.test(path) || u.hostname === 'discord.gg') {
    return 'นี่คือลิงก์เชิญเข้าเซิร์ฟเวอร์ ไม่ใช่ลิงก์ webhook';
  }
  if (!/^\/api\/(v\d+\/)?webhooks\//.test(path)) {
    return `ไม่ใช่เส้นทางของ webhook (ต้องเป็น /api/webhooks/... แต่ที่ใส่มาคือ ${path.split('/').slice(0, 3).join('/') || '/'}...)`;
  }

  const rest = path.replace(/^\/api\/(v\d+\/)?webhooks\//, '').split('/');
  if (rest.length < 2 || !rest[1]) return 'คัดลอกมาไม่ครบ — ขาดโทเค็นส่วนท้ายหลังเลขไอดี';
  if (rest.length > 2) return 'มีส่วนเกินต่อท้าย — ให้คัดลอกถึงแค่โทเค็นแล้วหยุด';
  if (!/^\d+$/.test(rest[0])) return 'ส่วนที่ควรเป็นเลขไอดีของ webhook ไม่ใช่ตัวเลข — คัดลอกมาไม่ครบหรือผิดที่';
  if (!/^[\w.-]+$/.test(rest[1])) return 'โทเค็นส่วนท้ายมีอักขระที่ไม่น่าใช่ — อาจมีช่องว่างหรือตัวอักษรแปลกปนมาตอนคัดลอก';

  return null;
}

/**
 * ตรวจว่าเป็น URL ของ Discord webhook จริง
 *
 * ไม่ใช่แค่ความสวยงาม: ถ้าผู้ใช้วาง URL ผิดที่ไป ระบบจะยิงข้อมูลการเทรด
 * ไปยังเซิร์ฟเวอร์ที่ไม่รู้จัก จึงต้องกันไว้ก่อนยิงครั้งแรก
 */
export function isValidWebhook(url) {
  return webhookProblem(url) === null;
}

/** ส่งข้อความเข้า Discord */
export async function sendDiscord(url, payload, opts = {}) {
  const problem = webhookProblem(url);
  if (problem) return { ok: false, reason: problem };
  const doFetch = opts.fetchImpl || ((u, i) => fetch(u, i));
  const t0 = Date.now();
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const ms = Date.now() - t0;
    // Discord ตอบ 204 เมื่อสำเร็จ (ไม่มีเนื้อหาตอบกลับ)
    if (res.status === 204 || res.ok) return { ok: true, ms, status: res.status };
    if (res.status === 429) {
      return { ok: false, ms, status: 429,
        reason: 'ส่งถี่เกินไป Discord จำกัดอัตราไว้ — เว้นระยะแล้วลองใหม่' };
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return { ok: false, ms, status: res.status,
        reason: 'Discord ไม่รับ webhook นี้ — อาจถูกลบไปแล้วหรือ URL ผิด สร้างใหม่ในห้องแล้วคัดลอกมาใส่อีกครั้ง' };
    }
    return { ok: false, ms, status: res.status, reason: `Discord ตอบรหัส ${res.status}` };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const cors = /Failed to fetch|NetworkError|Load failed/i.test(msg);
    return { ok: false, ms: Date.now() - t0, cors,
      reason: cors
        ? 'ยิงไปไม่ถึง Discord — เครือข่ายของคุณอาจบล็อก หรือเบราว์เซอร์ปฏิเสธคำขอข้ามโดเมน'
        : msg };
  }
}

/** ตัดข้อความให้พอดีขีดจำกัดของ Discord โดยไม่ตัดกลางคำจนอ่านไม่รู้เรื่อง */
function clip(text, max) {
  const t = String(text || '');
  if (t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

/**
 * แปลงสถานะระบบเป็นข้อความ Discord
 *
 * ใส่เฉพาะสิ่งที่ต้องใช้ตัดสินใจ: ทำอะไร ราคาไหน ตัดขาดทุนตรงไหน เป้าตรงไหน เสี่ยงเท่าไร
 * และเช็คลิสต์สามข้อของกติกา — ไม่ยัดทุกอย่างลงไปจนอ่านบนมือถือไม่ไหว
 *
 * o = { action: 'buy'|'sell'|'wait'|'warn', price, instrument, plan, size, checks, blocks, notes, stats }
 */
export function buildSignalMessage(o) {
  const { action, price, instrument, plan, size, checks = [], blocks = [], notes = [], stats } = o;
  const isTrade = action === 'buy' || action === 'sell';
  /* 'nocap' = มีสัญญาณจริงแต่ทุนไม่พอ ต้องมีหัวเรื่องของตัวเอง
     ถ้าไปใช้หัว "ยังไม่มีสัญญาณ" คนอ่านหัวแล้วจะเข้าใจผิดว่าตลาดเงียบ ทั้งที่เนื้อความบอกว่ามี */
  const title = action === 'buy' ? '🟢 สัญญาณซื้อ (BUY)'
    : action === 'sell' ? '🔴 สัญญาณขาย (SELL)'
    : action === 'nocap' ? '⛔ มีสัญญาณ แต่ทุนไม่พอสำหรับไม้นี้'
    : action === 'warn' ? '⚠️ ระบบมีปัญหา — ยังทำงานไม่ได้'
    : '⏸ ยังไม่มีสัญญาณ';

  const fields = [];
  if (plan && isTrade) {
    fields.push(
      { name: action === 'buy' ? 'ซื้อที่' : 'ขายที่', value: '`' + plan.entry.toFixed(2) + '`', inline: true },
      { name: 'ตัดขาดทุน', value: '`' + plan.stop.toFixed(2) + '`', inline: true },
      { name: `ทำกำไร (${plan.targetR}R)`, value: '`' + plan.target.toFixed(2) + '`', inline: true },
    );
    if (size) {
      /* เงินจริง ไม่ใช่แค่ R — คนตัดสินใจด้วยจำนวนเงินที่ยอมเสีย */
      fields.push({ name: 'ขนาดไม้', value: '`' + size.lots + '` ล็อต (' + size.oz.toFixed(2) + ' ออนซ์)', inline: true });
      fields.push({ name: 'เสี่ยง', value: '`' + size.riskUsd.toFixed(2) + '` USD'
        + (size.riskPctActual === null ? '' : ` (${size.riskPctActual.toFixed(1)}%)`), inline: true });
      fields.push({ name: 'ลุ้นได้', value: '`' + size.rewardUsd.toFixed(2) + '` USD', inline: true });
    }
    fields.push({ name: 'หลังเข้าไม้', value: 'ตั้ง SL/TP ไว้กับโบรกเกอร์เลย แล้วปล่อยให้ปิดเอง · ถ้า 6 วันยังไม่ถึงไหน ให้ปิดทิ้ง', inline: false });
  }
  if (checks.length) {
    fields.push({ name: 'เช็คลิสต์ของกติกา',
      value: clip(checks.map((c) => `${c.ok === true ? '✅' : c.ok === false ? '❌' : '⏳'} ${c.text}`).join('\n'), 1000) });
  }
  if (blocks.length) fields.push({ name: 'ทำไมยังไม่ควรเข้า', value: clip(blocks.join('\n'), 1000) });
  if (notes.length) fields.push({ name: 'ต้องรู้', value: clip(notes.join('\n'), 1000) });
  if (stats) {
    fields.push({ name: 'ผลของกติกานี้บนทองจริง 4 ปี',
      value: `${stats.n} ไม้ · ชนะ ${stats.win.toFixed(0)}% · เฉลี่ย ${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R ต่อไม้ · แพ้ติดกันมากสุด ${stats.maxLossStreak} ไม้` });
  }
  return {
    username: 'Gold Signal Lab',
    embeds: [{
      title: clip(title, 256),
      description: `**${instrument || 'ทองคำ'}** · ราคา \`${price ? price.toFixed(2) : '—'}\` · ตามเทรนด์รายวัน เข้าที่กราฟ 4 ชม.`,
      color: COLOR[action] || COLOR.wait,
      fields: fields.slice(0, 25),
      footer: { text: 'เพื่อการศึกษา ไม่ใช่คำแนะนำการลงทุน · ผลในอดีตไม่รับประกันอนาคต' },
      timestamp: new Date().toISOString(),
    }],
  };
}

export function buildTestMessage() {
  return buildSignalMessage({
    action: 'buy', price: 4472.54, instrument: 'PAXG/USD (ข้อความทดสอบ)',
    plan: { entry: 4472.84, stop: 4421.10, target: 4576.32, targetR: 2 },
    size: { lots: 0.01, oz: 1, riskUsd: 51.74, rewardUsd: 103.48, riskPctActual: 5.2 },
    checks: [
      { ok: true, text: 'นี่คือข้อความทดสอบ — ถ้าเห็นข้อความนี้แปลว่าเชื่อมต่อ Discord สำเร็จ' },
      { ok: null, text: 'สัญญาณจริงจะแสดงเช็คลิสต์สามข้อของกติกาตรงนี้' },
    ],
  });
}
