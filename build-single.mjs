/**
 * build-single.mjs — รวมทุกไฟล์เป็น HTML ไฟล์เดียว
 *
 * ทำไมต้องมี: ปกติเบราว์เซอร์ห้ามโหลด ES Module จากไฟล์ในเครื่อง (file://)
 * ดับเบิลคลิก index.html ตรง ๆ จึงขึ้นหน้าขาว ต้องรันเว็บเซิร์ฟเวอร์เสมอ
 * ไฟล์รวมนี้ไม่ใช้ module จึงดับเบิลคลิกเปิดได้เลย และยังต่อ Binance ได้ตามปกติ
 *
 * วิธีรวม: ห่อแต่ละโมดูลด้วย IIFE แล้วส่งออกเป็นอ็อบเจ็กต์ กันชื่อชนกันระหว่างไฟล์
 * รัน: node build-single.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ORDER = ['indicators', 'patterns', 'levels', 'macro', 'signals', 'narrate', 'backtest', 'chart', 'alerts', 'feed', 'tour', 'glossary', 'instrument', 'learn', 'adapt', 'app'];
const IMPORT_RE = /^import\s+(?:\*\s+as\s+(\w+)|\{([^}]+)\})\s+from\s+['"]\.\/(\w+)\.js['"];?[ \t]*$/gm;
const EXPORT_RE = /^export\s+(async\s+function|function|const|let|class)\s+(\w+)/gm;

function build(name) {
  const src = readFileSync(`js/${name}.js`, 'utf8');
  const prelude = [];
  const body = src.replace(IMPORT_RE, (_m, ns, named, from) => {
    if (ns) prelude.push(`  const ${ns} = __m.${from};`);
    else prelude.push(`  const {${named.trim()}} = __m.${from};`);
    return '';
  });
  const names = [...body.matchAll(EXPORT_RE)].map((m) => m[2]);
  const stripped = body.replace(/^export\s+/gm, '');
  return `__m.${name} = (function () {\n${prelude.join('\n')}\n${stripped}\n  return {${names.join(', ')}};\n})();`;
}

const bundle = `const __m = {};\n\n` + ORDER.map(build).join('\n\n');

let html = readFileSync('index.html', 'utf8');
const css = readFileSync('styles.css', 'utf8');

html = html
  .replace('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="js/app.js"></script>', `<script>\n${bundle}\n</script>`)
  // ฟอนต์จาก Google อาจโหลดไม่ได้ถ้าไม่มีเน็ต — ให้ fallback เป็นฟอนต์ในเครื่องแทน
  .replace('<title>', '<!-- ไฟล์รวมไฟล์เดียว สร้างด้วย build-single.mjs — แก้โค้ดที่ js/ แล้วสั่ง node build-single.mjs ใหม่ -->\n<title>');

writeFileSync('gold-signal-lab.html', html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`สร้าง gold-signal-lab.html สำเร็จ (${kb} KB, รวม ${ORDER.length} โมดูล)`);

/**
 * เวอร์ชันที่สอง: สำหรับโฮสต์บนหน้าเว็บที่ต่อ Binance ไม่ได้ (เช่นระบบที่บล็อกโดเมนภายนอก)
 * ต้องบังคับโหมดจำลอง และติดป้ายบอกให้ชัดว่าไม่ใช่ราคาจริง
 * เครื่องมือเทรดที่แสดงราคาปลอมโดยไม่บอก คือสิ่งที่อันตรายที่สุดที่จะปล่อยออกไป
 */
const banner = `
<style>
  .demo-banner {
    display: flex; align-items: center; justify-content: center; gap: 10px 18px;
    flex-wrap: wrap; text-align: center;
    background: linear-gradient(90deg, #4a370c, #6b4f10 50%, #4a370c);
    border-bottom: 1px solid #f0b429;
    color: #ffe9b0; padding: 9px 16px; font-size: 13px; line-height: 1.5;
  }
  .demo-banner b { color: #fff2cc; }
  .demo-banner .tag {
    background: #f0b429; color: #241a02; font-weight: 700;
    border-radius: 20px; padding: 2px 11px; font-size: 12px; white-space: nowrap;
  }
  .demo-banner a { color: #ffd980; }
  @media (max-width: 720px) {
    .demo-banner { font-size: 12.5px; padding: 7px 10px; gap: 5px 12px; line-height: 1.45; }
    .demo-banner .tag { font-size: 11.5px; padding: 2px 9px; }
  }
</style>
<div class="demo-banner">
  <span class="tag">หน้าตัวอย่างเพื่อการเรียนรู้</span>
  <span>ตัวเลขราคาทั้งหมดในหน้านี้เป็น <b>ข้อมูลจำลอง ไม่ใช่ราคาทองคำจริง</b> — ใช้ดูวิธีอ่านกราฟและฝึกใช้เครื่องมือ <b>ห้ามใช้ตัดสินใจซื้อขายจริง</b></span>
  <span>อยากได้ราคาจริง: ดาวน์โหลด <b>gold-signal-lab.html</b> ไปเปิดในเครื่อง</span>
</div>`;

