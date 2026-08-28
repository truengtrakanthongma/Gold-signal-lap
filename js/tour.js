/**
 * tour.js — พาชมหน้าจอครั้งแรก
 *
 * เครื่องมือเทรดมีศัพท์เฉพาะเยอะ คนเปิดครั้งแรกมักไม่รู้ว่าต้องมองตรงไหนก่อน
 * ทัวร์นี้ไฮไลต์ทีละจุดพร้อมอธิบายสั้น ๆ ว่าแต่ละส่วนคืออะไรและใช้ยังไง
 */

const LS_DONE = 'goldtrader.tour.done.v1';

const STEPS = [
  {
    sel: '.price-block',
    title: 'ราคาทองคำตอนนี้',
    text: 'ตัวเลขใหญ่คือราคาทองต่อ 1 ออนซ์ (หน่วยสากล) อัปเดตทุกวินาที ' +
          'บรรทัดล่างแปลงเป็นราคาบาททองคำไทยโดยประมาณให้แล้ว',
  },
  {
    sel: '.canvas-wrap',
    title: 'กราฟแท่งเทียน',
    text: 'แต่ละแท่งคือช่วงเวลาหนึ่ง (เริ่มต้นคือ 15 นาที) ' +
          '<b style="color:#22c55e">แท่งเขียว</b> = ช่วงนั้นราคาขึ้น · <b style="color:#ef4444">แท่งแดง</b> = ราคาลง ' +
          'ขีดบาง ๆ บนล่างคือจุดสูงสุด-ต่ำสุดที่ราคาไปแตะ<br><br>เลื่อนล้อเมาส์เพื่อซูม ลากเพื่อเลื่อนดูย้อนหลัง',
  },
  {
    sel: '#tfGroup',
    title: 'เลือกช่วงเวลาต่อแท่ง',
    text: '<b>15m</b> = แท่งละ 15 นาที เหมาะกับเทรดรายวัน · <b>5m</b> เร็วกว่า เหมาะกับเข้าออกไว · ' +
          '<b>4h / 1d</b> ช้ากว่า เหมาะกับถือยาวหลายวัน<br><br>ยิ่งแท่งสั้น สัญญาณยิ่งเยอะแต่หลอกบ่อยกว่า',
  },
  {
    sel: '#signalCard',
    title: 'ดูตรงนี้ที่เดียวพอ',
    text: 'บอกว่าตอนนี้ควรทำอะไร — <b>เข้าซื้อ · เข้าขาย · หรือรอ</b><br><br>' +
          'ตัวเลข % คือโอกาสที่สัญญาณแบบนี้จะได้กำไรก่อนขาดทุน ' +
          'คำนวณจากการย้อนไปทดสอบกฎเดียวกันนี้กับข้อมูลจริงในอดีต ไม่ใช่ตัวเลขที่ตั้งขึ้นเอง',
  },
  {
    sel: '#planBox',
    title: 'แผนเข้า-ออก',
    text: 'เมื่อมีสัญญาณ ตรงนี้จะบอกตัวเลข 3 อย่างให้เอาไปตั้งในโปรแกรมเทรด:<br><br>' +
          '<b>จุดเข้า</b> = ราคาที่ควรซื้อ/ขาย<br>' +
          '<b>ตัดขาดทุน</b> = ถ้าราคาถึงจุดนี้ให้ยอมแพ้ ปิดทันที (สำคัญที่สุด ห้ามข้าม)<br>' +
          '<b>เป้าที่ 1/2/3</b> = จุดทำกำไร<br><br>' +
          'ตั้งเป็นคำสั่งรอไว้ได้เลย ไม่ต้องนั่งเฝ้าจอ',
  },
  {
    sel: '.narration',
    title: 'คำอธิบายกราฟ (สำหรับเรียนรู้)',
    text: 'อธิบายเป็นภาษาไทยว่ากราฟกำลังบอกอะไร ทุกศัพท์เทคนิคมีคำแปลกำกับ ' +
          'อัปเดตตัวเองตลอดเวลา<br><br>ส่วนนี้ทำมาเพื่อการสอนโดยเฉพาะ เปิดค้างไว้ให้นักเรียนอ่านตามได้',
  },
  {
    sel: '#modeToggle',
    title: 'อยากดูละเอียดกว่านี้',
    text: 'ตอนนี้อยู่ใน <b>โหมดง่าย</b> ซึ่งซ่อนเครื่องมือขั้นสูงไว้<br><br>' +
          'กดปุ่มนี้เพื่อเปิด <b>โหมดเต็ม</b> จะเห็นผลทดสอบย้อนหลัง ตั้งค่าแจ้งเตือน ' +
          'ตัวชี้วัดเพิ่มเติม และปฏิทินข่าว',
  },
];

