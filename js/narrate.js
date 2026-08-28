/**
 * narrate.js — คำบรรยายกราฟสดเป็นภาษาไทย (เพื่อการศึกษา)
 *
 * เป้าหมาย: อ่านแล้วเข้าใจว่า "ตอนนี้กราฟกำลังบอกอะไร" โดยไม่ต้องรู้ศัพท์เทคนิคมาก่อน
 * ทุกครั้งที่ใช้ศัพท์เฉพาะ จะอธิบายความหมายกำกับไว้ในประโยคเดียวกัน
 *
 * ทุกข้อความสร้างจากตัวเลขจริงบนกราฟ ณ วินาทีนั้น ไม่ใช่ข้อความสำเร็จรูป
 */

import { projectedVolume } from './signals.js';

const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n))
  ? '—'
  : n.toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d });

/** แปลงระยะทางราคาเป็นภาษาคน: กี่ดอลลาร์ และคิดเป็นกี่เท่าของการแกว่งปกติ */
function distanceText(dist, atr) {
  const mult = atr > 0 ? dist / atr : 0;
  let how;
  if (mult < 0.4) how = 'ใกล้มาก ราคาแตะได้ภายในแท่งเดียว';
  else if (mult < 1) how = 'ใกล้ ราคาไปถึงได้ในแท่งเดียวถ้ามีแรง';
  else if (mult < 2.5) how = 'ระยะกลาง ๆ ต้องใช้เวลาสัก 2-3 แท่ง';
  else how = 'ยังไกล ต้องใช้หลายแท่งกว่าจะถึง';
  return `${fmt(dist)} ดอลลาร์ (${mult.toFixed(1)} เท่าของระยะแกว่งปกติต่อแท่ง — ${how})`;
}

/**
 * สร้างคำบรรยายกราฟ ณ ขณะนั้น
 * @returns {{id:string,title:string,tone:string,text:string}[]}
 */
