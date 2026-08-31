/**
 * news.js — ดึงข่าวโลกแล้ววิเคราะห์ว่ากระทบราคาทองทางไหน
 *
 * *** ข้อจำกัดที่ต้องบอกก่อน อย่าเข้าใจผิด ***
 *
 * หน้าเว็บนี้เป็นไฟล์นิ่ง ๆ ไม่มีเซิร์ฟเวอร์หลังบ้าน จึงไม่มีปัญญาประดิษฐ์อ่านข่าวให้
 * สิ่งที่ทำได้จริงคือ "จับคำสำคัญแล้วเทียบกับฐานความรู้ว่าเรื่องนั้นเคยขยับทองทางไหน"
 *
 * แปลว่า:
 *   ✓ บอกได้ว่าข่าวนี้แตะเรื่องที่มีผลกับทอง และตามทฤษฎีควรดันทางไหน
 *   ✗ อ่านบริบทไม่เป็น ประชดไม่รู้ ข่าวเก่าที่ถูกเล่าซ้ำก็แยกไม่ออก
 *   ✗ วัดขนาดผลกระทบจริงไม่ได้ — "ตลาดรับรู้ไปแล้วหรือยัง" เป็นคำถามที่คำสำคัญตอบไม่ได้
 *
 * จึงต้องใช้เป็น "บริบทประกอบ" เท่านั้น ห้ามใช้ตัดสินใจเข้าออกไม้โดยลำพัง
 * และหน้าจอต้องเขียนข้อจำกัดนี้ไว้ให้เห็น ไม่ใช่ซ่อนไว้ในโค้ด
 */

/**
 * ฐานความรู้: อะไรขยับราคาทอง และขยับทางไหน
 *
 * dir  +1 = ดันทองขึ้น, -1 = กดทองลง
 * w    น้ำหนักความสำคัญ (ยิ่งมากยิ่งเป็นตัวขับหลัก)
 * why  กลไกที่ทำให้เกิดผล — ส่วนนี้สำคัญที่สุด เพราะผู้ใช้ต้องเข้าใจ ไม่ใช่แค่เห็นลูกศร
 */
