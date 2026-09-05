/**
 * macro.js — บริบทเวลา/ข่าว ที่คำนวณได้แน่นอนโดยไม่ต้องต่อเน็ต
 *
 * ทองคำเคลื่อนไหวแรงเป็นเวลา: ช่วง London/NY overlap มีสภาพคล่องสูงสุด
 * และวันประกาศตัวเลขเศรษฐกิจสหรัฐฯ มักเกิด spike สวนทางสัญญาณเทคนิค
 *
 * สิ่งที่คำนวณอัตโนมัติ = สิ่งที่มีกฎตายตัว (NFP = ศุกร์แรกของเดือน, เวลาเปิดตลาด)
 * สิ่งที่วันเวลาไม่ตายตัว (CPI/FOMC) ให้ผู้ใช้กรอกเองในหน้า "ปฏิทินข่าว"
 */

/** DST สหรัฐฯ: อาทิตย์ที่ 2 ของ มี.ค. ถึง อาทิตย์แรกของ พ.ย. */
export function usDstActive(date) {
  const y = date.getUTCFullYear();
  const secondSundayMarch = nthWeekdayUTC(y, 2, 0, 2);
  const firstSundayNov = nthWeekdayUTC(y, 10, 0, 1);
  return date >= secondSundayMarch && date < firstSundayNov;
}

