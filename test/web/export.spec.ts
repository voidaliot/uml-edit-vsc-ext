import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';

const model = '@startuml\ntitle Orders\nclass Order {\n  + id: UUID\n  + submit()\n}\nclass LineItem\nOrder *-- LineItem : contains\n@enduml\n\n@startuml\nclass Other\n@enduml\n';

async function load(page: Page, source: string) {
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  await expect(page.locator('.react-flow__node')).not.toHaveCount(0);
}
async function exportImage(page: Page, format: 'SVG' | 'PNG', background?: string) {
  await page.getByRole('button', { name: 'Export image' }).click();
  if (background) { await page.getByRole('menuitemradio', { name: background }).click(); }
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: new RegExp(`^Export ${format}`) }).click()]);
  return { name: download.suggestedFilename(), data: await readFile((await download.path())!) };
}

test('exports the whole diagram as a standalone SVG and a 2× PNG without editor chrome', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await load(page, model);
  // Zoomed in and selected: the export is still the whole diagram at natural size, unselected.
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.locator('.react-flow__node[data-id="LineItem"]').click();
  await expect(page.locator('.react-flow__node[data-id="LineItem"] .uml-node')).toHaveClass(/is-selected/);
  const drawn = await page.locator('.react-flow__viewport').evaluate(viewport => {
    const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
    const rects = [...viewport.querySelectorAll('.react-flow__node')].map(node => node.getBoundingClientRect());
    return { width: (Math.max(...rects.map(rect => rect.right)) - Math.min(...rects.map(rect => rect.left))) / zoom, height: (Math.max(...rects.map(rect => rect.bottom)) - Math.min(...rects.map(rect => rect.top))) / zoom };
  });

  const svg = await exportImage(page, 'SVG');
  expect(svg.name).toBe('all-native-orders.svg');
  const text = svg.data.toString('utf8');
  const parsed = await page.evaluate(markup => {
    const document = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const root = document.documentElement;
    return { error: document.querySelector('parsererror')?.textContent ?? '', name: root.localName, width: Number(root.getAttribute('width')), height: Number(root.getAttribute('height')), viewBox: root.getAttribute('viewBox'), text: root.textContent ?? '', markers: [...document.querySelectorAll('marker')].map(marker => marker.id), references: [...document.querySelectorAll('[marker-start], [marker-end]')].map(path => path.getAttribute('marker-start') ?? path.getAttribute('marker-end')) };
  }, text);
  expect(parsed.error).toBe('');
  expect(parsed.name).toBe('svg');
  expect(parsed.viewBox).toBe(`0 0 ${parsed.width} ${parsed.height}`);
  // The nodes plus a 24px margin on each side, rounded out to whole pixels; nothing else here reaches further.
  expect(Math.abs(parsed.width - (drawn.width + 48))).toBeLessThanOrEqual(3);
  expect(Math.abs(parsed.height - (drawn.height + 48))).toBeLessThanOrEqual(3);
  for (const name of ['Order', 'LineItem', '+ id: UUID', 'contains']) expect(parsed.text).toContain(name);
  expect(parsed.text).not.toContain('Other');
  expect(parsed.text).not.toContain('attributes');
  expect(text).not.toMatch(/react-flow__handle|is-selected|react-flow__minimap|react-flow__background/);
  expect(text).not.toMatch(/(?:href|src)="(?!#)|url\((?!#)/);
  // Arrow heads resolve inside the file, under ids no other export shares.
  expect(parsed.references).toContain(`url(#${parsed.markers.find(id => id.endsWith('uml-composition'))})`);
  expect(parsed.markers.every(id => /^aliot-[a-z0-9]+-uml-/.test(id))).toBe(true);

  const png = await exportImage(page, 'PNG');
  expect(png.name).toBe('all-native-orders.png');
  expect(png.data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect([png.data.readUInt32BE(16), png.data.readUInt32BE(20)]).toEqual([parsed.width * 2, parsed.height * 2]);

  // A fresh page draws the file on its own, at its natural size, with the theme colours.
  const viewer = await browser.newPage();
  await viewer.setContent('<body style="margin:0;background:#fff"></body>');
  const rendered = await viewer.evaluate(async markup => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return { width: image.naturalWidth, height: image.naturalHeight, corner: [...context.getImageData(2, 2, 1, 1).data] };
  }, text);
  expect([rendered.width, rendered.height]).toEqual([parsed.width, parsed.height]);
  expect(rendered.corner).toEqual([0x17, 0x1b, 0x22, 255]);
  await viewer.close();
  expect(errors).toEqual([]);
});

test('offers a transparent and a light background', async ({ page }) => {
  await load(page, model);
  const transparent = (await exportImage(page, 'SVG', 'Transparent')).data.toString('utf8');
  expect(transparent).toMatch(/class="aliot-export" style="[^"]*background: transparent/);
  const light = (await exportImage(page, 'SVG', 'Light background')).data.toString('utf8');
  expect(light).toContain('--vscode-editor-background: #ffffff');
  // The choice is remembered for the next export.
  const png = await exportImage(page, 'PNG');
  const [red, green, blue, alpha] = await page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const context = Object.assign(document.createElement('canvas'), { width: 4, height: 4 }).getContext('2d')!;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(1, 1, 1, 1).data];
  }, png.data.toString('base64'));
  expect([red, green, blue, alpha]).toEqual([255, 255, 255, 255]);
});

test('export is unavailable while the canvas is empty', async ({ page }) => {
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), '@startuml\n@enduml\n');
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Choose a diagram type' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export image' })).toBeDisabled();
});

test('a selected relationship exports without the grips that reshape and re-attach it', async ({ page }) => {
  await load(page, '@startuml\nclass Order\nclass LineItem\nOrder --> LineItem : contains\n@enduml\n');
  await page.locator('.edge-label', { hasText: 'contains' }).click();
  await expect(page.locator('.bend-grip')).not.toHaveCount(0);
  const text = (await exportImage(page, 'SVG')).data.toString('utf8');
  expect(text).toContain('contains');
  expect(text).not.toMatch(/bend-grip|edge-grip|react-flow__edgeupdater|drag-overlay|drop-hint/);
});
