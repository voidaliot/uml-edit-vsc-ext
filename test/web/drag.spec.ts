import { test, expect, type Page } from '@playwright/test';

const model = `@startuml
' Ordering model
package Sales {
  class Order {
    +id : int
  }
  class Line
}
package Billing {
  class Invoice
}
class Customer
Customer --> Order : places
Order *-- Line
@enduml
`;

async function load(page: Page, source: string) {
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
}
async function source(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas' }).click();
  const value = await page.getByRole('textbox', { name: 'PlantUML source', exact: true }).inputValue();
  await page.getByRole('button', { name: 'Close source editor' }).click();
  return value;
}
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const box = async (page: Page, id: string) => (await node(page, id).boundingBox())!;
/** Press on a node's title and start dragging it. React Flow picks the node up on the first small move, so later moves are relative to that point. */
async function press(page: Page, id: string) {
  const title = (await node(page, id).locator('.node-title').boundingBox())!;
  const x = title.x + title.width / 2, y = title.y + title.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 2, y + 2);
  return { x: x + 2, y: y + 2 };
}

test('a dragged element snaps to the edges and centres of the others, with guides, unless Alt is held', async ({ page }) => {
  await load(page, model);
  const customer = await box(page, 'Customer'), invoice = await box(page, 'Invoice');
  const start = await press(page, 'Customer');
  // Three pixels right of the invoice's left edge, well below it.
  const target = { x: start.x + invoice.x - customer.x + 3, y: start.y + invoice.y + invoice.height + 150 - customer.y };
  await page.mouse.move(target.x, target.y, { steps: 8 });
  // A guide is a zero-width line, so count it rather than ask whether it is visible.
  await expect.poll(() => page.locator('.snap-guide').count()).toBeGreaterThan(0);
  await page.mouse.up();
  await expect(page.locator('.snap-guide')).toHaveCount(0);
  // Within a few pixels of the invoice's left edge, it lands exactly on the nearest vertical line of another node.
  const snapped = await box(page, 'Customer');
  expect(Math.abs(snapped.x - invoice.x - 3)).toBeLessThanOrEqual(6);
  const lines = (await Promise.all(['Sales', 'Order', 'Line', 'Billing', 'Invoice'].map(id => box(page, id)))).flatMap(other => [other.x, other.x + other.width / 2, other.x + other.width]);
  expect(Math.min(...[snapped.x, snapped.x + snapped.width / 2, snapped.x + snapped.width].flatMap(mine => lines.map(line => Math.abs(line - mine))))).toBeLessThan(.5);
  // Alt places freely, and nothing is drawn.
  const again = await press(page, 'Customer');
  await page.keyboard.down('Alt');
  await page.mouse.move(again.x + 3, again.y + 40, { steps: 4 });
  await expect(page.locator('.snap-guide')).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect((await box(page, 'Customer')).x).toBeCloseTo(snapped.x + 3, 0);
  // Placement only: the source is untouched.
  expect(await source(page)).toBe(model.trimEnd());
});

