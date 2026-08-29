/**
 * sources.js — ทะเบียนแหล่งราคาทองฟรี พร้อมตัวทดสอบว่าใช้ได้จริงไหม
 *
 * ทำไมถึงหา "ทองคำสปอตจริง ฟรี ไม่ต้องใช้คีย์" แทบไม่ได้เลย
 * ────────────────────────────────────────────────────────────
 * ราคาทองคำสปอต (XAU/USD) เป็นข้อมูลที่มีลิขสิทธิ์ ผู้ให้บริการต้องจ่ายค่าฟีดต่อ
 * เจ้าที่แจกฟรีจึงต้องจำกัดโควตาและบังคับให้สมัครคีย์เสมอ
 *
 * ส่วนที่ "ฟรีจริง ไม่ต้องใช้คีย์" ได้ คือตลาดคริปโตที่มีโทเคนหนุนด้วยทองคำ
 * เพราะเป็นข้อมูลของตลาดเขาเอง ไม่ต้องซื้อลิขสิทธิ์ใคร
 *
 * แต่โทเคนพวกนี้ไม่ใช่ทองคำสปอต — ต่างกันได้ 0.1-1% และตัวที่คู่กับ USDT
 * ยังบวกความคลาดเคลื่อนของ USDT เองเข้าไปอีกชั้น
 *
 * *** จุดที่คนมองข้าม: คู่ที่เทียบกับ USD จริง ดีกว่าคู่ที่เทียบกับ USDT ***
 * PAXG/USD บน Kraken และ XAUT/USD บน Bitfinex ตัดความคลาดเคลื่อนของ USDT ทิ้งไป
 * จึงใกล้ราคาทองจริงกว่า PAXG/USDT ที่ระบบใช้อยู่ตอนนี้ — และยังฟรี ไม่ต้องใช้คีย์
 *
 * หมายเหตุสำคัญ: ไฟล์นี้เขียนจากเอกสารของแต่ละเจ้า ยังไม่เคยยิงจริง
 * (เครื่องที่พัฒนาต่อเน็ตออกไปไม่ได้) จึงต้องมี testSource() ให้เบราว์เซอร์ผู้ใช้
 * ทดสอบเองแล้วรายงานผล ไม่ใช่เดาว่าใช้ได้แล้วปล่อยผ่าน
 */

/** ราคาทองต่อออนซ์ที่เป็นไปได้ — ใช้ตรวจว่าข้อมูลที่ได้มาเป็นทองจริงหรือหลงมาจากที่อื่น */
const GOLD_MIN = 500, GOLD_MAX = 20000;

