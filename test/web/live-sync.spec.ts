import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseURL = 'http://127.0.0.1:4174';
const fixture = resolve('.cache/live-sync/linked.puml');
const original = `' Keep the file header.
@startuml
title Linked class
class "Account" as A {
  +id: UUID
}
class "Ledger" as B
A --> B : records
@enduml

' Keep the diagram separator.
@startuml
title Linked state
state "Draft" as Draft
state "Done" as Done
Draft --> Done
@enduml
' Keep the file trailer.
`;

test.use({ baseURL });

test.beforeEach(async ({ request }) => {
  await writeFile(fixture, original, 'utf8');
  // The read refreshes the server before the page connects, resetting undo history
  // when a preceding test changed the linked file.
  const response = await request.get(`${baseURL}/api/document`);
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).source).toBe(original);
});

async function openLinkedFile(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Source file', exact: true })).toBeEnabled();
  await expect(page.getByRole('combobox', { name: 'Current diagram' }).locator('option')).toHaveCount(2);
  await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Account');
}

async function renameAccount(page: Page, name: string) {
  // The peer check opens a second tab; editing models the user returning to this tab.
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await page.locator('.uml-node[data-element-id="A"] .node-name').dblclick();
  const input = page.getByRole('textbox', { name: 'Element name', exact: true });
  await input.fill(name);
  await input.press('Enter');
  await expect(input).toBeHidden();
  await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText(name);
}

test('inline edits write the linked file, reach peer tabs, and support undo and redo', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openLinkedFile(page);
  const peer = await context.newPage();
  await openLinkedFile(peer);

  await renameAccount(page, 'Customer account');
  const edited = original.replace('"Account" as A', '"Customer account" as A');
  await expect.poll(() => readFile(fixture, 'utf8')).toBe(edited);
  await expect(peer.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Customer account');

  await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click();
  await expect.poll(() => readFile(fixture, 'utf8')).toBe(original);
  await expect(peer.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Account');
  await page.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)', exact: true }).click();
  await expect.poll(() => readFile(fixture, 'utf8')).toBe(edited);
  await expect(peer.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('Customer account');
  await expect(page.locator('.react-flow__node-image')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('external file edits update native nodes and an unmodified source panel', async ({ page }) => {
  await openLinkedFile(page);
  await page.getByRole('button', { name: 'Source file', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'PlantUML source', exact: true });
  await expect(editor).toHaveValue(/class "Account" as A/);

  const external = original.replace('"Account" as A', '"External account" as A').replace('+id: UUID', '+id: UUID\n  +owner: String');
  await writeFile(fixture, external, 'utf8');
  await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('External account');
  await expect(page.locator('.uml-node[data-element-id="A"]')).toContainText('+owner: String');
  await expect(editor).toHaveValue(/class "External account" as A/);
  await expect(editor).toHaveValue(/\+owner: String/);
  await expect(page.locator('.draft-notice')).toBeHidden();

  await page.reload();
  await expect(page.locator('.uml-node[data-element-id="A"] .node-name')).toHaveText('External account');
  expect(await readFile(fixture, 'utf8')).toBe(external);
});

test('an external change rejects a stale inline draft without overwriting the file', async ({ page }) => {
  await openLinkedFile(page);
  await page.locator('.uml-node[data-element-id="A"] .node-name').dblclick();
  const input = page.getByRole('textbox', { name: 'Element name', exact: true });
  await input.fill('Unsaved local name');

  const external = original.replace('"Account" as A', '"External account" as A');
  await writeFile(fixture, external, 'utf8');
  // The outline updates even while the node's input retains its unsaved draft.
  await expect(page.locator('.outline-item').filter({ hasText: 'External account' })).toBeVisible();
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('draft is preserved');
  await expect(input).toHaveValue('Unsaved local name');
  expect(await readFile(fixture, 'utf8')).toBe(external);
});

test('new native diagrams append to the linked file and select the appended block', async ({ page }) => {
  await openLinkedFile(page);
  await page.getByRole('button', { name: 'New diagram', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'Create a new diagram' });
  await expect(gallery).toContainText('Adds a diagram to this file');
  await gallery.locator('.template-card').filter({ has: page.getByText('Sequence', { exact: true }) }).click();
  const selector = page.getByRole('combobox', { name: 'Current diagram' });
  await expect(selector.locator('option')).toHaveCount(3);
  await expect(selector).toHaveValue('diagram-3');
  await expect(page.locator('.lifeline')).toHaveCount(3);
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);
  const content = await readFile(fixture, 'utf8');
  expect(content.startsWith(original.trimEnd() + '\n\n')).toBeTruthy();
  expect(content).toContain('actor "Customer" as customer');
  expect(content.match(/@startuml/g)).toHaveLength(3);
});
