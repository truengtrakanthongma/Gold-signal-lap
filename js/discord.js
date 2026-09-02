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
 * แปลงสัญญาณเป็นข้อความ Discord
 *
 * ใส่เฉพาะสิ่งที่ต้องใช้ตัดสินใจ: ทำอะไร ที่ราคาไหน ตัดขาดทุนตรงไหน เป้าตรงไหน
 * และเหตุผลสั้น ๆ — ไม่ใช่ยัดทุกอย่างลงไปจนอ่านบนมือถือไม่ไหว
 */
export function buildSignalMessage(o) {
  const { action, score, price, instrument, setup, reasons = [], prob, tf, blocks = [], sizing = null } = o;
  const isTrade = action === 'buy' || action === 'sell';
  /* warn ต้องมีหัวเรื่องของตัวเอง ไม่งั้นข้อความ "ดึงราคาไม่ได้" จะพาดหัวว่า
     "ยังไม่มีสัญญาณ" ซึ่งอ่านแล้วเข้าใจว่าตลาดเงียบ ทั้งที่จริงคือระบบมองไม่เห็นตลาด */
  const title = action === 'buy' ? 'สัญญาณซื้อ (BUY)'
    : action === 'sell' ? 'สัญญาณขาย (SELL)'
    : action === 'warn' ? 'ระบบมีปัญหา — ยังทำงานไม่ได้'
    : 'ยังไม่มีสัญญาณ';

  const fields = [];
  if (setup && isTrade) {
    fields.push(
      { name: 'ราคาเข้า', value: '`' + setup.entry.toFixed(2) + '`', inline: true },
      { name: 'ตัดขาดทุน', value: '`' + setup.sl.toFixed(2) + '`', inline: true },
      { name: `เป้าหมาย (${setup.mainR}R)`, value: '`' + setup.tpMain.toFixed(2) + '`', inline: true },
    );
    if (setup.lots) {
      fields.push({ name: 'ขนาดไม้', value: '`' + setup.lots + '` ล็อต', inline: true });
    }
    fields.push({ name: 'ได้:เสีย', value: '`' + setup.rrNow.toFixed(2) + ':1`', inline: true });

    /*
     * เงินจริง ไม่ใช่แค่ R
     *
     * คนตัดสินใจด้วยจำนวนเงินที่ยอมเสีย ไม่ใช่ด้วยตัวคูณความเสี่ยง
     * และเป็นตัวเลขเดียวที่บอกได้ว่าไม้นี้ใหญ่เกินทุนหรือเปล่า
     */
    if (setup.riskActual !== undefined && setup.rewardActual !== undefined) {
      const pct = setup.riskActualPct === null || setup.riskActualPct === undefined
        ? '' : ` (${setup.riskActualPct.toFixed(1)}% ของทุน)`;
      fields.push({ name: 'เสี่ยงจริง', value: '`' + setup.riskActual.toFixed(2) + '` USD' + pct, inline: true });
      fields.push({ name: 'ลุ้นได้', value: '`' + setup.rewardActual.toFixed(2) + '` USD', inline: true });
    }

    /*
     * เข้าได้ถึงราคาไหน
     *
     * สัญญาณมาถึงมือช้ากว่าที่ราคาวิ่งเสมอ คำถามแรกของคนอ่านคือ
     * "ตอนนี้ยังเข้าทันไหม" ซึ่งตอบไม่ได้ถ้าบอกมาแค่ราคาเข้าจุดเดียว
     * ตัวเลขนี้คือราคาที่แย่ที่สุดที่อัตราส่วนได้:เสีย ยังคุ้มอยู่ เลยไปแล้วให้ปล่อยผ่าน
     */
    /*
     * ทำไมไม้นี้ใหญ่กว่า/เท่าปกติ
     *
     * การเห็นขนาดไม้โตขึ้นโดยไม่รู้เหตุผล น่ากลัวกว่าไม่โตเลย
     * และถ้าไม่โต ก็ควรรู้ว่าเพราะอะไร จะได้ไม่นึกว่าฟีเจอร์เสีย
     */
    if (sizing && sizing.boosted) {
      fields.push({ name: `เพิ่มขนาดไม้ ${sizing.mult.toFixed(2)}× (สัญญาณชัด)`,
        value: clip(sizing.why, 1000), inline: false });
    }

    /* กฎหลังเข้าไม้ — ที่ที่คนเสียไม้จริง ไม่ใช่ตอนเลือกจังหวะเข้า */
    if (setup.manage && setup.manage.length) {
      fields.push({ name: 'หลังเข้าไม้แล้ว',
        value: clip(setup.manage.map((m) => '• ' + m).join('\n'), 1000), inline: false });
    }

    if (setup.entryLimit !== undefined && setup.entryLimit !== null) {
      fields.push({ name: `ยังเข้าได้ถึง (ได้:เสีย ≥ ${setup.minRR})`,
        value: '`' + setup.entryLimit.toFixed(2) + '` — เลยราคานี้ไปแล้วอย่าไล่ราคา', inline: false });
    }
  }
  if (prob && prob.p !== null && prob.p !== undefined) {
    fields.push({ name: 'อัตราชนะในอดีต', value: `\`${prob.p.toFixed(0)}%\` (${prob.n} ไม้)`, inline: true });
  }
  if (blocks.length) {
    fields.push({ name: 'เหตุผลที่ยังไม่ควรเข้า', value: clip(blocks.join('\n'), 1000) });
  }
  const warnings = (setup && setup.notes ? setup.notes : []).filter((n) => /⚠|⛔/.test(n));
  if (warnings.length) {
    fields.push({ name: 'ต้องอ่านก่อนเข้า', value: clip(warnings.join('\n\n'), 1000) });
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
