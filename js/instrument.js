/**
 * instrument.js — บอกให้ชัดว่ากำลังดูราคาอะไรอยู่
 *
 * แอปเคยเขียนว่า "ทองคำ USD/ออนซ์" ทั้งที่ดึงราคา PAXG/USDT มา
 * ซึ่งเป็นโทเคนที่หนุนด้วยทองคำ ไม่ใช่ราคาทองสปอต (XAU/USD)
 * สองอย่างนี้วิ่งเกาะกันแต่ไม่เท่ากัน ต่างกันได้หลายดอลลาร์
 *
 * ถ้าผู้ใช้เอาไปเทียบกับกราฟทองของโบรกเกอร์แล้วเห็นตัวเลขไม่ตรง
 * นั่นไม่ใช่กราฟผิด แต่เป็นคนละสินทรัพย์ — ต้องบอกให้รู้ ไม่ใช่ปล่อยให้เข้าใจผิด
 */

export const INSTRUMENTS = {
  PAXGUSDT: {
    name: 'PAXG/USDT',
    kind: 'โทเคนอิงทองคำ',
    long: 'Paxos Gold — โทเคน 1 เหรียญหนุนด้วยทองคำจริง 1 ทรอยออนซ์ เก็บในตู้นิรภัยลอนดอน',
    isSpot: false,
    note: 'ราคาวิ่งเกาะทองคำสปอต (XAU/USD) แต่ไม่เท่ากันเป๊ะ ต่างกันได้ประมาณ 0.1–1% '
        + 'ตามอุปสงค์อุปทานของโทเคนเอง โดยเฉพาะช่วงตลาดทองจริงปิด',
  },
  XAUTUSDT: {
    name: 'XAUT/USDT',
    kind: 'โทเคนอิงทองคำ',
    long: 'Tether Gold — โทเคน 1 เหรียญหนุนด้วยทองคำจริง 1 ทรอยออนซ์',
    isSpot: false,
    note: 'เช่นเดียวกับ PAXG คือวิ่งเกาะทองคำสปอตแต่ไม่เท่ากันเป๊ะ',
  },
  PAXGUSD: {
    name: 'PAXG/USD',
    kind: 'โทเคนอิงทองคำ เทียบดอลลาร์จริง',
    long: 'Paxos Gold ซื้อขายกับดอลลาร์สหรัฐโดยตรง (ไม่ผ่าน USDT)',
    isSpot: false,
    note: 'ใกล้ราคาทองคำสปอตกว่าคู่ที่เทียบ USDT เพราะตัดความคลาดเคลื่อนของ USDT ออกไปหนึ่งชั้น '
        + 'แต่ยังเป็นโทเคน จึงมีส่วนต่างของตัวเองอยู่ และสภาพคล่องบางกว่า',
  },
  XAUTUSD: {
    name: 'XAUT/USD',
    kind: 'โทเคนอิงทองคำ เทียบดอลลาร์จริง',
    long: 'Tether Gold ซื้อขายกับดอลลาร์สหรัฐโดยตรง (ไม่ผ่าน USDT)',
    isSpot: false,
    note: 'เช่นเดียวกับ PAXG/USD คือใกล้ราคาทองจริงกว่าคู่ที่เทียบ USDT แต่ยังไม่ใช่ทองสปอต',
  },
  'XAU/USD': {
    name: 'XAU/USD',
    kind: 'ทองคำสปอต',
    long: 'ราคาทองคำสปอตสากล ต่อ 1 ทรอยออนซ์',
    isSpot: true,
    note: 'นี่คือราคาทองคำจริงที่โบรกเกอร์และเว็บข่าวอ้างอิงกัน',
  },
  DEMO: {
    name: 'ข้อมูลจำลอง',
    kind: 'ไม่ใช่ราคาจริง',
    long: 'ตัวเลขสุ่มขึ้นในเครื่องเพื่อทดสอบระบบ',
    isSpot: false,
    note: 'ห้ามใช้ตัดสินใจซื้อขาย',
  },
};

const SOURCE_INSTRUMENT = {
  demo: 'DEMO',
  twelvedata: 'XAU/USD',
  kraken_paxg: 'PAXGUSD',
  bitfinex_xaut: 'XAUTUSD',
  okx_paxg: 'PAXGUSDT',
  binance_paxg: 'PAXGUSDT',
};

/**
 * แหล่งข้อมูลไหน = สินทรัพย์อะไร
 * ต้องตัดสินจากแหล่งก่อนเสมอ เพราะแหล่งเป็นตัวกำหนดว่าราคาที่ได้มาคือคู่อะไรจริง ๆ
 * ถ้าปล่อยให้ช่องสัญลักษณ์ตัดสิน ผู้ใช้เปลี่ยนแหล่งแล้วป้ายจะค้างอยู่ที่ของเดิม
 */
export function instrumentOf(source, symbol) {
  const key = SOURCE_INSTRUMENT[source];
  if (key) return INSTRUMENTS[key];
  return INSTRUMENTS[symbol] || INSTRUMENTS.PAXGUSDT;
}

/**
 * ตรวจสุขภาพข้อมูลที่โหลดมา — ถ้าผู้ใช้รู้สึกว่า "กราฟไม่ตรง"
 * ต้องตอบได้ว่ากำลังแสดงข้อมูลอะไร ครบไหม มีรูโหว่ตรงไหน
 */
export function dataHealth(candles, tfMs) {
  if (!candles || candles.length < 2) return { ok: false, reason: 'ข้อมูลน้อยเกินไป' };
  let gaps = 0, dups = 0, outOfOrder = 0, biggestGapBars = 0;
  const seen = new Set();
  for (let i = 0; i < candles.length; i++) {
    if (seen.has(candles[i].t)) dups++;
    seen.add(candles[i].t);
    if (i === 0) continue;
    const d = candles[i].t - candles[i - 1].t;
    if (d <= 0) { outOfOrder++; continue; }
    if (d > tfMs * 1.5) {
      gaps++;
      biggestGapBars = Math.max(biggestGapBars, Math.round(d / tfMs) - 1);
    }
  }
  const spanMs = candles[candles.length - 1].t - candles[0].t;
  return {
    ok: dups === 0 && outOfOrder === 0,
    bars: candles.length, gaps, dups, outOfOrder, biggestGapBars,
    from: candles[0].t, to: candles[candles.length - 1].t,
    days: spanMs / 86400000,
  };
}
