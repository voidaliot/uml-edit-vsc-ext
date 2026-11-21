import { test, expect, type Page } from '@playwright/test';

async function load(page: Page, source: string) {
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Edit PlantUML source in canvas' })).toBeVisible();
}
async function source(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas' }).click();
  const value = await page.getByRole('textbox', { name: 'PlantUML source', exact: true }).inputValue();
  await page.getByRole('button', { name: 'Close source editor' }).click();
  return value;
}
async function add(page: Page, kind: string, name: string) {
  await page.locator('.palette-list').getByRole('button', { name: kind, exact: true }).click();
  await page.getByRole('textbox', { name: 'New element name' }).fill(name);
  await page.getByRole('button', { name: 'Add element', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add element', exact: true })).toBeHidden();
}
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
async function boxes(page: Page) {
  return await page.locator('.react-flow__node').evaluateAll(nodes => Object.fromEntries(nodes.map(item => { const rect = item.getBoundingClientRect(); return [(item as HTMLElement).dataset.id!, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }]; })));
}
async function drag(page: Page, id: string, dx: number, dy: number) {
  const box = (await node(page, id).locator('.node-title').boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up();
}

test('an empty diagram asks for its type and is then built element by element', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await load(page, '@startuml\n@enduml\n');
  const chooser = page.getByRole('group', { name: 'Choose a diagram type' });
  await expect(chooser).toBeVisible();
  await expect(page.locator('.palette-list')).toHaveCount(0);
  await chooser.getByRole('button', { name: /^State machine/ }).click();
  await expect(page.getByRole('combobox', { name: 'Current diagram' })).toContainText('State machine');
  await add(page, 'state', 'Idle');
  await add(page, 'state', 'In progress');
  // The initial symbol is one end of a transition, so it needs a state to point at.
  await page.keyboard.press('Escape');
  await page.locator('.palette-list').getByRole('button', { name: 'initial', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Select a state first');
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await node(page, 'Idle').click();
  await page.locator('.palette-list').getByRole('button', { name: 'initial', exact: true }).click();
  await node(page, 'InProgress').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add final transition' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  expect(await source(page)).toBe('@startuml\nstate Idle\nstate "In progress" as InProgress\n[*] --> Idle\nInProgress --> [*]\n@enduml');
  expect(errors).toEqual([]);
});

test('the chosen type survives shared symbols and emptying the diagram again', async ({ page }) => {
  await load(page, '@startuml\n@enduml\n');
  await page.getByRole('group', { name: 'Choose a diagram type' }).getByRole('button', { name: /^Use case/ }).click();
  // An actor alone is also valid in a sequence diagram; the canvas must not turn into one.
  await add(page, 'actor', 'Customer');
  await expect(page.locator('.sequence-node')).toHaveCount(0);
  await expect(page.locator('.palette-list').getByRole('button', { name: 'usecase', exact: true })).toBeVisible();
  await add(page, 'usecase', 'Place order');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  await expect(page.locator('.palette-list').getByRole('button', { name: 'usecase', exact: true })).toBeVisible();
  // The type stays correctable while the source does not settle it.
  await page.getByRole('combobox', { name: 'Diagram type' }).selectOption('sequence');
  await expect(page.locator('.palette-list').getByRole('button', { name: 'participant', exact: true })).toBeVisible();
});

test('the gallery starts a blank diagram of the picked type', async ({ page }) => {
  await load(page, '@startuml\nclass Existing\n@enduml\n');
  await page.getByRole('button', { name: 'New diagram', exact: true }).click();
  await page.getByRole('radio', { name: 'Blank' }).click();
  await page.getByRole('dialog', { name: 'Create a new diagram' }).getByRole('button', { name: /^Sequence/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  await expect(page.getByText('Your canvas is ready')).toBeVisible();
  await page.getByRole('button', { name: 'Add participant' }).click();
  await page.getByRole('textbox', { name: 'New element name' }).fill('Web app');
  await page.getByRole('button', { name: 'Add element', exact: true }).click();
  await expect(page.locator('.sequence-node')).toHaveCount(1);
  expect(await source(page)).toBe('@startuml\nparticipant "Web app" as WebApp\n@enduml');
  // Families without a palette keep their example as the starting point.
  await page.getByRole('button', { name: 'New diagram', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Blank' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('dialog', { name: 'Create a new diagram' }).getByRole('button', { name: /^JSON/ }).click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
});

test('palette additions are laid out, never stacked, and select what was added', async ({ page }) => {
  await load(page, '@startuml\nclass First\n@enduml\n');
  for (const name of ['Second', 'Third', 'Fourth']) await add(page, 'class', name);
  const placed = Object.values(await boxes(page));
  expect(placed).toHaveLength(4);
  for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) {
    const p = placed[a], q = placed[b];
    expect(p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y).toBe(true);
  }
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(node(page, 'Fourth')).toHaveClass(/selected/);
  for (const item of placed) { expect(item.x).toBeGreaterThanOrEqual(0); expect(item.y).toBeGreaterThanOrEqual(0); }
});

test('a selection is deleted as one step, by keyboard, toolbar or menu', async ({ page }) => {
  const original = '@startuml\nclass A\nclass B\nclass C\nclass D\nA --> B : one\nB --> C\nC --> D\n@enduml';
  await load(page, original + '\n');
  const remove = page.getByRole('button', { name: 'Delete selection', exact: true });
  await expect(remove).toBeDisabled();
  await node(page, 'A').click();
  await node(page, 'B').click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(remove).toBeEnabled();
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  expect(await source(page)).toBe('@startuml\nclass C\nclass D\nC --> D\n@enduml');
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  expect(await source(page)).toBe(original);

  // A relationship is picked through its label and removed without its ends.
  await page.locator('.edge-label', { hasText: 'one' }).click();
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1);
  await remove.click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await expect(page.locator('.react-flow__node')).toHaveCount(4);

  // A right-click inside a selection offers the whole selection.
  await page.keyboard.press('Control+a');
  await node(page, 'C').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Delete 6 items/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  expect(await source(page)).toBe('@startuml\n@enduml');
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
});

test('an activity decision is deleted with its branches', async ({ page }) => {
  await load(page, '@startuml\nstart\n:Receive;\nif (Valid?) then (yes)\n  :Accept;\nelse (no)\n  :Reject;\nendif\nstop\n@enduml\n');
  await page.locator('.uml-node.kind-decision').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.uml-node.kind-decision')).toHaveCount(0);
  expect(await source(page)).toBe('@startuml\nstart\n:Receive;\nstop\n@enduml');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a marquee does not select text, and its box drags the whole selection', async ({ page }) => {
  await load(page, '@startuml\nclass A\nclass B\nclass C\n@enduml\n');
  const before = await boxes(page);
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  const left = Math.min(before.A.x, before.B.x) - 30, top = Math.min(before.A.y, before.B.y) - 30;
  const right = Math.max(before.A.x + before.A.width, before.B.x + before.B.width) + 20, bottom = Math.max(before.A.y + before.A.height, before.B.y + before.B.height) + 20;
  expect(left).toBeGreaterThan(pane.x);
  await page.mouse.move(left, top); await page.mouse.down(); await page.mouse.move((left + right) / 2, (top + bottom) / 2, { steps: 6 }); await page.mouse.move(right, bottom, { steps: 6 }); await page.mouse.up();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  expect(await page.evaluate(() => getSelection()?.toString() ?? '')).toBe('');
  const selection = (await page.locator('.react-flow__nodesselection-rect').boundingBox())!;
  await page.mouse.move(selection.x + 6, selection.y + 6); await page.mouse.down(); await page.mouse.move(selection.x + 96, selection.y + 66, { steps: 10 }); await page.mouse.up();
  const after = await boxes(page);
  // Both move by the same amount (the pointer travel less the drag threshold).
  expect(after.A.x - before.A.x).toBeGreaterThan(60); expect(after.A.y - before.A.y).toBeGreaterThan(40);
  expect(after.B.x - before.B.x).toBeCloseTo(after.A.x - before.A.x, 1); expect(after.B.y - before.B.y).toBeCloseTo(after.A.y - before.A.y, 1);
  expect(after.C).toEqual(before.C);
  // The move is a placement step of its own: undo puts both back.
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await expect.poll(async () => (await boxes(page)).A).toEqual(before.A);
  expect((await boxes(page)).B).toEqual(before.B);
});

test('a package follows a class dragged across it and alignment lines a selection up', async ({ page }) => {
  await load(page, '@startuml\npackage Core {\n  class A\n  class B\n}\nclass C\nA --> B\n@enduml\n');
  const inside = async () => { const all = await boxes(page); for (const id of ['A', 'B']) { expect(all[id].x).toBeGreaterThan(all.Core.x); expect(all[id].y).toBeGreaterThan(all.Core.y); expect(all[id].x + all[id].width).toBeLessThan(all.Core.x + all.Core.width); expect(all[id].y + all[id].height).toBeLessThan(all.Core.y + all.Core.height); } return all; };
  const before = await inside();
  await drag(page, 'B', 260, 40);
  const widened = await inside();
  expect(widened.Core.width).toBeGreaterThan(before.Core.width + 150);
  expect(widened.A).toEqual(before.A);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Arrange selection' })).toHaveCount(0);
  await node(page, 'A').click();
  await node(page, 'B').click({ modifiers: ['Shift'] });
  await page.getByRole('group', { name: 'Arrange selection' }).getByRole('button', { name: 'Align top edges' }).click();
  await expect.poll(async () => { const all = await boxes(page); return Math.abs(all.A.y - all.B.y); }).toBeLessThan(1);
  const aligned = await inside();
  expect(aligned.Core.height).toBeLessThan(widened.Core.height);
  // Re-layout returns to the automatic arrangement.
  await page.getByRole('button', { name: 'Re-layout diagram', exact: true }).click();
  await expect.poll(async () => { const all = await boxes(page); return all.B.y - all.A.y; }).toBeGreaterThan(50);
  await inside();
});

test('a link across several ranks bends around the boxes between its ends until one end is moved', async ({ page }) => {
  await load(page, '@startuml\nclass A\nclass B\nclass C\nA --> B\nB --> C\nA --> C\n@enduml\n');
  const long = page.locator('.react-flow__edge').filter({ has: page.locator('[aria-label], path') }).nth(2).locator('path.react-flow__edge-path');
  const segments = async () => ((await long.getAttribute('d')) ?? '').match(/[LQ]/g)?.length ?? 0;
  expect(await segments()).toBeGreaterThan(1);
  const all = await boxes(page);
  // The lane runs beside B, not through it.
  const lane = await long.evaluate((path, y) => { const shape = path as SVGPathElement, total = shape.getTotalLength(); let best = shape.getPointAtLength(0); for (let at = 0; at <= total; at += 2) { const point = shape.getPointAtLength(at), screen = point.matrixTransform(shape.getScreenCTM()!); if (Math.abs(screen.y - y) < Math.abs(best.matrixTransform(shape.getScreenCTM()!).y - y)) best = point; } return best.matrixTransform(shape.getScreenCTM()!).x; }, all.B.y + all.B.height / 2);
  expect(lane < all.B.x || lane > all.B.x + all.B.width).toBe(true);
  await drag(page, 'C', 220, 30);
  await expect.poll(segments).toBe(1);
});
