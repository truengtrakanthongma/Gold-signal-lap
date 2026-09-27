/**
 * preload สำหรับทดสอบบอทแบบครบสายโดยไม่ต่อเน็ต
 *
 * แทน fetch ด้วยตลาดสมมติในรูปแบบคำตอบของ Kraken และหยุดเวลาไว้ที่ MOCK_NOW
 * MOCK_SCENARIO:
 *   entry → เทรนด์ขาขึ้นสม่ำเสมอ แล้วแท่ง 4 ชม. ที่เพิ่งปิดย่อลงใต้เส้นค่าเฉลี่ย 20 แท่ง
 *   wait  → เทรนด์ขาขึ้นเหมือนกัน แต่ไม่มีการย่อ
 * ข้อความที่จะส่งเข้า Discord ถูกพิมพ์ออกมาแทนการส่งจริง ให้ตัวทดสอบอ่านได้
 */
const NOW = +process.env.MOCK_NOW;
const SCENARIO = process.env.MOCK_SCENARIO || 'entry';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

const H4 = 4 * 3600000, D1 = 86400000;
function daily() {
  const end = Math.floor(NOW / D1) * D1;           // แท่งวันนี้ยังไม่ปิด
  const out = [];
  for (let k = 399; k >= 0; k--) {
    const t = end - k * D1, c = 3000 + (399 - k) * 4;
    out.push([t / 1000, c - 2, c + 6, c - 6, c, 0, 100, 1]);
  }
  return out;
}
function fourHour() {
  const cur = Math.floor(NOW / H4) * H4;          // แท่งที่กำลังก่อตัว
  const out = [];
  for (let k = 719; k >= 0; k--) {
    const t = cur - k * H4, i = 719 - k;
    let c = 3000 + (i / 6) * 4 + 2;                // ไต่ขึ้นเท่ากับกราฟรายวัน
    let o = c - 0.6;
    if (SCENARIO === 'entry' && k === 1) { o = c; c = c - 25; }   // แท่งที่เพิ่งปิด: ย่อแรง
    if (k === 0) { o = out[out.length - 1][4]; c = o; }           // แท่งที่เพิ่งเริ่ม
    out.push([t / 1000, o, Math.max(o, c) + 1, Math.min(o, c) - 1, c, 0, 50, 1]);
  }
  return out;
}
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('discord.com')) {
    const body = JSON.parse(init.body);
    console.log('MOCK_DISCORD ' + JSON.stringify(body));
    return { ok: true, status: 204 };
  }
  if (u.includes('kraken.com')) {
    const iv = +new URL(u).searchParams.get('interval');
    const rows = iv === 1440 ? daily() : fourHour();
    const fmt = rows.map((r) => [r[0], String(r[1]), String(r[2]), String(r[3]), String(r[4]), '0', String(r[6]), r[7]]);
    return { ok: true, status: 200, json: async () => ({ error: [], result: { PAXGUSD: fmt, last: 0 } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