export const SOURCES = {
  binance_paxg: {
    label: 'Binance · PAXG/USDT',
    instrument: 'PAXGUSDT',
    kind: 'โทเคนอิงทอง เทียบ USDT',
    needsKey: false,
    live: 'websocket',
    accuracy: 2,
    note: 'ใช้อยู่ตอนนี้ — สภาพคล่องดีที่สุด มี WebSocket จึงอัปเดตทันที '
        + 'แต่เทียบกับ USDT จึงมีความคลาดเคลื่อนสองชั้น (โทเคน + USDT)',
    tf: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d' },
    url: (tf, limit) => `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${tf}&limit=${Math.min(limit, 1000)}`,
    parse: (j) => j.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closed: true })),
  },

  kraken_paxg: {
    label: 'Kraken · PAXG/USD',
    instrument: 'PAXGUSD',
    kind: 'โทเคนอิงทอง เทียบ USD จริง',
    needsKey: false,
    live: 'poll',
    accuracy: 3,
    note: 'เทียบกับดอลลาร์จริง ไม่ใช่ USDT จึงตัดความคลาดเคลื่อนของ USDT ทิ้งไปหนึ่งชั้น '
        + 'ใกล้ราคาทองจริงกว่า Binance แต่สภาพคล่องบางกว่า และให้ย้อนหลังได้ 720 แท่ง',
    tf: { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 },
    url: (tf) => `https://api.kraken.com/0/public/OHLC?pair=PAXGUSD&interval=${tf}`,
    parse: (j) => {
      if (j.error && j.error.length) throw new Error(j.error.join(', '));
      // Kraken ตั้งชื่อคีย์ผลลัพธ์ไม่ตรงกับที่ขอเสมอ (มีทั้ง PAXGUSD และชื่อแปลง)
      // จึงต้องหยิบคีย์แรกที่ไม่ใช่ last แทนการอ้างชื่อตรง ๆ
      const key = Object.keys(j.result || {}).find((k) => k !== 'last');
      if (!key) throw new Error('ไม่พบข้อมูลในผลลัพธ์');
      return j.result[key].map((r) => ({
        t: +r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6], closed: true,
      }));
    },
  },

  bitfinex_xaut: {
    label: 'Bitfinex · XAUT/USD',
    instrument: 'XAUTUSD',
    kind: 'โทเคนอิงทอง เทียบ USD จริง',
    needsKey: false,
    live: 'poll',
    accuracy: 3,
    note: 'Tether Gold เทียบดอลลาร์จริง เช่นเดียวกับ Kraken — ตัดความคลาดเคลื่อนของ USDT ทิ้ง '
        + 'ขอย้อนหลังได้ถึง 10,000 แท่ง แต่ไม่มีกรอบ 4 ชั่วโมง (มี 3 กับ 6 ชั่วโมงแทน)',
    tf: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1d': '1D' },
    url: (tf, limit) => `https://api-pub.bitfinex.com/v2/candles/trade:${tf}:tXAUT:USD/hist?limit=${Math.min(limit, 10000)}&sort=1`,
    /*
     * ระวัง: Bitfinex เรียงเป็น [เวลา, เปิด, ปิด, สูงสุด, ต่ำสุด, ปริมาณ]
     * ไม่ใช่ [เปิด, สูงสุด, ต่ำสุด, ปิด] แบบเจ้าอื่น
     * ถ้าอ่านผิดลำดับ กราฟจะยังวาดออกมาได้ แต่แท่งเทียนจะกลับหัวกลับหาง
     * และไม่มีอะไรบนหน้าจอบอกเลยว่าผิด — จึงมีเทสต์จับตรงนี้โดยเฉพาะ
     */
    parse: (j) => j.map((r) => ({ t: +r[0], o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: Math.abs(+r[5]), closed: true })),
  },

  okx_paxg: {
    label: 'OKX · PAXG/USDT',
    instrument: 'PAXGUSDT',
    kind: 'โทเคนอิงทอง เทียบ USDT',
    needsKey: false,
    live: 'poll',
    accuracy: 2,
    note: 'ตัวสำรองเผื่อ Binance ถูกบล็อกในเครือข่ายของคุณ ให้ครั้งละ 300 แท่ง',
    tf: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1D' },
    url: (tf, limit) => `https://www.okx.com/api/v5/market/candles?instId=PAXG-USDT&bar=${tf}&limit=${Math.min(limit, 300)}`,
    parse: (j) => {
      if (j.code && j.code !== '0') throw new Error(j.msg || `OKX ตอบรหัส ${j.code}`);
      // OKX ส่งใหม่ไปเก่า ต้องกลับด้านให้เป็นเก่าไปใหม่เหมือนเจ้าอื่น
      return (j.data || []).map((r) => ({
        t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], closed: true,
      })).reverse();
    },
  },

  twelvedata: {
    label: 'Twelve Data · XAU/USD',
    instrument: 'XAU/USD',
    kind: 'ทองคำสปอตจริง',
    needsKey: true,
    live: 'poll',
    accuracy: 5,
    note: 'ทองคำสปอตของจริง ตรงกับที่โบรกเกอร์อ้างอิง — แต่ต้องสมัครคีย์ฟรีเอง '
        + 'และแผนฟรีจำกัด 800 คำขอ/วัน (ระบบตั้งจังหวะดึงไว้ให้อยู่ในโควตาแล้ว)',
    tf: { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h', '1d': '1day' },
    url: (tf, limit, key) => `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${tf}`
      + `&outputsize=${Math.min(limit, 5000)}&order=ASC&apikey=${encodeURIComponent(key || '')}`,
    parse: (j) => {
      if (j.status === 'error') throw new Error(j.message || 'Twelve Data ตอบว่าผิดพลาด');
      return (j.values || []).map((r) => ({
        t: Date.parse(r.datetime.includes(' ') ? r.datetime.replace(' ', 'T') + 'Z' : r.datetime + 'T00:00:00Z'),
        o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +(r.volume || 0), closed: true,
      }));
    },
  },
};

/**
 * ตรวจว่าแท่งเทียนชุดหนึ่ง "สมเหตุสมผล" จริงไหม
 *
 * ไม่พอที่จะดูว่าคำขอสำเร็จ เพราะตัวแปลงข้อมูลอาจอ่านคอลัมน์ผิดลำดับ
 * แล้วยังคืนตัวเลขออกมาครบทุกช่อง กราฟก็ยังวาดได้ แต่ผิดทั้งหมด
 */
