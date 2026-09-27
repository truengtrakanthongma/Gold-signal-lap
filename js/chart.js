/**
 * chart.js — กราฟแท่งเทียนวาดเองบน Canvas (ไม่พึ่งไลบรารีภายนอก)
 *
 * วาดเฉพาะสิ่งที่กติกาใช้จริง: แท่งเทียน · เส้นค่าเฉลี่ย · แผนเทรด · ไม้ที่ถืออยู่
 * และจุดเข้า-ออกของทุกไม้ที่ระบบเคยเทรดในช่วงที่มองเห็น — ให้ตรวจด้วยตาได้ว่า
 * ระบบทำอะไรไปบ้าง ไม่ใช่แค่เชื่อตัวเลขสรุป
 *
 * ท่าสัมผัสบนมือถือ (ชุดเดียวกับแอปกราฟทั่วไป):
 *   นิ้วเดียวลาก = เลื่อน · แตะค้าง = อ่านค่าแท่ง · สองนิ้ว = ซูม
 *   แตะสองครั้ง = กลับมุมมองเดิม · ลากที่แถบราคาด้านขวา = ยืด/บีบแกนราคา
 */

const AXIS_W = 64;       // ความกว้างแถบราคาด้านขวา (ใช้ทั้งวาดและตรวจโซนที่นิ้วแตะ)
const TIME_H = 22;       // ความสูงแถบเวลาด้านล่าง
const TH_OFFSET = 7 * 3600000;
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

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

/** อ่านสีจากตัวแปร CSS — เปลี่ยนธีมแล้วกราฟเปลี่ยนตามโดยไม่ต้องแก้โค้ดตรงนี้ */
function readColors() {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const v = (name, fb) => (cs && cs.getPropertyValue(name).trim()) || fb;
  return {
    grid: v('--chart-grid', 'rgba(148,163,184,.10)'),
    text: v('--text-3', '#8a93a6'),
    textStrong: v('--text', '#e8ebf2'),
    up: v('--up', '#2bb673'), down: v('--down', '#e5484d'),
    ema: v('--brand', '#d4a72c'),
    entry: v('--text', '#e8ebf2'), stop: v('--down', '#e5484d'), target: v('--up', '#2bb673'),
    pos: v('--accent', '#5b9bd5'),
    bg: v('--surface', '#0f141e'),
    cross: v('--text-3', '#8a93a6'),
  };
}

