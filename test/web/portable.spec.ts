import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readEditorDocument, serializeAliotDocument } from '../../src/core/aliot-document';

const original = ['\' Preserve these comments.', '@startuml', 'class "Account" as A {', '  +id: UUID', '}', 'class "Ledger" as B', 'A --> B : records', '@enduml', '', '@startuml', 'state "Draft" as Draft', 'state "Done" as Done', 'Draft --> Done', '@enduml', '\' Preserve the trailer.', ''].join('\r\n');

async function openFile(page: Page, name: string, text: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open Aliot diagram', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: name.endsWith('.aliotuml') ? 'application/json' : 'text/plain', buffer: Buffer.from(text) });
}

async function downloadFile(page: Page, action: 'Save Aliot diagram' | 'Export PlantUML') {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: action, exact: true }).click();
  const download = await pending;
  return { name: download.suggestedFilename(), text: await readFile((await download.path())!, 'utf8') };
}

async function position(page: Page, id: string) {
  return page.locator(`.uml-node[data-element-id="${id}"]`).locator('..').evaluate(node => {
    const matrix = new DOMMatrix((node as HTMLElement).style.transform);
    return { x: matrix.e, y: matrix.f };
  });
}

async function rename(page: Page, id: string, name: string) {
  await page.locator(`.uml-node[data-element-id="${id}"] .node-name`).dblclick();
  const input = page.getByRole('textbox', { name: 'Element name', exact: true });
  await input.fill(name); await input.press('Enter'); await expect(input).toBeHidden();
}

test('Aliot download reopens source and manual placements, and PlantUML export preserves exact text', async ({ page }) => {
  await page.goto('/?example=class');
  await openFile(page, 'portable.puml', original);
  await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Account');
  await expect(page.getByRole('combobox', { name: 'Current diagram' }).locator('option')).toHaveCount(2);
  await rename(page, 'A', 'Customer account');
  const source = original.replace('"Account" as A', '"Customer account" as A');
  const handle = page.locator('.uml-node[data-element-id="A"] .node-name');
  await handle.hover();
  const start = await handle.boundingBox(); expect(start).not.toBeNull();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2); await page.mouse.down();
  await page.mouse.move(start!.x + start!.width / 2 + 100, start!.y + start!.height / 2 + 70, { steps: 8 }); await page.mouse.up();
  const moved = await position(page, 'A');
  const exported = await downloadFile(page, 'Export PlantUML');
  expect(exported).toEqual({ name: 'portable.puml', text: source });
  const saved = await downloadFile(page, 'Save Aliot diagram');
  expect(saved.name).toBe('portable.aliotuml');
  const parsed = readEditorDocument(saved.text, saved.name);
  expect(parsed.format).toBe('aliot'); expect(parsed.source).toBe(source);
  expect(parsed.layouts['diagram-1'].positions.A).toEqual(moved);
  expect(parsed.layouts['diagram-1'].viewport).toBeDefined();

  await openFile(page, 'empty.puml', '@startuml\nclass Other\n@enduml\n');
  await expect(page.locator('.uml-node[data-element-id="Other"] .node-name')).toHaveText('Other');
  await openFile(page, saved.name, saved.text);
  await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Customer account');
  await expect.poll(() => position(page, 'A')).toEqual(moved);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click();
  expect((await downloadFile(page, 'Export PlantUML')).text).toBe(source);
  await expect(page.getByRole('button', { name: 'Source file', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas', exact: true }).click();
  expect(await page.getByRole('textbox', { name: 'PlantUML source', exact: true }).inputValue()).toContain('class "Customer account" as A');
  await expect(page.getByRole('toolbar', { name: 'Diagram tools' })).toHaveCount(1);
  await expect(page.locator('.react-flow__attribution,.canvas-tools,.canvas-zoom,.statusbar')).toHaveCount(0);
});

test('invalid Aliot files leave the current source and placement intact', async ({ page }) => {
  await page.goto('/?example=class');
  const file = serializeAliotDocument(original, { 'diagram-1': { positions: { A: { x: 210, y: 180 } } } });
  await openFile(page, 'valid.aliotuml', file);
  await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Account');
  await openFile(page, 'invalid.aliotuml', '{"format":"unknown","source":42}');
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await downloadFile(page, 'Export PlantUML')).text).toBe(original);
  expect(await position(page, 'A')).toEqual({ x: 210, y: 180 });
});

