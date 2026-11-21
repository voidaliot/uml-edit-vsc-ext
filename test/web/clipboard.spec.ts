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
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const selected = (page: Page) => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(item => (item as HTMLElement).dataset.id).sort());
async function boxes(page: Page) {
  return await page.locator('.react-flow__node').evaluateAll(nodes => nodes.map(item => { const rect = item.getBoundingClientRect(); return { id: (item as HTMLElement).dataset.id!, x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }));
}
async function drag(page: Page, id: string, dx: number, dy: number) {
  const box = (await node(page, id).locator('.node-title').boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up();
}
const order = '@startuml\nclass Order {\n  +number: String\n}\nclass "Line item" as LineItem\nOrder *-- LineItem : contains\n@enduml\n';

test('duplicate, copy and paste insert renamed copies as one undoable edit and select them', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await load(page, order);
  await node(page, 'Order').click();
  await page.keyboard.press('Control+d');
  await expect(node(page, 'Order2')).toBeVisible();
  expect(await selected(page)).toEqual(['Order2']);
  expect(await source(page)).toBe('@startuml\nclass Order {\n  +number: String\n}\nclass "Line item" as LineItem\nOrder *-- LineItem : contains\nclass "Order" as Order2 {\n  +number: String\n}\n@enduml');
  await page.keyboard.press('Control+z');
  await expect(node(page, 'Order2')).toHaveCount(0);

  // A selection with its relationship pastes as a connected group.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(node(page, 'LineItem2')).toBeVisible();
  expect(await selected(page)).toEqual(['LineItem2', 'Order2']);
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1);
  expect(await source(page)).toContain('class "Line item" as LineItem2\nOrder2 *-- LineItem2 : contains\n@enduml');
  // The clipboard stays: a second paste counts on.
  await page.keyboard.press('Control+v');
  await expect(node(page, 'Order3')).toBeVisible();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  expect(await source(page)).toBe(order.trimEnd());
  expect(errors).toEqual([]);
});

test('copies of hand-placed elements land beside the originals, not on them', async ({ page }) => {
  await load(page, order);
  await drag(page, 'Order', 260, 0);
  await drag(page, 'LineItem', 260, 0);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+d');
  await expect(node(page, 'LineItem2')).toBeVisible();
  await page.getByRole('button', { name: 'Fit diagram (F)' }).click();
  await page.waitForTimeout(300);
  const all = await boxes(page);
  for (const copy of all.filter(box => box.id.endsWith('2'))) for (const other of all.filter(box => box.id !== copy.id)) {
    const overlap = copy.x < other.x + other.width && other.x < copy.x + copy.width && copy.y < other.y + other.height && other.y < copy.y + copy.height;
    expect(overlap, `${copy.id} overlaps ${other.id}`).toBe(false);
  }
  // The copies keep the arrangement of the originals.
  const at = (id: string) => all.find(box => box.id === id)!;
  expect(Math.abs((at('LineItem2').x - at('Order2').x) - (at('LineItem').x - at('Order').x))).toBeLessThan(2);
  expect(Math.abs((at('LineItem2').y - at('Order2').y) - (at('LineItem').y - at('Order').y))).toBeLessThan(2);
});

test('cut and paste through the context menu, also into another diagram of the same family', async ({ page }) => {
  await load(page, '@startuml\nclass Order\nclass Customer\nCustomer --> Order\n@enduml\n\n@startuml\nclass Invoice\n@enduml\n\n@startuml\n[*] --> Idle\n@enduml\n');
  await page.keyboard.press('Control+a');
  await node(page, 'Order').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Cut/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  const diagrams = page.getByRole('combobox', { name: 'Current diagram' });
  await diagrams.selectOption({ index: 1 });
  await expect(node(page, 'Invoice')).toBeVisible();
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 40, y: 40 } });
  await page.getByRole('menuitem', { name: /^Paste/ }).click();
  await expect(node(page, 'Customer')).toBeVisible();
  expect(await source(page)).toBe('@startuml\nclass Invoice\nclass Order\nclass Customer\nCustomer --> Order\n@enduml');
  // A different family refuses the paste and leaves its source alone.
  await diagrams.selectOption({ index: 2 });
  await expect(node(page, 'Idle')).toBeVisible();
  await page.keyboard.press('Control+v');
  await expect(page.getByRole('alert')).toContainText('copied from a class diagram and cannot be pasted into a state machine diagram');
  expect(await source(page)).toBe('@startuml\n[*] --> Idle\n@enduml');
});

