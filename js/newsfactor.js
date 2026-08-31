/**
 * newsfactor.js — เอาข่าวมาผสมกับกราฟ แล้ววัดว่ามันช่วยจริงไหม
 *
 * *** กับดักที่ทำให้ระบบข่าว+กราฟส่วนใหญ่ "ดูดีแต่ใช้ไม่ได้" ***
 *
 * ถ้าเอาข่าวเวลา 14:00 ไปใช้กับแท่งเทียน 14:00 คุณกำลังใช้ข้อมูลอนาคต
 * เพราะกว่าข่าวจะถูกเผยแพร่ ถูกเก็บเข้าฐานข้อมูล และคนอ่านทัน เวลาผ่านไปแล้ว
 * ผลคือ backtest จะสวยมาก และพังทันทีที่ใช้จริง
 *
 * ที่แย่กว่านั้น: GDELT บันทึก "เวลาที่ระบบเห็นข่าว" (seendate) ไม่ใช่เวลาที่ข่าวเกิด
 * ซึ่งอาจช้ากว่าเหตุการณ์จริงเป็นสิบนาที และ *ช้าไม่เท่ากันในแต่ละข่าว*
 * ถ้าไม่เผื่อเวลาหน่วง ตัวเลขที่ได้จะเป็นการโกงตัวเองล้วน ๆ
 *
 * ไฟล์นี้จึงบังคับ "เวลาหน่วง" (lag) ทุกครั้ง และมีเทสต์พิสูจน์ว่าข่าวที่เกิดหลังแท่ง
 * ไม่มีทางไหลย้อนเข้ามาในแท่งนั้นได้เลย
 */

import { classifyHeadline } from './news.js';

export const DEFAULT_NEWS_CFG = {
  /*
   * หน่วงกี่นาทีก่อนถือว่าข่าว "ใช้ได้"
   *
   * 15 นาทีไม่ใช่ตัวเลขสุ่ม: ข่าวต้องถูกเผยแพร่ → ถูกเก็บเข้าฐานข้อมูล → เราดึงมาได้
   * ถ้าตั้งน้อยกว่านี้ เท่ากับสมมติว่าเรารู้ข่าวเร็วกว่าที่เป็นไปได้จริง
   */
  lagMin: 15,
  /** ย้อนดูข่าวในกี่ชั่วโมง — ข่าวเก่ากว่านี้ถือว่าตลาดรับรู้ไปแล้ว */
  windowH: 6,
  /** ครึ่งชีวิตของอิทธิพลข่าว (ชั่วโมง) */
  halfLifeH: 3,
};

/**
 * สร้างดัชนีข่าวสำหรับเปิดดูตามเวลา
 *
 * เก็บเรียงตามเวลา แล้วเปิดดูด้วยการค้นแบบแบ่งครึ่ง เพื่อให้เรียกซ้ำหลายพันครั้งได้เร็ว
 * (backtest เรียกทุกแท่ง ถ้าไล่ทีละตัวจะช้าจนใช้ไม่ได้)
 */
