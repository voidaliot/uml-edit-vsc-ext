import { test, expect, type Page } from '@playwright/test';
import { nativeTemplates } from '../../src/core/templates';
import { parseDocument } from '../../src/core/parser';

const original = `@startuml\n' Keep this comment.\nclass "Order" as Order {\n  +number: String\n  +submit()\n}\nclass "Line item" as LineItem\nOrder --> LineItem : contains\n@enduml\n`;

async function loadSource(page: Page, source = original) {
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Edit PlantUML source in canvas' })).toBeVisible();
}
async function source(page: Page) {
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas' }).click();
  return page.getByRole('textbox', { name: 'PlantUML source', exact: true });
}
async function viewport(page: Page) {
  return page.locator('.react-flow__viewport').evaluate(element => {
    const m = new DOMMatrix(getComputedStyle(element).transform);
    return { x: m.e, y: m.f, zoom: m.a };
  });
}

test('rename in place preserves aliases, comments, relationships and native undo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await loadSource(page);
  const node = page.locator('.uml-node[data-element-id="Order"]');
  await node.locator('.node-name').dblclick();
  await page.getByRole('textbox', { name: 'Element name', exact: true }).fill('Purchase');
  await page.getByRole('textbox', { name: 'Element name', exact: true }).press('Enter');
  await expect(node.locator('.node-name')).toHaveText('Purchase');
  const editor = await source(page);
  await expect(editor).toHaveValue(original.trimEnd().replace('"Order" as Order', '"Purchase" as Order'));
  await page.getByRole('button', { name: 'Close source editor' }).click();
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await expect(node.locator('.node-name')).toHaveText('Order');
  await page.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)' }).click();
  await expect(node.locator('.node-name')).toHaveText('Purchase');
  expect(errors).toEqual([]);
});

test('edit class members inside the node', async ({ page }) => {
  await loadSource(page);
  const node = page.locator('.uml-node[data-element-id="Order"]');
  await node.locator('.node-members').dblclick();
  await page.getByRole('textbox', { name: 'Element members' }).fill('+number: String\n+total: Decimal\n+checkout()');
  await node.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(node).toContainText('+checkout()');
  const editor = await source(page);
  await expect(editor).toHaveValue(/\+total: Decimal/);
  await expect(editor).toHaveValue(/' Keep this comment\./);
  await expect(editor).toHaveValue(/Order --> LineItem : contains/);
});

test('right-click placement and dragging preserve positions across source changes', async ({ page }) => {
  await loadSource(page);
  const pane = page.locator('.react-flow__pane');
  await pane.click({ button: 'right', position: { x: 850, y: 350 } });
  await page.getByRole('menuitem', { name: 'class', exact: true }).click();
  await page.getByRole('textbox', { name: 'New element name' }).fill('Invoice');
  await page.getByRole('button', { name: 'Add element', exact: true }).click();
  const node = page.locator('.react-flow__node').filter({ has: page.locator('.node-name', { hasText: /^Invoice$/ }) });
  await expect(node).toBeInViewport();
  const initial = await node.boundingBox();
  expect(initial).not.toBeNull();
  await page.mouse.move(initial!.x + 70, initial!.y + 20);
  await page.mouse.down(); await page.mouse.move(initial!.x + 170, initial!.y + 100, { steps: 10 }); await page.mouse.up();
  const moved = await node.getAttribute('style');
  expect(moved).toContain('translate');
  const after = await node.boundingBox();
  expect(after!.x - initial!.x).toBeGreaterThan(60);
  const editor = await source(page);
  await expect(editor).toHaveValue(/class "Invoice" as/);
  await editor.fill((await editor.inputValue()).replace('"Order" as Order', '"Purchase" as Order'));
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.locator('.uml-node[data-element-id="Order"]')).toContainText('Purchase');
  await page.getByRole('button', { name: 'Close source editor' }).click();
  await expect(node).toHaveAttribute('style', moved!);
});

test('connection handles create relationships and edit labels without a command input', async ({ page }) => {
  await loadSource(page);
  const start = page.locator('.uml-node[data-element-id="Order"] [data-handleid="right"]');
  const end = page.locator('.uml-node[data-element-id="LineItem"] [data-handleid="left"]');
  await page.locator('.uml-node[data-element-id="Order"]').hover();
  await page.waitForTimeout(350); // Initial fit animates the handle coordinates for 180 ms.
  const a = await start.boundingBox(), b = await end.boundingBox();
  expect(a).not.toBeNull(); expect(b).not.toBeNull();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down(); await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 15 }); await page.mouse.up();
  const dialog = page.getByRole('dialog', { name: 'Edit relationship' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Relationship type' }).selectOption('..>');
  await dialog.getByRole('textbox', { name: 'Relationship label' }).fill('prices');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(await source(page)).toHaveValue(/Order \.\.> LineItem : prices/);
});

