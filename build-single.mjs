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