export class Tour {
  constructor() {
    this.idx = 0;
    this.el = null;
  }

  static seen() {
    try { return localStorage.getItem(LS_DONE) === '1'; } catch (e) { return false; }
  }

  start() {
    this.idx = 0;
    this._build();
    this._show();
  }

  _build() {
    if (this.el) return;
    const wrap = document.createElement('div');
    wrap.className = 'tour-root';
    wrap.innerHTML = `
      <div class="tour-spot"></div>
      <div class="tour-box" role="dialog" aria-live="polite">
        <div class="tour-step"></div>
        <h3></h3>
        <p></p>
        <div class="tour-btns">
          <button class="btn small tour-skip">ข้ามทั้งหมด</button>
          <span style="flex:1"></span>
          <button class="btn small tour-prev">ย้อนกลับ</button>
          <button class="btn primary small tour-next">ถัดไป</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    this.el = wrap;
    wrap.querySelector('.tour-skip').addEventListener('click', () => this.finish());
    wrap.querySelector('.tour-prev').addEventListener('click', () => { this.idx = Math.max(0, this.idx - 1); this._show(); });
    wrap.querySelector('.tour-next').addEventListener('click', () => {
      if (this.idx >= STEPS.length - 1) this.finish();
      else { this.idx++; this._show(); }
    });
    this._onKey = (e) => {
      if (e.key === 'Escape') this.finish();
      if (e.key === 'ArrowRight') wrap.querySelector('.tour-next').click();
      if (e.key === 'ArrowLeft') wrap.querySelector('.tour-prev').click();
    };
    document.addEventListener('keydown', this._onKey);
    this._onResize = () => this._show();
    window.addEventListener('resize', this._onResize);
  }

  _show() {
    const step = STEPS[this.idx];
    const target = document.querySelector(step.sel);
    if (!target) { // ถ้าหาองค์ประกอบไม่เจอ ข้ามไปขั้นถัดไปแทนที่จะค้าง
      if (this.idx >= STEPS.length - 1) return this.finish();
      this.idx++;
      return this._show();
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });

    setTimeout(() => {
      const r = target.getBoundingClientRect();
      const spot = this.el.querySelector('.tour-spot');
      const pad = 6;
      spot.style.top = `${r.top - pad}px`;
      spot.style.left = `${r.left - pad}px`;
      spot.style.width = `${r.width + pad * 2}px`;
      spot.style.height = `${r.height + pad * 2}px`;

      const box = this.el.querySelector('.tour-box');
      box.querySelector('.tour-step').textContent = `ขั้นที่ ${this.idx + 1} จาก ${STEPS.length}`;
      box.querySelector('h3').textContent = step.title;
      box.querySelector('p').innerHTML = step.text;
      box.querySelector('.tour-prev').style.visibility = this.idx === 0 ? 'hidden' : '';
      box.querySelector('.tour-next').textContent = this.idx >= STEPS.length - 1 ? 'เริ่มใช้งาน' : 'ถัดไป';

      const bw = Math.min(380, window.innerWidth - 24);
      box.style.width = `${bw}px`;
      const below = r.bottom + 14;
      const boxH = box.offsetHeight || 220;
      const top = (below + boxH < window.innerHeight) ? below : Math.max(12, r.top - boxH - 14);
      box.style.top = `${top}px`;
      box.style.left = `${Math.max(12, Math.min(window.innerWidth - bw - 12, r.left + r.width / 2 - bw / 2))}px`;
    }, 320);
  }

  finish() {
    try { localStorage.setItem(LS_DONE, '1'); } catch (e) { /* โหมดส่วนตัว */ }
    document.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
    if (this.el) { this.el.remove(); this.el = null; }
  }
}
