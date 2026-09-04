/**
 * position.js — ติดตามไม้ที่เปิดอยู่จริง แบบเรียลไทม์
 *
 * ทำไมต้องมี: แอปบอกได้ว่า "ควรเข้าตรงไหน" แต่พอเข้าไปแล้วก็เงียบ
 * ผู้ใช้ต้องสลับไปแอปโบรกเกอร์เพื่อดูว่าตอนนี้กำไรหรือขาดทุนเท่าไร
 * และที่สำคัญกว่านั้น — ไม่มีอะไรบอกว่า "ยังเหลือระยะอีกเท่าไรถึง SL"
 * ซึ่งเป็นตัวเลขที่ตัดสินใจได้จริงกว่ากำไรขาดทุนเป็นดอลลาร์เสียอีก
 *
 * ไฟล์นี้ไม่ต่อกับโบรกเกอร์ ผู้ใช้บันทึกไม้เอง แล้วระบบคิดให้จากราคาสด
 * จึงใช้ได้กับทุกโบรกเกอร์โดยไม่ต้องขอสิทธิ์อะไรเลย
 */

/** ไม้ว่าง ๆ สำหรับเริ่มกรอก */
export function blankPosition(side = 1, price = 0) {
  return { side, entry: price, sl: 0, tp: 0, size: 1, contractSize: 1, openedAt: Date.now(), note: '' };
}

const num = (v) => (Number.isFinite(+v) ? +v : NaN);

/**
 * ตรวจว่าไม้ที่กรอกมาใช้คำนวณได้ไหม — คืนรายการปัญหาเป็นภาษาคน
 *
 * ต้องเช็คก่อนคำนวณเสมอ เพราะเลขที่กรอกผิดจะให้กำไรขาดทุนที่ดูสมเหตุสมผล
 * แต่ผิดความจริง ซึ่งอันตรายกว่าไม่แสดงอะไรเลย
 */
export function checkPosition(p) {
  const bad = [];
  if (!p) return ['ยังไม่ได้บันทึกไม้'];
  if (p.side !== 1 && p.side !== -1) bad.push('ต้องระบุว่าซื้อหรือขาย');
  if (!(num(p.entry) > 0)) bad.push('ราคาเข้าต้องมากกว่า 0');
  if (!(num(p.size) > 0)) bad.push('ขนาดไม้ต้องมากกว่า 0');
  if (!(num(p.contractSize) > 0)) bad.push('ขนาดสัญญาต้องมากกว่า 0');
  if (num(p.sl) > 0 && num(p.entry) > 0) {
    /* SL ผิดฝั่งคือความผิดพลาดที่เกิดบ่อยและมองไม่เห็นด้วยตา
       ถ้าปล่อยผ่าน ระบบจะบอกว่า "ยังห่าง SL อีกไกล" ทั้งที่จริงเลยมาแล้ว */
    if (p.side > 0 && p.sl >= p.entry) bad.push('ไม้ซื้อ: จุดตัดขาดทุนต้องต่ำกว่าราคาเข้า');
    if (p.side < 0 && p.sl <= p.entry) bad.push('ไม้ขาย: จุดตัดขาดทุนต้องสูงกว่าราคาเข้า');
  }
  if (num(p.tp) > 0 && num(p.entry) > 0) {
    if (p.side > 0 && p.tp <= p.entry) bad.push('ไม้ซื้อ: เป้าทำกำไรต้องสูงกว่าราคาเข้า');
    if (p.side < 0 && p.tp >= p.entry) bad.push('ไม้ขาย: เป้าทำกำไรต้องต่ำกว่าราคาเข้า');
  }
  return bad;
}

/**
 * สถานะไม้ ณ ราคาปัจจุบัน
 *
 * @param {object} p    ไม้ที่บันทึกไว้
 * @param {number} px   ราคาล่าสุด
 * @param {number} account ทุนทั้งหมด (ใส่ 0 ถ้าไม่อยากคิดเป็น % ของพอร์ต)
 */