const demoOnly = html
  .replace('<body>', '<body>' + banner)
  // บังคับโหมดจำลองก่อนแอปเริ่มทำงาน และปิดตัวเลือกที่ใช้ไม่ได้ในหน้านี้
  .replace('<script>\nconst __m = {};', `<script>
try {
  const k = 'goldtrader.settings.v1';
  const cur = JSON.parse(localStorage.getItem(k) || '{}');
  localStorage.setItem(k, JSON.stringify({ ...cur, source: 'demo' }));
} catch (e) { /* โหมดส่วนตัวเขียน localStorage ไม่ได้ ก็ยังใช้ค่าเริ่มต้นได้ */ }
addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('sourceSel');
  if (!sel) return;
  for (const o of sel.options) {
    if (o.value !== 'demo') { o.disabled = true; o.textContent = o.textContent + ' — ใช้ในหน้านี้ไม่ได้'; }
  }
  sel.value = 'demo';
});
</script>
<script>
const __m = {};`);

writeFileSync('gold-signal-lab-demo.html', demoOnly);
console.log(`สร้าง gold-signal-lab-demo.html สำเร็จ (เวอร์ชันสำหรับโฮสต์ บังคับโหมดจำลอง + ติดป้ายเตือน)`);

// ตรวจว่าไม่มีร่องรอย import/export หลงเหลือ ซึ่งจะทำให้ไฟล์พังเงียบ ๆ
const inner = html.slice(html.indexOf('const __m = {};'));
const leftovers = [...inner.matchAll(/^\s*(import|export)\s/gm)];
if (leftovers.length) { console.error(`ผิดพลาด: ยังเหลือ import/export ${leftovers.length} จุด`); process.exit(1); }
console.log('ตรวจแล้ว: ไม่มี import/export หลงเหลือ');

/*
 * สร้างหน้า tradingview.html — หน้ารับโค้ด Pine สำหรับมือถือ
 *
 * ทำไมต้องมี: แอป TradingView บนมือถือไม่มี Pine Editor ต้องเปิดผ่านเบราว์เซอร์
 * แล้วขั้นที่ยากที่สุดบนมือถือคือ "คัดลอกโค้ด 249 บรรทัดจาก GitHub"
 * หน้านี้ตัดปัญหานั้นทิ้ง เหลือแค่กดปุ่มเดียว
 *
 * สร้างจากไฟล์ .pine โดยตรง โค้ดในหน้าเว็บจึงตรงกับไฟล์จริงเสมอ ไม่มีทางหลุดคนละเวอร์ชัน
 */
const pine = readFileSync('tradingview/gold-signal-lab.pine', 'utf8');
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pineLines = pine.split('\n').length;