test('Select wheel pans, Ctrl+wheel zooms, and Hand wheel zooms', async ({ page }) => {
  await loadSource(page);
  await expect(page.locator('.uml-node').first()).toBeVisible();
  await page.waitForTimeout(350);
  await page.mouse.move(1100, 700);
  const before = await viewport(page);
  await page.mouse.wheel(0, 90);
  await expect.poll(async () => (await viewport(page)).y).toBeLessThan(before.y - 30);
  const panned = await viewport(page);
  expect(panned.zoom).toBeCloseTo(before.zoom, 3);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThan(panned.zoom);
  await page.getByRole('button', { name: /^Hand tool/ }).click();
  await page.mouse.move(1100, 700);
  const hand = await viewport(page); await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await viewport(page)).zoom).toBeLessThan(hand.zoom);
  await page.getByRole('button', { name: /^Select tool/ }).click();
  await page.keyboard.down('Space');
  await expect(page.getByRole('button', { name: /^Hand tool/ })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('Space');
  await expect(page.getByRole('button', { name: /^Select tool/ })).toHaveAttribute('aria-pressed', 'true');
});

test('gallery creates a sequence with participant lifelines and messages', async ({ page }) => {
  await page.goto('/?empty=1');
  const gallery = page.getByRole('dialog', { name: 'Create a new diagram' });
  await expect(gallery.locator('.template-card')).toHaveCount(nativeTemplates.length);
  await gallery.getByRole('textbox', { name: 'Search diagram types' }).fill('sequence');
  await gallery.getByRole('button', { name: /^Sequence Participants and/ }).click();
  await expect(gallery).toBeHidden();
  await expect(page.locator('.lifeline')).toHaveCount(3);
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);
  await expect(await source(page)).toHaveValue(/actor "Customer" as customer/);
});

test('multiple diagrams are independently edited without changing surrounding source', async ({ page }) => {
  const second = '@startuml\nstate "Draft" as Draft\nstate "Done" as Done\nDraft --> Done\n@enduml';
  await loadSource(page, original + '\n\' Keep the separator\n' + second);
  await page.getByRole('combobox', { name: 'Current diagram' }).selectOption('diagram-2');
  await page.locator('.uml-node[data-element-id="Draft"] .node-name').dblclick();
  await page.getByRole('textbox', { name: 'Element name', exact: true }).fill('Ready');
  await page.getByRole('textbox', { name: 'Element name', exact: true }).press('Enter');
  await expect(page.locator('.uml-node[data-element-id="Draft"]')).toContainText('Ready');
  await page.getByRole('combobox', { name: 'Current diagram' }).selectOption('diagram-1');
  await expect(await source(page)).toHaveValue(original.trimEnd());
});

test('an external source change rejects a stale inline edit and retains the draft', async ({ page }) => {
  await loadSource(page);
  await page.locator('.uml-node[data-element-id="Order"] .node-name').dblclick();
  const input = page.getByRole('textbox', { name: 'Element name', exact: true });
  await input.fill('Unsaved purchase');
  await page.evaluate(next => window.postMessage({ type: 'document', source: next, version: 2, fileName: 'external.puml', layouts: {}, trusted: true }, '*'), original.replace('"Order" as', '"External order" as'));
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('draft is preserved');
  await expect(input).toHaveValue('Unsaved purchase');
});

test('include-only files can be edited in the canvas without replacing them with a template', async ({ page }) => {
  await loadSource(page, "' Shared styles\nskinparam monochrome true\n");
  const editor = await source(page);
  await expect(editor).toHaveValue("' Shared styles\nskinparam monochrome true\n");
  await editor.fill("' Shared styles\nskinparam monochrome false\n");
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(editor).toHaveValue(/monochrome false/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('unsupported diagrams are explicit and never request an image renderer', async ({ page }) => {
  const apiRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) apiRequests.push(request.url()); });
  await loadSource(page, '@startfuture\ncustom syntax\n@endfuture');
  await expect(page.getByRole('status', { name: 'Native diagram not supported' })).toBeVisible();
  await expect(page.locator('.uml-node, .plantuml-image, .react-flow__node-image')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Set up renderer|Export PlantUML SVG/ })).toHaveCount(0);
  // Plain-source export remains available even for syntax without native shapes.
  await expect(page.getByRole('button', { name: 'Export PlantUML', exact: true })).toBeEnabled();
  expect(apiRequests).toEqual([]);
  await expect(await source(page)).toHaveValue(/custom syntax/);
});

test('an inline member draft never crosses into another diagram with the same alias', async ({ page }) => {
  await loadSource(page, '@startuml\nclass A {\n +first: String\n}\n@enduml\n@startuml\nclass A {\n +second: Integer\n}\n@enduml');
  await page.locator('.uml-node[data-element-id="A"] .node-members').dblclick();
  await page.getByRole('textbox', { name: 'Element members' }).fill('+draft: Boolean');
  await page.getByRole('combobox', { name: 'Current diagram' }).selectOption('diagram-2');
  await expect(page.getByRole('textbox', { name: 'Element members' })).toHaveCount(0);
  await expect(page.locator('.uml-node[data-element-id="A"]')).toContainText('+second: Integer');
  await page.getByRole('combobox', { name: 'Current diagram' }).selectOption('diagram-1');
  await expect(page.getByRole('textbox', { name: 'Element members' })).toHaveValue('+draft: Boolean');
  await page.locator('.uml-node[data-element-id="A"]').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.uml-node[data-element-id="A"]')).toContainText('+draft: Boolean');
  await page.getByRole('combobox', { name: 'Current diagram' }).selectOption('diagram-2');
  await expect(await source(page)).toHaveValue('@startuml\nclass A {\n +second: Integer\n}\n@enduml');
});

