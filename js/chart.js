/**
 * chart.js — กราฟแท่งเทียนวาดเองบน Canvas (ไม่พึ่งไลบรารีภายนอก)
 * รองรับ: EMA, Bollinger, แนวรับ-ต้าน, จุดสัญญาณ, เส้นแผนเทรด (Entry/SL/TP),
 *         แผงย่อย Volume / RSI / MACD, crosshair, ซูมด้วยลูกกลิ้ง, ลากเลื่อน
 */

const COL = {
  bg: '#0b1020', grid: 'rgba(148,163,184,0.10)', text: '#94a3b8', textStrong: '#e2e8f0',
  up: '#22c55e', down: '#ef4444', upFill: 'rgba(34,197,94,0.85)', downFill: 'rgba(239,68,68,0.85)',
  ema20: '#facc15', ema50: '#38bdf8', ema200: '#f472b6',
  bb: 'rgba(148,163,184,0.35)', bbFill: 'rgba(56,189,248,0.05)',
  sup: 'rgba(34,197,94,0.55)', res: 'rgba(239,68,68,0.55)',
  entry: '#e2e8f0', sl: '#ef4444', tp: '#22c55e', vwap: '#a78bfa',
  cross: 'rgba(226,232,240,0.45)',
};

/** สี่เหลี่ยมมุมมน — เขียนเองแทน ctx.roundRect เพื่อให้เบราว์เซอร์รุ่นเก่ายังวาดได้ */
function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

export class Chart {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.candles = [];
    this.ind = null;
    this.setup = null;
    this.position = null;   // ไม้ที่ถืออยู่จริง (คนละเรื่องกับแผนที่ยังไม่ได้เข้า)
    this.posHit = null;     // กรอบปุ่มปิดบนป้าย ใช้ตรวจว่าแตะโดนไหม
    this.markers = [];
    this.view = { count: 140, offset: 0 }; // offset = จำนวนแท่งที่เลื่อนถอยจากขวาสุด
    this.panels = { volume: true, rsi: true, macd: true };
    this.mouse = null;
    this.drag = null;
    this.showLevels = true;
    this.showBB = true;