export const GOLD_DRIVERS = [
  {
    key: 'realYield', label: 'ผลตอบแทนพันธบัตรที่แท้จริง', dir: -1, w: 10, invertible: true,
    kw: ['real yield', 'treasury yield', 'bond yield', 'yields', '10-year', '10 year treasury',
         'tips yield', 'อัตราผลตอบแทนพันธบัตร', 'บอนด์ยีลด์'],
    why: 'ทองไม่มีดอกเบี้ย ถ้าถือพันธบัตรได้ผลตอบแทนจริง (หักเงินเฟ้อแล้ว) สูงขึ้น '
       + 'การถือทองก็เสียโอกาสมากขึ้น เงินจึงไหลออกจากทอง — นี่คือตัวขับที่แรงที่สุดของราคาทอง',
  },
  {
    key: 'fedDovish', label: 'เฟดผ่อนคลาย / ลดดอกเบี้ย', dir: +1, w: 9,
    kw: ['rate cut', 'cuts rates', 'dovish', 'easing', 'lower rates', 'rate reduction',
         'ลดดอกเบี้ย', 'ผ่อนคลายนโยบาย'],
    why: 'ดอกเบี้ยลด = ผลตอบแทนของการถือเงินสดและพันธบัตรลด ทองที่ไม่มีดอกเบี้ยจึงน่าถือขึ้นโดยเปรียบเทียบ',
  },
  {
    key: 'fedHawkish', label: 'เฟดเข้มงวด / ขึ้นดอกเบี้ย', dir: -1, w: 9,
    kw: ['rate hike', 'raise rates', 'hawkish', 'tightening', 'higher for longer',
         'ขึ้นดอกเบี้ย', 'คุมเข้มนโยบาย'],
    why: 'ตรงข้ามกับการลดดอกเบี้ย — ถือเงินสดได้ผลตอบแทนดีขึ้น ทองจึงถูกขายออก',
  },
  {
    key: 'dollar', label: 'ค่าเงินดอลลาร์', dir: -1, w: 8, invertible: true,
    kw: ['dollar', 'dxy', 'greenback', 'ดอลลาร์', 'ดัชนีดอลลาร์'],
    why: 'ทองซื้อขายเป็นดอลลาร์ ดอลลาร์แข็งทำให้คนถือสกุลอื่นต้องจ่ายแพงขึ้น ความต้องการจึงลด '
       + '(ข่าวดอลลาร์อ่อนให้ผลกลับกัน — ระบบอ่านทิศทางจากคำในหัวข้อ)',
  },
  {
    key: 'inflation', label: 'เงินเฟ้อ', dir: +1, w: 7, invertible: true,
    kw: ['inflation', 'cpi', 'consumer price', 'pce', 'price pressure',
         'เงินเฟ้อ', 'ดัชนีราคาผู้บริโภค'],
    why: 'ทองถูกใช้เป็นที่หลบเงินเฟ้อมาตลอด เงินเฟ้อสูงจึงหนุนราคา '
       + 'แต่ระวัง: ถ้าเงินเฟ้อสูงจนเฟดต้องขึ้นดอกเบี้ยแรง ผลอาจกลับเป็นลบได้',
  },
  {
    key: 'war', label: 'สงคราม / ความขัดแย้ง', dir: +1, w: 8,
    kw: ['war', 'conflict', 'invasion', 'missile', 'strike', 'military', 'escalation',
         'ceasefire talks', 'attack', 'สงคราม', 'ความขัดแย้ง', 'โจมตี', 'ยิงขีปนาวุธ'],
    why: 'ตอนโลกไม่แน่นอน เงินไหลเข้าสินทรัพย์ปลอดภัย ทองเป็นตัวเลือกอันดับต้น ๆ '
       + 'ผลมักแรงและเร็ว แต่จางเร็วเช่นกันถ้าเหตุการณ์ไม่ลุกลาม',
  },
  {
    key: 'centralBank', label: 'ธนาคารกลางซื้อทอง', dir: +1, w: 7,
    kw: ['central bank', 'central banks', 'gold reserves', 'buy gold', 'buys gold', 'buying gold',
         'gold purchases', 'bullion buying', 'pboc', 'ธนาคารกลางซื้อทอง', 'ทุนสำรองทองคำ'],
    // ต้องพูดถึงทองด้วย ไม่งั้น "central bank" เฉย ๆ จะไปโดนข่าวนโยบายการเงินทั่วไป
    requires: ['gold', 'bullion', 'ทอง'],
    why: 'ธนาคารกลางซื้อเป็นอุปสงค์ก้อนใหญ่และไม่ค่อยขายคืน จึงหนุนราคาในระยะยาว มากกว่าจะเป็นแรงกระชากรายวัน',
  },
  {
    key: 'recession', label: 'ความเสี่ยงเศรษฐกิจถดถอย / วิกฤตธนาคาร', dir: +1, w: 7,
    kw: ['recession', 'banking crisis', 'bank collapse', 'credit crunch', 'default',
         'debt ceiling', 'downgrade', 'เศรษฐกิจถดถอย', 'วิกฤตธนาคาร'],
    why: 'กลัวเศรษฐกิจพัง = หนีเข้าสินทรัพย์ปลอดภัย และมักตามมาด้วยการคาดว่าเฟดจะลดดอกเบี้ย ซึ่งหนุนทองอีกชั้น',
  },
  {
    key: 'jobs', label: 'ตัวเลขการจ้างงานสหรัฐ', dir: -1, w: 6, invertible: true,
    kw: ['nonfarm', 'non-farm', 'payrolls', 'jobless claims', 'unemployment rate', 'jobs report',
         'การจ้างงานนอกภาคเกษตร', 'ตัวเลขการจ้างงาน'],
    why: 'จ้างงานแข็งแรง = เศรษฐกิจดี = เฟดไม่ต้องรีบลดดอกเบี้ย ซึ่งกดทอง '
       + '(ถ้าตัวเลขออกมาแย่กว่าคาด ผลจะกลับทางทันที — ต้องดูตัวเลขจริงเทียบกับที่ตลาดคาด ไม่ใช่แค่หัวข้อข่าว)',
  },
  {
    key: 'riskOn', label: 'ตลาดหุ้นคึกคัก (เปิดรับความเสี่ยง)', dir: -1, w: 4, invertible: true,
    kw: ['stocks rally', 'record high', 'risk-on', 'risk appetite', 'equities surge',
         'หุ้นพุ่ง', 'ทำนิวไฮ'],
    why: 'เงินไหลไปหาผลตอบแทนที่สูงกว่า ทองที่ไม่มีดอกเบี้ยจึงถูกลดน้ำหนัก — ผลมักเบาและช้ากว่าตัวขับอื่น',
  },
  {
    key: 'tariff', label: 'ภาษีนำเข้า / สงครามการค้า', dir: +1, w: 5,
    kw: ['tariff', 'trade war', 'export ban', 'sanctions', 'ภาษีนำเข้า', 'สงครามการค้า', 'คว่ำบาตร'],
    why: 'ผลสองทางที่ต้องแยกให้ออก: เพิ่มความไม่แน่นอนและดันเงินเฟ้อ (หนุนทอง) '
       + 'แต่ก็มักทำให้ดอลลาร์แข็ง (กดทอง) สุทธิแล้วมักเป็นบวกเล็กน้อย จึงให้น้ำหนักไม่มาก',
  },
  {
    key: 'etf', label: 'กระแสเงินกองทุนทองคำ', dir: +1, w: 5,
    kw: ['gold etf', 'etf inflows', 'gld holdings', 'bullion demand',
         'กองทุนทองคำ', 'เงินไหลเข้าทอง'],
    why: 'เงินไหลเข้ากองทุนทองคำคือแรงซื้อจริงในตลาด วัดได้ตรงไปตรงมากว่าความรู้สึกของนักลงทุน',
  },
];