test('saving an opened Aliot file preserves unknown envelope and layout metadata', async ({ page }) => {
  await page.goto('/?example=class');
  const envelope = JSON.parse(serializeAliotDocument(original, { 'diagram-1': { positions: { A: { x: 210, y: 180 } } } }));
  envelope.owner = { team: 'Native editing', revision: 7 };
  envelope.layouts['diagram-1'].theme = 'light'; envelope.layouts['diagram-1'].positions.A.note = 'Keep this metadata';
  await openFile(page, 'metadata.aliotuml', JSON.stringify(envelope, null, 2) + '\n');
  await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Account');
  await rename(page, 'A', 'Renamed account');
  const saved = JSON.parse((await downloadFile(page, 'Save Aliot diagram')).text);
  expect(saved.owner).toEqual(envelope.owner);
  expect(saved.layouts['diagram-1'].theme).toBe('light');
  expect(saved.layouts['diagram-1'].positions.A.note).toBe('Keep this metadata');
  expect(saved.source).toBe(original.replace('"Account" as A', '"Renamed account" as A'));
  await page.getByRole('button', { name: 'New diagram', exact: true }).click();
  await page.getByRole('dialog', { name: 'Create a new diagram' }).locator('.template-card').filter({ has: page.getByText('Sequence', { exact: true }) }).click();
  await expect(page.locator('.lifeline')).toHaveCount(3);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click();
  await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Renamed account');
  expect(await position(page, 'A')).toEqual({ x: 210, y: 180 });
  const restored = await downloadFile(page, 'Save Aliot diagram');
  expect(restored.name).toBe('metadata.aliotuml');
  expect(JSON.parse(restored.text).owner).toEqual(envelope.owner);
  expect(JSON.parse(restored.text).layouts['diagram-1'].positions.A.note).toBe('Keep this metadata');
});

test('opening a portable download detaches from the live file without overwriting it', async ({ page, request }) => {
  const base = 'http://127.0.0.1:4174', fixture = resolve('.cache/live-sync/linked.puml');
  const initial = await (await request.get(`${base}/api/document`)).json();
  const diskBefore = await readFile(fixture, 'utf8');
  await page.goto(base);
  await expect(page.locator('.uml-node').first()).toBeVisible();
  const saved = await downloadFile(page, 'Save Aliot diagram');
  expect(readEditorDocument(saved.text, saved.name).source).toBe(initial.source);
  expect(await readFile(fixture, 'utf8')).toBe(diskBefore);
  await openFile(page, 'independent.aliotuml', serializeAliotDocument(original, { 'diagram-1': { positions: { A: { x: 240, y: 150 } } } }));
  await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Account');
  await rename(page, 'A', 'Local copy');
  expect(await readFile(fixture, 'utf8')).toBe(diskBefore);
  try {
    await writeFile(fixture, diskBefore + '\n\' External change after opening the local file.\n', 'utf8');
    await request.get(`${base}/api/document`);
    await page.waitForTimeout(300);
    expect((await downloadFile(page, 'Export PlantUML')).text).toBe(original.replace('"Account" as A', '"Local copy" as A'));
    await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Local copy');
  } finally { await writeFile(fixture, diskBefore, 'utf8'); await request.get(`${base}/api/document`); }
});

test('live Aliot drag persists on disk and reload, layout undo preserves source version, and rename keeps metadata', async ({ page, request }) => {
  const base = 'http://127.0.0.1:4175', fixture = resolve('.cache/live-sync/linked.aliotuml');
  const before = await readFile(fixture, 'utf8'), envelope = JSON.parse(before);
  const initial = await (await request.get(`${base}/api/document`)).json();
  const readDisk = async () => readEditorDocument(await readFile(fixture, 'utf8'), fixture);
  try {
    await page.goto(base);
    await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Account');
    await expect.poll(() => position(page, 'A')).toEqual({ x: 160, y: 120 });
    const header = page.locator('.uml-node[data-element-id="A"] .node-name');
    await header.hover(); const bounds = await header.boundingBox(); expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2); await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width / 2 + 90, bounds!.y + bounds!.height / 2 + 65, { steps: 8 }); await page.mouse.up();
    const moved = await position(page, 'A'); expect(moved.x).toBeGreaterThan(210);
    await expect.poll(async () => (await readDisk()).layouts['diagram-1'].positions.A).toEqual(moved);
    expect((await (await request.get(`${base}/api/document`)).json()).version).toBe(initial.version);
    expect((await readDisk()).source).toBe(initial.source);
    await page.reload();
    await expect.poll(() => position(page, 'A')).toEqual(moved);
    await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click();
    await expect.poll(async () => (await readDisk()).layouts['diagram-1'].positions.A).toEqual({ x: 160, y: 120 });
    await expect.poll(() => position(page, 'A')).toEqual({ x: 160, y: 120 });
    expect((await (await request.get(`${base}/api/document`)).json()).version).toBe(initial.version);
    await page.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)', exact: true }).click();
    await expect.poll(() => position(page, 'A')).toEqual(moved);
    await rename(page, 'A', 'Portable account');
    const expected = initial.source.replace('"Account" as A', '"Portable account" as A');
    await expect.poll(async () => (await readDisk()).source).toBe(expected);
    expect((await (await request.get(`${base}/api/document`)).json()).version).toBe(initial.version + 1);
    expect((await readDisk()).layouts['diagram-1'].positions.A).toEqual(moved);
    const saved = await downloadFile(page, 'Save Aliot diagram');
    expect(saved.name).toBe('linked.aliotuml'); expect(JSON.parse(saved.text).metadata).toEqual(envelope.metadata);
    expect(readEditorDocument(saved.text, saved.name).source).toBe(expected);
    expect((await downloadFile(page, 'Export PlantUML')).text).toBe(expected);
    await page.reload();
    await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Portable account');
    await expect.poll(() => position(page, 'A')).toEqual(moved);
  } finally { await writeFile(fixture, before, 'utf8'); await request.get(`${base}/api/document`); }
});
