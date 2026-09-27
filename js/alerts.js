/**
 * alerts.js — ระบบแจ้งเตือน: เสียง + แจ้งเตือนเบราว์เซอร์ + พูดไทย + Webhook (Discord ฯลฯ)
 * และ "กฎเตือนส่วนตัว" เช่น ราคาทะลุ 3400 หรือ RSI ต่ำกว่า 30
 */

const LS_KEY = 'goldtrader.alerts.v1';

import { sendDiscord, webhookProblem } from './discord.js';

export class AlertCenter {
  constructor() {
    this.log = [];
    this.rules = [];
    this.sound = true;
    this.speak = false;
    this.desktop = false;
    this.webhookUrl = '';
    this.lastWebhook = null;   // ผลการส่งครั้งล่าสุด ให้หน้าจอบอกผู้ใช้ได้ว่าใช้ได้จริงไหม
    this.onWebhookResult = null;
    this.cooldownMs = 5 * 60 * 1000;
    this._lastSignalAt = 0;
    this._lastSignalSide = 0;
    this.audioCtx = null;
    this.onUpdate = () => {};
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      this.log = raw.log || [];
      this.rules = raw.rules || [];
      this.sound = raw.sound !== false;
      this.speak = !!raw.speak;
      this.desktop = !!raw.desktop;
      this.webhookUrl = raw.webhookUrl || '';
      this.cooldownMs = raw.cooldownMs || this.cooldownMs;
    } catch (e) { /* เริ่มใหม่ถ้าอ่านไม่ได้ */ }
  }

  save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        log: this.log.slice(0, 200), rules: this.rules, sound: this.sound,
        speak: this.speak, desktop: this.desktop, webhookUrl: this.webhookUrl, cooldownMs: this.cooldownMs,
      }));
    } catch (e) { /* โควตาเต็มก็ข้าม */ }
  }

  async requestDesktopPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') { this.desktop = true; this.save(); return 'granted'; }
    const res = await Notification.requestPermission();
    this.desktop = res === 'granted';
    this.save();
    return res;
  }

  /** เล่นเสียงเตือน — ซื้อ = โทนไล่ขึ้น, ขาย = โทนไล่ลง, เตือนทั่วไป = ปี๊บสั้น */
  playSound(kind = 'info') {
    if (!this.sound) return;
    try {
      this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const seq = kind === 'buy' ? [523, 659, 784]
        : kind === 'sell' ? [784, 659, 440]
        : kind === 'warn' ? [660, 0, 660]        // ปี๊บ-หยุด-ปี๊บ = "เตรียมตัว" ยังไม่ใช่สัญญาณจริง
        : [880, 880];
      seq.forEach((f, i) => {
        if (!f) return; // 0 = เว้นจังหวะเงียบ
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        const t0 = ctx.currentTime + i * 0.16;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.16);
      });
    } catch (e) { /* เบราว์เซอร์บล็อกเสียงก่อนผู้ใช้กดจอ */ }
  }

  saySomething(text) {
    if (!this.speak || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'th-TH';
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch (e) { /* ไม่มีเสียงไทยก็ข้าม */ }
  }

  /**
   * ส่งเข้า Discord
   *
   * เดิมกลืน error ทิ้งทั้งหมด "เพื่อไม่รบกวนผู้ใช้" ซึ่งเป็นการตัดสินใจที่ผิด:
   * ช่องแจ้งเตือนที่ล้มเงียบ ๆ แย่กว่าไม่มีเลย เพราะผู้ใช้จะนั่งรอสัญญาณ
   * ที่ไม่มีวันมา โดยเชื่อว่าระบบกำลังเฝ้าให้อยู่
   *
   * ตอนนี้เก็บผลครั้งล่าสุดไว้ให้หน้าจอแสดงได้ว่าส่งผ่านหรือไม่ผ่าน เพราะอะไร
   */
  async sendWebhook(message) {
    if (!this.webhookUrl || !message) return null;
    const res = await sendDiscord(this.webhookUrl, message);
    this.lastWebhook = { ...res, at: Date.now() };
    if (this.onWebhookResult) this.onWebhookResult(this.lastWebhook);
    return res;
  }

  /** ส่งข้อความทดสอบ เพื่อให้ผู้ใช้เห็นว่าเชื่อมต่อได้จริงก่อนพึ่งพามัน */
  async testWebhook(message) {
    const problem = webhookProblem(this.webhookUrl);
    if (problem) {
      const bad = { ok: false, at: Date.now(), reason: problem };
      this.lastWebhook = bad;
      if (this.onWebhookResult) this.onWebhookResult(bad);
      return bad;
    }
    const res = await sendDiscord(this.webhookUrl, message);
    this.lastWebhook = { ...res, at: Date.now(), test: true };
    if (this.onWebhookResult) this.onWebhookResult(this.lastWebhook);
    return this.lastWebhook;
  }

  /** ยิงแจ้งเตือน 1 รายการ (บันทึกลง log + เสียง + desktop + webhook) */
  fire({ kind = 'info', title, body, price, meta, discord }) {
    const entry = { id: Date.now() + Math.random(), ts: Date.now(), kind, title, body, price, meta };
    this.log.unshift(entry);
    this.log = this.log.slice(0, 200);
    this.save();
    this.playSound(['buy', 'sell', 'warn'].includes(kind) ? kind : 'info');
    if (kind === 'buy') this.saySomething('สัญญาณซื้อทองคำ');
    if (kind === 'sell') this.saySomething('สัญญาณขายทองคำ');
    if (this.desktop && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body, tag: 'gold-' + kind, silent: false }); } catch (e) { /* ignore */ }
    }
    /* ส่ง Discord เฉพาะเมื่อมีข้อความที่จัดรูปแล้ว — ห้ามแต่งหัวข้อเองจากชนิดเตือน
       เดิมส่งสัญญาณซื้อออกไปพร้อมหัวข้อ "ยังไม่มีสัญญาณ" เพราะเดาชนิดผิด */
    if (discord) this.sendWebhook(discord);
    this.onUpdate(entry);
    return entry;
  }

  /** กันเตือนรัว: สัญญาณทิศเดิมต้องเว้นระยะตาม cooldown */
  shouldFireSignal(side) {
    const now = Date.now();
    if (side === this._lastSignalSide && now - this._lastSignalAt < this.cooldownMs) return false;
    this._lastSignalAt = now;
    this._lastSignalSide = side;
    return true;
  }

  resetCooldown() { this._lastSignalAt = 0; this._lastSignalSide = 0; }

  addRule(rule) {
    this.rules.push({ id: Date.now() + Math.random(), active: true, ...rule });
    this.save();
  }

  removeRule(id) {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.save();
  }

  /**
   * เตือนเมื่อราคาถึงระดับที่ตั้งไว้ — ใช้ตอนรอราคาย่อมาถึงจุดเข้า จะได้ไม่ต้องนั่งเฝ้า
   * @param {{price:number}} state
   */
  checkRules(state) {
    for (const r of this.rules) {
      if (!r.active || !Number.isFinite(state.price)) continue;
      const hit = (r.type === 'price_above' && state.price >= r.value) || (r.type === 'price_below' && state.price <= r.value);
      if (!hit) continue;
      r.active = false;   // เตือนครั้งเดียวพอ ราคาแกว่งรอบเส้นจะได้ไม่ดังรัว
      this.fire({ kind: 'rule', title: '🔔 ราคาถึงระดับที่ตั้งไว้',
        body: `${r.type === 'price_above' ? 'ขึ้นถึง' : 'ลงถึง'} ${r.value.toFixed(2)} · ราคาตอนนี้ ${state.price.toFixed(2)}`
          + (r.note ? `\n${r.note}` : ''), price: state.price });
      this.save();
    }
  }

  clearLog() { this.log = []; this.save(); }
}
