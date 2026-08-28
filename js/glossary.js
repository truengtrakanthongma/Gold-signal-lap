/**
 * glossary.js — แปลชื่อปัจจัยและรูปแบบแท่งเทียนเป็นภาษาไทย
 *
 * แสดงชื่อไทยนำ แล้ววงเล็บชื่ออังกฤษไว้ท้าย เพราะผู้เรียนจะไปเจอศัพท์อังกฤษ
 * ในโปรแกรมเทรดและคลิปสอนอื่น ๆ อยู่ดี — เห็นคู่กันบ่อย ๆ จะจำได้เอง
 */

const TH = {
  'EMA Alignment': 'การเรียงตัวของเส้นค่าเฉลี่ย',
  'ADX / DI': 'ความแรงของแนวโน้ม',
  MACD: 'โมเมนตัม (แรงส่งของราคา)',
  'MACD Cross': 'จุดตัดโมเมนตัม',
  'RSI Momentum': 'แรงซื้อ-แรงขาย',
  'RSI Overheat': 'ราคาร้อนแรงเกินไป',
  'RSI Oversold': 'ราคาถูกทุบเกินไป',
  'RSI Mean-Revert': 'ราคาเหวี่ยงห่างค่ากลาง',
  'Market Structure': 'โครงสร้างราคา',
  'Volume Confirm': 'ปริมาณซื้อขายยืนยัน',
  'Volume Warning': 'ปริมาณซื้อขายเบาบาง',
  'BB Squeeze Breakout': 'กรอบบีบแคบแล้วทะลุขึ้น',
  'BB Squeeze Breakdown': 'กรอบบีบแคบแล้วหลุดลง',
  'BB Lower Band': 'ราคาแตะขอบล่างของกรอบ',
  'BB Upper Band': 'ราคาแตะขอบบนของกรอบ',
  'Band Ride': 'ราคาเกาะขอบกรอบไปเรื่อย ๆ',
  'Support Test': 'ราคาลงมาทดสอบแนวรับ',
  'Resistance Test': 'ราคาขึ้นไปทดสอบแนวต้าน',
  'Resistance Break': 'ทะลุแนวต้านขึ้นไป',
  'Support Break': 'หลุดแนวรับลงมา',
  'Bullish Divergence': 'สัญญาณแรงขายเริ่มหมด',
  'Bearish Divergence': 'สัญญาณแรงซื้อเริ่มหมด',
  'VWAP Position': 'ราคาเทียบต้นทุนเฉลี่ยของวัน',
  'Stochastic Cross': 'จุดตัดสัญญาณระยะสั้น',
  // รูปแบบแท่งเทียน
  'Bullish Engulfing': 'แท่งเขียวกลืนแท่งแดง',
  'Bearish Engulfing': 'แท่งแดงกลืนแท่งเขียว',
  'Hammer / Pin Bar': 'ค้อน — ไส้ล่างยาว',
  'Shooting Star': 'ดาวตก — ไส้บนยาว',
  'Strong Bull Candle': 'แท่งขึ้นแรงผิดปกติ',
  'Strong Bear Candle': 'แท่งลงแรงผิดปกติ',
  'Morning Star': 'ดาวรุ่ง — กลับตัวขึ้น',
  'Evening Star': 'ดาวค่ำ — กลับตัวลง',
  Doji: 'โดจิ — ตลาดลังเล',
  'Inside Bar Breakout': 'บีบตัวแล้วทะลุขึ้น',
  'Inside Bar Breakdown': 'บีบตัวแล้วหลุดลง',
};

/**
 * แปลงชื่อปัจจัยเป็นคู่ ไทย/อังกฤษ
 * @returns {{th:string, en:string}}
 */
export function toThai(name) {
  if (!name) return { th: '', en: '' };
  const pa = name.match(/^Price Action:\s*(.+)$/);
  if (pa) {
    const inner = pa[1].trim();
    return { th: `รูปแบบแท่งเทียน: ${TH[inner] || inner}`, en: inner };
  }
  const th = TH[name];
  return th ? { th, en: name } : { th: name, en: '' };
}