export function buildNewsIndex(items, cfg = {}) {
  const o = { ...DEFAULT_NEWS_CFG, ...cfg };
  const rows = (items || [])
    .map((it) => {
      const a = it.analysis || classifyHeadline(it.title);
      if (!a || !it.at) return null;
      return { at: it.at, score: a.score, dir: a.dir, title: it.title };
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);

  return { rows, cfg: o };
}

/** ตำแหน่งแรกที่เวลา >= t (ค้นแบบแบ่งครึ่ง) */
function lowerBound(rows, t) {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].at < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * บรรยากาศข่าว ณ เวลาหนึ่ง — ใช้ได้เฉพาะข่าวที่ "รู้ได้แล้วจริง ๆ" ตอนนั้น
 *
 * @param at เวลาของแท่งที่กำลังตัดสินใจ (ต้องเป็นเวลาเปิดแท่ง ไม่ใช่เวลาปิด)
 */
export function newsAt(index, at) {
  const { rows, cfg } = index;
  if (!rows.length) return { score: 0, n: 0 };

  // ขอบบน: ข่าวต้องเก่ากว่าเวลาปัจจุบันอย่างน้อยเท่ากับเวลาหน่วง
  const usableUntil = at - cfg.lagMin * 60000;
  const from = at - cfg.windowH * 3600000;

  const hi = lowerBound(rows, usableUntil);
  const lo = lowerBound(rows, from);
  if (hi <= lo) return { score: 0, n: 0 };

  let num = 0, den = 0, n = 0;
  for (let i = lo; i < hi; i++) {
    const ageH = (at - rows[i].at) / 3600000;
    const w = Math.pow(0.5, ageH / cfg.halfLifeH);
    num += rows[i].score * w;
    den += Math.abs(rows[i].score) * w;
    n++;
  }
  return { score: den ? num / den : 0, n };
}

/**
 * ข่าวเห็นด้วยกับทิศที่กราฟจะเข้าไหม
 *
 * คืน 'agree' | 'against' | 'quiet'
 * 'quiet' คือไม่มีข่าวพอจะบอกอะไร — ต่างจาก 'against' และต้องแยกให้ออก
 */
export function newsAgreement(index, at, side, minScore = 0.25) {
  const s = newsAt(index, at);
  if (!s.n || Math.abs(s.score) < minScore) return { state: 'quiet', ...s };
  return { state: Math.sign(s.score) === side ? 'agree' : 'against', ...s };
}

/**
 * ดึงข่าวย้อนหลังจาก GDELT เป็นช่วงเวลา
 *
 * GDELT จำกัดผลลัพธ์ต่อคำขอ จึงต้องแบ่งช่วงเวลาเป็นก้อน ๆ
 * และต้องหน่วงระหว่างคำขอ ไม่งั้นโดนปฏิเสธ (เป็นบริการฟรีของโครงการวิจัย)
 */
export async function fetchHistoricalNews(fromMs, toMs, opts = {}) {
  const doFetch = opts.fetchImpl || ((u) => fetch(u));
  const chunkH = opts.chunkH || 24;
  const pause = opts.pauseMs === undefined ? 1200 : opts.pauseMs;
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const out = [];
  let cursor = fromMs, calls = 0;

  while (cursor < toMs) {
    const end = Math.min(cursor + chunkH * 3600000, toMs);
    const url = 'https://api.gdeltproject.org/api/v2/doc/doc?query='
      + encodeURIComponent('(gold OR "federal reserve" OR inflation OR "interest rate" OR dollar) sourcelang:english')
      + `&mode=artlist&maxrecords=250&format=json&sort=datedesc`
      + `&startdatetime=${stamp(cursor)}&enddatetime=${stamp(end)}`;
    try {
      const res = await doFetch(url);
      calls++;
      if (res.ok) {
        const j = await res.json();
        for (const a of (j.articles || [])) {
          const at = parseStamp(a.seendate);
          if (at) out.push({ title: a.title, url: a.url, source: a.domain, at });
        }
      }
    } catch (e) { /* ช่วงที่ดึงไม่ได้ ข้ามไป ดีกว่าล้มทั้งงาน */ }
    cursor = end;
    if (pause && cursor < toMs) await new Promise((r) => setTimeout(r, pause));
    if (opts.onProgress) opts.onProgress({ done: cursor - fromMs, total: toMs - fromMs, calls, got: out.length });
    if (calls > (opts.maxCalls || 40)) break;
  }
  return { items: out, calls };
}

function parseStamp(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * คำถามที่ต้องตอบ: "กรองด้วยข่าวแล้วดีขึ้นจริงไหม"
 *
 * ไม่ใช่การเดา — เอาไม้ที่ backtest ได้มาแล้ว มาแบ่งกลุ่มตามท่าทีของข่าว ณ เวลาที่เข้าไม้
 * แล้วเทียบผลกันตรง ๆ
 *
 * *** ต้องวัดกับช่วงที่ไม่ได้ใช้ตั้งกฎเท่านั้น ***
 * ถ้าดูทั้งชุดแล้วเลือกกลุ่มที่ดีที่สุด ก็แค่เลือกความบังเอิญที่สวยที่สุด
 */
export function evaluateNewsFilter(trades, index, opts = {}) {
  const minScore = opts.minScore === undefined ? 0.25 : opts.minScore;
  const groups = { agree: [], against: [], quiet: [] };
  for (const t of trades) {
    const g = newsAgreement(index, t.t, t.side, minScore);
    groups[g.state].push(t);
  }
  const summarise = (list) => {
    if (!list.length) return { n: 0, expectancy: null, winRate: null, avgWin: null };
    const wins = list.filter((t) => t.rMultiple >= 1);
    return {
      n: list.length,
      expectancy: list.reduce((a, t) => a + t.rMultiple, 0) / list.length,
      winRate: (wins.length / list.length) * 100,
      avgWin: (() => {
        const w = list.filter((t) => t.rMultiple > 0);
        return w.length ? w.reduce((a, t) => a + t.rMultiple, 0) / w.length : null;
      })(),
    };
  };
  const all = summarise(trades);
  const agree = summarise(groups.agree);
  const against = summarise(groups.against);
  const quiet = summarise(groups.quiet);

  // ถ้าตัดไม้ที่ข่าวค้านออก จะเหลือผลเท่าไร
  const kept = [...groups.agree, ...groups.quiet];
  const filtered = summarise(kept);

  return {
    all, agree, against, quiet, filtered,
    covered: trades.length ? ((groups.agree.length + groups.against.length) / trades.length) * 100 : 0,
    delta: all.expectancy !== null && filtered.expectancy !== null ? filtered.expectancy - all.expectancy : null,
  };
}

/**
 * ตัดสินว่าควรใช้ข่าวกรองหรือไม่ — โดยดูจากช่วงที่ไม่ได้ใช้ตั้งกฎ
 *
 * เกณฑ์เข้มโดยตั้งใจ เพราะการเพิ่มตัวกรองมีต้นทุนเสมอ (ไม้น้อยลง = ตัวอย่างน้อยลง)
 * ของใหม่ต้องพิสูจน์ตัวเอง ของเดิมไม่ต้องพิสูจน์ซ้ำ
 */
export function newsVerdict(res, opts = {}) {
  const minN = opts.minN || 30;
  const margin = opts.margin === undefined ? 0.05 : opts.margin;
  if (!res || res.all.n < minN) {
    return { level: 'unknown', apply: false,
      text: `ไม้ยังน้อยเกินไป (${res ? res.all.n : 0} ไม้ ต้องการ ${minN}) — สรุปไม่ได้ว่าข่าวช่วยหรือไม่` };
  }
  if (res.covered < 20) {
    return { level: 'unknown', apply: false,
      text: `มีข่าวครอบคลุมแค่ ${res.covered.toFixed(0)}% ของไม้ — น้อยเกินกว่าที่ข่าวจะมีผลกับผลรวม` };
  }
  const d = res.delta;
  if (d !== null && d > margin) {
    return { level: 'good', apply: true,
      text: `ตัดไม้ที่ข่าวค้านออกแล้วดีขึ้น ${d.toFixed(3)} R ต่อไม้ `
        + `(เหลือ ${res.filtered.n} จาก ${res.all.n} ไม้) — ข่าวช่วยได้จริงกับข้อมูลชุดนี้` };
  }
  if (d !== null && d < -margin) {
    return { level: 'bad', apply: false,
      text: `ตัดไม้ที่ข่าวค้านออกแล้วกลับแย่ลง ${Math.abs(d).toFixed(3)} R ต่อไม้ — `
        + 'ข่าวที่จับได้ไม่ได้บอกอะไรที่กราฟยังไม่รู้ อย่าเอามากรอง' };
  }
  return { level: 'ok', apply: false,
    text: `ต่างกันแค่ ${d === null ? '—' : d.toFixed(3)} R ต่อไม้ ซึ่งอยู่ในระดับความบังเอิญ — `
      + 'กรองด้วยข่าวไม่ได้เพิ่มความแน่นอน มีแต่ทำให้ไม้น้อยลง' };
}