/** คำที่บอกว่าเป็นข่าวคนละเรื่องกัน แม้จะมีคำว่า gold อยู่ — กันการจับผิดเรื่อง */
const FALSE_FRIENDS = [
  'gold medal', 'golden globe', 'gold cup', 'goldman', 'gold coast', 'golden state',
  'gold star', 'goldfish', 'gold rush game', 'olympic',
];

/*
 * คำที่กลับทิศของตัวขับ — "ดอลลาร์อ่อน" ต้องให้ผลตรงข้ามกับ "ดอลลาร์แข็ง"
 *
 * ต้องเทียบแบบรู้ขอบเขตคำและครอบคลุมรูปผันของกริยา
 * เวอร์ชันแรกใช้การหาสตริงตรง ๆ ด้วยรายการ ['falls', ...] จึงพลาด "yields fall"
 * (พหูพจน์ กริยาไม่เติม s) แล้วอ่านข่าวยีลด์ร่วงเป็น "กดทอง" ซึ่งกลับหัวกับความจริง
 * เจอตอนทดสอบบนเบราว์เซอร์ ไม่ใช่ตอนเขียน — จึงมีเทสต์คุมรูปผันไว้แล้ว
 */
const INVERTERS = [
  /\bfall(s|en|ing)?\b/, /\bdrop(s|ped|ping)?\b/, /\bweaken(s|ed|ing)?\b/,
  /\bdecline(s|d|ing)?\b/, /\bslide(s)?\b/, /\bslid\b/, /\btumbl(e|es|ed|ing)\b/,
  /\bease(s|d)?\b/, /\beasing\b/, /\bcool(s|ed|ing)?\b/, /\bsoften(s|ed|ing)?\b/,
  /\bslump(s|ed)?\b/, /\bplunge(s|d)?\b/, /\bsink(s|ing)?\b/, /\bsank\b/,
  /\bretreat(s|ed|ing)?\b/, /\blower\b/, /\bweaker\b/, /\bdown\b/, /\bcut(s)?\b/,
  /อ่อนค่า/, /ร่วง/, /ลดลง/, /ดิ่ง/, /ชะลอ/,
];

/** คำสำคัญบางคำเป็นวลี ต้องเทียบแบบยืดหยุ่นช่องว่างและรูปพหูพจน์ */
const hasKeyword = (text, kw) => text.includes(kw.toLowerCase());

/**
 * วิเคราะห์หัวข้อข่าวหนึ่งชิ้น
 *
 * คืนตัวขับที่ตรง ทิศทางสุทธิต่อทอง และเหตุผลเป็นภาษาไทย
 * ถ้าไม่ตรงอะไรเลย คืน null — ดีกว่าเดามั่ว
 */