test('clipboard shortcuts leave typing alone and are refused where copies are not faithful', async ({ page }) => {
  await load(page, '@startuml\nparticipant A\nparticipant B\nA -> B : hi\n@enduml\n');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await expect(page.getByRole('alert')).toContainText('not available in sequence diagrams');
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await node(page, 'A').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /^Copy/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Ctrl+C and Ctrl+V inside the source panel stay text editing.
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas' }).click();
  const text = page.getByRole('textbox', { name: 'PlantUML source', exact: true });
  await text.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+d');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await text.inputValue()).toBe('@startuml\nparticipant A\nparticipant B\nA -> B : hi\n@enduml');
});

test('the outline finds elements and the shortcut reference lists the real keys', async ({ page }) => {
  await load(page, '@startuml\nclass Order\nclass Customer\ninterface Payable\nCustomer --> Order\n@enduml\n');
  await page.keyboard.press('Control+f');
  const find = page.getByRole('searchbox', { name: 'Find element' });
  await expect(find).toBeFocused();
  await find.fill('pay');
  await expect(page.locator('.outline-item')).toHaveCount(1);
  await find.fill('class');
  await expect(page.locator('.outline-item')).toHaveCount(2);
  await find.fill('cust');
  await find.press('Enter');
  expect(await selected(page)).toEqual(['Customer']);
  await find.fill('nothing like it');
  await expect(page.getByText('No element matches')).toBeVisible();
  await find.press('Escape');
  await expect(page.locator('.outline-item')).toHaveCount(3);

  await page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 } });
  await page.keyboard.press('?');
  const reference = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(reference).toBeVisible();
  for (const action of ['Copy selected elements', 'Paste', 'Duplicate selected elements', 'Find an element in the outline', 'Undo']) await expect(reference.getByText(action, { exact: true })).toBeVisible();
  await expect(reference.getByText('Ctrl+D')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reference).toBeHidden();
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(reference).toBeVisible();
  await page.getByRole('button', { name: 'Close keyboard shortcuts' }).click();
  await expect(reference).toBeHidden();
});

test('properties set and clear a stereotype and colour on the declaration', async ({ page }) => {
  await load(page, "@startuml\nclass Order { ' kept\n  +id\n}\nOrder --> Customer\n@enduml\n");
  await node(page, 'Order').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Properties…' }).click();
  const form = page.getByRole('dialog', { name: 'Element properties' });
  await form.getByRole('textbox', { name: 'Stereotype' }).fill('a >> b');
  await expect(form.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await form.getByRole('textbox', { name: 'Stereotype' }).fill('aggregate');
  await form.getByRole('textbox', { name: 'Background colour', exact: true }).fill('#FFE0A0');
  await form.getByRole('button', { name: 'Apply' }).click();
  await expect(form).toBeHidden();
  await expect(node(page, 'Order').getByText('«aggregate»')).toBeVisible();
  expect(await source(page)).toBe("@startuml\nclass Order <<aggregate>> #FFE0A0 { ' kept\n  +id\n}\nOrder --> Customer\n@enduml");
  await node(page, 'Order').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Properties…' }).click();
  await expect(form.getByRole('textbox', { name: 'Stereotype' })).toHaveValue('aggregate');
  await form.getByRole('textbox', { name: 'Stereotype' }).fill('');
  await form.getByRole('textbox', { name: 'Background colour', exact: true }).fill('');
  await form.getByRole('button', { name: 'Apply' }).click();
  expect(await source(page)).toBe("@startuml\nclass Order { ' kept\n  +id\n}\nOrder --> Customer\n@enduml");
  // An element only named in a relationship has no declaration to carry properties.
  await node(page, 'Customer').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Properties…' })).toHaveCount(0);
});

test('SDL palette shows readable labels and keeps the kind as its accessible name', async ({ page }) => {
  await load(page, '@startuml\nstart\n:Receive request; <<input>>\nstop\n@enduml\n');
  const input = page.locator('.palette-list').getByRole('button', { name: 'sdl-input', exact: true });
  await expect(input).toHaveText('input');
});
