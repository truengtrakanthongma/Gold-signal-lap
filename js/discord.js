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
const COLOR = { buy: 0x26a96a, sell: 0xdc4c4c, wait: 0x667085, warn: 0xc99a2e };

/**
 * ตรวจว่าเป็น URL ของ Discord webhook จริง
 *
 * ไม่ใช่แค่ความสวยงาม: ถ้าผู้ใช้วาง URL ผิดที่ไป ระบบจะยิงข้อมูลการเทรด
 * ไปยังเซิร์ฟเวอร์ที่ไม่รู้จัก จึงต้องกันไว้ก่อนยิงครั้งแรก
 */
export function isValidWebhook(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== 'https:') return false;
    if (!/^(canary\.|ptb\.)?discord(app)?\.com$/.test(u.hostname)) return false;
    return /^\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(u.pathname);
  } catch (e) { return false; }
}

/** ส่งข้อความเข้า Discord */
export async function sendDiscord(url, payload, opts = {}) {
  if (!isValidWebhook(url)) {
    return { ok: false, reason: 'ไม่ใช่ URL ของ Discord webhook — ต้องขึ้นต้นด้วย https://discord.com/api/webhooks/...' };
  }
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
 * แปลงสัญญาณเป็นข้อความ Discord
 *
 * ใส่เฉพาะสิ่งที่ต้องใช้ตัดสินใจ: ทำอะไร ที่ราคาไหน ตัดขาดทุนตรงไหน เป้าตรงไหน
 * และเหตุผลสั้น ๆ — ไม่ใช่ยัดทุกอย่างลงไปจนอ่านบนมือถือไม่ไหว
 */
export function buildSignalMessage(o) {
  const { action, score, price, instrument, setup, reasons = [], prob, tf, blocks = [] } = o;
  const isTrade = action === 'buy' || action === 'sell';
  const title = action === 'buy' ? 'สัญญาณซื้อ (BUY)'
    : action === 'sell' ? 'สัญญาณขาย (SELL)'
    : 'ยังไม่มีสัญญาณ';

  const fields = [];
  if (setup && isTrade) {
    fields.push(
      { name: 'ราคาเข้า', value: '`' + setup.entry.toFixed(2) + '`', inline: true },
      { name: 'ตัดขาดทุน', value: '`' + setup.sl.toFixed(2) + '`', inline: true },
      { name: `เป้าหมาย (${setup.mainR}R)`, value: '`' + setup.tpMain.toFixed(2) + '`', inline: true },
    );
    if (setup.lots) {
      fields.push({ name: 'ขนาดไม้', value: '`' + setup.lots.toFixed(2) + '` ล็อต', inline: true });
    }
    fields.push({ name: 'ได้:เสีย', value: '`' + setup.rrNow.toFixed(2) + ':1`', inline: true });
  }
  if (prob && prob.p !== null && prob.p !== undefined) {
    fields.push({ name: 'อัตราชนะในอดีต', value: `\`${prob.p.toFixed(0)}%\` (${prob.n} ไม้)`, inline: true });
  }
  if (blocks.length) {
    fields.push({ name: 'เหตุผลที่ยังไม่ควรเข้า', value: clip(blocks.join('\n'), 1000) });
  }
  if (reasons.length) {
    fields.push({ name: 'ปัจจัยสนับสนุน', value: clip(reasons.slice(0, 5).map((r) => '• ' + r).join('\n'), 1000) });
  }

  return {
    username: 'Gold Signal Lab',
    embeds: [{
      title: clip(title, 256),
      description: `**${instrument || 'ทองคำ'}** · กรอบ ${tf || '—'} · ราคา \`${price ? price.toFixed(2) : '—'}\``
        + `\nคะแนนสัญญาณ **${score === null || score === undefined ? '—' : score.toFixed(1)}**`,
      color: COLOR[action] || COLOR.wait,
      fields: fields.slice(0, 25),
      footer: { text: 'เพื่อการศึกษา ไม่ใช่คำแนะนำการลงทุน' },
      timestamp: new Date().toISOString(),
    }],
  };
}

/** ข้อความทดสอบ ให้ผู้ใช้เห็นหน้าตาจริงก่อนใช้งาน */
export function buildTestMessage() {
  return buildSignalMessage({
    action: 'buy', score: 62.4, price: 3345.18, instrument: 'PAXG/USD (ทดสอบ)', tf: '15 นาที',
    setup: { entry: 3345.18, sl: 3332.40, tpMain: 3370.74, mainR: 2, lots: 0.78, rrNow: 2.0 },
    prob: { p: 41, n: 86 },
    reasons: ['นี่คือข้อความทดสอบ — ถ้าเห็นข้อความนี้แปลว่าเชื่อมต่อสำเร็จ',
              'สัญญาณจริงจะมีเหตุผลจากปัจจัยที่ระบบตรวจพบจริง'],
  });
}