export function classifyHeadline(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (FALSE_FRIENDS.some((f) => t.includes(f))) return null;

  const hits = [];
  for (const d of GOLD_DRIVERS) {
    const matched = d.kw.filter((k) => t.includes(k.toLowerCase()));
    if (!matched.length) continue;
    // บางตัวขับต้องมีคำยืนยันเรื่องด้วย กัน "central bank" ไปโดนข่าวนโยบายทั่วไป
    if (d.requires && !d.requires.some((r) => t.includes(r))) continue;

    /*
     * กลับทิศเฉพาะตัวขับที่ "ทิศขึ้นกับกริยา" เท่านั้น
     *
     * ดอลลาร์/ผลตอบแทนพันธบัตร/เงินเฟ้อ เป็นคำกลาง ๆ — ขึ้นหรือลงให้ผลตรงข้ามกัน
     * แต่ "rate cut" หรือ "hawkish" มีทิศอยู่ในตัวคำแล้ว ถ้าไปกลับด้วยจะผิดทันที
     * เช่น "Fed signals rate cut as inflation falls" คำว่า falls ต้องกลับแค่ inflation
     * ไม่ใช่กลับ rate cut ให้กลายเป็นขึ้นดอกเบี้ย
     *
     * และต้องอยู่ใกล้กันด้วย (ภายใน 40 ตัวอักษร) ไม่ใช่โผล่ที่ไหนก็ได้ในประโยค
     */
    let inverted = false;
    if (d.invertible) {
      for (const k of matched) {
        const at = t.indexOf(k.toLowerCase());
        const near = t.slice(Math.max(0, at - 20), at + k.length + 40);
        if (INVERTERS.some((re) => re.test(near))) { inverted = true; break; }
      }
    }
    hits.push({ ...d, matched, dir: inverted ? -d.dir : d.dir, inverted });
  }
  if (!hits.length) return null;

  const score = hits.reduce((a, h) => a + h.dir * h.w, 0);
  const strength = hits.reduce((a, h) => a + h.w, 0);
  return {
    drivers: hits,
    score,
    dir: Math.sign(score),
    // ความมั่นใจต่ำเมื่อตัวขับหลายตัวขัดกันเอง — สะท้อนความจริงว่าข่าวนั้นตีสองหน้า
    confidence: strength ? Math.abs(score) / strength : 0,
    conflicted: hits.length > 1 && Math.abs(score) < strength * 0.6,
  };
}

/**
 * แหล่งข่าวที่เบราว์เซอร์เรียกได้ตรง ๆ
 *
 * เงื่อนไขที่ตัดตัวเลือกออกไปเกือบหมด: ต้องยอมให้เว็บอื่นเรียก (CORS) และต้องฟรีจริง
 * NewsAPI.org แผนฟรีบล็อกการเรียกจากเบราว์เซอร์ จึงใช้กับหน้าเว็บนิ่ง ๆ ไม่ได้เลย
 * GDELT เป็นโครงการวิจัยเปิด ไม่ต้องใช้คีย์ และเปิด CORS — จึงเป็นตัวเลือกหลัก
 */
export const NEWS_FEEDS = {
  gdelt: {
    label: 'GDELT (ฟรี ไม่ต้องใช้คีย์)',
    needsKey: false,
    note: 'ฐานข้อมูลข่าวเปิดที่เก็บข่าวทั่วโลกแบบเรียลไทม์ ครอบคลุมกว้างแต่คุณภาพหัวข้อไม่สม่ำเสมอ',
    url: (hours) => 'https://api.gdeltproject.org/api/v2/doc/doc?query='
      + encodeURIComponent('(gold prices OR "federal reserve" OR inflation OR "interest rate") sourcelang:english')
      + `&mode=artlist&maxrecords=60&timespan=${Math.max(1, hours)}h&format=json&sort=datedesc`,
    parse: (j) => (j.articles || []).map((a) => ({
      title: a.title, url: a.url, source: a.domain,
      at: parseGdeltDate(a.seendate),
    })),
  },
};

/** GDELT ส่งเวลามาแบบ 20260831T120000Z ซึ่ง Date.parse อ่านไม่ออก ต้องแปลงเอง */
export function parseGdeltDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** ดึงข่าวแล้ววิเคราะห์ทีละชิ้น เรียงข่าวที่กระทบทองแรงสุดไว้บน */
export async function fetchNews(opts = {}) {
  const feed = NEWS_FEEDS[opts.feed || 'gdelt'];
  const doFetch = opts.fetchImpl || ((u) => fetch(u));
  const t0 = Date.now();
  try {
    const res = await doFetch(feed.url(opts.hours || 24));
    if (!res.ok) return { ok: false, reason: `เซิร์ฟเวอร์ตอบรหัส ${res.status}`, ms: Date.now() - t0 };
    const raw = await res.json();
    const items = feed.parse(raw)
      .filter((a) => a.title)
      .map((a) => ({ ...a, analysis: classifyHeadline(a.title) }))
      .filter((a) => a.analysis)
      .sort((a, b) => Math.abs(b.analysis.score) - Math.abs(a.analysis.score));
    return { ok: true, items, ms: Date.now() - t0, at: Date.now(), climate: climateOf(items) };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const cors = /Failed to fetch|NetworkError|Load failed/i.test(msg);
    return { ok: false, cors, ms: Date.now() - t0,
      reason: cors ? 'ยิงไปไม่ถึง — เซิร์ฟเวอร์อาจไม่อนุญาตให้เว็บอื่นเรียก (CORS) หรือเครือข่ายบล็อก' : msg };
  }
}

