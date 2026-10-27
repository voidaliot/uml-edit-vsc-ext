import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Capture the real editor using original examples, without external assets.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('.cache/ms-playwright')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.cache/ms-playwright');
}
const { chromium } = await import('@playwright/test');
const output = resolve('media/screenshots');
await mkdir(output, { recursive: true });
const port = 4187;
const server = fork('scripts/preview.mjs', [], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});
let browser;
try {
  await new Promise((yes, no) => {
    const timeout = setTimeout(() => no(new Error('Preview did not start within 30 seconds.')), 30_000);
    server.on('message', message => {
      if (message?.type === 'ready') { clearTimeout(timeout); yes(); }
    });
    server.once('error', error => { clearTimeout(timeout); no(error); });
    server.once('exit', code => { clearTimeout(timeout); no(new Error(`Preview exited: ${code}`)); });
  });
  browser = await chromium.launch({ headless: true });
  const errors = [];
  async function openExample(file) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 840 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    if (file) {
      const source = await readFile(file, 'utf8');
      await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
    }
    await page.goto(`http://127.0.0.1:${port}/${file ? '' : '?empty=1'}`);
    await page.getByRole('toolbar', { name: 'Diagram tools' }).waitFor();
    if (file) {
      await page.locator('.react-flow__node').first().waitFor();
      await page.getByRole('button', { name: 'Fit diagram (F)', exact: true }).click();
      await page.waitForTimeout(500);
    }
    await page.evaluate(() => document.fonts.ready);
    return page;
  }
  async function save(page, name) {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: resolve(output, name), animations: 'disabled' });
    await page.close();
    console.log(`Captured ${name}`);
  }
  const editor = await openExample('examples/order-model.puml');
  // Use the canvas pan gesture to leave room for the source panel.
  await editor.mouse.move(1100, 450);
  await editor.mouse.down({ button: 'middle' });
  await editor.mouse.move(810, 450, { steps: 12 });
  await editor.mouse.up({ button: 'middle' });
  await editor.getByRole('button', { name: 'Edit PlantUML source in canvas', exact: true }).click();
  await editor.getByRole('textbox', { name: 'PlantUML source', exact: true }).waitFor();
  await save(editor, 'visual-and-source.png');
  await save(await openExample('examples/checkout-sequence.puml'), 'sequence.png');
  await save(await openExample('examples/fulfilment.puml'), 'activity.png');
  const gallery = await openExample();
  await gallery.getByRole('dialog', { name: 'Create a new diagram' }).waitFor();
  await save(gallery, 'diagram-gallery.png');
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser?.close();
  if (server.connected) server.send({ type: 'shutdown' });
  if (server.exitCode === null) {
    await new Promise(yes => {
      const timeout = setTimeout(() => { server.kill(); yes(); }, 5000);
      server.once('exit', () => { clearTimeout(timeout); yes(); });
    });
  }
}
