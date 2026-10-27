import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseLayoutFile } from '../../src/core/layout-file';

const original = ['\' Preserve these comments.', '@startuml', 'class "Account" as A {', '  +id: UUID', '}', 'class "Ledger" as B', 'A --> B : records', '@enduml', '', '@startuml', 'state "Draft" as Draft', 'state "Done" as Done', 'Draft --> Done', '@enduml', '\' Preserve the trailer.', ''].join('\r\n');

async function openFile(page: Page, name: string, text: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PlantUML file', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
}

async function download(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PlantUML', exact: true }).click();
  const file = await pending;
  return { name: file.suggestedFilename(), text: await readFile((await file.path())!, 'utf8') };
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

async function drag(page: Page, id: string, dx: number, dy: number) {
  const header = page.locator(`.uml-node[data-element-id="${id}"] .node-name`);
  await header.hover(); const bounds = await header.boundingBox(); expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2); await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width / 2 + dx, bounds!.y + bounds!.height / 2 + dy, { steps: 8 }); await page.mouse.up();
}

test('a local PlantUML file opens, edits and downloads as exact plain text', async ({ page }) => {
  await page.goto('/?example=class');
  await openFile(page, 'local.puml', original);
  await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Account');
  await expect(page.getByRole('combobox', { name: 'Current diagram' }).locator('option')).toHaveCount(2);
  await rename(page, 'A', 'Customer account');
  const source = original.replace('"Account" as A', '"Customer account" as A');
  expect(await download(page)).toEqual({ name: 'local.puml', text: source });
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click();
  expect((await download(page)).text).toBe(original);
  await expect(page.getByRole('button', { name: 'Save Aliot diagram' })).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Diagram tools' })).toHaveCount(1);
  await expect(page.locator('.react-flow__attribution,.canvas-tools,.canvas-zoom,.statusbar')).toHaveCount(0);
});

test('a too-large local file leaves the current diagram intact', async ({ page }) => {
  await page.goto('/?example=class');
  await openFile(page, 'local.puml', original);
  await openFile(page, 'huge.puml', 'x'.repeat(2 * 1024 * 1024 + 1));
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await download(page)).text).toBe(original);
});

test('placements live in the layout file and share one undo history with source edits', async ({ page, request }) => {
  const base = 'http://127.0.0.1:4175', fixture = resolve('.cache/live-sync/placed.puml'), layoutPath = fixture + '.layout.json';
  const sourceBefore = await readFile(fixture, 'utf8'), layoutBefore = await readFile(layoutPath, 'utf8');
  const initial = await (await request.get(`${base}/api/document`)).json();
  const diskPlacement = async () => parseLayoutFile(await readFile(layoutPath, 'utf8'))['diagram-1'].positions.A;
  try {
    await page.goto(base);
    await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Account');
    await expect.poll(() => position(page, 'A')).toEqual({ x: 160, y: 120 });
    await drag(page, 'A', 90, 65);
    const moved = await position(page, 'A'); expect(moved.x).toBeGreaterThan(210);
    await expect.poll(diskPlacement).toEqual(moved);
    expect(await readFile(fixture, 'utf8')).toBe(sourceBefore);
    expect((await (await request.get(`${base}/api/document`)).json()).version).toBe(initial.version);
    await page.reload();
    await expect.poll(() => position(page, 'A')).toEqual(moved);

    await rename(page, 'A', 'Placed account');
    const renamed = sourceBefore.replace('"Account" as A', '"Placed account" as A');
    await expect.poll(() => readFile(fixture, 'utf8')).toBe(renamed);
    expect(await diskPlacement()).toEqual(moved);

    // Newest first: the rename, then the move, then redo both in order.
    const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }), redo = page.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)', exact: true });
    await undo.click();
    await expect.poll(() => readFile(fixture, 'utf8')).toBe(sourceBefore);
    expect(await diskPlacement()).toEqual(moved);
    await undo.click();
    await expect.poll(() => readFile(layoutPath, 'utf8')).toBe(layoutBefore);
    await expect.poll(() => position(page, 'A')).toEqual({ x: 160, y: 120 });
    expect(await readFile(fixture, 'utf8')).toBe(sourceBefore);
    await redo.click();
    await expect.poll(diskPlacement).toEqual(moved);
    expect(await readFile(fixture, 'utf8')).toBe(sourceBefore);
    await redo.click();
    await expect.poll(() => readFile(fixture, 'utf8')).toBe(renamed);
    await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Placed account');
    await expect.poll(() => position(page, 'A')).toEqual(moved);

    await page.getByRole('button', { name: 'Re-layout diagram', exact: true }).click();
    await expect.poll(() => readFile(layoutPath, 'utf8').then(() => true, () => false)).toBe(false);
    expect(await readFile(fixture, 'utf8')).toBe(renamed);
  } finally {
    await writeFile(fixture, sourceBefore, 'utf8');
    await rm(layoutPath, { force: true });
    await writeFile(layoutPath, layoutBefore, 'utf8');
    await request.get(`${base}/api/document`);
  }
});