/**
 * บรรยากาศข่าวโดยรวม — ข่าวส่วนใหญ่ตอนนี้เอียงไปทางหนุนหรือกดทอง
 *
 * ถ่วงน้ำหนักตามความใหม่: ข่าวเมื่อชั่วโมงที่แล้วมีน้ำหนักกว่าข่าวเมื่อวาน
 * เพราะตลาดรับรู้ข่าวเก่าไปแล้ว
 */
export function climateOf(items, now = Date.now()) {
  if (!items || !items.length) return { score: 0, n: 0, label: 'ไม่มีข่าวที่เกี่ยวข้อง', level: 'flat' };
  let num = 0, den = 0;
  for (const it of items) {
    if (!it.analysis) continue;
    const ageH = it.at ? Math.max(0, (now - it.at) / 3600000) : 12;
    const recency = Math.exp(-ageH / 12);   // ครึ่งชีวิตราว 8 ชั่วโมง
    num += it.analysis.score * recency;
    den += Math.abs(it.analysis.score) * recency;
  }
  const score = den ? num / den : 0;
  const level = score > 0.35 ? 'up' : score < -0.35 ? 'down' : 'flat';
  return {
    score, n: items.length, level,
    label: level === 'up' ? 'ข่าวช่วงนี้เอียงไปทางหนุนทอง'
         : level === 'down' ? 'ข่าวช่วงนี้เอียงไปทางกดทอง'
         : 'ข่าวสองทางพอ ๆ กัน ไม่มีทิศชัด',
  };
}

/**
 * ปฏิทินข่าวเศรษฐกิจที่คำนวณเองได้
 *
 * *** ใส่เฉพาะที่คำนวณได้แน่นอนเท่านั้น ***
 * NFP มีกฎตายตัว (ศุกร์แรกของเดือน 8:30 น. เวลาตะวันออกสหรัฐ) จึงคำนวณได้เป๊ะ
 * ส่วน CPI ประกาศราวกลางเดือนแต่วันไม่ตายตัว และ FOMC กำหนดล่วงหน้าเป็นปี ๆ
 * — สองอันนี้ถ้าเดาวันเองจะผิด และผิดแบบที่ผู้ใช้ไม่มีทางรู้ จึงบอกเป็น "ช่วงโดยประมาณ"
 * พร้อมบอกให้ไปดูวันจริง ไม่ใช่แสร้งว่ารู้
 */
export function economicCalendar(now = new Date()) {
  const out = [];
  const d = new Date(now);

  // NFP: ศุกร์แรกของเดือน — คำนวณได้แน่นอน
  for (let m = 0; m < 3; m++) {
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, 1));
    const add = (5 - first.getUTCDay() + 7) % 7;
    const nfp = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1 + add, 12, 30));
    if (nfp.getTime() > now.getTime()) {
      out.push({ key: 'nfp', title: 'ตัวเลขการจ้างงานสหรัฐ (Non-Farm Payrolls)',
        at: nfp.getTime(), exact: true, impact: 'สูง',
        note: 'ศุกร์แรกของเดือน 19:30 น. เวลาไทย — ราคาทองมักเหวี่ยงแรงในไม่กี่นาทีแรก' });
      break;
    }
  }

  // CPI: ราวกลางเดือน วันไม่ตายตัว — บอกเป็นช่วง ไม่ใช่วันเป๊ะ
  const cpiMonth = d.getUTCDate() > 15 ? d.getUTCMonth() + 1 : d.getUTCMonth();
  out.push({ key: 'cpi', title: 'เงินเฟ้อสหรัฐ (CPI)',
    at: Date.UTC(d.getUTCFullYear(), cpiMonth, 12, 12, 30), exact: false, impact: 'สูง',
    note: 'ปกติประกาศราววันที่ 10-15 ของเดือน 19:30 น. เวลาไทย แต่วันไม่ตายตัว — เช็กวันจริงจากปฏิทินเศรษฐกิจก่อนเทรด' });

  // FOMC: ไม่คำนวณเอง เพราะเดาแล้วผิดแน่
  out.push({ key: 'fomc', title: 'ผลประชุมเฟด (FOMC)',
    at: null, exact: false, impact: 'สูงมาก',
    note: 'ปีละ 8 ครั้ง กำหนดล่วงหน้าแต่ไม่มีกฎคำนวณ — ใส่วันเองในช่องด้านล่างจากปฏิทินที่คุณใช้ '
        + 'นี่คือข่าวที่ขยับทองแรงที่สุดในรอบเดือน' });

  return out.filter((e) => e.at === null || e.at > now.getTime() - 3600000)
    .sort((a, b) => (a.at || Infinity) - (b.at || Infinity));
}
