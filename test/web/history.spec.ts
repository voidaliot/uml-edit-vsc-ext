import { test, expect, type Page } from '@playwright/test';

async function load(page: Page, source: string) {
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  await expect(page.locator('.react-flow__node')).not.toHaveCount(0);
}
async function source(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas' }).click();
  const value = await page.getByRole('textbox', { name: 'PlantUML source', exact: true }).inputValue();
  await page.getByRole('button', { name: 'Close source editor' }).click();
  return value;
}
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const place = async (page: Page, id: string) => { const box = (await node(page, id).boundingBox())!; return { x: Math.round(box.x), y: Math.round(box.y) }; };

test('an element placed where it was added is undone and redone in one step with its place', async ({ page }) => {
  const original = '@startuml\nclass A\nclass B\nA --> B\n@enduml';
  await load(page, original + '\n');
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 900, y: 600 } });
  await page.getByRole('menuitem', { name: 'class', exact: true }).click();
  await page.getByRole('textbox', { name: 'New element name' }).fill('Placed');
  await page.getByRole('button', { name: 'Add element', exact: true }).click();
  await expect(node(page, 'Placed')).toBeVisible();
  const dropped = await place(page, 'Placed');

  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await expect(node(page, 'Placed')).toHaveCount(0);
  expect(await source(page)).toBe(original);
  await page.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)' }).click();
  await expect(node(page, 'Placed')).toBeVisible();
  await expect.poll(() => place(page, 'Placed')).toEqual(dropped);
  // Nothing is left over on the redo side: one more redo changes nothing.
  await page.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)' }).click();
  expect(await place(page, 'Placed')).toEqual(dropped);
});

test('copies of hand-placed elements go back in one undo', async ({ page }) => {
  const original = '@startuml\nclass A\nclass B\n@enduml';
  await load(page, original + '\n');
  const box = (await node(page, 'A').locator('.node-title').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 60, box.y + 80, { steps: 10 }); await page.mouse.up();
  await node(page, 'A').click();
  await page.keyboard.press('Control+d');
  await expect(node(page, 'A2')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(node(page, 'A2')).toHaveCount(0);
  expect(await source(page)).toBe(original);
  // The drag made before the duplicate is still its own step.
  const moved = await place(page, 'A');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await place(page, 'A')).y).toBeLessThan(moved.y - 40);
});

test('snapping can be switched off from the toolbar', async ({ page }) => {
  await load(page, '@startuml\nclass A\nclass B\nclass C\n@enduml\n');
  const snap = page.getByRole('button', { name: 'Snap while dragging' });
  await expect(snap).toHaveAttribute('aria-pressed', 'true');
  const drag = async (expectGuides: boolean) => {
    const a = (await node(page, 'A').boundingBox())!, b = (await node(page, 'B').boundingBox())!, grab = (await node(page, 'B').locator('.node-title').boundingBox())!;
    // React Flow picks a node up on its first small move; the travel is measured from there.
    const x = grab.x + grab.width / 2 + 2, y = grab.y + grab.height / 2 + 2;
    await page.mouse.move(x - 2, y - 2); await page.mouse.down(); await page.mouse.move(x, y);
    // B's left edge three pixels right of A's, well below it.
    await page.mouse.move(x + a.x - b.x + 3, y + 300, { steps: 8 });
    if (expectGuides) await expect.poll(() => page.locator('.snap-guide').count()).toBeGreaterThan(0);
    const guides = await page.locator('.snap-guide').count();
    await page.mouse.up();
    return { guides, offset: Math.abs((await node(page, 'B').boundingBox())!.x - a.x) };
  };
  const snapped = await drag(true);
  expect(snapped.guides).toBeGreaterThan(0);
  expect(snapped.offset).toBeLessThan(0.5);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await snap.click();
  await expect(snap).toHaveAttribute('aria-pressed', 'false');
  const free = await drag(false);
  expect(free.guides).toBe(0);
  expect(free.offset).toBeGreaterThan(1.5);
});
