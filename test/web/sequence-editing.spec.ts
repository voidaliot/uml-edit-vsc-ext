import { readFile } from 'node:fs/promises';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { parseDocument } from '../../src/core/parser';

const original = `@startuml
participant Alpha as A
participant Beta as B
participant Gamma as C
A -> B : First
== Phase ==
B -> C : Second
C --> A : Third
A -> A : Self
@enduml\n`;

async function open(page: Page) {
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), original);
  await page.goto('/');
  await expect(page.locator('.sequence-node')).toHaveCount(3);
  await expect(page.locator('.react-flow__edge-path')).toHaveCount(4);
  await page.getByRole('button', { name: 'Fit diagram (F)', exact: true }).click();
  await page.waitForTimeout(250);
}
async function drag(page: Page, locator: Locator, dx: number, dy: number) {
  const rect = (await locator.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}
async function source(page: Page) {
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas', exact: true }).click();
  const value = await page.getByRole('textbox', { name: 'PlantUML source', exact: true }).inputValue();
  await page.getByRole('button', { name: 'Close source editor', exact: true }).click();
  return value;
}
async function zoom(page: Page) { return Number((await page.getByRole('button', { name: 'Reset zoom to 100%' }).textContent())!.replace('%', '')) / 100; }

test('lifeline handles coincide with every message endpoint, including self-call returns', async ({ page }) => {
  await open(page);
  const block = parseDocument(original).diagrams[0];
  for (const relation of block.relations) {
    const row = Number(relation.meta?.row), self = relation.source === relation.target;
    const edge = page.locator(`.react-flow__edge[data-id="${relation.id}"] .react-flow__edge-path`);
    const ends = await edge.evaluate((path: SVGPathElement) => {
      const matrix = path.getScreenCTM()!, length = path.getTotalLength();
      return [path.getPointAtLength(0), path.getPointAtLength(length)].map(point => ({ x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f }));
    });
    for (const [index, participant, handle] of [[0, relation.source, `sequence-${row}`], [1, relation.target, self ? `sequence-return-${row}` : `sequence-${row}`]] as const) {
      const rect = (await page.locator(`.react-flow__node[data-id="${participant}"] .sequence-handle[data-handleid="${handle}"]`).boundingBox())!;
      expect(ends[index].x).toBeCloseTo(rect.x + rect.width / 2, 0);
      expect(ends[index].y).toBeCloseTo(rect.y + rect.height / 2, 0);
    }
  }
  await expect(page.locator('.sequence-node .uml-handle[data-handleid="top"], .sequence-node .uml-handle[data-handleid="bottom"], .sequence-node .uml-handle[data-handleid="left"], .sequence-node .uml-handle[data-handleid="right"]')).toHaveCount(0);
});

test('dragging a message label reorders source rows and supports undo and redo', async ({ page }) => {
  await open(page);
  await drag(page, page.getByRole('button', { name: 'Edit relationship First', exact: true }), 0, 104 * await zoom(page));
  await expect.poll(async () => parseDocument(await source(page)).diagrams[0].relations.map(relation => relation.label)).toEqual(['Second', 'First', 'Third', 'Self']);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click();
  expect((await source(page)).trim()).toBe(original.trim());
  await page.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)', exact: true }).click();
  expect(parseDocument(await source(page)).diagrams[0].relations.map(relation => relation.label)).toEqual(['Second', 'First', 'Third', 'Self']);
});

test('a message line can be dragged upward without moving participant columns', async ({ page }) => {
  await open(page);
  const participant = page.locator('.react-flow__node[data-id="A"]');
  const before = (await participant.boundingBox())!;
  const relation = parseDocument(original).diagrams[0].relations.find(item => item.label === 'Third')!;
  const line = page.locator(`.react-flow__edge[data-id="${relation.id}"] .react-flow__edge-path`);
  const point = await line.evaluate((path: SVGPathElement) => {
    const p = path.getPointAtLength(path.getTotalLength() * .3), m = path.getScreenCTM()!;
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  });
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x, point.y - 156 * await zoom(page), { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => parseDocument(await source(page)).diagrams[0].relations[0].label).toBe('Third');
  const after = (await participant.boundingBox())!;
  expect(after.x).toBeCloseTo(before.x, 0); expect(after.y).toBeCloseTo(before.y, 0);
});

test('dividers move between message rows and can be resized with undo and portable round trips', async ({ page }) => {
  await open(page);
  const divider = page.locator('.uml-node.kind-sequence-divider'), title = divider.locator('.node-title');
  const initial = (await divider.boundingBox())!;
  await drag(page, title, 60, 104 * await zoom(page));
  await expect.poll(async () => {
    const value = await source(page);
    return value.indexOf('== Phase ==') > value.indexOf('C --> A : Third');
  }).toBe(true);
  await expect.poll(async () => (await divider.boundingBox())!.y).toBeGreaterThan(initial.y + 50);
  await expect.poll(async () => (await divider.boundingBox())!.x).toBeCloseTo(initial.x + 60, 0);
  await title.click();
  await expect(divider.locator('.sequence-divider-resize.right')).toBeVisible();
  const before = (await divider.boundingBox())!;
  await drag(page, divider.locator('.sequence-divider-resize.right'), 120, 0);
  await expect.poll(async () => (await divider.boundingBox())!.width).toBeGreaterThan(before.width + 100);
  const resized = (await divider.boundingBox())!;
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click();
  await expect.poll(async () => (await divider.boundingBox())!.width).toBeCloseTo(before.width, 0);
  await page.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)', exact: true }).click();
  await expect.poll(async () => (await divider.boundingBox())!.width).toBeCloseTo(resized.width, 0);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save Aliot diagram', exact: true }).click();
  const download = await downloadEvent, file = (await download.path())!;
  const portable = JSON.parse(await readFile(file, 'utf8'));
  const id = parseDocument(portable.source).diagrams[0].elements.find(element => element.kind === 'sequence-divider')!.id;
  expect(portable.layouts['diagram-1'].positions[id].width).toBeGreaterThan(100);
  const chooserEvent = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open Aliot diagram', exact: true }).click();
  await (await chooserEvent).setFiles({ name: 'sequence.aliotuml', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(portable)) });
  await expect(divider).toBeVisible();
  await page.waitForTimeout(250);
  const reopened = (await divider.boundingBox())!;
  expect(reopened.width).toBeCloseTo(resized.width, 0);
});

test('connecting lifelines at an existing row inserts a horizontal message at that row', async ({ page }) => {
  await open(page);
  const from = page.locator('.react-flow__node[data-id="A"] .sequence-handle[data-handleid="sequence-2"]');
  const to = page.locator('.react-flow__node[data-id="C"] .sequence-handle[data-handleid="sequence-2"]');
  const a = (await from.boundingBox())!, b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 }); await page.mouse.up();
  const form = page.getByRole('dialog', { name: 'Edit relationship' });
  await form.getByRole('textbox', { name: 'Relationship label' }).fill('Inserted');
  await form.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => parseDocument(await source(page)).diagrams[0].relations.map(relation => relation.label)).toEqual(['First', 'Inserted', 'Second', 'Third', 'Self']);
  const inserted = parseDocument(await source(page)).diagrams[0].relations.find(relation => relation.label === 'Inserted')!;
  expect(inserted.meta?.row).toBe(2);
});
