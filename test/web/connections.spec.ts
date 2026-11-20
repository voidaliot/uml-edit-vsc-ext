import { test, expect, type Page } from '@playwright/test';

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
const center = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** Drag a new connection out of one of the element's handles and release it at a screen point. */
async function dragFromHandle(page: Page, id: string, handle: string, to: { x: number; y: number }) {
  await node(page, id).locator('.sequence-head, .node-title').first().hover();
  const from = center((await node(page, id).locator(`.react-flow__handle[data-handleid="${handle}"]`).boundingBox())!);
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
}
/** Select a relationship by clicking its line, then drag one of its end grips to a screen point. */
async function dragEnd(page: Page, edgeId: string, end: 'source' | 'target', to: { x: number; y: number }) {
  const line = center((await page.locator(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-interaction`).boundingBox())!);
  await page.mouse.click(line.x, line.y);
  await expect(page.locator('.edge-grip')).toHaveCount(2);
  const grip = center((await page.locator(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edgeupdater-${end}`).boundingBox())!);
  await page.mouse.move(grip.x, grip.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
}

test('a connection released on empty canvas adds a connected element there in one source edit', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const original = '@startuml\nclass Order\nclass Customer\nOrder --> Customer\n@enduml';
  await load(page, original + '\n');
  const order = (await node(page, 'Order').boundingBox())!;
  const drop = { x: order.x + order.width + 260, y: order.y + 260 };
  await dragFromHandle(page, 'Order', 'right', drop);
  const chooser = page.getByRole('menu', { name: 'Add connected element' });
  await expect(chooser.getByRole('menuitem')).toHaveText([/class$/, /interface/, /abstract class/, /enum/, /annotation/, /Cancel/]);
  await chooser.getByRole('menuitem', { name: 'interface' }).click();
  await page.getByRole('textbox', { name: 'New element name' }).fill('Payable');
  await page.getByRole('button', { name: 'Add and connect' }).click();
  await expect(node(page, 'Payable')).toHaveClass(/selected/);
  const added = (await node(page, 'Payable').boundingBox())!;
  expect(Math.abs(added.x + 96 - drop.x)).toBeLessThan(3);
  expect(Math.abs(added.y + 40 - drop.y)).toBeLessThan(3);
  expect(await source(page)).toBe('@startuml\nclass Order\nclass Customer\nOrder --> Customer\ninterface Payable {\n}\nOrder --> Payable\n@enduml');
  // The placement and the source change are the usual two history steps of a placed element.
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await expect(node(page, 'Payable')).toHaveCount(0);
  expect(await source(page)).toBe(original);

  // Escape at either step leaves the source alone.
  await dragFromHandle(page, 'Order', 'right', drop);
  await expect(chooser).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(chooser).toHaveCount(0);
  await dragFromHandle(page, 'Order', 'right', drop);
  await chooser.getByRole('menuitem', { name: 'enum' }).click();
  await page.getByRole('textbox', { name: 'New element name' }).fill('Status');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Add connected element' })).toHaveCount(0);
  expect(await source(page)).toBe(original);
  expect(errors).toEqual([]);
});

test('a connection released on an element body links to that element', async ({ page }) => {
  await load(page, '@startuml\nclass A\nclass B\n@enduml\n');
  await dragFromHandle(page, 'A', 'right', center((await node(page, 'B').boundingBox())!));
  await expect(page.getByRole('dialog', { name: 'Edit relationship' })).toContainText('Connect elements');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit relationship' })).toHaveCount(0);
  expect(await source(page)).toBe('@startuml\nclass A\nclass B\nA --> B\n@enduml');
});

test('a message dragged off a lifeline adds a participant and the message at that row', async ({ page }) => {
  await load(page, '@startuml\nparticipant Web\nparticipant Api\nWeb -> Api : first\nApi --> Web : second\n@enduml\n');
  const row = center((await node(page, 'Api').locator('.react-flow__handle[data-handleid="sequence-1"]').boundingBox())!);
  await dragFromHandle(page, 'Api', 'sequence-1', { x: row.x + 300, y: row.y });
  await page.getByRole('menu', { name: 'Add connected element' }).getByRole('menuitem', { name: 'database' }).click();
  await page.getByRole('textbox', { name: 'New element name' }).fill('Store');
  await page.getByRole('button', { name: 'Add and connect' }).click();
  await expect(node(page, 'Store')).toBeVisible();
  expect(await source(page)).toBe('@startuml\nparticipant Web\nparticipant Api\ndatabase Store\nWeb -> Api : first\nApi -> Store\nApi --> Web : second\n@enduml');
});

test('either end of a selected relationship can be re-attached to another element', async ({ page }) => {
  const original = '@startuml\nclass A\nclass B\nclass C\nA "1" *-- "many" B : owns \' keep\n@enduml';
  await load(page, original + '\n');
  // Unselected relationships offer no end grips, so a drag near an end still starts a new connection.
  await expect(page.locator('.react-flow__edgeupdater')).toHaveCount(0);
  const c = (await node(page, 'C').boundingBox())!;
  await dragEnd(page, 'relation-4-0', 'target', center(c));
  await expect.poll(() => source(page)).toBe('@startuml\nclass A\nclass B\nclass C\nA "1" *-- "many" C : owns \' keep\n@enduml');
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await expect.poll(() => source(page)).toBe(original);

  // Released on empty canvas, the relationship stays as it was and nothing else is offered.
  await dragEnd(page, 'relation-4-0', 'source', { x: c.x + c.width + 160, y: c.y + 320 });
  await expect(page.getByRole('menu', { name: 'Add connected element' })).toHaveCount(0);
  expect(await source(page)).toBe(original);

  // A handle of the new element works as well as its body.
  await dragEnd(page, 'relation-4-0', 'source', { x: c.x, y: c.y + c.height / 2 });
  await expect.poll(() => source(page)).toBe('@startuml\nclass A\nclass B\nclass C\nC "1" *-- "many" B : owns \' keep\n@enduml');
});

