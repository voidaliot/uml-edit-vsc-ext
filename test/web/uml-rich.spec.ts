import { test, expect, type Page, type Locator } from '@playwright/test';
import { nativeTemplates } from '../../src/core/templates';
import { parseDocument } from '../../src/core/parser';

async function load(page: Page, source: string) {
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  await expect(page.locator('.react-flow__node')).toHaveCount(parseDocument(source).diagrams[0].elements.length);
  await expect(page.locator('.uml-node').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fit diagram (F)', exact: true }).click();
  await page.waitForTimeout(300);
}

async function readSource(page: Page) {
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas' }).click();
  const value = await page.getByRole('textbox', { name: 'PlantUML source', exact: true }).inputValue();
  await page.getByRole('button', { name: 'Close source editor' }).click();
  return value;
}

async function drag(page: Page, target: Locator, dx: number, dy: number) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up();
}

test('moving nested containers preserves child placement and context creation writes inside the selected package', async ({ page }) => {
  const source = '@startuml\npackage "Domain" as Domain {\n  package "Orders" as Orders {\n    class "Order" as Order\n  }\n}\nclass "Service" as Service\nService --> Order : reads\n@enduml\n';
  await load(page, source);
  const group = page.locator('.uml-node[data-element-id="Domain"]');
  const nested = page.locator('.uml-node[data-element-id="Orders"]');
  const child = page.locator('.uml-node[data-element-id="Order"]');
  const start = await group.boundingBox(), childStart = await child.boundingBox(), nestedStart = await nested.boundingBox();
  await drag(page, group.locator('.node-name'), 65, 50);
  const moved = await group.boundingBox(), childMoved = await child.boundingBox(), nestedMoved = await nested.boundingBox();
  expect(moved!.x - start!.x).toBeGreaterThan(40);
  expect(childMoved!.x - childStart!.x).toBeCloseTo(moved!.x - start!.x, 0);
  expect(nestedMoved!.y - nestedStart!.y).toBeCloseTo(moved!.y - start!.y, 0);
  expect((await readSource(page)).trim()).toBe(source.trim());
  await nested.locator('.node-name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add class inside', exact: true }).click();
  await page.getByRole('textbox', { name: 'New element name' }).fill('Invoice');
  await page.getByRole('button', { name: 'Add element', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add element', exact: true })).toBeHidden();
  const updated = await readSource(page), parsed = parseDocument(updated).diagrams[0];
  expect(parsed.graphical).toBe(true);
  expect(parsed.elements.find(element => element.name === 'Invoice')?.parentId).toBe('Orders');
  expect(updated).toContain('Service --> Order : reads');
});

for (const kind of ['gantt', 'chronology'] as const) test(`${kind}: dragging updates source dates and undo restores them`, async ({ page }) => {
  const template = nativeTemplates.find(template => template.kind === kind)!;
  await load(page, template.source);
  const initial = parseDocument(template.source).diagrams[0];
  const element = initial.elements.find(element => element.meta?.moveEdit)!;
  expect(element).toBeDefined();
  const selector = `.uml-node[data-element-id=${JSON.stringify(element.id)}]`;
  await drag(page, page.locator(selector).locator('.node-name'), 85, 0);
  const changed = await readSource(page);
  expect(changed.trim()).not.toBe(template.source.trim());
  const parsed = parseDocument(changed).diagrams[0];
  expect(parsed.graphical).toBe(true);
  expect(parsed.elements.filter(element => element.meta?.moveEdit).map(element => element.name)).toEqual(initial.elements.filter(element => element.meta?.moveEdit).map(element => element.name));
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click();
  expect((await readSource(page)).trim()).toBe(template.source.trim());
});
