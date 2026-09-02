/**
 * line.js — ส่งสัญญาณเข้า LINE ผ่าน Messaging API
 *
 * ทำไมมีทั้ง Discord และ LINE: คนไทยส่วนใหญ่เปิดแจ้งเตือน LINE ไว้อยู่แล้ว
 * ส่วน Discord ต้องตั้งค่าแจ้งเตือนเพิ่มเอง และมักโดนปิดเสียงโดยไม่รู้ตัว
 * ช่องทางที่เตือนแล้วไม่ถึงตัวคนใช้ ก็ไม่ต่างจากไม่มีเลย
 *
 * *** LINE Notify ปิดบริการไปแล้ว *** ตัวที่ใช้ได้คือ Messaging API
 * ซึ่งต้องมีบัญชีทางการ (Official Account) แล้วเอา channel access token มาใช้
 *
 * *** โทเค็นคือความลับ *** ใครได้ไปก็ส่งข้อความในนามคุณได้
 * จึงเก็บใน Secrets ของ GitHub เท่านั้น ไม่เขียนลงไฟล์ ไม่ขึ้นรีโป
 */

const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const MAX_TEXT = 5000;   // ขีดจำกัดข้อความหนึ่งก้อนของ LINE

/** ตัดข้อความให้พอดีขีดจำกัด โดยยังบอกให้รู้ว่าถูกตัด */
export function clipText(t, max = MAX_TEXT) {
  const s = String(t == null ? '' : t);
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

/**
 * ตรวจว่าตั้งค่า LINE มาครบและใช้ได้ไหม — คืน null ถ้าไม่มีปัญหา
 *
 * แยกเหตุผลเหมือนฝั่ง Discord เพราะ "ตั้งค่าไม่ครบ" กับ "ตั้งค่าผิด"
 * แก้คนละวิธี และการบอกรวม ๆ ว่า "ใช้ไม่ได้" ทำให้คนติดอยู่ตรงนั้น
 */
export function lineProblem(token, to) {
  const tk = String(token == null ? '' : token).trim();
  const id = String(to == null ? '' : to).trim();
  if (!tk) return 'ยังไม่ได้ใส่ LINE_TOKEN (channel access token ของบัญชีทางการ)';
  if (!id) return 'ยังไม่ได้ใส่ LINE_TO (ไอดีผู้รับ ขึ้นต้นด้วย U, C หรือ R)';
  if (tk.length < 40) return 'LINE_TOKEN สั้นผิดปกติ — น่าจะคัดลอกมาไม่ครบ';
  /* ไอดีผู้รับของ LINE ขึ้นต้นด้วย U (คน) C (กลุ่ม) R (ห้อง) ตามด้วยเลขฐานสิบหก 32 ตัว
     คนมักเอา "ไอดีที่ใช้ค้นหาเพื่อน" มาใส่แทน ซึ่งคนละอย่างและใช้ไม่ได้ */
  if (!/^[UCR][0-9a-f]{32}$/.test(id)) {
    return `LINE_TO ไม่ใช่รูปแบบไอดีผู้รับ (ต้องเป็น U/C/R ตามด้วยเลขฐานสิบหก 32 ตัว) — `
      + 'ไม่ใช่ไอดีที่ใช้ค้นหาเพื่อน ต้องเอามาจาก webhook หรือหน้า Developers';
  }
  return null;
}

/** แปลงข้อความแบบ Discord (embed) ให้เป็นข้อความล้วนที่ LINE อ่านรู้เรื่อง */
export function toPlainText(msg) {
  const e = msg && msg.embeds && msg.embeds[0];
  if (!e) return clipText(typeof msg === 'string' ? msg : JSON.stringify(msg));
  const lines = [];
  if (e.title) lines.push(e.title);
  if (e.description) lines.push(String(e.description).replace(/\*\*/g, '').replace(/`/g, ''));
  for (const f of e.fields || []) {
    const val = String(f.value).replace(/\*\*/g, '').replace(/`/g, '');
    /* ค่าสั้น ๆ อยู่บรรทัดเดียวกับหัวข้อได้ ค่ายาว ๆ ต้องขึ้นบรรทัดใหม่ไม่งั้นอ่านไม่ออกบนมือถือ */
    lines.push('', val.includes('\n') || val.length > 40 ? `[${f.name}]\n${val}` : `${f.name}: ${val}`);
  }
  if (e.footer && e.footer.text) lines.push('', e.footer.text);
  return clipText(lines.join('\n'));
}

/** ส่งข้อความเข้า LINE */
export async function sendLine(token, to, msg, opts = {}) {
  const problem = lineProblem(token, to);
  if (problem) return { ok: false, reason: problem };
  const text = typeof msg === 'string' ? clipText(msg) : toPlainText(msg);
  const doFetch = opts.fetchImpl || ((u, i) => fetch(u, i));
  const t0 = Date.now();
  try {
    const res = await doFetch(PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(token).trim()}` },
      body: JSON.stringify({ to: String(to).trim(), messages: [{ type: 'text', text }] }),
    });
    const ms = Date.now() - t0;
    if (res.ok || res.status === 200) return { ok: true, ms, status: res.status };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, ms, status: res.status,
        reason: 'LINE ปฏิเสธโทเค็น — หมดอายุ ถูกเปลี่ยน หรือคัดลอกมาไม่ครบ สร้างใหม่ในหน้า Developers' };
    }
    if (res.status === 429) {
      return { ok: false, ms, status: 429,
        reason: 'ส่งเกินโควตาเดือนนี้ของแผนฟรี หรือส่งถี่เกินไป — รอเดือนถัดไปหรือลดความถี่' };
    }
    if (res.status === 400) {
      return { ok: false, ms, status: 400,
        reason: 'LINE ไม่รับคำขอ — มักเพราะ LINE_TO ไม่ใช่ไอดีผู้รับที่ถูกต้อง หรือผู้รับยังไม่ได้เพิ่มบัญชีทางการเป็นเพื่อน' };
    }
    return { ok: false, ms, status: res.status, reason: `LINE ตอบรหัส ${res.status}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0,
      reason: `ส่งเข้า LINE ไม่ได้: ${String((e && e.message) || e)}` };
  }
}
