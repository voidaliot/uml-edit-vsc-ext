import { createServer } from 'node:http';
import { readdir, readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, relative, join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import sharp from 'sharp';
import { loadModule } from './runtime.mjs';

// Local, read-only corpus review: uses checked-in PlantUML reference PNGs and
// the extension's real browser bundle. No includes or external engine execute.
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const corpus = resolve(arg('--examples') ?? '../plantuml-examples/doc');
const phase = arg('--phase') ?? 'updated';
if (!/^[a-z0-9-]+$/i.test(phase)) throw new Error('Use a simple phase name.');
const output = resolve('.cache/layout-comparison');
const phaseDir = join(output, phase);
await mkdir(phaseDir, { recursive: true });
const { parseDocument } = await loadModule('src/core/parser.ts', `compare-parser-${phase}`);
const { codeLines } = await loadModule('src/core/syntax.ts', `compare-syntax-${phase}`);
if (!process.argv.includes('--resume') || !existsSync(join(phaseDir, 'webview.js'))) await build({ entryPoints: ['src/webview/main.tsx'], outfile: join(phaseDir, 'webview.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('.cache/ms-playwright')) process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.cache/ms-playwright');
const { chromium } = await import('playwright');
const cases = [];
async function walk(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(?:plantuml|puml|pu|iuml)$/i.test(path)) {
      const source = await readFile(path, 'utf8');
      const parsed = parseDocument(source);
      const utility = /^@startuml\s+(?:listsprite|listopeniconic|stdlib)\s+@enduml$/i.test(codeLines(source).map(s => s.trim()).filter(Boolean).join('\n'));
      const key = relative(corpus, path).replaceAll('\\', '/').replace(/\.(?:plantuml|puml|pu|iuml)$/i, '');
      cases.push({ key, source, path, png: path.replace(/\.(?:plantuml|puml|pu|iuml)$/i, '.png'), diagrams: parsed.diagrams, status: utility ? 'ENGINE UTILITY' : !parsed.diagrams.length ? 'SHARED STYLES' : parsed.diagrams.every(d => d.graphical) ? 'NATIVE' : 'SOURCE ONLY' });
    }
  }
}
await walk(corpus);
const selected = arg('--filter') ? cases.filter(item => item.key.includes(arg('--filter'))) : cases;
let current;
const server = createServer(async (request, response) => {
  try {
    const name = request.url?.split('?')[0];
    if (name === '/') {
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/webview.css"></head><body><div id="root"></div><script>window.__ALIOT_INITIAL_SOURCE__=${JSON.stringify(current.source).replaceAll('<', '\\u003c')};window.__ALIOT_FILE_NAME__=${JSON.stringify(current.key + '.plantuml')};</script><script src="/webview.js"></script></body></html>`);
    } else if (name === '/webview.js' || name === '/webview.css') {
      response.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : 'text/css');
      response.end(await readFile(join(phaseDir, name.slice(1))));
    } else { response.statusCode = 404; response.end(); }
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
await new Promise((yes, no) => { server.once('error', no); server.listen(4180, '127.0.0.1', yes); });
let browser;
const report = [];
const htmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
async function saveFigure(page, row) {
  row.canvas = row.actual.replace(/\.png$/, '-canvas.png');
  const canvas = page.locator('.canvas-shell'), box = await canvas.boundingBox();
  await canvas.screenshot({ path: join(output, row.canvas) });
  const bounds = await page.locator('.react-flow__node, .react-flow__node *, .edge-label, .multiplicity').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; }).filter(box => box.width && box.height));
  if (!bounds.length) { await copyFile(join(output, row.canvas), join(output, row.actual)); return; }
  const left = Math.max(0, Math.floor(Math.min(...bounds.map(rect => rect.x)) - box.x - 30));
  const top = Math.max(0, Math.floor(Math.min(...bounds.map(rect => rect.y)) - box.y - 30));
  const right = Math.min(Math.floor(box.width), Math.ceil(Math.max(...bounds.map(rect => rect.right)) - box.x + 30));
  const bottom = Math.min(Math.floor(box.height), Math.ceil(Math.max(...bounds.map(rect => rect.bottom)) - box.y + 30));
  await sharp(join(output, row.canvas)).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toFile(join(output, row.actual));
}
try {
  browser = await chromium.launch({ headless: true });
  for (const item of selected) {
    const file = item.key.replaceAll('/', '--');
    const original = join(output, 'reference', file + '.png');
    if (existsSync(item.png)) { await mkdir(dirname(original), { recursive: true }); await copyFile(item.png, original); }
    const warnings = item.diagrams.flatMap(d => d.warnings);
    const row = { key: item.key, status: item.status, kinds: item.diagrams.map(d => d.kind), elements: item.diagrams.reduce((n, d) => n + d.elements.length, 0), warnings, reference: existsSync(original) ? `reference/${file}.png` : undefined };
    if (item.status === 'NATIVE') {
      row.actual = `${phase}/${file}.png`;
      if (process.argv.includes('--resume') && existsSync(join(output, row.actual))) { report.push(row); console.log(`REUSED ${item.key}`); continue; }
      current = item;
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto('http://127.0.0.1:4180');
      if (row.elements) await page.locator('.react-flow__node').first().waitFor();
      else await page.locator('.editor-toolbar').waitFor();
      await page.getByRole('button', { name: 'Toggle outline', exact: true }).click();
      if (row.elements) await page.getByRole('button', { name: 'Fit diagram (F)', exact: true }).click();
      await page.waitForTimeout(500);
      await saveFigure(page, row);
      row.nodes = await page.locator('.uml-node').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { id: node.getAttribute('data-element-id'), kind: node.getAttribute('data-element-kind'), x: box.x, y: box.y, width: box.width, height: box.height, text: node.textContent }; }));
      row.errors = errors;
      await page.close();
    }
    report.push(row);
    console.log(`${item.status} ${item.key}`);
  }
} finally { await browser?.close(); await new Promise(yes => server.close(yes)); }
await writeFile(join(phaseDir, 'report.json'), JSON.stringify({ phase, corpus, date: new Date().toISOString(), cases: report }, null, 2));
// Separate sheets keep every diagram large enough for actual visual inspection.
for (let start = 0; start < report.length; start += 6) {
  const rows = report.slice(start, start + 6); const width = 1600, rowHeight = 450;
  const composites = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], top = index * rowHeight;
    const label = `<svg width="1600" height="38"><rect width="1600" height="38" fill="#e6e9ec"/><text x="15" y="26" font-size="20" font-family="Arial">${htmlEscape(row.key)} — ${row.status} (PlantUML left / Aliot right)</text></svg>`;
    composites.push({ input: Buffer.from(label), top, left: 0 });
    for (const [column, image] of [row.reference, row.actual].entries()) if (image) composites.push({ input: await sharp(join(output, image)).flatten({ background: column ? '#171b22' : 'white' }).resize(790, rowHeight - 48, { fit: 'contain', background: column ? '#171b22' : 'white' }).png().toBuffer(), top: top + 40, left: column * 800 + 5 });
  }
  await sharp({ create: { width, height: rowHeight * rows.length, channels: 3, background: 'white' } }).composite(composites).png().toFile(join(phaseDir, `contact-${Math.floor(start / 6) + 1}.png`));
}
const html = `<!doctype html><html><meta charset="utf-8"><title>PlantUML / Aliot layout review</title><style>body{font:15px system-ui;margin:24px;background:#f4f5f6;color:#18212a}article{background:white;padding:16px;margin:22px 0;page-break-inside:avoid}h2{font-size:18px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}.pair img{width:100%;height:620px;object-fit:contain;border:1px solid #ccd2d8}pre{white-space:pre-wrap;font-size:12px}a{color:#125b8a}</style><h1>PlantUML reference / Aliot ${htmlEscape(phase)} layout</h1><p>All ${report.length} source files from ${htmlEscape(corpus)}. Reference images are provided by the example repository. Native renders use the extension's real React Flow bundle with a fresh automatic layout. Colors follow the editor theme. Includes are preserved without execution. Geometry and notation differences remain visible.</p>${report.map(row => `<article><h2>${htmlEscape(row.key)} — ${row.status}</h2><div class="pair"><div><b>PlantUML reference</b>${row.reference ? `<a href="../${row.reference}"><img src="../${row.reference}"></a>` : '<p>No reference image</p>'}</div><div><b>Aliot ${htmlEscape(phase)}</b>${row.actual ? `<a href="../${row.actual}"><img src="../${row.actual}"></a>` : '<p>Engine utility or shared style file; no diagram canvas.</p>'}</div></div>${row.warnings.length ? `<details><summary>Native scope diagnostics</summary><pre>${htmlEscape(row.warnings.join('\n'))}</pre></details>` : ''}</article>`).join('')}</html>`;
await writeFile(join(phaseDir, 'index.html'), html);
if (phase === 'updated') await writeFile(join(output, 'index.html'), html.replaceAll('../', '').replace('<h1>', '<nav><a href="baseline/index.html">Earlier baseline</a> · <a href="updated/report.json">Current diagnostics</a></nav><h1>'));
console.log(`Compared ${report.length} files. Gallery: ${join(phaseDir, 'index.html')}`);