test('dragging an element clear of its package takes it out, and dropping it on another package moves it in', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await load(page, model);
  const sales = await box(page, 'Sales');
  // Rearranging inside keeps the membership; the package follows.
  let start = await press(page, 'Line');
  await page.mouse.move(start.x + 20, start.y + 30, { steps: 4 });
  await expect(page.locator('.drop-hint')).toHaveCount(0);
  await page.mouse.up();
  expect(await source(page)).toBe(model.trimEnd());
  // Clear of the package, the package lets go and the hint says what a release does.
  const line = await box(page, 'Line');
  start = await press(page, 'Line');
  await page.mouse.move(start.x + sales.width + 300, start.y, { steps: 12 });
  await expect(page.locator('.drop-hint')).toContainText('Release to take “Line” out of “Sales” to the top level');
  expect((await box(page, 'Sales')).height).toBeLessThan(sales.height);
  await page.mouse.up();
  await expect(page.locator('.drop-hint')).toHaveCount(0);
  await expect.poll(() => source(page)).toBe("@startuml\nclass Line\n' Ordering model\npackage Sales {\n  class Order {\n    +id : int\n  }\n}\npackage Billing {\n  class Invoice\n}\nclass Customer\nCustomer --> Order : places\nOrder *-- Line\n@enduml");
  const dropped = await box(page, 'Line');
  expect(dropped.x).toBeGreaterThan(line.x + sales.width);
  // Onto another package: it is highlighted while the element is over it.
  const billing = await box(page, 'Billing');
  start = await press(page, 'Line');
  await page.mouse.move(billing.x + billing.width / 2, billing.y + billing.height - 20, { steps: 12 });
  await expect(page.locator('.drop-target')).toBeVisible();
  await expect(page.locator('.drop-hint')).toContainText('Release to move “Line” into “Billing”');
  await page.mouse.up();
  await expect.poll(() => source(page)).toContain('package Billing {\n  class Invoice\n  class Line\n}');
  const inside = await box(page, 'Line'), grown = await box(page, 'Billing');
  expect(inside.x).toBeGreaterThanOrEqual(grown.x); expect(inside.y + inside.height).toBeLessThanOrEqual(grown.y + grown.height);
  // Each move is one step: the edit and the place the element was dropped at go back together.
  await page.keyboard.press('Control+z');
  await expect.poll(() => source(page)).toContain("@startuml\nclass Line\n' Ordering model");
  await expect.poll(async () => (await box(page, 'Line')).x).toBeCloseTo(dropped.x, 0);
  await page.keyboard.press('Control+z');
  await expect.poll(() => source(page)).toBe(model.trimEnd());
  // Redo brings back the move and its place as one step too.
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => source(page)).toContain("@startuml\nclass Line\n' Ordering model");
  await expect.poll(async () => (await box(page, 'Line')).x).toBeCloseTo(dropped.x, 0);
  expect(errors).toEqual([]);
});

test('the context menu moves an element into a container or to the top level without dragging', async ({ page }) => {
  await load(page, model);
  await node(page, 'Customer').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Top level' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: /^Billing/ }).click();
  await expect.poll(() => source(page)).toContain('package Billing {\n  class Invoice\n  class Customer\n}');
  await node(page, 'Order').click({ button: 'right' });
  // Its own package is not offered; the top level is.
  await expect(page.getByRole('menuitem', { name: /^Sales/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Top level' }).click();
  await expect.poll(() => source(page)).toContain("@startuml\nclass Order {\n  +id : int\n}\n' Ordering model\npackage Sales {\n  class Line\n}");
  // A package cannot be moved into itself, and is offered nowhere it could not go.
  await node(page, 'Sales').click({ button: 'right', position: { x: 40, y: 30 } });
  await expect(page.getByRole('menuitem', { name: /^Sales/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /^Billing/ })).toBeVisible();
});

test('states move between composite states, but concurrent regions stay in the source', async ({ page }) => {
  const machine = '@startuml\nstate Idle\nstate Active {\n  state Working\n}\nstate Parallel {\n  state Left\n  --\n  state Right\n}\n[*] --> Idle\nIdle --> Active\n@enduml\n';
  await load(page, machine);
  await node(page, 'Left').click({ button: 'right' });
  await expect(page.locator('.context-subheading')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await node(page, 'Idle').click({ button: 'right' });
  // A state split into regions cannot take a moved state.
  await expect(page.getByRole('menuitem', { name: /^Parallel/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: /^Active/ }).click();
  await expect.poll(() => source(page)).toContain('state Active {\n  state Working\n  state Idle\n}');
  // Dragging over a state with regions is refused, and says so.
  const parallel = await box(page, 'Parallel');
  await press(page, 'Working');
  await page.mouse.move(parallel.x + parallel.width / 2, parallel.y + 30, { steps: 12 });
  await expect(page.locator('.drop-hint')).toContainText('cannot hold');
  await page.mouse.up();
  expect(await source(page)).toContain('state Active {\n  state Working\n  state Idle\n}');
});
