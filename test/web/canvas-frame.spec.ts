import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';

for (const width of [960, 1440]) for (const outline of [true, false]) test(`canvas fills the ${width}px webview frame with outline ${outline ? 'open' : 'closed'}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 850 });
  // VS Code inserts its webview stylesheet before the extension stylesheet.
  // Reproduce that body padding here instead of testing only the bare browser.
  await page.route('**/*', async route => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    const body = (await response.text()).replace('<head>', '<head><style id="emulated-webview-host">body { padding: 0 20px; }</style>');
    await route.fulfill({ response, body });
  });
  await page.goto('/?example=class');
  await expect(page.locator('.uml-node').first()).toBeVisible();
  if (!outline) await page.getByRole('button', { name: 'Toggle outline', exact: true }).click();
  const frame = await page.evaluate(() => {
    const box = (selector: string) => { const rect = document.querySelector(selector)!.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }; };
    const body = getComputedStyle(document.body);
    return { viewport: innerWidth, height: innerHeight, bodyPadding: [body.paddingLeft, body.paddingRight], app: box('.app-shell'), toolbar: box('.editor-toolbar'), workspace: box('.workspace'), canvas: box('.canvas-shell'), outline: document.querySelector('.outline') ? box('.outline') : undefined, scrollWidth: document.documentElement.scrollWidth };
  });
  expect(frame.bodyPadding).toEqual(['0px', '0px']);
  for (const [name, box] of Object.entries({ app: frame.app, toolbar: frame.toolbar, workspace: frame.workspace })) {
    expect(Math.abs(box.x), `${name} reaches the viewport's left edge`).toBeLessThan(1);
    expect(Math.abs(box.right - width), `${name} reaches the viewport's right edge`).toBeLessThan(1);
    expect(Math.abs(box.width - width), `${name} uses the full frame width`).toBeLessThan(1);
  }
  expect(Math.abs(frame.canvas.right - width)).toBeLessThan(1);
  expect(Math.abs(frame.canvas.bottom - frame.height)).toBeLessThan(1);
  if (outline) {
    expect(frame.outline).toBeDefined();
    expect(Math.abs(frame.outline!.x)).toBeLessThan(1);
    expect(Math.abs(frame.canvas.x - frame.outline!.right)).toBeLessThan(1);
  } else expect(Math.abs(frame.canvas.x)).toBeLessThan(1);
  expect(frame.scrollWidth).toBeLessThanOrEqual(width);
  await mkdir(resolve('.cache/canvas-frame'), { recursive: true });
  await page.screenshot({ path: resolve(`.cache/canvas-frame/${width}-${outline ? 'outline' : 'canvas'}.png`) });
});
