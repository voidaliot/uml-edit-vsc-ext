import { test, expect, type Page } from '@playwright/test';

async function open(page: Page, body: string) {
  await page.addInitScript(source => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value: source }), `@startuml\n${body}\n@enduml`);
  await page.goto('/');
  await expect(page.locator('.uml-node').first()).toBeVisible();
}

for (const setting of ['straight', 'ortho', 'polyline', 'spline']) test(`source routing: ${setting}`, async ({ page }) => {
  await open(page, `${setting === 'straight' ? '' : `skinparam linetype ${setting}\n`}class Parent\nclass Left\nclass Right\nParent --> Left\nParent -[dotted]-> Right`);
  await expect(page.locator('.react-flow__edge-path')).toHaveCount(2);
  const paths = await page.locator('.react-flow__edge-path').evaluateAll(items => items.map(item => item.getAttribute('d')!));
  if (setting === 'spline') expect(paths.every(path => path.includes('C'))).toBe(true);
  else expect(paths.every(path => !/[CQ]/.test(path))).toBe(true);
  if (setting === 'straight' || setting === 'polyline') expect(paths.every(path => /^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+$/.test(path))).toBe(true);
  await expect(page.locator('.react-flow__edge-path').nth(1)).toHaveCSS('stroke-dasharray', '1px, 4px');
});

test('changing source linetype updates existing connectors immediately', async ({ page }) => {
  await open(page, 'class A\nclass B\nA --> B');
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'PlantUML source', exact: true });
  await field.fill('@startuml\nskinparam linetype spline\nclass A\nclass B\nA --> B\n@enduml');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.locator('.react-flow__edge-path')).toHaveAttribute('d', /C/);
});

test('title-only OpenIconic example renders its label and symbols', async ({ page }) => {
  await open(page, 'title: <&heart> Demo <&heart>');
  await expect(page.locator('.standalone-title')).toContainText('Demo');
  await expect(page.locator('.standalone-title .label-icon')).toHaveCount(2);
  await expect(page.getByText('Your canvas is ready', { exact: true })).toBeHidden();
});

test('procedure values stay editable without duplicate text in the diagram', async ({ page }) => {
  await open(page, '!procedure $card($id, $heading, $detail)\ncard $id as "<b>$heading</b>\\n$detail"\n!endprocedure\n$card(Order, "Checkout", "Ready to submit")');
  const node = page.locator('.uml-node[data-element-id="Order"]');
  await expect(node).toContainText('Ready to submit');
  await expect(node.locator('.node-members, .node-detail')).toHaveCount(0);
  await node.click();
  await node.getByRole('button', { name: 'Edit values', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Element members', exact: true })).toHaveValue(/\$detail = "Ready to submit"/);
});

test('WBS stacked leaves share sharp vertical stems', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value: '@startwbs\n* Top\n** A\n*** A1\n*** A2\n** B\n*** B1\n*** B2\n@endwbs' }));
  await page.goto('/');
  await expect(page.locator('.react-flow__edge-path')).toHaveCount(6);
  const paths = await page.locator('.react-flow__edge-path').evaluateAll(items => items.map(item => item.getAttribute('d')!));
  expect(paths.every(path => !/[CQ]/.test(path))).toBe(true);
  expect(paths.filter(path => (path.match(/L/g) ?? []).length === 2)).toHaveLength(4);
});

test('Gantt dependencies use small arrows and sharp routes', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value: '@startgantt\n[Draft] requires 3 days\nthen [Build] requires 4 days\n@endgantt' }));
  await page.goto('/');
  const edge = page.locator('.react-flow__edge-path');
  await expect(edge).toHaveCount(1);
  await expect(edge).toHaveAttribute('marker-end', 'url(#uml-schedule-arrow)');
  expect(await edge.getAttribute('d')).not.toMatch(/[CQ]/);
});
