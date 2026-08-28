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

const ORDER = ['indicators', 'patterns', 'levels', 'macro', 'signals', 'narrate', 'backtest', 'chart', 'alerts', 'feed', 'app'];
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

// ตรวจว่าไม่มีร่องรอย import/export หลงเหลือ ซึ่งจะทำให้ไฟล์พังเงียบ ๆ
const inner = html.slice(html.indexOf('const __m = {};'));
const leftovers = [...inner.matchAll(/^\s*(import|export)\s/gm)];
if (leftovers.length) { console.error(`ผิดพลาด: ยังเหลือ import/export ${leftovers.length} จุด`); process.exit(1); }
console.log('ตรวจแล้ว: ไม่มี import/export หลงเหลือ');