export class Chart {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.candles = [];
    this.lines = [];
    this.plan = null;
    this.position = null;
    this.trades = [];
    this.tfMs = 4 * 3600000;
    this.defaultCount = 90;
    this.view = { count: this.defaultCount, offset: 0, priceZoom: 1 };
    this.mouse = null;
    this.drag = null;
    this.axisDrag = null;
    this.anim = { min: null, max: null, count: null };
    this.needsDraw = true;
    this.col = readColors();
    this.onView = null;     // แจ้งหน้าจอว่าผู้ใช้เลื่อนออกจากแท่งล่าสุดหรือยัง
    this.reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._bind();
    this._raf();
  }

  setTheme() { this.col = readColors(); this.invalidate(); }
  invalidate() { this.needsDraw = true; }

  setData({ candles, lines, plan, position, trades, tfMs } = {}) {
    if (candles !== undefined) {
      /* แท่งใหม่เข้ามาระหว่างที่ผู้ใช้เลื่อนดูของเก่า — ดันมุมมองตาม ไม่งั้นภาพจะเลื่อนเอง */
      if (this.candles.length && candles.length > this.candles.length && this.view.offset > 0) {
        this.view.offset += candles.length - this.candles.length;
      }
      this.candles = candles;
    }
    if (lines !== undefined) this.lines = lines || [];
    if (plan !== undefined) this.plan = plan;
    if (position !== undefined) this.position = position;
    if (trades !== undefined) this.trades = trades || [];
    if (tfMs !== undefined && tfMs !== this.tfMs) { this.tfMs = tfMs; this.anim.min = null; }
    this.invalidate();
  }

  reset(count) {
    if (count) this.defaultCount = count;
    this.view = { count: this.defaultCount, offset: 0, priceZoom: 1 };
    this.mouse = null;
    this.invalidate();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.cv.width = Math.round(r.width * dpr);
    this.cv.height = Math.round(r.height * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = r.width; this.H = r.height;
    this.invalidate();
  }

  /* ── วงจรวาด: ยกธงเมื่อข้อมูลเปลี่ยน แล้ววาดครั้งเดียวต่อเฟรม ───────── */
  _raf() {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => this._raf());
    const moving = this._ease();
    if (moving || this.needsDraw) { this.needsDraw = false; this._draw(); }
  }

  _window() {
    const n = this.candles.length;
    const count = Math.max(15, Math.round(this.anim.count === null ? this.view.count : this.anim.count));
    const end = Math.max(Math.min(15, n), n - this.view.offset);
    const start = Math.max(0, end - count);
    let lo = Infinity, hi = -Infinity;
    for (let i = start; i < end; i++) { const c = this.candles[i]; if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
    const add = (v) => { if (Number.isFinite(v) && v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    for (const L of this.lines) for (let i = start; i < end; i++) add(L.values[i]);
    /* แผนกับไม้ที่ถืออยู่ต้องอยู่ในกรอบเสมอ ไม่งั้นคนถือไม้มองไม่เห็นว่า SL อยู่ตรงไหน */
    if (this.plan && this.view.offset === 0) [this.plan.entry, this.plan.stop, this.plan.target].forEach(add);
    if (this.position) [this.position.entry, this.position.sl, this.position.tp].forEach(add);
    if (!Number.isFinite(lo)) return null;
    const pad = (hi - lo) * 0.07 || 1;
    lo -= pad; hi += pad;
    const z = this.view.priceZoom || 1;
    if (z !== 1 && end > 0) {
      /* ยืดรอบราคาล่าสุด ไม่ใช่รอบกึ่งกลาง — ราคาปัจจุบันคือจุดที่สายตาจ้องอยู่ */
      const a = Math.min(hi, Math.max(lo, this.candles[end - 1].c));
      lo = a - (a - lo) / z; hi = a + (hi - a) / z;
    }
    return { lo, hi, start, end };
  }

  _ease() {
    if (!this.candles.length || !this.W) return false;
    if (this.anim.count === null) this.anim.count = this.view.count;
    const k = this.reduce ? 1 : 0.25;
    let moving = false;
    const dc = this.view.count - this.anim.count;
    if (Math.abs(dc) > 0.4) { this.anim.count += dc * k; moving = true; } else this.anim.count = this.view.count;
    const w = this._window();
    if (!w) return moving;
    this.win = w;
    if (this.anim.min === null) { this.anim.min = w.lo; this.anim.max = w.hi; }
    const span = Math.max(1e-9, w.hi - w.lo);
    const d1 = w.lo - this.anim.min, d2 = w.hi - this.anim.max;
    if (Math.abs(d1) > span * 0.0005 || Math.abs(d2) > span * 0.0005) {
      this.anim.min += d1 * k; this.anim.max += d2 * k; moving = true;
    } else { this.anim.min = w.lo; this.anim.max = w.hi; }
    return moving;
  }

  /* ── วาด ─────────────────────────────────────────────────────────── */
  _draw() {
    const g = this.g, W = this.W, H = this.H, C = this.col;
    if (!W || !H) return;
    g.clearRect(0, 0, W, H);
    const w = this.win;
    if (!this.candles.length || !w) {
      g.fillStyle = C.text; g.font = '13px "IBM Plex Sans Thai", system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText('กำลังโหลดกราฟ…', W / 2, H / 2);
      return;
    }
    const plotW = W - AXIS_W, plotH = H - TIME_H, padT = 10;
    const lo = this.anim.min, hi = this.anim.max;
    const y = (p) => padT + (1 - (p - lo) / (hi - lo)) * (plotH - padT * 2);
    const count = Math.max(15, Math.round(this.anim.count));
    const barW = plotW / count;
    const x = (i) => (i - (w.end - count)) * barW + barW / 2;
    this.plot = { barW };

    // เส้นตาราง + ป้ายราคา
    g.font = '11px "JetBrains Mono", ui-monospace, monospace';
    g.textBaseline = 'middle';
    const step = niceStep((hi - lo) / 6);
    g.strokeStyle = C.grid; g.lineWidth = 1; g.fillStyle = C.text; g.textAlign = 'left';
    for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
      const yy = Math.round(y(p)) + 0.5;
      if (yy < 4 || yy > plotH - 4) continue;
      g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke();
      g.fillText(p.toFixed(step < 1 ? 2 : 0), plotW + 8, yy);
    }
    // เส้นแบ่งวัน/เดือนตามเวลาไทย + ป้ายวันที่
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    let lastLabelX = -1e9;
    const daily = this.tfMs >= 86400000;
    for (let i = Math.max(w.start, 1); i < w.end; i++) {
      const a = this.candles[i - 1].t, b = this.candles[i].t;
      const boundary = daily ? thMonth(a) !== thMonth(b) : thDay(a) !== thDay(b);
      if (!boundary) continue;
      const xx = Math.round(x(i) - barW / 2) + 0.5;
      g.strokeStyle = C.grid; g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, plotH); g.stroke();
      if (xx - lastLabelX > 58 && xx > 26 && xx < plotW - 24) {
        g.fillStyle = C.text;
        g.fillText(daily ? thMonthLabel(b) : thDateLabel(b), xx, H - 6);
        lastLabelX = xx;
      }
    }

    g.save();
    g.beginPath(); g.rect(0, 0, plotW, plotH); g.clip();

    // โซนของแผน (เข้า→เป้า เขียวจาง · เข้า→SL แดงจาง) ยื่นจากแท่งล่าสุดไปทางขวา
    if (this.plan && this.view.offset === 0) {
      const P = this.plan, x0 = Math.max(0, x(w.end - 1) - barW / 2);
      g.globalAlpha = 0.10;
      g.fillStyle = C.target; g.fillRect(x0, Math.min(y(P.entry), y(P.target)), plotW - x0, Math.abs(y(P.target) - y(P.entry)));
      g.fillStyle = C.stop; g.fillRect(x0, Math.min(y(P.entry), y(P.stop)), plotW - x0, Math.abs(y(P.stop) - y(P.entry)));
      g.globalAlpha = 1;
    }

    // ไม้ของระบบ: เส้นประจากจุดเข้าไปจุดออก สีตามผล
    for (const t of this.trades) {
      const exitI = t.exitIndex === undefined ? w.end - 1 : t.exitIndex;
      if (exitI < w.start || t.entryIndex >= w.end) continue;
      const xe = x(t.entryIndex), ye = y(t.entry);
      const xo = x(exitI), yo = t.exitIndex === undefined ? y(this.candles[w.end - 1].c) : y(t.exit);
      const good = t.exitIndex === undefined ? (t.rNow || 0) > 0 : t.r > 0;
      g.strokeStyle = good ? C.up : C.down; g.lineWidth = 1.4; g.setLineDash([4, 3]); g.globalAlpha = 0.9;
      g.beginPath(); g.moveTo(xe, ye); g.lineTo(xo, yo); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
      const bar = this.candles[t.entryIndex];
      if (bar) triangle(g, xe, t.side > 0 ? y(bar.l) + 11 : y(bar.h) - 11, t.side, t.side > 0 ? C.up : C.down);
      if (t.exitIndex !== undefined) { g.fillStyle = good ? C.up : C.down; g.beginPath(); g.arc(xo, yo, 3, 0, Math.PI * 2); g.fill(); }
    }

    // แท่งเทียน
    const bw = Math.max(1, Math.min(14, barW * 0.7));
    for (let i = w.start; i < w.end; i++) {
      const c = this.candles[i], xx = x(i), up = c.c >= c.o;
      g.strokeStyle = up ? C.up : C.down; g.fillStyle = up ? C.up : C.down; g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(xx) + 0.5, y(c.h)); g.lineTo(Math.round(xx) + 0.5, y(c.l)); g.stroke();
      const top = y(Math.max(c.o, c.c)), hgt = Math.max(1, Math.abs(y(c.o) - y(c.c)));
      if (c.closed === false) g.globalAlpha = 0.55;   // แท่งที่ยังไม่ปิด วาดจางไว้ให้รู้ว่ายังเปลี่ยนได้
      g.fillRect(Math.round(xx - bw / 2), Math.round(top), Math.max(1, Math.round(bw)), Math.round(hgt));
      g.globalAlpha = 1;
    }

    // เส้นค่าเฉลี่ย
    for (const L of this.lines) {
      g.strokeStyle = L.color || C.ema; g.lineWidth = L.width || 1.8; g.setLineDash(L.dash || []);
      g.beginPath(); let on = false;
      for (let i = w.start; i < w.end; i++) {
        const v = L.values[i];
        if (!Number.isFinite(v)) { on = false; continue; }
        if (!on) { g.moveTo(x(i), y(v)); on = true; } else g.lineTo(x(i), y(v));
      }
      g.stroke(); g.setLineDash([]);
    }
    g.restore();

    // เส้นแผน / ไม้ที่ถืออยู่ + ป้ายบนแถบราคา
    const levels = [];
    if (this.plan && this.view.offset === 0) {
      levels.push({ p: this.plan.target, c: C.target, t: 'ทำกำไร' },
        { p: this.plan.entry, c: C.entry, t: this.plan.side > 0 ? 'ซื้อ' : 'ขาย' },
        { p: this.plan.stop, c: C.stop, t: 'ตัดขาดทุน' });
    }
    if (this.position) {
      const P = this.position;
      if (P.tp > 0) levels.push({ p: P.tp, c: C.target, t: 'TP คุณ', dash: [2, 3] });
      if (P.entry > 0) levels.push({ p: P.entry, c: C.pos, t: 'ไม้คุณ', dash: [2, 3] });
      if (P.sl > 0) levels.push({ p: P.sl, c: C.stop, t: 'SL คุณ', dash: [2, 3] });
    }
    for (const L of levels) {
      const yy = y(L.p);
      if (yy < 0 || yy > plotH) { this._offscreen(L, yy < 0, plotW, plotH); continue; }
      g.strokeStyle = L.c; g.lineWidth = 1.2; g.setLineDash(L.dash || [6, 4]);
      g.beginPath(); g.moveTo(0, Math.round(yy) + 0.5); g.lineTo(plotW, Math.round(yy) + 0.5); g.stroke(); g.setLineDash([]);
      g.font = '600 11px "IBM Plex Sans Thai", system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
      const label = `${L.t} ${L.p.toFixed(2)}`;
      const tw = g.measureText(label).width + 14;
      g.fillStyle = C.bg; g.globalAlpha = 0.92; roundRect(g, 6, yy - 10, tw, 20, 6); g.fill(); g.globalAlpha = 1;
      g.strokeStyle = L.c; g.lineWidth = 1; roundRect(g, 6, yy - 10, tw, 20, 6); g.stroke();
      g.fillStyle = L.c; g.fillText(label, 13, yy + 0.5);
      this._pill(L.p, L.c, plotW, yy);
    }

    // ราคาล่าสุด
    const last = this.candles[this.candles.length - 1];
    if (last && this.view.offset === 0) {
      const yy = y(last.c);
      if (yy >= 0 && yy <= plotH) {
        const col = last.c >= last.o ? C.up : C.down;
        g.strokeStyle = col; g.globalAlpha = 0.55; g.setLineDash([2, 2]);
        g.beginPath(); g.moveTo(0, Math.round(yy) + 0.5); g.lineTo(plotW, Math.round(yy) + 0.5); g.stroke();
        g.setLineDash([]); g.globalAlpha = 1;
        this._pill(last.c, col, plotW, yy, true);
      }
    }

    // เส้นเล็ง + กล่องข้อมูลแท่ง
    if (this.mouse && this.mouse.x < plotW && this.mouse.y < plotH) {
      const i = Math.max(w.start, Math.min(w.end - 1, Math.floor(w.end - count + this.mouse.x / barW)));
      const c = this.candles[i];
      if (c) {
        const xx = Math.round(x(i)) + 0.5;
        g.strokeStyle = C.cross; g.setLineDash([3, 3]); g.lineWidth = 1;
        g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, plotH); g.moveTo(0, this.mouse.y); g.lineTo(plotW, this.mouse.y); g.stroke();
        g.setLineDash([]);
        const py = lo + (1 - (this.mouse.y - padT) / (plotH - padT * 2)) * (hi - lo);
        this._pill(py, C.text, plotW, this.mouse.y);
        const rows = [thFull(c.t), `เปิด ${c.o.toFixed(2)}  สูง ${c.h.toFixed(2)}`, `ต่ำ ${c.l.toFixed(2)}  ปิด ${c.c.toFixed(2)}`];
        for (const L of this.lines) if (Number.isFinite(L.values[i])) rows.push(`${L.label} ${L.values[i].toFixed(2)}`);
        g.font = '12px "JetBrains Mono", ui-monospace, monospace';
        const bwBox = Math.max(...rows.map((r) => g.measureText(r).width)) + 20, bhBox = rows.length * 18 + 12;
        const bx = this.mouse.x > plotW / 2 ? 10 : plotW - bwBox - 10;
        g.fillStyle = C.bg; g.globalAlpha = 0.95; roundRect(g, bx, 10, bwBox, bhBox, 8); g.fill(); g.globalAlpha = 1;
        g.strokeStyle = C.grid; roundRect(g, bx, 10, bwBox, bhBox, 8); g.stroke();
        g.textAlign = 'left'; g.textBaseline = 'top';
        rows.forEach((r, k) => { g.fillStyle = k === 0 ? C.text : C.textStrong; g.fillText(r, bx + 10, 18 + k * 18); });
      }
    }
    if (this.onView) this.onView(this.view.offset > 0);
  }

  _pill(p, color, plotW, yy, strong) {
    const g = this.g;
    g.font = `${strong ? 700 : 600} 11px "JetBrains Mono", ui-monospace, monospace`;
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillStyle = color; roundRect(g, plotW + 2, yy - 9, AXIS_W - 4, 18, 4); g.fill();
    g.fillStyle = this.col.bg; g.fillText(p.toFixed(2), plotW + 7, yy + 0.5);
  }

  /** เส้นที่หลุดนอกจอ: บอกทิศและราคาไว้ที่ขอบ ผู้ใช้จะได้รู้ว่ามันอยู่ทางไหน */
  _offscreen(L, above, plotW, plotH) {
    const g = this.g;
    const yy = above ? 14 : plotH - 14;
    g.font = '600 11px "IBM Plex Sans Thai", system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
    const label = `${above ? '▲' : '▼'} ${L.t} ${L.p.toFixed(2)}`;
    const tw = g.measureText(label).width + 14;
    g.fillStyle = this.col.bg; g.globalAlpha = 0.92; roundRect(g, plotW - tw - 6, yy - 10, tw, 20, 6); g.fill(); g.globalAlpha = 1;
    g.fillStyle = L.c; g.fillText(label, plotW - 13, yy + 0.5);
  }

  /* ── อินพุต ──────────────────────────────────────────────────────── */
  _zoomPrice(dy, base) {
    this.view.priceZoom = Math.max(0.4, Math.min(8, base * Math.pow(2, dy / 160)));
    this.invalidate();
  }

  _pan(offset) {
    this.view.offset = Math.max(0, Math.min(Math.max(0, this.candles.length - 15), offset));
    this.invalidate();
  }

  _bind() {
    const cv = this.cv;
    const onAxis = (px) => px > (this.W || cv.clientWidth) - AXIS_W;
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.view.count = Math.max(20, Math.min(500, Math.round(this.view.count * (e.deltaY > 0 ? 1.15 : 0.87))));
      this.invalidate();
    }, { passive: false });
    cv.addEventListener('mousedown', (e) => {
      if (onAxis(e.offsetX)) { this.axisDrag = { y: e.offsetY, zoom: this.view.priceZoom }; return; }
      this.drag = { x: e.offsetX, offset: this.view.offset };
    });
    window.addEventListener('mouseup', () => { this.drag = null; this.axisDrag = null; });
    cv.addEventListener('mousemove', (e) => {
      this.mouse = { x: e.offsetX, y: e.offsetY };
      if (this.axisDrag) { this._zoomPrice(this.axisDrag.y - e.offsetY, this.axisDrag.zoom); return; }
      if (this.drag) this._pan(this.drag.offset + Math.round((e.offsetX - this.drag.x) / (this.plot ? this.plot.barW : 6)));
      this.invalidate();
    });
    cv.addEventListener('mouseleave', () => { this.mouse = null; this.invalidate(); });
    cv.addEventListener('dblclick', () => this.reset());

    const rel = (t) => { const r = cv.getBoundingClientRect(); return { x: t.clientX - r.left, y: t.clientY - r.top }; };
    const spread = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    let pinch = null, hold = null, lastTap = 0, moved = 0;
    const endHold = () => { if (hold) { clearTimeout(hold); hold = null; } };

    cv.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        /* จำระยะนิ้วกับจำนวนแท่งตอนเริ่ม แล้วคิดเป็นสัดส่วน — คิดทีละก้าวจะสะสมจนซูมกระตุก */
        endHold(); this.drag = null;
        pinch = { d: spread(e.touches), count: this.view.count };
        return;
      }
      if (e.touches.length !== 1) return;
      const p = rel(e.touches[0]);
      moved = 0;
      /* นิ้วบนแถบราคา = ยืดแกนราคา ต้องเช็คก่อนเรื่องอื่น ไม่งั้นจะกลายเป็นเลื่อนกราฟแทน */
      if (onAxis(p.x)) { endHold(); this.drag = null; this.axisDrag = { y: p.y, zoom: this.view.priceZoom }; return; }
      this.drag = { x: p.x, offset: this.view.offset };
      const now = Date.now();
      if (now - lastTap < 300) { this.drag = null; lastTap = 0; this.reset(); return; }
      lastTap = now;
      /* แตะค้างโดยไม่ขยับ = อ่านค่า ต้องรอให้แน่ใจก่อนว่าไม่ใช่การลาก */
      hold = setTimeout(() => { if (moved < 8) { this.drag = null; this.mouse = p; this.invalidate(); } }, 260);
    }, { passive: true });

    cv.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) {
        const ratio = spread(e.touches) / (pinch.d || 1);
        this.view.count = Math.max(20, Math.min(500, Math.round(pinch.count / (ratio || 1))));
        this.invalidate();
        return;
      }
      if (e.touches.length !== 1) return;
      const p = rel(e.touches[0]);
      if (this.axisDrag) { this._zoomPrice(this.axisDrag.y - p.y, this.axisDrag.zoom); return; }
      if (this.mouse) { this.mouse = p; this.invalidate(); return; }
      if (!this.drag) return;
      moved = Math.max(moved, Math.abs(p.x - this.drag.x));
      if (moved >= 8) endHold();
      this._pan(this.drag.offset + Math.round((p.x - this.drag.x) / (this.plot ? this.plot.barW : 6)));
    }, { passive: true });

    cv.addEventListener('touchend', (e) => {
      endHold(); this.drag = null;
      if (e.touches.length === 0) this.axisDrag = null;
      if (e.touches.length < 2) pinch = null;
      /* ยกนิ้วแล้วเก็บเส้นเล็ง ไม่งั้นค้างบังกราฟ */
      if (this.mouse && e.touches.length === 0) setTimeout(() => { this.mouse = null; this.invalidate(); }, 2200);
    }, { passive: true });
    cv.addEventListener('touchcancel', () => { endHold(); this.drag = null; pinch = null; this.axisDrag = null; });
  }
}

function triangle(g, x, y, side, color) {
  g.fillStyle = color;
  g.beginPath();
  if (side > 0) { g.moveTo(x, y - 6); g.lineTo(x - 5, y + 3); g.lineTo(x + 5, y + 3); }
  else { g.moveTo(x, y + 6); g.lineTo(x - 5, y - 3); g.lineTo(x + 5, y - 3); }
  g.closePath(); g.fill();
}

/** ระยะเส้นตารางที่เป็นเลขกลม (1, 2, 5 × 10^n) — อ่านง่ายกว่าเลขเศษ */
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

const thDate = (t) => new Date(t + TH_OFFSET);
const thDay = (t) => Math.floor((t + TH_OFFSET) / 86400000);
const thMonth = (t) => { const d = thDate(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const thDateLabel = (t) => { const d = thDate(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const thMonthLabel = (t) => { const d = thDate(t); return `${MONTHS[d.getUTCMonth()]} ${String((d.getUTCFullYear() + 543) % 100).padStart(2, '0')}`; };
const thFull = (t) => {
  const d = thDate(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} น.`;
};