test('reconnecting keeps the initial pseudo-state of a transition', async ({ page }) => {
  await load(page, '@startuml\n[*] --> Idle\nIdle --> Busy\nBusy --> [*]\n@enduml\n');
  await dragEnd(page, 'relation-1-0', 'target', center((await node(page, 'Busy').boundingBox())!));
  await expect.poll(() => source(page)).toBe('@startuml\n[*] --> Busy\nIdle --> Busy\nBusy --> [*]\n@enduml');
});

test('reconnecting refuses to lose an element that only the relationship declares', async ({ page }) => {
  await load(page, '@startuml\nclass A\nclass C\nA --> B\n@enduml\n');
  await dragEnd(page, 'relation-3-0', 'target', center((await node(page, 'C').boundingBox())!));
  await expect(page.getByRole('alert')).toContainText('exists only through this relationship');
  expect(await source(page)).toBe('@startuml\nclass A\nclass C\nA --> B\n@enduml');
});

test('a selected relationship is shaped with bends that share the undo history and Re-layout clears', async ({ page }) => {
  await load(page, '@startuml\nclass A\nclass B\nclass C\nA --> B : uses\n@enduml\n');
  const path = page.locator('.react-flow__edge[data-id="relation-4-0"] path.react-flow__edge-path');
  const straight = await path.getAttribute('d');
  const line = center((await page.locator('.react-flow__edge[data-id="relation-4-0"] .react-flow__edge-interaction').boundingBox())!);
  await page.mouse.click(line.x, line.y);
  // One grip in the middle of the only segment; dragging it adds a bend there.
  await expect(page.locator('.bend-grip.add')).toHaveCount(1);
  const add = center((await page.locator('.bend-grip.add').boundingBox())!);
  await page.mouse.move(add.x, add.y); await page.mouse.down(); await page.mouse.move(add.x - 220, add.y, { steps: 10 }); await page.mouse.up();
  await expect(page.locator('.bend-grip:not(.add)')).toHaveCount(1);
  await expect(page.locator('.bend-grip.add')).toHaveCount(2);
  const bent = await path.getAttribute('d');
  expect(bent).not.toBe(straight);
  // Dragging the bend moves it; the source is never touched.
  const bend = center((await page.locator('.bend-grip:not(.add)').boundingBox())!);
  await page.mouse.move(bend.x, bend.y); await page.mouse.down(); await page.mouse.move(bend.x, bend.y - 70, { steps: 10 }); await page.mouse.up();
  await expect(path).not.toHaveAttribute('d', bent!);
  const moved = await path.getAttribute('d');
  expect(await source(page)).toBe('@startuml\nclass A\nclass B\nclass C\nA --> B : uses\n@enduml');

  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await expect(path).toHaveAttribute('d', bent!);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await expect(path).toHaveAttribute('d', straight!);
  await page.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)' }).click();
  await page.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)' }).click();
  await expect(path).toHaveAttribute('d', moved!);

  // An edit above the relationship changes its line, not its bends.
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas' }).click();
  await page.getByRole('textbox', { name: 'PlantUML source', exact: true }).fill('@startuml\nclass A\nclass B\nclass C\nC --> A\nA --> B : uses\n@enduml');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await page.getByRole('button', { name: 'Close source editor' }).click();
  const shifted = page.locator('.react-flow__edge[data-id="relation-5-1"] path.react-flow__edge-path');
  await expect(shifted).toHaveAttribute('d', /Q/);

  // Double-clicking a bend removes it, without opening the relationship dialog.
  await page.locator('.react-flow__edge[data-id="relation-5-1"]').dispatchEvent('click');
  await page.locator('.bend-grip:not(.add)').dblclick();
  await expect(shifted).not.toHaveAttribute('d', /Q/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await expect(shifted).toHaveAttribute('d', /Q/);
  await page.getByRole('button', { name: 'Re-layout diagram' }).click();
  await expect(shifted).not.toHaveAttribute('d', /Q/);
});

test('sequence messages have no bend grips', async ({ page }) => {
  await load(page, '@startuml\nparticipant Web\nparticipant Api\nWeb -> Api : load\n@enduml\n');
  await page.getByRole('button', { name: /Edit relationship load/ }).click();
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1);
  await expect(page.locator('.bend-grip')).toHaveCount(0);
});

test('structure-derived connections offer neither grips nor quick add', async ({ page }) => {
  await load(page, '@startuml\nstart\n:One;\n:Two;\nstop\n@enduml\n');
  const edge = page.locator('.react-flow__edge').first();
  const line = center((await edge.locator('.react-flow__edge-interaction').boundingBox())!);
  await page.mouse.click(line.x, line.y);
  await expect(page.locator('.react-flow__edgeupdater')).toHaveCount(0);
  await expect(page.locator('.edge-grip')).toHaveCount(0);
});