export function narrate({ candles, ctx, scored, combined, setup, action, blocks = [], tf, session, prob, htfScores = [] }) {
  const out = [];
  if (!candles || !candles.length || !scored || !scored.ready) {
    return [{ id: 'wait', title: 'กำลังรวบรวมข้อมูล', tone: 'neutral',
      text: 'ระบบต้องใช้ข้อมูลอย่างน้อยประมาณ 200 แท่งเพื่อคำนวณเส้นค่าเฉลี่ยระยะยาวให้นิ่งก่อน รอสักครู่แล้วคำอธิบายจะขึ้นเอง' }];
  }

  const i = candles.length - 1;
  const c = candles[i];
  const prev = candles[i - 1];
  const price = c.c;
  const atr = scored.atr;
  const chg = prev ? price - prev.c : 0;
  const chgPct = prev && prev.c ? (chg / prev.c) * 100 : 0;

  // ── 1) ราคาตอนนี้ ──────────────────────────────────────────────────────
  const bodyPct = Math.abs(c.c - c.o) / Math.max(c.h - c.l, 1e-9);
  const forming = c.closed === false;
  const inBar = c.c - c.o;   // ราคาขยับเท่าไรนับจากจุดเปิดของแท่งนี้เอง
  let candleTalk;
  if (c.h - c.l < atr * 0.4) {
    candleTalk = `${forming ? 'แท่งที่กำลังก่อตัว' : 'แท่งล่าสุด'}ตัวเล็กกว่าปกติ แปลว่าตลาดกำลังลังเล ยังไม่มีฝ่ายไหนกล้าดันราคา`;
  } else if (bodyPct > 0.7) {
    candleTalk = `นับจากจุดเปิดแท่งที่ ${fmt(c.o)} ราคา${inBar >= 0 ? 'ขึ้น' : 'ลง'}มาเป็นเนื้อเทียนยาวเต็มแท่ง แปลว่า${inBar >= 0 ? 'ผู้ซื้อ' : 'ผู้ขาย'}ดันราคาไปทางเดียวโดยแทบไม่มีแรงต้าน`;
  } else if (bodyPct < 0.3) {
    candleTalk = `นับจากจุดเปิดแท่งที่ ${fmt(c.o)} ราคาถูกเหวี่ยงขึ้นลงแล้วกลับมาอยู่ใกล้จุดเดิม (ไส้เทียนยาว ตัวเทียนสั้น) = ทั้งสองฝ่ายสูสี ยังไม่มีผู้ชนะ`;
  } else {
    candleTalk = `นับจากจุดเปิดแท่งที่ ${fmt(c.o)} ราคาขยับ${inBar >= 0 ? 'ขึ้น' : 'ลง'} ${fmt(Math.abs(inBar))} ดอลลาร์ ถือว่าปกติ ไม่มีอะไรผิดสังเกต`;
  }

  out.push({
    id: 'price', title: '1. ราคาตอนนี้', tone: chg >= 0 ? 'good' : 'bad',
    text: `ทองคำอยู่ที่ <b>${fmt(price)}</b> ดอลลาร์ต่อออนซ์ ${chg >= 0 ? 'ขึ้น' : 'ลง'} ${fmt(Math.abs(chg))} ดอลลาร์ (${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%) เทียบกับ<b>ราคาปิดของแท่งก่อนหน้า</b>` +
      `<br><br>${candleTalk}` +
      (forming ? '<br><br><i>⏳ แท่งนี้ยังไม่ปิด ตัวเลขทั้งหมดยังเปลี่ยนได้จนกว่าจะหมดเวลาแท่ง</i>' : ''),
  });

  // ── 2) ใครคุมเกม (เทรนด์) ──────────────────────────────────────────────
  const e20 = ctx.ema20[i], e50 = ctx.ema50[i], e200 = ctx.ema200[i];
  let trendText = '';
  let trendTone = 'neutral';
  if (e20 !== null && e50 !== null) {
    const aboveAll = price > e20 && e20 > e50 && (e200 === null || e50 > e200);
    const belowAll = price < e20 && e20 < e50 && (e200 === null || e50 < e200);
    if (aboveAll) {
      trendTone = 'good';
      trendText = `ราคายืนเหนือเส้นค่าเฉลี่ยทุกเส้น และเส้นเรียงตัวจากสั้นไปยาวอย่างเป็นระเบียบ (${fmt(e20)} > ${fmt(e50)}${e200 !== null ? ` > ${fmt(e200)}` : ''}) — ภาษาชาวบ้านคือ <b>คนที่ซื้อไว้ในทุกช่วงเวลากำลังมีกำไรอยู่</b> จึงไม่มีใครรีบขาย นี่คือรูปแบบของขาขึ้นที่แข็งแรง`;
    } else if (belowAll) {
      trendTone = 'bad';
      trendText = `ราคาอยู่ใต้เส้นค่าเฉลี่ยทุกเส้น และเรียงตัวลงอย่างเป็นระเบียบ (${fmt(e20)} < ${fmt(e50)}${e200 !== null ? ` < ${fmt(e200)}` : ''}) — แปลว่า <b>คนที่ซื้อไว้ในทุกช่วงเวลากำลังขาดทุน</b> ทุกการเด้งขึ้นจึงมักเจอแรงขายของคนที่อยากออกทุน นี่คือรูปแบบขาลง`;
    } else {
      trendText = `เส้นค่าเฉลี่ยยังพันกันอยู่ (EMA20 ${fmt(e20)} · EMA50 ${fmt(e50)}) ไม่ได้เรียงตัวชัดเจนไปทางไหน — ช่วงแบบนี้คือ <b>ตลาดยังไม่เลือกข้าง</b> การเทรดตามแนวโน้มมักโดนหลอกบ่อย`;
    }
  }
  const struct = scored.structure;
  trendText += `<br><br>โครงสร้างจุดสูง-จุดต่ำของราคาเป็น<b>${struct.label}</b> — ${struct.detail}`;
  if (scored.adx !== null && scored.adx !== undefined) {
    trendText += `<br><br>ความแรงของแนวโน้ม (ADX) อยู่ที่ ${scored.adx.toFixed(1)} ` + (scored.regime === 'trend'
      ? '<b>เกิน 22 = มีแนวโน้มจริง</b> ช่วงนี้ควรเทรดตามทิศทาง อย่าสวน'
      : '<b>ต่ำกว่า 22 = ยังไม่มีแนวโน้ม ราคาออกข้าง</b> ช่วงนี้กลยุทธ์ "ซื้อถูกขายแพงในกรอบ" ได้ผลกว่าการวิ่งตาม');
  }
  out.push({ id: 'trend', title: '2. ใครคุมเกมอยู่', tone: trendTone, text: trendText });

  // ── 3) แรงซื้อ-แรงขาย ──────────────────────────────────────────────────
  let momo = [];
  const r = scored.rsi;
  if (r !== null) {
    let rsiMean;
    if (r >= 78) rsiMean = 'ร้อนแรงเกินไป คนที่เข้าตรงนี้คือคนไล่ราคา ระวังย่อแรง';
    else if (r >= 55) rsiMean = 'ฝั่งซื้อกำลังนำ และยังไม่ร้อนเกิน ถือว่าเป็นโซนสุขภาพดีของขาขึ้น';
    else if (r > 45) rsiMean = 'ก้ำกึ่ง ยังไม่มีฝ่ายไหนนำชัด';
    else if (r > 22) rsiMean = 'ฝั่งขายกำลังนำ';
    else rsiMean = 'ถูกเทขายหนักเกินไป มักตามด้วยการเด้งกลับ';
    momo.push(`<b>RSI = ${r.toFixed(1)}</b> (ตัวเลข 0-100 ที่วัดว่าแรงซื้อหรือแรงขายชนะกันแค่ไหนในช่วง 14 แท่งล่าสุด) — ${rsiMean}`);
  }
  const h = ctx.macd.hist[i], hPrev = ctx.macd.hist[i - 1];
  if (h !== null && hPrev !== null) {
    const rising = h > hPrev;
    momo.push(`<b>MACD</b> (วัดว่าโมเมนตัมกำลังเร่งขึ้นหรือแผ่วลง) ตอนนี้เป็น${h > 0 ? 'บวก' : 'ลบ'}และกำลัง${rising ? 'ขยายตัว' : 'หดตัว'} — ` +
      (h > 0 && rising ? 'แรงขึ้นกำลังเร่ง เป็นช่วงที่ราคามักวิ่งต่อ'
       : h > 0 && !rising ? 'ยังเป็นขาขึ้นแต่แรงเริ่มหมด ระวังการพักฐาน'
       : h < 0 && !rising ? 'แรงลงกำลังเร่ง ยังไม่ควรรีบรับมีด'
       : 'ยังเป็นขาลงแต่แรงขายเริ่มลด อาจมีเด้ง'));
  }
  const pv = projectedVolume(candles, i);
  if (ctx.volSma[i] && pv.v > 0) {
    const ratio = pv.v / ctx.volSma[i];
    momo.push(`<b>ปริมาณซื้อขาย</b>แท่งนี้เท่ากับ ${(ratio * 100).toFixed(0)}% ของค่าเฉลี่ย${pv.partial ? ' <i>(เทียบแบบประมาณการทั้งแท่ง เพราะแท่งนี้เพิ่งผ่านไป ' + Math.round(pv.frac * 100) + '% ของเวลา)</i>' : ''} — ` +
      (ratio > 1.3 ? 'มากกว่าปกติชัดเจน แปลว่ามีเงินจริงเข้ามาหนุนการเคลื่อนไหวนี้ ไม่ใช่การแกว่งลอย ๆ'
       : ratio < 0.6 ? '<b>เบาบางกว่าปกติมาก</b> การเคลื่อนไหวที่ไม่มีปริมาณหนุน มักไปไม่ไกลและกลับตัวง่าย'
       : 'อยู่ในระดับปกติ'));
  }
  // เมื่อโมเมนตัมระยะสั้นสวนทางแนวโน้มหลัก ต้องเตือน เพราะมือใหม่มักตีความว่า "กลับตัวแล้ว"
  const trendSide = (e20 !== null && e50 !== null)
    ? (price > e20 && e20 > e50 ? 1 : price < e20 && e20 < e50 ? -1 : 0) : 0;
  const momoSide = h !== null ? Math.sign(h) : 0;
  if (trendSide !== 0 && momoSide !== 0 && trendSide !== momoSide) {
    momo.push(`⚠ <b>สังเกต:</b> โมเมนตัมระยะสั้นกำลังสวนทางกับแนวโน้มหลัก — ในขา${trendSide > 0 ? 'ขึ้น' : 'ลง'}ที่ยังแข็งแรง อาการแบบนี้ส่วนใหญ่คือ<b>การพัก${trendSide > 0 ? 'ฐาน' : 'ตัวเด้งกลับชั่วคราว'}</b> ไม่ใช่การกลับตัวจริง การเทรดสวนตรงนี้คือจุดที่มือใหม่เสียเงินบ่อยที่สุด ถ้าจะเข้าควรรอให้ราคาปิดยืน${trendSide > 0 ? 'ใต้' : 'เหนือ'}เส้นค่าเฉลี่ยได้ก่อน`);
  }
  out.push({ id: 'momentum', title: '3. แรงซื้อ-แรงขายเป็นอย่างไร', tone: 'neutral', text: momo.join('<br><br>') });

  // ── 4) ราคาอยู่ตรงไหนของสนาม ───────────────────────────────────────────
  const zone = [];
  if (scored.resistance) {
    zone.push(`<b>แนวต้านที่ใกล้ที่สุดอยู่ที่ ${fmt(scored.resistance)}</b> — ห่างขึ้นไป ${distanceText(scored.resistance - price, atr)}`);
  } else {
    zone.push('<b>ด้านบนไม่มีแนวต้านที่ชัดเจนในกรอบข้อมูลนี้</b> — ราคาอยู่ในเขตที่ไม่เคยมีคนติดดอย จึงวิ่งขึ้นได้คล่องกว่าปกติ');
  }
  if (scored.support) {
    zone.push(`<b>แนวรับที่ใกล้ที่สุดอยู่ที่ ${fmt(scored.support)}</b> — ห่างลงมา ${distanceText(price - scored.support, atr)}`);
  } else {
    zone.push('<b>ด้านล่างไม่มีแนวรับที่ชัดเจน</b> — ถ้าราคาลงมา อาจไหลได้ลึกกว่าที่คิดเพราะไม่มีจุดที่คนเคยเข้าซื้อไว้คอยรับ');
  }
  zone.push('<i>แนวรับ/แนวต้าน คือระดับราคาที่ในอดีตราคาเคยกลับตัวซ้ำ ๆ เพราะมีคนจำราคานั้นได้และตั้งคำสั่งรอไว้ — ยิ่งเคยกลับตัวหลายครั้ง แนวยิ่งสำคัญ</i>');
  out.push({ id: 'zone', title: '4. ราคาอยู่ตรงไหนของสนาม', tone: 'neutral', text: zone.join('<br><br>') });

  // ── 5) ความผันผวนและจังหวะเวลา ─────────────────────────────────────────
  const volLines = [];
  volLines.push(`ตอนนี้ราคาแกว่งเฉลี่ยแท่งละประมาณ <b>${fmt(atr)} ดอลลาร์</b> (${scored.atrPct.toFixed(2)}% ของราคา) — ตัวเลขนี้เรียกว่า ATR ใช้ตอบคำถามว่า "ถ้าตั้งจุดตัดขาดทุนใกล้กว่านี้ จะโดนการแกว่งปกติเขี่ยออกไหม"`);
  if (scored.atrPct > 0.6) volLines.push('⚠ ความผันผวนตอนนี้<b>สูงกว่าปกติ</b> กำไรและขาดทุนจะมาเร็วกว่าเดิม ควรลดขนาดไม้ลง');
  else if (scored.atrPct < 0.08) volLines.push('ความผันผวนตอนนี้<b>ต่ำมาก</b> ตลาดเงียบ กำไรต่อไม้จะน้อยจนอาจไม่คุ้มค่าสเปรด — แต่ช่วงเงียบมักเป็นการสะสมกำลังก่อนวิ่งแรง');
  if (session) volLines.push(`ช่วงตลาดตอนนี้คือ <b>${session.label}</b> — ${session.detail}`);
  out.push({ id: 'vol', title: '5. ความผันผวนและจังหวะเวลา', tone: scored.atrPct > 0.6 ? 'warn' : 'neutral', text: volLines.join('<br><br>') });

  // ── 6) หลายกรอบเวลา ───────────────────────────────────────────────────
  if (htfScores && htfScores.length) {
    const parts = htfScores.filter((x) => x.score !== null);
    if (parts.length) {
      const agree = parts.every((x) => Math.sign(x.score) === Math.sign(parts[0].score) && x.score !== 0);
      out.push({
        id: 'mtf', title: '6. กรอบเวลาใหญ่เห็นตรงกันไหม', tone: agree ? 'good' : 'warn',
        text: parts.map((x) => `<b>${x.tf}</b> → ${x.score > 8 ? 'เอนไปทางซื้อ' : x.score < -8 ? 'เอนไปทางขาย' : 'กลาง ๆ'} (${x.score.toFixed(0)})`).join(' · ') +
          '<br><br>' + (agree
            ? 'ทุกกรอบเวลาไปทางเดียวกัน — นี่คือสถานการณ์ที่ราคามักวิ่งได้ไกลกว่าปกติ เพราะไม่มีแรงสวนจากกรอบใหญ่'
            : 'กรอบเวลาไม่ตรงกัน — เวลากรอบเล็กสวนกรอบใหญ่ ระยะกำไรมักสั้นและกลับตัวเร็ว ระบบจึงตัดคะแนนลง 40% ในกรณีนี้'),
      });
    }
  }

  // ── 7) สรุป: ควรทำอะไร ────────────────────────────────────────────────
  const num = out.length + 1;
  let doText = '';
  let doTone = 'neutral';
  if (action === 'buy' || action === 'sell') {
    doTone = action === 'buy' ? 'good' : 'bad';
    const dir = action === 'buy' ? 'ซื้อ' : 'ขาย';
    doText = `ปัจจัยส่วนใหญ่ชี้ไปทาง<b>${dir}</b> คะแนนรวม ${combined.score.toFixed(1)}` +
      (prob && prob.p !== null ? ` และจากสถิติย้อนหลัง สัญญาณระดับคะแนนนี้เคยไปถึงเป้าแรกก่อนโดนตัดขาดทุน <b>${prob.p.toFixed(0)}%</b> ของครั้ง` : '');
    if (setup) {
      doText += `<br><br><b>สิ่งที่ควรทำ:</b> ไม่ต้องรีบกดตามราคาตลาด ให้ตั้งคำสั่งรอ (limit order) ไว้ที่ <b>${fmt(setup.entry)}</b> ` +
        `พร้อมตั้งจุดตัดขาดทุนที่ <b>${fmt(setup.sl)}</b> และเป้าแรกที่ <b>${fmt(setup.tp1)}</b> ตั้งทิ้งไว้ได้เลย ` +
        `<b>ไม่ต้องเฝ้าจอ</b> — ถ้าราคามาถึงระบบของโบรกเกอร์จะเข้าให้เอง วิธีนี้แก้ปัญหา "จังหวะมาเร็วเกินกดไม่ทัน" ได้ตรงจุดที่สุด`;
    }
  } else if (blocks.length) {
    doTone = 'warn';
    doText = `<b>ตอนนี้ยังไม่ควรเข้า</b> ถึงแม้คะแนนจะถึงเกณฑ์ เพราะ:<br>• ${blocks.join('<br>• ')}`;
  } else {
    const need = combined ? Math.abs(combined.score) : 0;
    doText = `ยังไม่มีสัญญาณที่ชัดพอ (คะแนนตอนนี้ ${combined ? combined.score.toFixed(1) : '0'}) — <b>การไม่เข้าเทรดก็คือการตัดสินใจอย่างหนึ่ง</b><br><br>`;
    const watch = [];
    if (scored.resistance) watch.push(`ราคาปิดทะลุแนวต้าน <b>${fmt(scored.resistance)}</b> ขึ้นไปได้ (จะเปิดทางขาขึ้น)`);
    if (scored.support) watch.push(`ราคาปิดหลุดแนวรับ <b>${fmt(scored.support)}</b> ลงมา (จะเปิดทางขาลง)`);
    if (scored.regime === 'range') watch.push('ADX ขึ้นเหนือ 22 ซึ่งแปลว่าตลาดเริ่มเลือกข้างแล้ว');
    doText += `<b>สิ่งที่ควรจับตา:</b><br>• ${watch.join('<br>• ')}`;
    doText += `<br><br>เคล็ดลับ: ตั้ง "กฎเตือนส่วนตัว" ในแท็บแจ้งเตือนไว้ที่ระดับราคาข้างบนนี้ ระบบจะเตือนให้เองโดยไม่ต้องเฝ้าจอ (ปัจจุบันคะแนนห่างจากเกณฑ์อยู่ ${Math.max(0, (combined ? Math.abs(combined.score) : 0)).toFixed(0)} คะแนน)`;
    void need;
  }
  out.push({ id: 'action', title: `${num}. สรุป — ควรทำอะไรตอนนี้`, tone: doTone, text: doText });

  return out;
}

/** สรุปสั้นบรรทัดเดียว สำหรับใส่ในข้อความแจ้งเตือน */
export function narrateShort({ scored, combined, action, candles }) {
  if (!scored || !scored.ready) return 'ข้อมูลยังไม่พอวิเคราะห์';
  const price = candles[candles.length - 1].c;
  const trend = scored.structure.side > 0 ? 'โครงสร้างขาขึ้น' : scored.structure.side < 0 ? 'โครงสร้างขาลง' : 'ตลาดออกข้าง';
  const mode = scored.regime === 'trend' ? 'มีแนวโน้มชัด' : 'ยังไม่มีแนวโน้ม';
  return `${fmt(price)} · ${trend} · ${mode} (ADX ${scored.adx ? scored.adx.toFixed(0) : '-'}) · RSI ${scored.rsi ? scored.rsi.toFixed(0) : '-'} · คะแนน ${combined ? combined.score.toFixed(0) : '0'}${action !== 'wait' ? ` → ${action === 'buy' ? 'สัญญาณซื้อ' : 'สัญญาณขาย'}` : ''}`;
}