    // ค่าที่ "ไหลเข้าหาเป้าหมาย" แทนการกระโดด — ทำให้ซูมและสเกลแกนราคานุ่ม
    this.anim = { min: null, max: null, count: null };
    this.needsDraw = true;
    this.reduce = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._bind();
    this._raf();
  }

  /**
   * วาดใหม่ตามรอบรีเฟรชของจอ ไม่ใช่ตามจังหวะที่ข้อมูลเข้ามา
   *
   * เดิมทุก event (ราคาเข้า, ขยับเมาส์, ลาก) สั่งวาดทันที ทำให้วาดถี่เกินจำเป็น
   * บางเฟรมวาดหลายรอบ บางเฟรมไม่วาดเลย ภาพจึงกระตุก
   * ตอนนี้ทุก event แค่ยกธง แล้ววาดครั้งเดียวต่อเฟรม
   */
  _raf() {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => this._raf());
    const moving = this._ease();
    if (moving || this.needsDraw) {
      this.needsDraw = false;
      this._draw();
    }
  }

  /** ขอให้วาดใหม่ในเฟรมถัดไป (ราคาถูก เรียกบ่อยแค่ไหนก็ได้) */
  invalidate() { this.needsDraw = true; }

  /** ขอบเขตแกนราคาที่ "ควรจะเป็น" ณ ตอนนี้ */
  _computeTarget() {
    const n = this.candles.length;
    const count = Math.max(20, Math.round(this.anim.count === null ? this.view.count : this.anim.count));
    const end = Math.max(20, n - this.view.offset);
    const start = Math.max(0, end - count);
    let min = Infinity, max = -Infinity;
    for (let i = start; i < end; i++) {
      const c = this.candles[i];
      if (c.l < min) min = c.l;
      if (c.h > max) max = c.h;
    }
    const add = (v) => { if (v === null || v === undefined || Number.isNaN(v)) return; if (v < min) min = v; if (v > max) max = v; };
    if (this.ind && this.showBB) for (let i = start; i < end; i++) { add(this.ind.bb.upper[i]); add(this.ind.bb.lower[i]); }
    if (this.setup) [this.setup.entry, this.setup.sl, this.setup.tp1, this.setup.tp2, this.setup.tp3].forEach(add);
    /* ไม้ที่ถืออยู่ต้องอยู่ในกรอบราคาที่มองเห็นเสมอ ไม่งั้นเส้นจะหลุดออกนอกจอ
       แล้วคนถือไม้อยู่จะมองไม่เห็นว่า SL ตัวเองอยู่ตรงไหนเทียบกับราคา */
    if (this.position) [this.position.entry, this.position.sl, this.position.tp].forEach((v) => { if (v > 0) add(v); });
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const pad = (max - min) * 0.08 || 1;
    return { min: min - pad, max: max + pad, start, end };
  }

  /** ค่อย ๆ เลื่อนค่าที่แสดงเข้าหาเป้าหมาย คืน true ถ้ายังเคลื่อนอยู่ */
  _ease() {
    if (!this.candles.length || !this.W) return false;
    if (this.anim.count === null) this.anim.count = this.view.count;
    const k = this.reduce ? 1 : 0.24;   // ผู้ที่ตั้งค่าลดการเคลื่อนไหว จะได้ภาพนิ่งทันที
    let moving = false;

    const dCount = this.view.count - this.anim.count;
    if (Math.abs(dCount) > 0.4) { this.anim.count += dCount * k; moving = true; }
    else this.anim.count = this.view.count;

    const t = this._computeTarget();
    if (!t) return moving;
    this.win = t;
    if (this.anim.min === null) { this.anim.min = t.min; this.anim.max = t.max; }
    const span = Math.max(1e-9, t.max - t.min);
    const dMin = t.min - this.anim.min, dMax = t.max - this.anim.max;
    if (Math.abs(dMin) > span * 0.0006 || Math.abs(dMax) > span * 0.0006) {
      this.anim.min += dMin * k;
      this.anim.max += dMax * k;
      moving = true;
    } else { this.anim.min = t.min; this.anim.max = t.max; }
    return moving;
  }

  _bind() {
    const cv = this.cv;
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = Math.sign(e.deltaY);
      const next = Math.round(this.view.count * (dir > 0 ? 1.15 : 0.87));
      this.view.count = Math.max(30, Math.min(600, next));
      this.invalidate();
    }, { passive: false });

    cv.addEventListener('mousedown', (e) => { this.drag = { x: e.offsetX, offset: this.view.offset }; });
    window.addEventListener('mouseup', () => { this.drag = null; });
    cv.addEventListener('mousemove', (e) => {
      this.mouse = { x: e.offsetX, y: e.offsetY };
      if (this.drag) {
        const bw = this.plot ? this.plot.barW : 6;
        const shift = Math.round((e.offsetX - this.drag.x) / bw);
        this.view.offset = Math.max(0, Math.min(this.candles.length - 20, this.drag.offset + shift));
      }
      this.invalidate();
    });
    cv.addEventListener('mouseleave', () => { this.mouse = null; this.invalidate(); });

    /* กากบาทบนป้ายไม้ที่ถืออยู่ — วาดแล้วต้องกดได้จริง
       ปุ่มที่วาดไว้เฉย ๆ แต่กดไม่ได้ แย่กว่าไม่วาด เพราะทำให้เข้าใจผิด */
    const hitClose = (x, y) => {
      const h = this.posHit;
      return h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
    };
    cv.addEventListener('click', (e) => {
      if (hitClose(e.offsetX, e.offsetY) && this.onClosePosition) this.onClosePosition();
    });
    cv.addEventListener('touchend', (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const r = cv.getBoundingClientRect();
      if (hitClose(t.clientX - r.left, t.clientY - r.top) && this.onClosePosition) this.onClosePosition();
    }, { passive: true });

    /*
     * สัมผัสบนมือถือ — เดิมทำได้อย่างเดียวคือลากเลื่อน
     *
     * ซูมไม่ได้เลย และแตะดูค่าไม่ได้ ทั้งที่โค้ดวาดกล่อง OHLC ไว้แล้ว
     * แต่กล่องนั้นขึ้นจาก mousemove อย่างเดียว มือถือจึงไม่มีทางเรียกมันออกมาได้
     *
     * ท่าที่ใส่ให้ เป็นชุดเดียวกับที่แอปกราฟทั่วไปใช้ คนจะได้ไม่ต้องเรียนใหม่:
     *   นิ้วเดียวลาก      = เลื่อนกราฟ
     *   นิ้วเดียวแตะค้าง  = เส้นเล็งพร้อมกล่องข้อมูลของแท่งนั้น
     *   สองนิ้วหุบ/กาง    = ซูม
     *   แตะสองครั้ง       = กลับไปมุมมองตั้งต้น
     */
    const rel = (t) => {
      const r = cv.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const spread = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    let pinch = null, holdTimer = null, lastTap = 0, moved = 0;

    const endHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

    cv.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        /* เริ่มซูม — จำระยะห่างนิ้วกับจำนวนแท่งตอนเริ่ม แล้วคิดเป็นสัดส่วน
           ถ้าคิดทีละก้าวจะสะสมความคลาดเคลื่อนจนซูมกระตุก */
        endHold();
        this.drag = null;
        pinch = { d: spread(e.touches), count: this.view.count };
        return;
      }
      if (e.touches.length !== 1) return;
      const p = rel(e.touches[0]);
      moved = 0;
      this.drag = { x: p.x, offset: this.view.offset };

      const now = Date.now();
      if (now - lastTap < 300) {          // แตะสองครั้ง = รีเซ็ต
        this.view.count = 140; this.view.offset = 0; this.mouse = null;
        this.drag = null; lastTap = 0; this.invalidate();
        return;
      }
      lastTap = now;

      /* แตะค้างโดยไม่ขยับ = เข้าโหมดอ่านค่า ต้องรอให้แน่ใจก่อนว่าไม่ใช่การลาก */
      holdTimer = setTimeout(() => {
        if (moved < 8) { this.drag = null; this.mouse = p; this.invalidate(); }
      }, 260);
    }, { passive: true });

    cv.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) {
        const ratio = spread(e.touches) / (pinch.d || 1);
        // กางนิ้วออก = เห็นแท่งน้อยลง = ซูมเข้า
        this.view.count = Math.max(20, Math.min(600, Math.round(pinch.count / (ratio || 1))));
        this.invalidate();
        return;
      }
      if (e.touches.length !== 1) return;
      const p = rel(e.touches[0]);
      if (this.mouse) { this.mouse = p; this.invalidate(); return; }   // อยู่ในโหมดอ่านค่า
      if (!this.drag) return;
      moved = Math.max(moved, Math.abs(p.x - this.drag.x));
      if (moved >= 8) endHold();
      const bw = this.plot ? this.plot.barW : 6;
      this.view.offset = Math.max(0, Math.min(this.candles.length - 20, this.drag.offset + Math.round((p.x - this.drag.x) / bw)));
      this.invalidate();
    }, { passive: true });

    cv.addEventListener('touchend', (e) => {
      endHold();
      this.drag = null;
      if (e.touches.length < 2) pinch = null;
      /* ยกนิ้วแล้วเก็บเส้นเล็ง ไม่งั้นค้างบังกราฟจนกว่าจะแตะที่อื่น */
      if (this.mouse && e.touches.length === 0) {
        setTimeout(() => { this.mouse = null; this.invalidate(); }, 2200);
      }
    }, { passive: true });
    cv.addEventListener('touchcancel', () => { endHold(); this.drag = null; pinch = null; });
  }

  setData({ candles, ind, setup, position, markers, levels }) {
    // เปลี่ยนชุดข้อมูล (สลับกรอบเวลา/สัญลักษณ์) = ช่วงราคาคนละเรื่องกัน
    // ต้องรีเซ็ตค่าที่หน่วงไว้ ไม่งั้นกราฟจะไหลจากสเกลเก่าไปสเกลใหม่ให้เห็นเป็นการกวาดยาว ๆ
    if (candles && candles !== this.candles) {
      this.anim.min = null;
      this.anim.max = null;
      this.win = null;
    }
    if (candles) this.candles = candles;
    if (ind !== undefined) this.ind = ind;
    if (setup !== undefined) this.setup = setup;
    if (position !== undefined) this.position = position;
    if (markers !== undefined) this.markers = markers || [];
    if (levels !== undefined) this.levels = levels || [];
    this.invalidate();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.cv.getBoundingClientRect();
    this.cv.width = Math.max(320, r.width * dpr);
    this.cv.height = Math.max(280, r.height * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = r.width; this.H = r.height;
    this.invalidate();
  }

  /** ขอวาดใหม่ (ของเดิมเรียก render() อยู่หลายที่ จึงคงชื่อไว้) */
  render() { this.invalidate(); }

  _draw() {
    const g = this.g;
    if (!this.W) this.resize();
    const W = this.W, H = this.H;
    g.clearRect(0, 0, W, H);
    g.fillStyle = COL.bg;
    g.fillRect(0, 0, W, H);
    if (!this.candles.length) {
      g.fillStyle = COL.text; g.font = '14px system-ui'; g.textAlign = 'center';
      g.fillText('กำลังโหลดข้อมูล…', W / 2, H / 2);
      return;
    }

    const padR = 62, padL = 6, padT = 8, padB = 22;
    const sub = [];
    if (this.panels.volume) sub.push({ key: 'volume', h: 0.10 });
    if (this.panels.rsi) sub.push({ key: 'rsi', h: 0.15 });
    if (this.panels.macd) sub.push({ key: 'macd', h: 0.15 });
    const subTotal = sub.reduce((a, s) => a + s.h, 0);
    const usableH = H - padT - padB;
    const priceH = usableH * (1 - subTotal);

    const n = this.candles.length;
    if (!this.win || this.anim.min === null) { this._ease(); }
    const win = this.win || { start: Math.max(0, n - this.view.count), end: n, min: 0, max: 1 };
    const end = win.end;
    const start = win.start;
    const vis = this.candles.slice(start, end);
    const plotW = W - padL - padR;
    const barW = plotW / Math.max(1, vis.length);
    this.plot = { start, end, barW, padL, padR, padT, priceH, plotW };

    // ── สเกลราคา (ใช้ค่าที่หน่วงแล้ว จึงไม่กระโดดเวลาราคาทะลุกรอบเดิม) ──
    const min = this.anim.min, max = this.anim.max;
    const yP = (p) => padT + ((max - p) / (max - min)) * priceH;
    const xI = (i) => padL + (i - start + 0.5) * barW;
    this.yP = yP; this.xI = xI; this.min = min; this.max = max;

    // ── เส้นกริดและแกนราคา ──────────────────────────────────────────────
    g.font = '11px ui-monospace, monospace';
    g.textAlign = 'left';
    const steps = 6;
    for (let s = 0; s <= steps; s++) {
      const p = min + ((max - min) * s) / steps;
      const y = yP(p);
      g.strokeStyle = COL.grid; g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke();
      g.fillStyle = COL.text;
      g.fillText(p.toFixed(2), W - padR + 6, y + 3.5);
    }

    // ── Bollinger ───────────────────────────────────────────────────────
    if (this.ind && this.showBB) {
      this._line(this.ind.bb.upper, start, end, COL.bb, 1);
      this._line(this.ind.bb.lower, start, end, COL.bb, 1);
      this._line(this.ind.bb.mid, start, end, 'rgba(148,163,184,0.5)', 1, [4, 4]);
    }

    // ── แนวรับ/แนวต้าน ─────────────────────────────────────────────────
    if (this.showLevels && this.levels) {
      const drawn = [];
      for (const lv of this.levels) {
        if (lv.price < min || lv.price > max) continue;
        const y = yP(lv.price);
        g.strokeStyle = lv.type === 'support' ? COL.sup : COL.res;
        /* ถ้ามีไม้เปิดอยู่ ให้แนวรับ/ต้านจางลงเป็นพื้นหลัง
           เส้นที่มีเงินของจริงผูกอยู่ ต้องเด่นกว่าเส้นอ้างอิงเสมอ */
        g.globalAlpha = (this.position && this.position.entry > 0) ? 0.4 : 1;
        g.lineWidth = Math.min(2.5, 0.6 + lv.touches * 0.35);
        g.setLineDash([6, 5]);
        g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke();
        g.setLineDash([]);
        // ป้ายกำกับ: วางชิดขวา และข้ามป้ายที่จะทับกับป้ายก่อนหน้า
        if (drawn.some((yy) => Math.abs(yy - y) < 13)) continue;
        drawn.push(y);
        // ป้ายแนวรับ/ต้านวางชิดซ้าย ส่วนป้ายแผนเทรด (Entry/SL/TP) อยู่ชิดขวา จะได้ไม่ทับกัน
        g.fillStyle = lv.type === 'support' ? COL.sup : COL.res;
        g.font = '10px system-ui';
        g.fillText(`${lv.type === 'support' ? 'รับ' : 'ต้าน'} ${lv.price.toFixed(2)} · แตะ ${lv.touches} ครั้ง`, padL + 5, y - 3);
      }
      g.globalAlpha = 1;
    }

    // ── แท่งเทียน ───────────────────────────────────────────────────────
    // ปัดทุกพิกัดเป็นจำนวนเต็ม ไม่งั้นเบราว์เซอร์จะเกลี่ยขอบให้จาง-เข้มไม่เท่ากัน
    // ทำให้แถวแท่งเทียนดู "ขาด ๆ" ทั้งที่ข้อมูลครบ
    const bodyW = Math.max(1, Math.round(barW * 0.62));
    const wickW = Math.max(1, Math.round(barW * 0.14));
    for (let i = start; i < end; i++) {
      const c = this.candles[i];
      const xc = Math.round(xI(i));
      const up = c.c >= c.o;
      const yh = Math.round(yP(c.h)), yl = Math.round(yP(c.l));
      g.fillStyle = up ? COL.up : COL.down;
      g.fillRect(xc - Math.floor(wickW / 2), yh, wickW, Math.max(1, yl - yh));
      const yo = Math.round(yP(c.o)), yc2 = Math.round(yP(c.c));
      g.fillStyle = up ? COL.upFill : COL.downFill;
      g.fillRect(xc - Math.floor(bodyW / 2), Math.min(yo, yc2), bodyW, Math.max(1, Math.abs(yc2 - yo)));
    }

    // ── เส้นค่าเฉลี่ย ───────────────────────────────────────────────────
    if (this.ind) {
      this._line(this.ind.ema20, start, end, COL.ema20, 1.4);
      this._line(this.ind.ema50, start, end, COL.ema50, 1.4);
      this._line(this.ind.ema200, start, end, COL.ema200, 1.6);
      if (this.panels.vwap !== false) this._line(this.ind.vwap, start, end, COL.vwap, 1, [3, 3], (i) => this._newDay(i));
    }

    // ── แผนเทรดปัจจุบัน ────────────────────────────────────────────────
    /* มีไม้เปิดอยู่แล้ว ก็ไม่ต้องวาดแผน "ถ้าจะเข้า" ทับเข้ามาอีก
       สองชุดเส้นที่หมายถึงคนละเรื่องแต่หน้าตาคล้ายกัน ทำให้อ่านผิดได้ง่ายมาก
       และแผนก็ไม่มีประโยชน์แล้วสำหรับคนที่เข้าไปแล้ว */
    if (this.setup && !(this.position && this.position.entry > 0)) {
      const rows = [
        { p: this.setup.tp3, c: COL.tp, label: `TP3 ${this.setup.tp3.toFixed(2)}` },
        { p: this.setup.tp2, c: COL.tp, label: `TP2 ${this.setup.tp2.toFixed(2)}` },
        { p: this.setup.tp1, c: COL.tp, label: `TP1 ${this.setup.tp1.toFixed(2)}` },
        { p: this.setup.entry, c: COL.entry, label: `เข้า ${this.setup.entry.toFixed(2)}` },
        { p: this.setup.sl, c: COL.sl, label: `SL ${this.setup.sl.toFixed(2)}` },
      ];
      // แรเงาโซนกำไร/ขาดทุน
      const yEntry = yP(this.setup.entry);
      g.fillStyle = 'rgba(34,197,94,0.07)';
      g.fillRect(padL, Math.min(yEntry, yP(this.setup.tp2)), plotW, Math.abs(yP(this.setup.tp2) - yEntry));
      g.fillStyle = 'rgba(239,68,68,0.09)';
      g.fillRect(padL, Math.min(yEntry, yP(this.setup.sl)), plotW, Math.abs(yP(this.setup.sl) - yEntry));
      for (const r of rows) {
        if (r.p < min || r.p > max) continue;
        const y = yP(r.p);
        g.strokeStyle = r.c; g.lineWidth = 1; g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke();
        g.setLineDash([]);
        g.fillStyle = r.c; g.font = '10px ui-monospace, monospace';
        g.textAlign = 'right';
        g.fillText(r.label, W - padR - 4, y - 3);
        g.textAlign = 'left';
      }
    }

    /*
     * ── ไม้ที่ถืออยู่จริง ────────────────────────────────────────────────
     *
     * วาดทับแผนเสมอ และเด่นกว่าแผนชัดเจน เพราะแผนคือ "ถ้าเข้า" ส่วนอันนี้
     * คือเงินที่อยู่ในตลาดแล้ว สองอย่างนี้ต้องแยกออกจากกันด้วยตาในแวบเดียว
     *
     * รูปแบบป้ายทำตามที่ผู้ใช้ยกตัวอย่างมา: [ขนาด] [กำไร/ขาดทุนที่เส้นนั้น] [×]
     * ตัวเลขบนป้าย SL/TP คือ "จะได้/เสียเท่าไรถ้าราคามาถึงเส้นนี้"
     * ส่วนป้ายที่เส้นเข้าคือกำไรขาดทุน ณ ราคาปัจจุบัน
     */
    this.posHit = null;
    if (this.position && this.position.entry > 0) {
      const P = this.position;
      const unit = (P.size || 0) * (P.contractSize || 0);
      const px = this.candles.length ? this.candles[this.candles.length - 1].c : P.entry;
      const plAt = (price) => (price - P.entry) * P.side * unit;
      const fmt = (v) => `${v >= 0 ? '+' : '−'} ${Math.abs(v).toFixed(2)} USD`;
      const size = P.size % 1 === 0 ? String(P.size) : String(P.size);

      const rows = [];
      if (P.tp > 0) rows.push({ p: P.tp, col: COL.tp, txt: fmt(plAt(P.tp)) });
      rows.push({ p: P.entry, col: '#4a8fd4', txt: fmt(plAt(px)), now: true });
      if (P.sl > 0) rows.push({ p: P.sl, col: '#e0913d', txt: fmt(plAt(P.sl)) });

      // เส้นตั้งเชื่อม SL → เข้า → เป้า ให้เห็นว่าไม้นี้กินช่วงราคาแค่ไหน
      const ys = rows.filter((r) => r.p >= min && r.p <= max).map((r) => yP(r.p));
      if (ys.length > 1) {
        const xv = W - padR - 10;
        g.strokeStyle = 'rgba(74,143,212,.55)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(xv, Math.min(...ys)); g.lineTo(xv, Math.max(...ys)); g.stroke();
      }

      /*
       * ป้ายห้ามทับกัน
       *
       * ตอนราคาเข้ากับ SL ห่างกันไม่กี่ดอลลาร์ (ซึ่งเป็นเรื่องปกติของกรอบ 15 นาที)
       * เส้นสองเส้นจะห่างกันไม่ถึงความสูงป้าย ป้ายเลยซ้อนกันจนอ่านไม่ออกทั้งคู่
       * ดันป้ายออกจากกันตามแนวตั้ง โดยที่ "เส้น" ยังอยู่ที่ราคาจริงเสมอ
       */
      const LH = 22;
      const vis = rows.filter((r) => r.p >= min && r.p <= max).map((r) => ({ ...r, y: yP(r.p), ly: yP(r.p) }));
      vis.sort((a, b) => a.y - b.y);
      for (let k = 1; k < vis.length; k++) {
        if (vis[k].ly - vis[k - 1].ly < LH) vis[k].ly = vis[k - 1].ly + LH;
      }
      // ถ้าดันแล้วล้นขอบล่าง ให้ยกกลับขึ้นมาทั้งชุด
      const over = vis.length ? vis[vis.length - 1].ly - (padT + priceH - 12) : 0;
      if (over > 0) vis.forEach((v) => { v.ly -= over; });

      for (const r of vis) {
        const y = r.y;
        g.strokeStyle = r.col; g.lineWidth = r.now ? 1.6 : 1.2; g.setLineDash([]);
        g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR - 10, y); g.stroke();

        // จุดกลมตรงปลายเส้น เหมือนหมุดหมายบนกราฟของโบรกเกอร์
        g.fillStyle = r.now ? r.col : '#0b1020';
        g.beginPath(); g.arc(W - padR - 10, y, 3.5, 0, Math.PI * 2);
        g.fill(); g.strokeStyle = r.col; g.stroke();

        /* ป้าย: กล่องขนาด + ข้อความ + ปุ่มกากบาท
           วางชิดขวาแต่ไม่ทับแกนราคา เพื่อให้ยังอ่านราคาที่แกนได้ */
        g.font = '11px ui-monospace, monospace';
        const tw = g.measureText(r.txt).width;
        const sw = g.measureText(size).width + 12;
        const boxW = sw + tw + 12 + 18;
        const boxH = 19;
        const bx = W - padR - 16 - boxW;
        const by = r.ly - boxH / 2;

        g.fillStyle = 'rgba(11,16,32,.92)';
        g.strokeStyle = r.col; g.lineWidth = 1.2;
        roundRect(g, bx, by, boxW, boxH, 4); g.fill(); g.stroke();

        // ช่องขนาดไม้ (พื้นทึบ) แยกจากตัวเลขเงินให้อ่านง่าย
        g.fillStyle = r.col;
        roundRect(g, bx, by, sw, boxH, 4); g.fill();
        g.fillStyle = '#0b1020'; g.textAlign = 'center';
        g.fillText(size, bx + sw / 2, r.ly + 3.5);

        g.fillStyle = r.col; g.textAlign = 'left';
        g.fillText(r.txt, bx + sw + 6, r.ly + 3.5);

        // ปุ่มปิด — เก็บกรอบไว้ให้แตะได้จริง ไม่ใช่วาดไว้เฉย ๆ ให้เข้าใจผิด
        const cx = bx + boxW - 11, cyy = r.ly;
        g.strokeStyle = r.col; g.lineWidth = 1.3;
        g.beginPath(); g.moveTo(cx - 3.5, cyy - 3.5); g.lineTo(cx + 3.5, cyy + 3.5);
        g.moveTo(cx + 3.5, cyy - 3.5); g.lineTo(cx - 3.5, cyy + 3.5); g.stroke();
        if (r.now) this.posHit = { x: cx - 11, y: cyy - 11, w: 22, h: 22 };

        /* ถ้าป้ายถูกดันออกจากเส้น ลากเส้นบาง ๆ โยงไว้ ไม่งั้นไม่รู้ว่าป้ายไหนของเส้นไหน */
        if (Math.abs(r.ly - y) > 2) {
          g.strokeStyle = r.col; g.lineWidth = 0.8; g.setLineDash([2, 2]);
          g.beginPath(); g.moveTo(bx + boxW, r.ly); g.lineTo(W - padR - 10, y); g.stroke();
          g.setLineDash([]);
        }

        /* ป้ายราคาที่แกนขวา — ข้ามถ้าจะไปทับป้ายราคาปัจจุบัน
           ราคาปัจจุบันสำคัญกว่า และตัวเลขของเส้นนี้ก็อ่านได้จากป้ายทางซ้ายอยู่แล้ว
           คิดตำแหน่งตรงนี้เอง ไม่รอค่าจากบล็อกราคาปัจจุบันซึ่งวาดทีหลัง
           (ถ้าไปอ่านค่าที่นั่น จะได้ตำแหน่งของเฟรมก่อน และเฟรมแรกจะไม่มีค่าเลย) */
        const yNow = yP(px);
        if (Math.abs(yNow - y) >= 15) {
          g.fillStyle = r.col;
          roundRect(g, W - padR + 1, y - 8, padR - 3, 16, 3); g.fill();
          g.fillStyle = '#0b1020'; g.textAlign = 'left';
          g.fillText(r.p.toFixed(2), W - padR + 4, y + 3.5);
        }
        g.textAlign = 'left';
      }
    }

    // ── จุดสัญญาณย้อนหลัง ───────────────────────────────────────────────
    for (const m of this.markers) {
      if (m.index < start || m.index >= end) continue;
      const c = this.candles[m.index];
      const x = xI(m.index);
      const y = m.side > 0 ? yP(c.l) + 12 : yP(c.h) - 12;
      g.fillStyle = m.side > 0 ? COL.up : COL.down;
      g.beginPath();
      if (m.side > 0) { g.moveTo(x, y - 9); g.lineTo(x - 5, y); g.lineTo(x + 5, y); }
      else { g.moveTo(x, y + 9); g.lineTo(x - 5, y); g.lineTo(x + 5, y); }
      g.closePath(); g.fill();
    }

    // ── เส้นราคาปัจจุบัน ────────────────────────────────────────────────
    const last = this.candles[n - 1];
    const yLast = yP(last.c);
    if (yLast > padT && yLast < padT + priceH) {
      g.strokeStyle = last.c >= last.o ? COL.up : COL.down;
      g.setLineDash([5, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, yLast); g.lineTo(W - padR, yLast); g.stroke();
      g.setLineDash([]);
      g.fillStyle = last.c >= last.o ? COL.up : COL.down;
      g.fillRect(W - padR + 2, yLast - 8, padR - 4, 16);
      g.fillStyle = '#0b1020'; g.font = 'bold 11px ui-monospace, monospace';
      g.fillText(last.c.toFixed(2), W - padR + 5, yLast + 3.5);
    }

    // ── แผงย่อย ────────────────────────────────────────────────────────
    let y0 = padT + priceH;
    for (const s of sub) {
      const h = usableH * s.h;
      this._drawSub(s.key, y0, h, start, end, padL, W - padR);
      y0 += h;
    }

    // ── แกนเวลา ────────────────────────────────────────────────────────
    g.fillStyle = COL.text; g.font = '10px system-ui'; g.textAlign = 'center';
    // จำนวนป้ายต้องคิดจากความกว้างที่มีจริง ไม่ใช่ตั้งไว้ตายตัว 7 ป้าย
    // จอแคบ ๆ ป้าย 7 อันจะทับกันจนอ่านไม่ออก
    const sample = new Date(this.candles[start].t)
      .toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const lblW = g.measureText(sample).width + 18;   // เผื่อช่องไฟกันชนกัน
    const maxLabels = Math.max(2, Math.floor(plotW / lblW));
    const tickEvery = Math.max(1, Math.ceil(vis.length / maxLabels));
    let lastRight = -Infinity;
    for (let i = start; i < end; i += tickEvery) {
      const d = new Date(this.candles[i].t);
      const lbl = d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const w = g.measureText(lbl).width;
      const x = Math.max(padL + w / 2, Math.min(W - padR - w / 2, xI(i)));
      if (x - w / 2 < lastRight + 8) continue;   // กันป้ายที่จะทับป้ายก่อนหน้า
      lastRight = x + w / 2;
      g.fillText(lbl, x, H - 7);
    }
    g.textAlign = 'left';

    if (this.mouse) this._crosshair(padL, W - padR, padT, H - padB);
  }

  /**
   * @param {(i:number)=>boolean} breakAt คืน true ตรงจุดที่ต้อง "ยกปากกา"
   *   ใช้กับเส้นที่รีเซ็ตค่าเป็นช่วง ๆ เช่น VWAP ที่เริ่มนับใหม่ทุกวัน
   *   ถ้าลากพาดข้ามรอยต่อ จะได้เส้นดิ่งที่ไม่มีอยู่จริงบนกราฟ
   */
  _line(series, start, end, color, width = 1, dash = null, breakAt = null) {
    const g = this.g;
    g.strokeStyle = color; g.lineWidth = width;
    if (dash) g.setLineDash(dash);
    g.beginPath();
    let started = false;
    for (let i = start; i < end; i++) {
      const v = series[i];
      if (!Number.isFinite(v)) { started = false; continue; }
      if (started && breakAt && breakAt(i)) started = false;
      const x = this.xI(i), y = this.yP(v);
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.stroke();
    if (dash) g.setLineDash([]);
  }

  /** VWAP เริ่มนับใหม่ทุกวัน (เวลา UTC) — ตรงรอยต่อวันต้องไม่ลากเส้นเชื่อม */
  _newDay(i) {
    const a = this.candles[i - 1], b = this.candles[i];
    if (!a || !b) return false;
    return new Date(a.t).getUTCDate() !== new Date(b.t).getUTCDate();
  }

  /*
   * ค่าที่ "ไม่มี" ในชุดตัวชี้วัดมาได้สามแบบ: null (ยังคำนวณไม่ได้),
   * undefined (ดัชนีเกินความยาวของชุด) และ NaN (คำนวณแล้วพัง)
   *
   * โค้ดเดิมเช็กแค่ null ตัว undefined จึงหลุดผ่านไปเรียก .toFixed แล้วโยน error
   * เกิดจริงตอนข้อมูลอัปเดต: แท่งเทียนยาวขึ้นก่อนที่ตัวชี้วัดจะคำนวณเสร็จ
   * ชั่วขณะนั้นดัชนีสุดท้ายของแท่งจึงเกินความยาวของ rsi อยู่ไม่กี่มิลลิวินาที
   * ตรวจพบตอนไล่กดหน้าเว็บจริง — โยนออกมา 40 ครั้งในการใช้งานปกติ
   *
   * Number.isFinite ครอบทั้งสามแบบในเงื่อนไขเดียว จึงใช้ตัวนี้ทุกที่แทน
   */
  _drawSub(key, top, h, start, end, x0, x1) {
    const g = this.g;
    g.strokeStyle = COL.grid;
    g.beginPath(); g.moveTo(x0, top); g.lineTo(x1, top); g.stroke();
    g.fillStyle = COL.text; g.font = '10px system-ui';
    const inner = h - 10;
    const barW = this.plot.barW;

    if (key === 'volume') {
      let vmax = 0;
      for (let i = start; i < end; i++) vmax = Math.max(vmax, this.candles[i].v);
      for (let i = start; i < end; i++) {
        const c = this.candles[i];
        const bh = vmax ? (c.v / vmax) * inner : 0;
        g.fillStyle = c.c >= c.o ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)';
        const vw = Math.max(1, Math.round(barW * 0.62));
        g.fillRect(Math.round(this.xI(i)) - Math.floor(vw / 2), Math.round(top + h - bh - 4), vw, Math.max(1, Math.round(bh)));
      }
      g.fillStyle = COL.text; g.fillText('Volume', x0 + 4, top + 11);
      return;
    }

    if (key === 'rsi' && this.ind) {
      const y = (v) => top + 6 + ((100 - v) / 100) * inner;
      for (const lvl of [70, 50, 30]) {
        g.strokeStyle = lvl === 50 ? COL.grid : 'rgba(148,163,184,0.25)';
        g.setLineDash(lvl === 50 ? [] : [3, 4]);
        g.beginPath(); g.moveTo(x0, y(lvl)); g.lineTo(x1, y(lvl)); g.stroke();
        g.setLineDash([]);
        g.fillStyle = COL.text; g.fillText(String(lvl), x1 + 4, y(lvl) + 3);
      }
      g.strokeStyle = '#c084fc'; g.lineWidth = 1.3; g.beginPath();
      let st = false;
      for (let i = start; i < end; i++) {
        const v = this.ind.rsi[i];
        if (!Number.isFinite(v)) { st = false; continue; }
        const px = this.xI(i), py = y(v);
        if (!st) { g.moveTo(px, py); st = true; } else g.lineTo(px, py);
      }
      g.stroke();
      const lastRsi = this.ind.rsi[end - 1];
      g.fillStyle = COL.text;
      g.fillText(`RSI(14) ${Number.isFinite(lastRsi) ? lastRsi.toFixed(1) : '-'}`, x0 + 4, top + 11);
      return;
    }

    if (key === 'macd' && this.ind) {
      let mmax = 1e-9;
      for (let i = start; i < end; i++) {
        for (const v of [this.ind.macd.line[i], this.ind.macd.signal[i], this.ind.macd.hist[i]]) {
          if (Number.isFinite(v)) mmax = Math.max(mmax, Math.abs(v));
        }
      }
      const y = (v) => top + 6 + inner / 2 - (v / mmax) * (inner / 2);
      g.strokeStyle = COL.grid; g.beginPath(); g.moveTo(x0, y(0)); g.lineTo(x1, y(0)); g.stroke();
      for (let i = start; i < end; i++) {
        const hv = this.ind.macd.hist[i];
        if (!Number.isFinite(hv)) continue;
        const prev = this.ind.macd.hist[i - 1];
        const rising = !Number.isFinite(prev) ? true : hv > prev;
        g.fillStyle = hv >= 0 ? (rising ? 'rgba(34,197,94,0.8)' : 'rgba(34,197,94,0.35)')
                              : (rising ? 'rgba(239,68,68,0.35)' : 'rgba(239,68,68,0.8)');
        const yy = y(hv), y0v = y(0);
        g.fillRect(this.xI(i) - barW * 0.28, Math.min(yy, y0v), Math.max(1, barW * 0.56), Math.abs(yy - y0v));
      }
      const drawL = (series, color) => {
        g.strokeStyle = color; g.lineWidth = 1.2; g.beginPath();
        let st = false;
        for (let i = start; i < end; i++) {
          const v = series[i];
          if (!Number.isFinite(v)) { st = false; continue; }
          const px = this.xI(i), py = y(v);
          if (!st) { g.moveTo(px, py); st = true; } else g.lineTo(px, py);
        }
        g.stroke();
      };
      drawL(this.ind.macd.line, '#38bdf8');
      drawL(this.ind.macd.signal, '#fb923c');
      g.fillStyle = COL.text; g.fillText('MACD(12,26,9)', x0 + 4, top + 11);
    }
  }

  _crosshair(x0, x1, y0, y1) {
    const g = this.g;
    const { x, y } = this.mouse;
    if (x < x0 || x > x1) return;
    const i = Math.round((x - this.plot.padL) / this.plot.barW - 0.5) + this.plot.start;
    if (i < 0 || i >= this.candles.length) return;
    const c = this.candles[i];
    g.strokeStyle = COL.cross; g.setLineDash([3, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(this.xI(i), y0); g.lineTo(this.xI(i), y1); g.stroke();
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.setLineDash([]);

    const price = this.min + ((y1 - y - (y1 - y0) * 0) / 1) * 0; // ป้ายราคาตามแกน Y
    const yy = Math.max(this.plot.padT, Math.min(this.plot.padT + this.plot.priceH, y));
    const pv = this.max - ((yy - this.plot.padT) / this.plot.priceH) * (this.max - this.min);
    g.fillStyle = 'rgba(226,232,240,0.9)';
    g.fillRect(x1 + 2, yy - 8, 58, 16);
    g.fillStyle = '#0b1020'; g.font = '11px ui-monospace, monospace';
    g.fillText(pv.toFixed(2), x1 + 5, yy + 3.5);
    void price;

    // กล่องข้อมูลแท่ง
    const txt = [
      new Date(c.t).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }),
      `O ${c.o.toFixed(2)}  H ${c.h.toFixed(2)}`,
      `L ${c.l.toFixed(2)}  C ${c.c.toFixed(2)}`,
      `เปลี่ยน ${(((c.c - c.o) / c.o) * 100).toFixed(2)}%`,
    ];
    if (this.ind && Number.isFinite(this.ind.rsi[i])) txt.push(`RSI ${this.ind.rsi[i].toFixed(1)}`);
    g.font = '11px system-ui';
    const w = Math.max(...txt.map((t) => g.measureText(t).width)) + 14;
    const bx = Math.min(x + 12, x1 - w), by = Math.max(y0 + 4, y - 70);
    g.fillStyle = 'rgba(2,6,23,0.92)';
    g.strokeStyle = 'rgba(148,163,184,0.3)';
    g.beginPath(); g.roundRect(bx, by, w, txt.length * 15 + 10, 6); g.fill(); g.stroke();
    g.fillStyle = COL.textStrong;
    txt.forEach((t, k) => g.fillText(t, bx + 7, by + 18 + k * 15));
  }

  /** กรอบปุ่มปิดไม้บนกราฟ (พิกัด CSS pixel เทียบมุมบนซ้ายของ canvas) — null = ไม่มีไม้เปิดอยู่ */
  closeButtonBox() { return this.posHit ? { ...this.posHit } : null; }

  scrollToEnd() { this.view.offset = 0; this.invalidate(); }
}