const tvPage = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gold Signal Lab — ใส่ใน TradingView</title>
<style>
  :root { --bg:#0b1020; --panel:#141a2e; --panel2:#1b2238; --line:#2a3350;
          --text:#e8ecf7; --muted:#94a3b8; --gold:#f0b429; --up:#22c55e; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); line-height:1.7;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif; font-size:15px; }
  .wrap { max-width:760px; margin:0 auto; padding:16px 14px 60px; }
  h1 { font-size:20px; margin:0 0 4px; color:var(--gold); }
  h2 { font-size:16px; margin:26px 0 8px; }
  .sub { color:var(--muted); font-size:13.5px; margin:0 0 18px; }
  .copy-bar { position:sticky; top:0; z-index:10; background:var(--bg); padding:10px 0 12px; border-bottom:1px solid var(--line); }
  button.copy { width:100%; padding:16px; font-size:16px; font-weight:700; border-radius:12px;
                border:none; background:var(--gold); color:#1a1200; cursor:pointer; font-family:inherit; }
  button.copy:active { transform:scale(.99); }
  button.copy.done { background:var(--up); color:#04210f; }
  .steps { counter-reset:s; padding:0; margin:0; list-style:none; }
  .steps > li { counter-increment:s; position:relative; padding:12px 0 12px 42px; border-bottom:1px solid var(--line); }
  .steps > li::before { content:counter(s); position:absolute; left:0; top:12px; width:28px; height:28px;
    border-radius:50%; background:var(--panel2); color:var(--gold); font-weight:700; font-size:14px;
    display:flex; align-items:center; justify-content:center; }
  .steps b { color:var(--gold); }
  .note { background:var(--panel); border-left:3px solid var(--gold); border-radius:8px;
          padding:11px 13px; margin:14px 0; font-size:13.5px; }
  .note.warn { border-left-color:#ef4444; }
  code { background:var(--panel2); padding:2px 6px; border-radius:5px; font-size:13px;
         font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre { background:#080d1a; border:1px solid var(--line); border-radius:10px; padding:12px;
        overflow:auto; max-height:340px; font-size:11.5px; line-height:1.55;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  a { color:var(--gold); }
  .tabs { display:flex; gap:8px; margin:14px 0 0; }
  .tabs button { flex:1; padding:10px; border-radius:9px; border:1px solid var(--line);
    background:var(--panel); color:var(--muted); font-size:14px; font-family:inherit; cursor:pointer; }
  .tabs button.on { background:var(--panel2); color:var(--gold); border-color:var(--gold); font-weight:600; }
  .pane[hidden] { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <h1>ใส่ Gold Signal Lab ใน TradingView</h1>
  <p class="sub">ได้ราคา XAUUSD จริงจากโบรกเกอร์คุณ ไม่มีโควตา ทดสอบย้อนหลังในตัว และแจ้งเตือนเข้ามือถือ</p>

  <div class="copy-bar">
    <button class="copy" id="copyBtn">📋 คัดลอกโค้ดทั้งหมด (${pineLines} บรรทัด)</button>
  </div>

  <div class="tabs">
    <button id="tabMobile" class="on">📱 ทำบนมือถือ</button>
    <button id="tabDesktop">💻 ทำบนคอม</button>
  </div>

  <div class="pane" id="paneMobile">
    <div class="note warn">
      <b>ข้อจำกัดที่ต้องรู้ก่อน:</b> แอป TradingView บนมือถือ<b>ไม่มี Pine Editor</b>
      จึงวางโค้ดในแอปไม่ได้ ต้องวางผ่าน<b>เบราว์เซอร์ในโหมดคอมพิวเตอร์</b> ครั้งเดียว
      หลังจากนั้นใช้ในแอปได้ตามปกติ รวมถึงรับแจ้งเตือน
    </div>
    <ol class="steps">
      <li>กดปุ่ม <b>คัดลอกโค้ดทั้งหมด</b> ข้างบน</li>
      <li>เปิด <b>Chrome</b> (Android) หรือ <b>Safari</b> (iPhone) — <u>ไม่ใช่แอป TradingView</u></li>
      <li>เปิดโหมดคอมพิวเตอร์:<br>
        • <b>Chrome</b> → จุดสามจุดมุมขวาบน → ติ๊ก <code>เว็บไซต์เดสก์ท็อป</code><br>
        • <b>Safari</b> → ไอคอน <code>ᴀA</code> ซ้ายช่อง URL → <code>ขอเว็บไซต์เดสก์ท็อป</code></li>
      <li>ไปที่ <a href="https://www.tradingview.com/chart/" target="_blank" rel="noopener">tradingview.com/chart</a> แล้วเข้าสู่ระบบ (สมัครฟรีได้)</li>
      <li>ค้นหาสัญลักษณ์ <code>XAUUSD</code> แล้วเลือกกรอบเวลา <b>15 นาที</b></li>
      <li>ล่างจอมีแถบ <b>Pine Editor</b> — แตะเพื่อกางขึ้นมา
        <div class="note">หมุนมือถือเป็น<b>แนวนอน</b>ตรงนี้จะง่ายขึ้นมาก</div></li>
      <li>ลบโค้ดตัวอย่างที่มีอยู่ให้หมด แล้ว<b>วาง</b>โค้ดที่คัดลอกมา</li>
      <li>กด <b>Save</b> → ตั้งชื่อ <code>Gold Signal Lab</code> → กด <b>Add to chart</b></li>
      <li>เสร็จแล้ว! ปิดโหมดเดสก์ท็อปได้ กลับไปใช้<b>แอป TradingView</b> ตามปกติ —
        สคริปต์จะอยู่ใน <b>Indicators → My scripts</b> เพิ่มลงกราฟได้เลย</li>
    </ol>
  </div>

  <div class="pane" id="paneDesktop" hidden>
    <ol class="steps">
      <li>กดปุ่ม <b>คัดลอกโค้ดทั้งหมด</b> ข้างบน</li>
      <li>เปิด <a href="https://www.tradingview.com/chart/" target="_blank" rel="noopener">tradingview.com/chart</a> แล้วเข้าสู่ระบบ</li>
      <li>ค้นหา <code>XAUUSD</code> เลือกกรอบเวลา <b>15 นาที</b></li>
      <li>ล่างจอ กด <b>Pine Editor</b></li>
      <li>ลบโค้ดเดิมทั้งหมด แล้ววางโค้ดที่คัดลอกมา</li>
      <li>กด <b>Save</b> ตั้งชื่อ แล้วกด <b>Add to chart</b></li>
      <li>เปิดแท็บ <b>Strategy Tester</b> ล่างจอ เพื่อดูผลทดสอบย้อนหลังกับทองจริง</li>
    </ol>
  </div>

  <h2>ตั้งแจ้งเตือนเข้ามือถือ</h2>
  <ol class="steps">
    <li>บนกราฟที่ใส่สคริปต์แล้ว กดไอคอน <b>นาฬิกาปลุก</b> (Alert)</li>
    <li>ช่อง <b>Condition</b> เลือก <code>Gold Signal Lab</code></li>
    <li>เลือกเงื่อนไข <b>Any alert() function call</b></li>
    <li>ในแท็บ <b>Notifications</b> ติ๊ก <b>Push notification</b></li>
    <li>กด <b>Create</b> — จากนี้สัญญาณจะเด้งเข้ามือถือเอง ไม่ต้องเปิดจอทิ้งไว้</li>
  </ol>

  <h2>อ่านผลทดสอบย้อนหลังยังไง</h2>
  <div class="note">
    ในแท็บ <b>Strategy Tester</b> ดูสามตัวนี้พอ:<br>
    • <b>Profit Factor</b> — เกิน 1.0 คือกำไร ต่ำกว่าคือขาดทุน<br>
    • <b>Total Closed Trades</b> — ต่ำกว่า 30 ไม้ ยังสรุปอะไรไม่ได้ ให้ถือว่าเป็นแค่ตัวอย่าง<br>
    • <b>Max Drawdown</b> — เคยติดลบลึกสุดเท่าไร ถ้าคุณทนไม่ไหว ก็ใช้ระบบนี้ไม่ได้ ต่อให้สุดท้ายมันกำไร
  </div>
  <div class="note warn">
    <b>ค่าเริ่มต้นเป็นค่ากลาง ๆ ไม่ได้จูนมาเพื่อทองคำโดยเฉพาะ</b>
    ถ้าผลออกมาไม่ดี อย่าเพิ่งสรุปว่ากฎใช้ไม่ได้ — ลองปรับ <b>คะแนนขั้นต่ำ</b> และ <b>เป้าทำกำไร</b> ในหน้าตั้งค่าของสคริปต์ดูก่อน
    และอย่าเชื่อค่าที่จูนจนสวยที่สุด เพราะนั่นคือการฟิตกับอดีต
  </div>

  <h2>โค้ดทั้งหมด</h2>
  <p class="sub">ถ้าปุ่มคัดลอกใช้ไม่ได้ กดค้างในกล่องนี้แล้วเลือกทั้งหมดเองได้</p>
  <pre id="code">${esc(pine)}</pre>

  <p class="sub" style="margin-top:24px">
    ⚠ เครื่องมือเพื่อการศึกษา ไม่ใช่คำแนะนำการลงทุน ·
    <a href="./">กลับไปหน้าเว็บแอป</a> ·
    <a href="https://github.com/truengtrakanthongma/Gold-signal-lap" target="_blank" rel="noopener">ซอร์สโค้ด</a>
  </p>
</div>

<script>
(function () {
  var btn = document.getElementById('copyBtn');
  var code = document.getElementById('code');
  btn.addEventListener('click', function () {
    var text = code.textContent;
    function done() {
      btn.textContent = '✓ คัดลอกแล้ว — ไปวางใน Pine Editor ได้เลย';
      btn.classList.add('done');
      setTimeout(function () {
        btn.textContent = '📋 คัดลอกโค้ดทั้งหมด (${pineLines} บรรทัด)';
        btn.classList.remove('done');
      }, 4000);
    }
    // clipboard API ต้องใช้ HTTPS — ถ้าไม่มี ถอยไปใช้วิธีเก่าที่ทำงานได้ทุกที่
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { btn.textContent = 'คัดลอกอัตโนมัติไม่ได้ — เลื่อนลงไปคัดลอกจากกล่องโค้ดด้านล่าง'; }
      document.body.removeChild(ta);
    }
  });

  var tm = document.getElementById('tabMobile'), td = document.getElementById('tabDesktop');
  var pm = document.getElementById('paneMobile'), pd = document.getElementById('paneDesktop');
  function pick(mobile) {
    tm.classList.toggle('on', mobile); td.classList.toggle('on', !mobile);
    pm.hidden = !mobile; pd.hidden = mobile;
  }
  tm.addEventListener('click', function () { pick(true); });
  td.addEventListener('click', function () { pick(false); });
  // เปิดบนคอมให้เลือกแท็บคอมให้เลย
  if (!/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) pick(false);
})();
</script>
</body>
</html>`;

writeFileSync('tradingview.html', tvPage);
console.log(`สร้าง tradingview.html สำเร็จ (หน้ารับโค้ด Pine ${pineLines} บรรทัด สำหรับมือถือ)`);
