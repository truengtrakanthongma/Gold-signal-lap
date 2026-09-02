/**
 * classic.js — เทคนิคจากตำราที่คนในวงการยอมรับ
 *
 * ทุกตัวในไฟล์นี้ต้องผ่านการวัดก่อนถึงจะถูกเอาไปใช้ให้คะแนน
 * ตำราเขียนไว้ว่าดี ไม่ได้แปลว่าดีกับทองในกรอบ 15 นาทีของเรา
 * ที่มาแต่ละตัวเขียนกำกับไว้ เพื่อให้ตามไปอ่านต้นทางได้
 *
 * *** ห้ามมองอนาคต *** ทุกฟังก์ชันดูได้แค่แท่งที่ index i และก่อนหน้าเท่านั้น
 */

const hi = (c) => c.h;
const lo = (c) => c.l;

/**
 * Spring / Upthrust — Richard Wyckoff
 *
 * ราคาทะลุแนวออกไปแล้ว "เอาไม่อยู่" กลับเข้ามาในกรอบเดิมอย่างรวดเร็ว
 * ไวคอฟฟ์อธิบายว่าเป็นการกวาดคำสั่งตัดขาดทุนของรายย่อยก่อนราคาไปทางตรงข้าม
 * ฝั่งขาลงเรียก spring (ทะลุลงแล้วเด้งกลับ) ฝั่งขาขึ้นเรียก upthrust
 *
 * แนวคิดเดียวกันนี้ Linda Raschke เรียก "Turtle Soup" เมื่อใช้กับจุดสูง/ต่ำ 20 วัน
 *
 * @param {number} look จำนวนแท่งที่ใช้หาจุดสูง/ต่ำอ้างอิง
 * @param {number} within ต้องกลับเข้ากรอบภายในกี่แท่ง
 */
export function springUpthrust(candles, i, atrVal, { look = 40, within = 3, minTouch = 2 } = {}) {
  if (i < look + within + 2) return null;
  const a = atrVal > 0 ? atrVal : 1e-9;

  for (let back = 1; back <= within; back++) {
    const brk = i - back;                       // แท่งที่ทะลุออกไป
    const from = brk - look, to = brk - 1;
    if (from < 0) return null;
    let hh = -Infinity, ll = Infinity, touchHi = 0, touchLo = 0;
    for (let k = from; k <= to; k++) { hh = Math.max(hh, hi(candles[k])); ll = Math.min(ll, lo(candles[k])); }
    /* แนวที่มีความหมายต้องเคยถูกทดสอบมาก่อน ไม่ใช่จุดต่ำสุดบังเอิญของช่วงนั้น
       ไวคอฟฟ์พูดถึงกรอบสะสมที่ราคาเคยเด้งซ้ำ ๆ ไม่ใช่ก้นหลุมครั้งเดียว */
    for (let k = from; k <= to; k++) {
      if (Math.abs(lo(candles[k]) - ll) <= a * 0.6) touchLo++;
      if (Math.abs(hi(candles[k]) - hh) <= a * 0.6) touchHi++;
    }

    const b = candles[brk], c = candles[i];
    const bRange = Math.max(b.h - b.l, 1e-9);

    /*
     * เงื่อนไขที่เข้มขึ้นหลังวัดแล้วพบว่าแบบหลวมจับได้ทุก 5 แท่ง ซึ่งมั่วเกินไป
     * spring ของจริงต้องมีครบสี่อย่าง: แนวเคยถูกทดสอบซ้ำ · ทะลุลึกพอ ·
     * แท่งที่ทะลุปิดกลับเข้ามาแล้ว (ปฏิเสธราคาต่ำในแท่งเดียวกัน) · ตอนนี้ยังยืนเหนือแนว
     */
    if (touchLo >= minTouch && b.l < ll - a * 0.2 && b.c > ll
        && (b.c - b.l) / bRange > 0.45 && c.c > ll) {
      const depth = (ll - b.l) / a;
      return { side: 1, name: 'Spring (Wyckoff)', level: ll, depth, bars: back, touches: touchLo,
        strength: Math.min(1, depth / 1.5),
        reason: `ทะลุลงใต้แนวรับที่ ${ll.toFixed(2)} (เคยถูกทดสอบ ${touchLo} ครั้ง) ลึก ${depth.toFixed(2)} เท่าของ ATR `
          + 'แล้วดีดกลับปิดเหนือแนวในแท่งเดียวกัน — ไวคอฟฟ์เรียก spring คือกวาด SL ก่อนไปทางตรงข้าม' };
    }
    if (touchHi >= minTouch && b.h > hh + a * 0.2 && b.c < hh
        && (b.h - b.c) / bRange > 0.45 && c.c < hh) {
      const depth = (b.h - hh) / a;
      return { side: -1, name: 'Upthrust (Wyckoff)', level: hh, depth, bars: back, touches: touchHi,
        strength: Math.min(1, depth / 1.5),
        reason: `ทะลุขึ้นเหนือแนวต้านที่ ${hh.toFixed(2)} (เคยถูกทดสอบ ${touchHi} ครั้ง) ไป ${depth.toFixed(2)} เท่าของ ATR `
          + 'แล้วโดนตีกลับปิดใต้แนวในแท่งเดียวกัน — upthrust คือกับดักฝั่งซื้อ' };
    }
  }
  return null;
}

