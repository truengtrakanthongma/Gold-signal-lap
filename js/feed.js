/**
 * feed.js — แหล่งข้อมูลราคาทองคำแบบเรียลไทม์
 *
 * 1) binance  : PAXG/USDT หรือ XAUT/USDT — โทเคนที่หนุนด้วยทองคำจริง 1 เหรียญ = 1 ทรอยออนซ์
 *               ราคาวิ่งตาม XAU/USD ใกล้เคียงมาก ใช้ได้ฟรี ไม่ต้องมี API key
 *               มี WebSocket จึงได้ราคาเรียลไทม์จริง และเทรด 24/7 (มีข้อมูลแม้ตลาด spot ปิด)
 * 2) twelvedata: XAU/USD ของจริง ต้องใส่ API key ฟรีเอง (twelvedata.com) — ใช้วิธี polling
 * 3) demo     : จำลองราคาในเครื่อง ใช้ทดสอบระบบตอนไม่มีเน็ต/ตลาดปิด
 *
 * ทุกแหล่งคืนแท่งเทียนรูปแบบเดียวกัน: {t, o, h, l, c, v}  (t = เวลาเปิดแท่ง, ms)
 */

export const TF = {
  '1m':  { ms: 60000,      binance: '1m',  td: '1min',  label: '1 นาที' },
  '5m':  { ms: 300000,     binance: '5m',  td: '5min',  label: '5 นาที' },
  '15m': { ms: 900000,     binance: '15m', td: '15min', label: '15 นาที' },
  '30m': { ms: 1800000,    binance: '30m', td: '30min', label: '30 นาที' },
  '1h':  { ms: 3600000,    binance: '1h',  td: '1h',    label: '1 ชั่วโมง' },
  '4h':  { ms: 14400000,   binance: '4h',  td: '4h',    label: '4 ชั่วโมง' },
  '1d':  { ms: 86400000,   binance: '1d',  td: '1day',  label: '1 วัน' },
};

const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api-gcp.binance.com',
];
const BINANCE_WS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];

/**
 * จังหวะเต้นของราคาในโหมดจำลอง
 * ของจริงจาก WebSocket ส่งมาหลายครั้งต่อวินาที ถ้าจำลองช้ากว่านั้นมาก
 * กราฟจะดูกระตุกเป็นขั้นบันได ทั้งที่ระบบวาดไม่ได้มีปัญหา
 */
const DEMO_TICK_MS = 80;

/**
 * Twelve Data แผนฟรีให้ 8 คำขอ/นาที และ 800 คำขอ/วัน
 *
 * ถ้าดึงราคาใหม่ทุก 15 วินาทีเหมือน Binance จะใช้ 5,760 คำขอ/วัน = เกินโควตา 7 เท่า
 * คีย์จะใช้ไม่ได้ภายในราว 2 ชั่วโมง จึงต้องยืดจังหวะให้อยู่ในงบ
 *
 * งบที่ตั้งไว้: ดึงราคาทุก 3 นาที (480/วัน) + กรอบเวลาใหญ่ทุก 30 นาที (~96/วัน)
 * รวมราว 600 คำขอ/วัน เหลือที่ว่างให้โหลดหน้าใหม่ได้อีกหลายรอบ
 */
export const TD_LIMITS = {
  pollMs: 180000,        // 3 นาที
  htfRefreshMs: 1800000, // 30 นาที
  perDay: 800,
  perMinute: 8,
};