function nthWeekdayUTC(year, monthIdx, weekday, n) {
  const d = new Date(Date.UTC(year, monthIdx, 1, 7, 0, 0));
  let count = 0;
  while (true) {
    if (d.getUTCDay() === weekday) { count++; if (count === n) break; }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

/** เวลา 8:30 ET เป็น UTC (13:30 ฤดูหนาว / 12:30 ฤดูร้อน) */
function etToUtcHour(date, etHour) {
  return etHour + (usDstActive(date) ? 4 : 5);
}

/** Non-Farm Payrolls ครั้งถัดไป = ศุกร์แรกของเดือน 8:30 ET */
export function nextNFP(now = new Date()) {
  for (let add = 0; add < 3; add++) {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + add;
    const firstFriday = nthWeekdayUTC(y, m, 5, 1);
    const h = etToUtcHour(firstFriday, 8);
    const dt = new Date(Date.UTC(firstFriday.getUTCFullYear(), firstFriday.getUTCMonth(), firstFriday.getUTCDate(), h, 30));
    if (dt > now) return dt;
  }
  return null;
}

/*
 * ตลาดทอง spot (XAU/USD) ไม่ได้เปิดตลอด 24/7 — และเดิมทั้งระบบไม่รู้เรื่องนี้เลย
 *
 * sessionInfo เดิมดูแค่ "ชั่วโมงที่เท่าไร" ไม่เคยดูว่าวันอะไร
 * วันเสาร์บ่ายจึงถูกรายงานว่า "London session · คุณภาพ 0.8" ทั้งที่ตลาดปิดสนิท
 * และเพราะ 0.8 สูงกว่าเกณฑ์ 0.6 ตัวกรองช่วงตลาดก็ไม่ได้กันอะไรเลย
 *
 * ที่ต้องระวังเป็นพิเศษ: แหล่งราคาที่ระบบใช้อยู่เป็นเหรียญทอง (PAXG/XAUT)
 * ซึ่งซื้อขายกัน 24/7 ราคาจึงยังขยับตลอดเสาร์-อาทิตย์ ตัวจับ "ราคาค้าง" จึงไม่ทำงาน
 * กราฟดูมีชีวิตทุกอย่าง แต่เป็นราคาของตลาดคนละตลาดกับที่ผู้ใช้กดส่งคำสั่งได้
 * และช่วงสุดสัปดาห์สภาพคล่องบางมาก ราคามักเหวี่ยงออกจากราคาทองจริง
 *
 * เวลาทำการมาตรฐาน (เขตนิวยอร์ก): เปิดอาทิตย์ 18:00 ถึงศุกร์ 17:00
 * และพักวันละหนึ่งชั่วโมงช่วง 17:00-18:00
 */
function openAtEt(day, hour) {
  if (day === 6) return false;              // เสาร์ ปิดทั้งวัน
  if (day === 0) return hour >= 18;         // อาทิตย์ เปิดเย็น
  if (day === 5) return hour < 17;          // ศุกร์ ปิดเย็น
  return hour < 17 || hour >= 18;           // จันทร์-พฤหัส พักวันละชั่วโมง
}

/** เวลาปัจจุบันในเขตนิวยอร์ก (คิดจาก DST สหรัฐฯ ที่มีอยู่แล้ว) */
function etParts(now) {
  const et = new Date(now.getTime() - (usDstActive(now) ? 4 : 5) * 3600000);
  return { day: et.getUTCDay(), hour: et.getUTCHours() + et.getUTCMinutes() / 60 };
}

/**
 * ตลาดทองเปิดอยู่ไหม และจะเปลี่ยนสถานะเมื่อไร
 *
 * หาเวลาที่สถานะเปลี่ยนด้วยการเดินไปข้างหน้าทีละ 15 นาที แทนการคำนวณตรง ๆ
 * เพราะแบบนี้ข้ามช่วงเปลี่ยน DST ได้ถูกเองโดยไม่ต้องมีกรณีพิเศษ
 */
export function goldMarketOpen(now = new Date()) {
  const { day, hour } = etParts(now);
  const open = openAtEt(day, hour);
  /* เดินจาก "ต้นชั่วโมง" เพื่อให้จุดที่เจอเป็นเวลาเปิด/ปิดจริง ไม่ใช่เวลาที่บังเอิญเดินไปเจอ
     (เส้นแบ่งอยู่ที่ต้นชั่วโมงเสมอ เพราะเขตนิวยอร์กต่างจาก UTC เป็นจำนวนชั่วโมงเต็ม) */
  const STEP = 15 * 60000;
  const from = Math.floor(now.getTime() / 3600000) * 3600000;
  let at = null;
  for (let k = 1; k <= 4 * 24 * 4; k++) {
    const t = new Date(from + k * STEP);
    const p = etParts(t);
    if (openAtEt(p.day, p.hour) !== open) { at = t; break; }
  }
  return { open, opensAt: open ? null : at, closesAt: open ? at : null };
}

/** ช่วงเวลาตลาดที่มีผลกับทองคำ (คืนค่าเป็นเวลาไทย UTC+7 ในข้อความ) */
export function sessionInfo(now = new Date()) {
  /* ตลาดปิด = ไม่ใช่ "ช่วงที่คุณภาพต่ำ" แต่คือ "เทรดไม่ได้เลย" ต้องตอบก่อนข้ออื่นทั้งหมด */
  const mk = goldMarketOpen(now);
  if (!mk.open) {
    return { key: 'closed', label: 'ตลาดทองปิด', quality: 0, closed: true, opensAt: mk.opensAt,
      detail: 'ตลาดทอง spot ปิดทำการ' + (mk.opensAt ? ` จะเปิดอีกครั้ง ${thTime(mk.opensAt)} (เวลาไทย)` : '')
        + ' — ราคาที่ยังขยับอยู่บนกราฟมาจากเหรียญทองที่ซื้อขาย 24/7 ซึ่งเป็นคนละตลาดกับที่ส่งคำสั่งได้ '
        + 'และช่วงนี้สภาพคล่องบางจนราคามักเหวี่ยงออกจากราคาทองจริง' };
  }
  const dst = usDstActive(now);
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
  const londonOpen = dst ? 7 : 8;          // 08:00 London
  const nyOpen = dst ? 13.5 : 14.5;        // 09:30 New York
  const nyClose = dst ? 20 : 21;
  const londonClose = dst ? 15.5 : 16.5;

  const inLondon = utcH >= londonOpen && utcH < londonClose;
  const inNY = utcH >= nyOpen && utcH < nyClose;
  const overlap = inLondon && inNY;
  const asia = utcH >= 0 && utcH < londonOpen;

  if (overlap) {
    return { key: 'overlap', label: 'London × New York overlap', quality: 1.0,
      detail: 'ช่วงสภาพคล่องสูงสุดของทองคำ สัญญาณเบรกเอาต์มีโอกาสไปต่อมากที่สุด และสเปรดแคบที่สุด' };
  }
  if (inNY) {
    return { key: 'ny', label: 'New York session', quality: 0.85,
      detail: 'ตลาดสหรัฐฯ เปิด ทองคำตอบสนองดอลลาร์และบอนด์ยีลด์โดยตรง โมเมนตัมยังใช้ได้ดี' };
  }
  if (inLondon) {
    return { key: 'london', label: 'London session', quality: 0.8,
      detail: 'ตลาดลอนดอนคือศูนย์กลางการค้าทองจริง (spot) แนวโน้มระหว่างวันมักถูกตั้งในช่วงนี้' };
  }
  if (asia) {
    return { key: 'asia', label: 'Asia session', quality: 0.45,
      detail: 'สภาพคล่องต่ำ ราคามักออกข้างในกรอบแคบ สัญญาณเบรกเอาต์ "หลอก" บ่อยกว่าปกติ' };
  }
  return { key: 'quiet', label: 'ช่วงคาบเกี่ยว/ตลาดเงียบ', quality: 0.5,
    detail: 'อยู่นอกช่วงคาบเกี่ยวหลัก ปริมาณการซื้อขายบาง ควรลดขนาดไม้หรือรอช่วงตลาดหลัก' };
}

/**
 * ตรวจว่าอยู่ในกรอบเวลาเสี่ยงข่าวหรือไม่
 * @param {Date} now
 * @param {{time:string,title:string,impact:string}[]} userEvents เวลาในรูป ISO
 * @param {number} windowMin กี่นาทีก่อน/หลังข่าวที่ถือว่าเสี่ยง
 */
export function riskWindow(now, userEvents = [], windowMin = 30) {
  const events = [];
  const nfp = nextNFP(now);
  if (nfp) events.push({ time: nfp, title: 'US Non-Farm Payrolls (NFP)', impact: 'high', auto: true });
  for (const e of userEvents) {
    const t = new Date(e.time);
    if (!Number.isNaN(t.getTime())) events.push({ time: t, title: e.title, impact: e.impact || 'high', auto: false });
  }
  events.sort((a, b) => a.time - b.time);
  const ms = windowMin * 60000;
  const active = events.filter((e) => Math.abs(e.time - now) <= ms);
  const upcoming = events.filter((e) => e.time > now).slice(0, 3);
  return { active, upcoming, blocked: active.length > 0 };
}

/** ฟอร์แมตเวลาไทย */
export function thTime(d) {
  return new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' });
}

/**
 * แปลงราคา XAU/USD (ต่อทรอยออนซ์) เป็นราคาทองไทยโดยประมาณ (บาทละ, ทอง 96.5%)
 * 1 บาททองคำ = 15.244 กรัม, 1 ทรอยออนซ์ = 31.1035 กรัม
 * เป็นค่าประมาณเชิงคำนวณ ไม่ใช่ราคาประกาศของสมาคมค้าทองคำ (มีค่ากันเหนียว/ค่าบล็อกเพิ่ม)
 */
export function xauToThaiBaht(xauUsd, usdThb) {
  const perGramUsd = xauUsd / 31.1035;
  const perBahtUsd = perGramUsd * 15.244 * 0.965;
  return perBahtUsd * usdThb;
}