/**
 * NR7 และการบีบตัวของความผันผวน — Toby Crabel
 *
 * "Day Trading with Short Term Price Patterns and Opening Range Breakout"
 * แกนคือ ช่วงราคาที่แคบผิดปกติมักตามมาด้วยการขยายตัว
 * NR7 = แท่งที่ช่วงราคาแคบที่สุดในรอบ 7 แท่ง
 *
 * ตัวนี้ไม่บอกทิศทาง บอกแค่ว่า "กำลังจะมีการเคลื่อนไหว" จึงคืน side เป็น 0
 */
export function rangeContraction(candles, i, { n = 7 } = {}) {
  if (i < n) return null;
  const r = (c) => c.h - c.l;
  const cur = r(candles[i]);
  let narrowest = true, sum = 0;
  for (let k = i - n + 1; k <= i; k++) {
    sum += r(candles[k]);
    if (k !== i && r(candles[k]) <= cur) narrowest = false;
  }
  if (!narrowest) return null;
  const avg = sum / n;
  return { side: 0, name: `NR${n} (Crabel)`, ratio: cur / (avg || 1e-9),
    strength: Math.min(1, 1 - cur / (avg || 1e-9)),
    reason: `ช่วงราคาแท่งนี้แคบที่สุดใน ${n} แท่ง (${(cur / avg * 100).toFixed(0)}% ของค่าเฉลี่ย) `
      + '— แครเบลชี้ว่าช่วงที่บีบตัวมักตามด้วยการขยายตัวแรง แต่ไม่บอกทิศ' };
}

/**
 * Effort vs Result — Richard Wyckoff
 *
 * ปริมาณซื้อขาย (ความพยายาม) ควรสมน้ำสมเนื้อกับระยะที่ราคาไปได้ (ผลลัพธ์)
 * ถ้าปริมาณพุ่งแต่ราคาแทบไม่ไปไหน แปลว่ามีคนรับของอยู่ฝั่งตรงข้าม
 * ไวคอฟฟ์ถือเป็นสัญญาณว่าแนวโน้มปัจจุบันกำลังหมดแรง
 */
export function effortVsResult(candles, i, atrVal, { look = 20 } = {}) {
  if (i < look) return null;
  let vs = 0;
  for (let k = i - look; k < i; k++) vs += candles[k].v;
  const avgV = vs / look;
  if (!avgV) return null;
  const c = candles[i];
  const a = atrVal > 0 ? atrVal : 1e-9;
  const volX = c.v / avgV;
  const rangeX = (c.h - c.l) / a;
  /* ปริมาณมากผิดปกติแต่ระยะทางสั้น = มีการดูดซับ ทิศสวนกับแท่งนั้น */
  if (volX >= 1.5 && rangeX <= 0.85) {
    const side = c.c >= c.o ? -1 : 1;
    return { side, name: 'Effort vs Result (Wyckoff)', volX, rangeX,
      strength: Math.min(1, (volX - 1.5) / 2 + 0.4),
      reason: `ปริมาณซื้อขาย ${volX.toFixed(1)} เท่าของค่าเฉลี่ย แต่ราคาไปได้แค่ ${rangeX.toFixed(2)} เท่าของ ATR `
        + '— แรงเยอะแต่ไม่ไปไหน แปลว่ามีคนรับของอยู่ฝั่งตรงข้าม' };
  }
  return null;
}

/**
 * Holy Grail — Linda Raschke & Larry Connors ("Street Smarts")
 *
 * ตลาดที่มีแนวโน้มแข็ง (ADX สูง) แล้วย่อกลับมาแตะเส้นค่าเฉลี่ย 20
 * เป็นจังหวะเข้าตามแนวโน้มที่ความเสี่ยงต่ำที่สุด เพราะ SL อยู่ใกล้
 *
 * ต้นฉบับใช้ ADX > 30 บนกราฟรายวัน ที่นี่รับค่ามาจากภายนอกเพื่อปรับได้
 */
export function holyGrailPullback(candles, i, ctxLike, { adxMin = 30 } = {}) {
  const { adx, ema20, atr } = ctxLike;
  if (i < 1) return null;
  const ad = adx && adx.adx ? adx.adx[i] : null;
  const e = ema20 ? ema20[i] : null;
  const a = atr ? atr[i] : null;
  if (!Number.isFinite(ad) || !Number.isFinite(e) || !Number.isFinite(a) || a <= 0) return null;
  if (ad < adxMin) return null;

  const c = candles[i];
  const plus = adx.plusDI ? adx.plusDI[i] : null;
  const minus = adx.minusDI ? adx.minusDI[i] : null;
  if (!Number.isFinite(plus) || !Number.isFinite(minus)) return null;
  const up = plus > minus;

  /* ต้องแตะเส้นจริง ไม่ใช่แค่เข้าใกล้ และต้องยังไม่หลุดเส้นไปอีกฝั่ง */
  const touched = c.l <= e + a * 0.25 && c.h >= e - a * 0.25;
  if (!touched) return null;
  if (up && c.c < e - a * 0.5) return null;
  if (!up && c.c > e + a * 0.5) return null;

  return { side: up ? 1 : -1, name: 'Holy Grail (Raschke)', adx: ad,
    strength: Math.min(1, (ad - adxMin) / 20 + 0.5),
    reason: `แนวโน้มแข็ง (ADX ${ad.toFixed(0)}) แล้วราคาย่อกลับมาแตะเส้นค่าเฉลี่ย 20 ที่ ${e.toFixed(2)} `
      + '— รัสช์กีเรียกจังหวะนี้ว่าเข้าตามเทรนด์โดยเสี่ยงน้อยที่สุด เพราะจุดตัดขาดทุนอยู่ใกล้' };
}