async function fetchJson(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class MarketFeed {
  constructor() {
    this.source = 'binance';
    this.symbol = 'PAXGUSDT';
    this.interval = '15m';
    this.apiKey = '';
    this.ws = null;
    this.pollTimer = null;
    this.demoTimer = null;
    this.hostIdx = 0;
    this.wsIdx = 0;
    this.retry = 0;
    this.onCandle = () => {};
    this.onStatus = () => {};
    this.stopped = true;
    this.demoState = null;
    this.requestCount = 0;   // นับคำขอที่ยิงออกไป เพื่อให้ผู้ใช้เห็นว่าใช้โควตาไปเท่าไร
    this.lastDataAt = 0;     // เวลาที่ได้ข้อมูลล่าสุด — ใช้จับว่าราคาค้างหรือยัง
  }

  /*
   * ข้อมูลค้างนานแค่ไหนถึงเรียกว่า "เชื่อไม่ได้แล้ว"
   *
   * ทำไมต้องมี: WebSocket ค้างแบบ "เปิดอยู่แต่ไม่ส่งอะไรมา" เกิดบ่อยมากบนมือถือ
   * (จอดับ, สลับ WiFi เป็นเน็ตมือถือ, เข้าลิฟต์) ในกรณีนี้ onclose ไม่ยิง
   * ระบบจึงไม่รู้ตัวว่าหลุด แล้วโชว์ราคาเก่าค้างพร้อมสัญญาณเข้าซื้อเหมือนปกติ
   * ซึ่งอันตรายกว่าการไม่มีสัญญาณเลย
   */
  get staleAfterMs() {
    if (this.source === 'demo') return 15000;
    // โหมดดึงเป็นรอบ: ต้องเผื่อให้เกินรอบดึงพอสมควร ไม่งั้นจะเตือนผิดทุกครั้งที่รอรอบถัดไป
    if (this.source === 'twelvedata') return this.livePollMs * 2.5;
    return 90000;   // WebSocket ควรมีข้อมูลเข้ามาตลอด เงียบเกินหนึ่งนาทีครึ่ง = ผิดปกติ
  }

  /** ข้อมูลค้างหรือยัง และค้างมานานเท่าไร */
  freshness(now = Date.now()) {
    if (this.stopped || !this.lastDataAt) return { stale: false, ageMs: 0, unknown: true };
    const ageMs = now - this.lastDataAt;
    return { stale: ageMs > this.staleAfterMs, ageMs, limitMs: this.staleAfterMs };
  }

  /** จังหวะดึงราคาสด ขึ้นกับข้อจำกัดของผู้ให้บริการ */
  get livePollMs() {
    return this.source === 'twelvedata' ? TD_LIMITS.pollMs : 15000;
  }

  /** จังหวะรีเฟรชกรอบเวลาใหญ่ */
  get htfRefreshMs() {
    return this.source === 'twelvedata' ? TD_LIMITS.htfRefreshMs : 60000;
  }

  configure(opts) { Object.assign(this, opts); }

  // ── โหลดประวัติราคา ───────────────────────────────────────────────────
  async loadHistory(interval = this.interval, limit = 700) {
    if (this.source === 'demo') return this._demoHistory(interval, limit);
    if (this.source === 'twelvedata') return this._tdHistory(interval, limit);
    return this._binanceHistory(interval, limit);
  }

  /** ยิงคำขอไป Binance โดยสลับโฮสต์อัตโนมัติถ้าโฮสต์แรกใช้ไม่ได้ */
  async _binanceGet(path) {
    let lastErr;
    for (let attempt = 0; attempt < BINANCE_HOSTS.length; attempt++) {
      const idx = (this.hostIdx + attempt) % BINANCE_HOSTS.length;
      try {
        const data = await fetchJson(`${BINANCE_HOSTS[idx]}${path}`);
        this.hostIdx = idx;   // จำโฮสต์ที่ใช้ได้ไว้ ครั้งต่อไปจะได้ไม่ต้องลองใหม่
        return data;
      } catch (e) { lastErr = e; }
    }
    throw new Error(`โหลดข้อมูลจาก Binance ไม่สำเร็จ (${lastErr && lastErr.message})`);
  }

  /**
   * โหลดแท่งเทียนย้อนหลัง — ขอได้เกิน 1,000 แท่ง
   *
   * Binance ให้ครั้งละไม่เกิน 1,000 แท่ง ถ้าอยากได้มากกว่านั้นต้องไล่ขอเป็นชุด
   * โดยเลื่อน endTime ถอยหลังไปทีละชุด
   *
   * ทำไมต้องได้เยอะ: สถิติจาก 1,000 แท่งบนกรอบ 15 นาที = ข้อมูลแค่ 10 วัน
   * ได้ไม้เทรดไม่กี่สิบไม้ ซึ่งน้อยเกินกว่าจะบอกได้ว่าระบบมีความได้เปรียบจริงหรือแค่บังเอิญ
   */
  async _binanceHistory(interval, limit) {
    const perCall = 1000;
    const tf = TF[interval].binance;
    const out = [];
    let endTime = null;
    let remaining = Math.max(1, limit);

    while (remaining > 0 && out.length < limit) {
      const n = Math.min(perCall, remaining);
      const q = `/api/v3/klines?symbol=${this.symbol}&interval=${tf}&limit=${n}`
        + (endTime ? `&endTime=${endTime}` : '');
      const raw = await this._binanceGet(q);
      if (!raw || !raw.length) break;
      out.unshift(...raw);
      endTime = raw[0][0] - 1;      // ขยับไปก่อนแท่งเก่าสุดที่เพิ่งได้มา
      remaining -= raw.length;
      if (raw.length < n) break;     // ไม่มีข้อมูลเก่ากว่านี้อีกแล้ว
      this.onStatus({ state: 'loading', message: `กำลังโหลดประวัติราคา ${out.length.toLocaleString('th-TH')} แท่ง…` });
    }
    if (!out.length) throw new Error('Binance ไม่ส่งข้อมูลแท่งเทียนกลับมา');

    // ชุดที่ต่อกันอาจมีแท่งซ้ำตรงรอยต่อ ต้องกรองออกและเรียงตามเวลาให้แน่ใจ
    const seen = new Set();
    return out
      .filter((k) => { if (seen.has(k[0])) return false; seen.add(k[0]); return true; })
      .sort((a, b) => a[0] - b[0])
      .map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closed: true }));
  }

  async _tdHistory(interval, limit) {
    if (!this.apiKey) throw new Error('โหมด Twelve Data ต้องใส่ API key ก่อน (สมัครฟรีที่ twelvedata.com)');
    const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${TF[interval].td}&outputsize=${Math.min(limit, 5000)}&order=ASC&apikey=${encodeURIComponent(this.apiKey)}`;
    this.requestCount++;
    const data = await fetchJson(url);
    if (data.status === 'error') {
      const msg = String(data.message || '');
      if (/limit|quota|credits/i.test(msg)) {
        throw new Error(`ใช้โควตา Twelve Data หมดแล้ว — แผนฟรีจำกัด ${TD_LIMITS.perMinute} คำขอ/นาที และ ${TD_LIMITS.perDay} คำขอ/วัน `
          + `(ข้อความจากผู้ให้บริการ: ${msg})`);
      }
      throw new Error(`Twelve Data: ${msg}`);
    }
    return (data.values || []).map((v) => ({
      t: new Date(v.datetime.replace(' ', 'T') + 'Z').getTime(),
      o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume || 0), closed: true,
    }));
  }

  // ── ราคาสด ────────────────────────────────────────────────────────────
  start(onCandle, onStatus) {
    this.onCandle = onCandle || this.onCandle;
    this.onStatus = onStatus || this.onStatus;
    this.stopped = false;
    if (this.source === 'demo') return this._startDemo();
    if (this.source === 'twelvedata') return this._startPolling();
    return this._startBinanceWs();
  }

  stop() {
    this.stopped = true;
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) { /* ignore */ } this.ws = null; }
    clearInterval(this.pollTimer); this.pollTimer = null;
    clearInterval(this.demoTimer); this.demoTimer = null;
  }

  _startBinanceWs() {
    const host = BINANCE_WS[this.wsIdx % BINANCE_WS.length];
    const stream = `${this.symbol.toLowerCase()}@kline_${TF[this.interval].binance}`;
    try {
      this.ws = new WebSocket(`${host}/ws/${stream}`);
    } catch (e) {
      this.onStatus({ state: 'error', message: 'สร้าง WebSocket ไม่สำเร็จ' });
      return this._scheduleReconnect();
    }
    this.ws.onopen = () => { this.retry = 0; this.onStatus({ state: 'live', message: `เชื่อมต่อสด: ${this.symbol} ${this.interval}` }); };
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const k = msg.k;
        if (!k) return;
        this.lastDataAt = Date.now();
        this.onCandle({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, closed: !!k.x });
      } catch (e) { /* ข้ามข้อความที่ parse ไม่ได้ */ }
    };
    this.ws.onerror = () => this.onStatus({ state: 'error', message: 'WebSocket ผิดพลาด' });
    this.ws.onclose = () => { if (!this.stopped) { this.wsIdx++; this._scheduleReconnect(); } };
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.onStatus({ state: 'reconnect', message: `หลุดการเชื่อมต่อ — ต่อใหม่ใน ${(delay / 1000).toFixed(0)} วิ` });
    setTimeout(() => { if (!this.stopped) this._startBinanceWs(); }, delay);
  }

  _startPolling() {
    const tick = async () => {
      try {
        const rows = await this._tdHistory(this.interval, 3);
        // ส่งแท่งเก่า (ปิดแล้ว) ก่อน แล้วค่อยส่งแท่งล่าสุดที่ยังก่อตัวอยู่
        rows.slice(0, -1).forEach((r) => this.onCandle({ ...r, closed: true }));
        const last = rows[rows.length - 1];
        if (last) this.onCandle({ ...last, closed: false });
        this.lastDataAt = Date.now();
        this.onStatus({ state: 'live',
          message: `XAU/USD จาก Twelve Data · อัปเดตทุก ${Math.round(this.livePollMs / 60000)} นาที `
            + `(แผนฟรีจำกัดโควตา) · ใช้ไปแล้ว ${this.requestCount} คำขอ` });
      } catch (e) {
        this.onStatus({ state: 'error', message: e.message });
      }
    };
    tick();
    this.pollTimer = setInterval(tick, this.livePollMs);
  }

  // ── โหมดจำลอง ─────────────────────────────────────────────────────────
  _demoHistory(interval, limit) {
    const step = TF[interval].ms;
    const now = Date.now();
    // จัดแท่งให้ตรงกรอบเวลาจริง โดยแท่งสุดท้าย = แท่งที่กำลังก่อตัวอยู่ตอนนี้
    const end = Math.floor(now / step) * step;
    const start = end - step * (limit - 1);
    let price = 3350 + (Math.random() - 0.5) * 60;
    let vol = 0.0006;
    const out = [];
    let trend = 0;
    for (let i = 0; i < limit; i++) {
      // เทรนด์เปลี่ยนเป็นช่วง ๆ + ความผันผวนจับกลุ่ม (volatility clustering) เหมือนตลาดจริง
      if (i % 60 === 0) trend = (Math.random() - 0.5) * 0.0004;
      vol = Math.max(0.00025, vol * 0.94 + Math.abs(gauss()) * 0.00012);
      const t = start + i * step;
      const hourTh = (new Date(t).getUTCHours() + 7) % 24;
      const sessionMult = hourTh >= 14 && hourTh < 24 ? 1.5 : 0.7; // ลอนดอน/นิวยอร์กผันผวนกว่า
      const o = price;
      const drift = trend + gauss() * vol * sessionMult;
      const c = o * (1 + drift);
      const wick = Math.abs(gauss()) * o * vol * sessionMult * 0.8;
      const h = Math.max(o, c) + wick;
      const l = Math.min(o, c) - Math.abs(gauss()) * o * vol * sessionMult * 0.8;
      const v = 500 * sessionMult * (1 + Math.abs(drift) * 400) * (0.6 + Math.random());
      out.push({ t, o, h, l, c, v, closed: i < limit - 1 });
      price = c;
    }
    // ผูก state ของราคาสดกับ "กรอบเวลาที่กำลังแสดงอยู่" เท่านั้น
    // ไม่งั้นการโหลดข้อมูลกรอบใหญ่ (1h/4h) จะไปทับ แล้วแท่งสดจะมี timestamp ผิดกรอบ
    if (interval === this.interval) {
      // ปริมาณต่อ tick ต้องหารตามจำนวน tick ที่จะเกิดใน 1 แท่ง
      // ไม่งั้นแท่งสดจะสะสมปริมาณจนสูงกว่าข้อมูลย้อนหลังหลายเท่า
      const avgVol = out.reduce((a, k) => a + k.v, 0) / out.length;
      const ticksPerCandle = Math.max(1, step / DEMO_TICK_MS);
      this.demoState = {
        price, step, lastT: out[out.length - 1].t, cur: null, vol,
        volPerTick: avgVol / ticksPerCandle,
        lastBar: out[out.length - 1],   // แท่งที่กำลังก่อตัวอยู่ในประวัติ
      };
    }
    return Promise.resolve(out);
  }

  _startDemo() {
    this.onStatus({ state: 'demo', message: 'โหมดจำลอง (ไม่ใช่ราคาจริง) — ใช้ทดสอบระบบ' });
    const st = this.demoState;
    if (!st) return;
    this.demoTimer = setInterval(() => {
      const now = Date.now();
      this.lastDataAt = now;
      const bucket = Math.floor(now / st.step) * st.step;
      // ความผันผวนต่อ tick ต้องลดตามรากที่สองของเวลา ไม่งั้นเต้นถี่ขึ้น = ผันผวนเกินจริง
      const move = gauss() * st.price * st.vol * 0.35 * Math.sqrt(DEMO_TICK_MS / 900);
      st.price = Math.max(1, st.price + move);
      if (!st.cur || st.cur.t !== bucket) {
        if (st.cur) this.onCandle({ ...st.cur, closed: true }); // ปิดแท่งเดิมก่อน
        if (!st.cur && st.lastBar && st.lastBar.t === bucket) {
          // แท่งสดแท่งแรกคือแท่งเดียวกับที่อยู่ท้ายประวัติ — ต้องสานต่อ ไม่ใช่เขียนทับ
          // ถ้าสร้างใหม่ ราคาเปิดกับปริมาณที่สะสมมาแล้วจะหายไป เกิดช่องว่างราคาปลอม
          st.cur = { ...st.lastBar, closed: false };
        } else {
          st.cur = { t: bucket, o: st.price, h: st.price, l: st.price, c: st.price, v: 0, closed: false };
        }
      }
      st.cur.c = st.price;
      st.cur.h = Math.max(st.cur.h, st.price);
      st.cur.l = Math.min(st.cur.l, st.price);
      st.cur.v += (st.volPerTick || 1) * (0.5 + Math.random() + Math.abs(move) / (st.price * st.vol + 1e-9) * 0.3);
      this.onCandle({ ...st.cur });
    }, DEMO_TICK_MS);
  }
}

let spare = null;
function gauss() {
  if (spare !== null) { const s = spare; spare = null; return s; }
  let u = 0, v = 0, s = 0;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
  const mul = Math.sqrt((-2 * Math.log(s)) / s);
  spare = v * mul;
  return u * mul;
}

/** รวมแท่งใหม่เข้า array เดิม (แทนที่ถ้าเป็นแท่งเดียวกัน, ต่อท้ายถ้าเป็นแท่งใหม่) */
export function mergeCandle(candles, k) {
  const last = candles[candles.length - 1];
  if (!last || k.t > last.t) { candles.push(k); return { appended: true }; }
  if (k.t === last.t) { candles[candles.length - 1] = { ...last, ...k }; return { appended: false }; }
  return { appended: false, stale: true };
}
