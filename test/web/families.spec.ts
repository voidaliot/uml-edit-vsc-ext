import { test, expect, type Page } from '@playwright/test';
import { nativeTemplates } from '../../src/core/templates';
import { parseDocument } from '../../src/core/parser';

async function readSource(page: Page) {
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas' }).click();
  const text = await page.getByRole('textbox', { name: 'PlantUML source', exact: true }).inputValue();
  await page.getByRole('button', { name: 'Close source editor' }).click();
  return text;
}

for (const template of nativeTemplates) test(`${template.kind}: gallery, native geometry, inline source edit, placement and removal`, async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?empty=1');
  const gallery = page.getByRole('dialog', { name: 'Create a new diagram' });
  await gallery.locator('.template-card').filter({ has: page.locator('strong', { hasText: new RegExp(`^${template.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).click();
  await expect(gallery).toBeHidden();
  const initial = parseDocument(template.source).diagrams[0];
  await expect(page.locator('.react-flow__node')).toHaveCount(initial.elements.length);
  expect(initial.elements.length).toBeGreaterThan(0);
  const geometry = await page.locator('.react-flow__node').evaluateAll(nodes => nodes.every(node => { const rect = node.getBoundingClientRect(); const style = (node as HTMLElement).style.transform; return rect.width > 0 && rect.height > 0 && !style.includes('NaN'); }));
  expect(geometry).toBe(true);
  expect(await page.locator('img, iframe').count()).toBe(0);
  if (['c4','network','chen','ditaa','board','git','jcckit','timing','gantt','chronology','math','salt','chart','json','ebnf'].includes(template.kind)) { await page.getByRole('button', { name: 'Fit diagram (F)', exact: true }).click(); await page.waitForTimeout(250); await page.screenshot({ path: test.info().outputPath(`${template.kind}-native.png`) }); }
  let editable = initial.elements.find(element => element.meta?.editable !== false && element.meta?.root !== true && !['start','end','initial','final','fork','join','merge'].includes(element.kind) && (template.kind !== 'chart' || element.kind.startsWith('chart-') && element.kind !== 'chart-axis' && element.kind !== 'chart-plot'));
  expect(editable).toBeDefined();
  // Attribute locators avoid assuming labels are plain text (formula and styled headers).
  const namedNode = page.locator('.uml-node').locator(`xpath=self::*[@data-element-id=${JSON.stringify(editable!.id)}]`);
  await page.locator('.outline-item').filter({ has: page.locator('span', { hasText: new RegExp(`^${editable!.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first().click();
  await namedNode.locator(template.kind === 'salt' ? '.family-content' : '.node-name').dblclick();
  const field = page.getByRole('textbox', { name: 'Element name', exact: true });
  await expect(field).toBeVisible(); await field.fill('NativeEdit'); await field.press('Enter'); await expect(field).toBeHidden();
  const renamedSource = await readSource(page); const renamed = parseDocument(renamedSource).diagrams[0];
  expect(renamed.graphical).toBe(true); expect(renamed.elements.some(e => e.name.includes('NativeEdit'))).toBe(true);
  editable = renamed.elements.find(e => e.name.includes('NativeEdit'))!;
  const renamedNode = page.locator('.uml-node').locator(`xpath=self::*[@data-element-id=${JSON.stringify(editable.id)}]`);
  const flow = renamedNode.locator('..'); const before = await flow.getAttribute('style');
  const header = await renamedNode.locator(template.kind === 'salt' ? '.family-content' : '.node-name').boundingBox(); expect(header).not.toBeNull();
  await page.mouse.move(header!.x + header!.width / 2, header!.y + header!.height / 2); await page.mouse.down(); await page.mouse.move(header!.x + header!.width / 2 + 45, header!.y + header!.height / 2 + 45, { steps: 8 }); await page.mouse.up();
  // Date-based dragging changes the source timestamp; the first timeline event
  // can stay at the same canvas x when the axis recalculates its starting date.
  if (editable.meta?.moveEdit) await expect.poll(() => readSource(page)).not.toBe(renamedSource);
  else if (!editable.meta?.positionLocked) await expect(flow).not.toHaveAttribute('style', before!);
  if (template.palette.length) {
    await page.locator('.palette-list').getByRole('button', { name: template.palette[0], exact: true }).click();
    await page.getByRole('textbox', { name: 'New element name' }).fill('AddedNative'); await page.getByRole('button', { name: 'Add element', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Add element', exact: true })).toBeHidden();
    const added = await readSource(page); expect(added).toContain('AddedNative'); expect(parseDocument(added).diagrams[0].graphical).toBe(true);
  }
  const latest = parseDocument(await readSource(page)).diagrams[0]; const remove = latest.elements.find(e => e.name.includes('NativeEdit'));
  if (remove) {
    await page.locator('.outline-item').filter({ has: page.locator('span', { hasText: new RegExp(`^${remove.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first().click();
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await readSource(page)).includes('NativeEdit')).toBe(false);
  }
  expect(errors).toEqual([]);
});

test('specialized member editors update C4 descriptions, chart values and timing states in place', async ({ page }) => {
  for (const kind of ['c4', 'jcckit', 'timing'] as const) {
    const template = nativeTemplates.find(t => t.kind === kind)!;
    await page.addInitScript(source => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value: source, configurable: true }), template.source);
    await page.goto('/');
    const block = parseDocument(template.source).diagrams[0], element = block.elements.find(e => e.meta?.editMembers)!;
    const node = page.locator('.uml-node').locator(`xpath=self::*[@data-element-id=${JSON.stringify(element.id)}]`);
    await node.locator('.family-content').dblclick();
    const editor = page.getByRole('textbox', { name: 'Element members', exact: true }); await expect(editor).toBeVisible();
    const value = kind === 'c4' ? 'Native description' : kind === 'jcckit' ? element.members.map(v => v.startsWith('loans.y') ? 'loans.y = 8 7 6 5 4' : v).join('\n') : '0 is Idle\n10 is Working\n20 is Complete';
    await editor.fill(value); await node.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(editor).toBeHidden();
    const updated = await readSource(page); expect(updated).toContain(kind === 'c4' ? 'Native description' : kind === 'jcckit' ? '8 7 6 5 4' : 'Working');
  }
});

test('state initial and final symbols align with the state centers', async ({ page }) => {
  const source = '@startuml\n[*] --> Queued\nQueued --> Running\nRunning --> [*]\nQueued : waiting for a worker\nRunning : processing the request\n@enduml';
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source); await page.goto('/');
  await expect(page.locator('.uml-node')).toHaveCount(4);
  const centers = await page.locator('.uml-node').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return rect.x + rect.width / 2; }));
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
});

test('activity decision and merge handles attach at the diamond cardinal points', async ({ page }) => {
  const source = '@startuml\nstart\n:Validate request;\nif (Accepted?) then (yes)\n:Store request;\nelse (no)\n:Report issue;\nendif\n:Complete request;\nstop\n@enduml';
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source); await page.goto('/');
  await expect(page.locator('.kind-decision')).toHaveCount(1); await expect(page.locator('.kind-merge')).toHaveCount(1);
  const offsets = await page.locator('.kind-decision, .kind-merge').evaluateAll(nodes => nodes.flatMap(node => { const box = node.getBoundingClientRect(); return ['top','right','bottom','left'].map(side => { const handle = node.querySelector(`[data-handleid="${side}"]`)!.getBoundingClientRect(); const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2; const expectedX = side === 'left' ? box.left : side === 'right' ? box.right : box.left + box.width / 2, expectedY = side === 'top' ? box.top : side === 'bottom' ? box.bottom : box.top + box.height / 2; return Math.hypot(x - expectedX,y - expectedY); }); }));
  for (const offset of offsets) expect(offset).toBeLessThan(3);
});