export function positionStatus(p, px, account = 0) {
  const problems = checkPosition(p);
  if (problems.length || !Number.isFinite(px) || px <= 0) return { ok: false, problems };

  const side = p.side;
  const move = (px - p.entry) * side;              // ระยะที่ราคาไปทางเรา (ติดลบ = สวนทาง)
  const unit = p.size * p.contractSize;            // กำไรขาดทุนต่อการเคลื่อนไหว 1 หน่วยราคา
  const pl = move * unit;

  const slDist = p.sl > 0 ? Math.abs(p.entry - p.sl) : null;
  const tpDist = p.tp > 0 ? Math.abs(p.tp - p.entry) : null;
  /* คิดเป็น R เสมอเมื่อรู้ SL — เพราะ "ตอนนี้ได้ 0.7R" บอกอะไรได้มากกว่า "ได้ 7 ดอลลาร์"
     คนที่เทรดด้วยระบบตัดสินใจจากตัวเลขนี้ ไม่ใช่จากจำนวนเงิน */
  const r = slDist ? move / slDist : null;

  const toSL = p.sl > 0 ? (px - p.sl) * side : null;   // บวก = ยังไม่ถึง SL
  const toTP = p.tp > 0 ? (p.tp - px) * side : null;   // บวก = ยังไม่ถึงเป้า
  const risk = slDist ? slDist * unit : null;

  /* เดินทางมาถึงไหนแล้วระหว่าง SL กับ TP — ใช้วาดแถบให้เห็นภาพในแวบเดียว
     0% = อยู่ที่ SL, 100% = อยู่ที่เป้า */
  let progress = null;
  if (p.sl > 0 && p.tp > 0) {
    const span = Math.abs(p.tp - p.sl);
    progress = span > 0 ? Math.max(0, Math.min(1, ((px - p.sl) * side) / span)) : null;
  }

  const hitSL = toSL !== null && toSL <= 0;
  const hitTP = toTP !== null && toTP <= 0;

  return {
    ok: true, problems: [], side, price: px, entry: p.entry,
    move, pl, r, risk,
    plPct: account > 0 ? (pl / account) * 100 : null,
    slDist, tpDist, toSL, toTP, progress, hitSL, hitTP,
    /* สถานะเป็นคำ ใช้เลือกสีและข้อความ ไม่ต้องให้หน้าจอมาตีความเองซ้ำ */
    state: hitSL ? 'sl' : hitTP ? 'tp' : pl > 0 ? 'win' : pl < 0 ? 'lose' : 'flat',
    heldMs: p.openedAt ? Date.now() - p.openedAt : null,
  };
}

/**
 * ประโยคเดียวที่บอกว่าตอนนี้ควรรู้สึกยังไงกับไม้นี้
 *
 * ตั้งใจให้อ่านจบในแวบเดียวตอนเปิดดูกลางวัน ไม่ใช่ตารางตัวเลขให้มานั่งตีความ
 * และต้องไม่เชียร์ให้ทำอะไร — หน้าที่ของมันคือรายงาน ไม่ใช่สั่ง
 */
export function positionAdvice(st) {
  if (!st || !st.ok) return null;
  if (st.hitSL) return { level: 'sl', text: 'ราคาถึงจุดตัดขาดทุนแล้ว — ถ้าตั้ง SL ไว้กับโบรกเกอร์ ไม้นี้ควรถูกปิดไปแล้ว' };
  if (st.hitTP) return { level: 'tp', text: 'ราคาถึงเป้าแล้ว — ถ้าตั้ง TP ไว้ ไม้นี้ควรถูกปิดไปแล้ว' };
  if (st.r === null) return { level: 'flat', text: 'ยังไม่ได้ใส่จุดตัดขาดทุน จึงบอกได้แค่กำไรขาดทุนเป็นเงิน ไม่ใช่เทียบกับความเสี่ยง' };
  if (st.r >= 1) return { level: 'win', text: `กำไรตอนนี้ ${st.r.toFixed(2)} เท่าของที่เสี่ยงไป — เลยจุดที่ชนะหนึ่งไม้ลบล้างแพ้หนึ่งไม้ได้แล้ว` };
  if (st.r >= 0.3) return { level: 'win', text: `กำไรอยู่ ${st.r.toFixed(2)} เท่าของที่เสี่ยง — ยังไม่ถึงเป้า ราคาย่อกลับมาบ้างเป็นเรื่องปกติ` };
  if (st.r > -0.5) return { level: 'flat', text: 'ยังแกว่งอยู่แถวราคาเข้า — ระยะแค่นี้ยังไม่บอกอะไร ไม่ใช่สัญญาณให้รีบทำอะไร' };
  return { level: 'lose', text: `ติดลบ ${Math.abs(st.r).toFixed(2)} เท่าของที่เสี่ยง — ยังไม่ถึงจุดตัดขาดทุน แผนเดิมจึงยังไม่ผิด` };
}