export function validateBars(bars, tfMs) {
  const issues = [];
  if (!Array.isArray(bars) || !bars.length) return { ok: false, issues: ['ไม่ได้ข้อมูลแท่งเทียนกลับมาเลย'] };

  const bad = bars.filter((b) => ![b.t, b.o, b.h, b.l, b.c].every(Number.isFinite));
  if (bad.length) issues.push(`มี ${bad.length} แท่งที่ค่าไม่ใช่ตัวเลข`);

  // สูงสุดต้องไม่ต่ำกว่าเปิด/ปิด และต่ำสุดต้องไม่สูงกว่า — จับการอ่านคอลัมน์สลับได้ตรงนี้
  const wrong = bars.filter((b) => b.h < Math.max(b.o, b.c) - 1e-9 || b.l > Math.min(b.o, b.c) + 1e-9);
  if (wrong.length) issues.push(`มี ${wrong.length} แท่งที่สูงสุด/ต่ำสุดขัดกับราคาเปิด-ปิด (อ่านคอลัมน์สลับหรือเปล่า)`);

  const prices = bars.map((b) => b.c).filter(Number.isFinite);
  const mid = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  if (mid !== null && (mid < GOLD_MIN || mid > GOLD_MAX)) {
    issues.push(`ราคาอยู่ที่ ${mid.toFixed(2)} ซึ่งไม่ใช่ช่วงราคาทองต่อออนซ์ (${GOLD_MIN}-${GOLD_MAX})`);
  }

  const outOfOrder = bars.filter((b, i) => i > 0 && b.t <= bars[i - 1].t).length;
  if (outOfOrder) issues.push(`มี ${outOfOrder} แท่งที่เวลาไม่เรียงจากเก่าไปใหม่`);

  if (tfMs && bars.length > 3) {
    const gaps = bars.slice(1).map((b, i) => b.t - bars[i].t);
    const offGrid = gaps.filter((g) => g % tfMs !== 0).length;
    if (offGrid > gaps.length * 0.1) issues.push(`ระยะห่างระหว่างแท่งไม่ตรงกับกรอบเวลาที่ขอ (${offGrid}/${gaps.length} ช่วง)`);
  }

  return { ok: issues.length === 0, issues };
}

/**
 * ทดสอบแหล่งข้อมูลหนึ่งแหล่งจากเบราว์เซอร์ของผู้ใช้
 *
 * ต้องรันในเบราว์เซอร์เท่านั้น เพราะสิ่งที่อยากรู้จริง ๆ คือ
 * "เครือข่ายและเบราว์เซอร์ของผู้ใช้ ยิงไปถึงและผ่าน CORS ไหม"
 * ซึ่งทดสอบจากที่อื่นแทนกันไม่ได้
 */
export async function testSource(key, opts = {}) {
  const src = SOURCES[key];
  if (!src) return { key, ok: false, reason: 'ไม่รู้จักแหล่งข้อมูลนี้' };
  const interval = opts.interval || '15m';
  const tf = src.tf[interval];
  if (tf === undefined) {
    return { key, ok: false, unsupported: true, reason: `แหล่งนี้ไม่มีกรอบเวลา ${interval}` };
  }
  if (src.needsKey && !opts.apiKey) {
    return { key, ok: false, needsKey: true, reason: 'ต้องใส่ API key ก่อนถึงจะทดสอบได้' };
  }

  const t0 = Date.now();
  const doFetch = opts.fetchImpl || ((u) => fetch(u));
  try {
    const res = await doFetch(src.url(tf, opts.limit || 120, opts.apiKey));
    if (!res.ok) {
      return { key, ok: false, status: res.status, ms: Date.now() - t0,
        reason: `เซิร์ฟเวอร์ตอบรหัส ${res.status}` + (res.status === 451 || res.status === 403
          ? ' — มักแปลว่าถูกบล็อกจากประเทศหรือเครือข่ายของคุณ' : '') };
    }
    const json = await res.json();
    const bars = src.parse(json);
    const tfMs = opts.tfMs || null;
    const v = validateBars(bars, tfMs);
    const ms = Date.now() - t0;
    const last = bars[bars.length - 1];
    return {
      key, ok: v.ok, issues: v.issues, ms, bars: bars.length,
      lastPrice: last ? last.c : null,
      lastAt: last ? last.t : null,
      ageMs: last ? Date.now() - last.t : null,
      reason: v.ok ? null : v.issues.join(' · '),
    };
  } catch (e) {
    const msg = String(e && e.message || e);
    // เบราว์เซอร์ไม่บอกตรง ๆ ว่าโดน CORS — เห็นแค่ "Failed to fetch"
    const cors = /Failed to fetch|NetworkError|Load failed/i.test(msg);
    return { key, ok: false, ms: Date.now() - t0, cors,
      reason: cors ? 'ยิงไปไม่ถึง — มักเป็นเพราะเซิร์ฟเวอร์ไม่อนุญาตให้เว็บอื่นเรียก (CORS) หรือเครือข่ายบล็อก' : msg };
  }
}

/** ทดสอบทุกแหล่งพร้อมกัน แล้วเรียงตัวที่ใช้ได้และแม่นกว่าไว้บน */
export async function testAllSources(opts = {}) {
  const keys = Object.keys(SOURCES);
  const results = await Promise.all(keys.map((k) => testSource(k, opts)));
  return results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return (SOURCES[b.key].accuracy || 0) - (SOURCES[a.key].accuracy || 0);
  });
}