test('entity fields with parameterized types remain visible', async ({ page }) => {
  await loadSource(page, '@startuml\nentity Customer {\n name: varchar(255)\n}\n@enduml');
  await expect(page.locator('.uml-node')).toContainText('name: varchar(255)');
});

test('sequence movement keeps message rows ordered by locking participant height', async ({ page }) => {
  await page.goto('/?example=sequence');
  const participant = page.locator('.react-flow__node[data-id="checkout"]');
  await participant.locator('.sequence-head').hover(); await page.waitForTimeout(350);
  const box = await participant.boundingBox();
  await page.mouse.move(box!.x + 50, box!.y + 20);
  await page.mouse.down(); await page.mouse.move(box!.x + 150, box!.y - 100, { steps: 12 }); await page.mouse.up();
  const after = await participant.boundingBox();
  expect(after!.y).toBeCloseTo(box!.y, 0);
  expect(after!.x - box!.x).toBeGreaterThan(50);
});

for (const kind of ['class', 'object', 'sequence', 'usecase', 'component', 'deployment', 'state', 'activity', 'entity', 'mindmap', 'wbs']) {
  test(`${kind} template has a usable native diagram`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/?example=${kind}`);
    await expect(page.locator('.uml-node').first()).toBeVisible();
    const expected = parseDocument(nativeTemplates.find(template => template.kind === kind)!.source).diagrams[0];
    await expect(page.locator('.react-flow__node')).toHaveCount(expected.elements.length);
    await expect(page.locator('.react-flow__edge')).toHaveCount(expected.relations.filter(relation => !relation.arrow.includes('hidden')).length);
    expect(errors).toEqual([]);
  });
}

test('default showcase exposes every native type in one document', async ({ page }) => {
  await page.goto('/');
  const selector = page.getByRole('combobox', { name: 'Current diagram' });
  await expect(selector.locator('option')).toHaveCount(nativeTemplates.length);
  await selector.selectOption('diagram-3');
  await expect(page.locator('.lifeline')).toHaveCount(3);
  await selector.selectOption('diagram-8');
  await expect(page.locator('.kind-decision')).toBeVisible();
  await page.getByRole('button', { name: 'New diagram', exact: true }).click();
  await expect(page.locator('.template-card')).toHaveCount(nativeTemplates.length);
  await expect(page.locator('.template-card:disabled')).toHaveCount(0);
});

test('diagram controls share one toolbar row without passive editor chrome', async ({ page }) => {
  await loadSource(page);
  const toolbar = page.getByRole('toolbar', { name: 'Diagram tools', exact: true });
  await expect(page.getByRole('toolbar')).toHaveCount(1);
  await expect(toolbar).toBeVisible();
  await expect(page.locator('.topbar, .workspace-toolbar, .canvas-tools, .canvas-zoom, .statusbar, .brand, .file-label, .sync-badge, .native-badge, .kind-badge, .diagram-count')).toHaveCount(0);
  for (const name of ['New diagram', 'Source file', 'Edit PlantUML source in canvas', 'Re-layout diagram', 'Fit diagram (F)', 'Undo (Ctrl+Z)', 'Redo (Ctrl+Shift+Z)', 'Zoom in', 'Zoom out', 'Reset zoom to 100%']) await expect(toolbar.getByRole('button', { name, exact: true })).toHaveCount(1);
  await expect(toolbar.getByRole('button', { name: 'Re-layout diagram', exact: true })).toHaveText('');
  await expect(toolbar.getByRole('button', { name: 'Toggle grid', exact: true })).toHaveCount(0);
  const minimap = toolbar.getByRole('button', { name: 'Toggle minimap', exact: true });
  await expect(minimap.locator('svg.lucide-map')).toHaveCount(1);
  await minimap.click();
  await expect(page.locator('.react-flow__minimap')).toBeVisible();
  await minimap.click();
  await expect(page.locator('.react-flow__minimap')).toHaveCount(0);
  await expect(toolbar.getByRole('combobox', { name: 'Current diagram' })).toBeVisible();
  for (const width of [1440, 960]) {
    await page.setViewportSize({ width, height: 960 });
    const rows = await toolbar.locator('button, select').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return rect.top + rect.height / 2; }));
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(3);
    const passiveText = await toolbar.evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), values: string[] = [];
      for (let text = walker.nextNode(); text; text = walker.nextNode()) if (text.textContent?.trim() && !text.parentElement?.closest('button, select')) values.push(text.textContent.trim());
      return values;
    });
    expect(passiveText).toEqual([]);
  }
});
