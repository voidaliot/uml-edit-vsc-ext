import { test, expect } from '@playwright/test';

for (const kind of ['json', 'yaml'] as const) test(`${kind} table keys and values edit in place`, async ({ page }) => {
  const source = kind === 'json' ? '@startjson\n{"fruit":"Apple","size":"Large","color":["Red","Green"]}\n@endjson' : '@startyaml\nfruit: Apple\nsize: Large\ncolor:\n  - Red\n  - Green\n@endyaml';
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  await expect(page.locator('.data-table-grid')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await page.locator('.node-name').filter({ hasText: /^fruit$/ }).dblclick();
  await page.getByRole('textbox', { name: 'Element name', exact: true }).fill('food');
  await page.getByRole('textbox', { name: 'Element name', exact: true }).press('Enter');
  await expect(page.locator('.node-name').filter({ hasText: /^food$/ })).toBeVisible();
  const row = page.locator('.uml-node').filter({ has: page.locator('.node-name').filter({ hasText: /^food$/ }) });
  await row.locator('.data-table-row').dblclick();
  await page.getByRole('textbox', { name: 'Element members', exact: true }).fill(kind === 'json' ? '"Pear"' : 'Pear');
  await row.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(row.locator('.data-table-row')).toHaveText('Pear');
  await page.getByRole('button', { name: 'Edit PlantUML source in canvas', exact: true }).click();
  const updated = await page.getByRole('textbox', { name: 'PlantUML source', exact: true }).inputValue();
  expect(updated).toContain(kind === 'json' ? '"food":"Pear"' : 'food: Pear');
  await page.getByRole('button', { name: 'Close source editor', exact: true }).click();
  await expect(page.locator('.data-table-grid')).toHaveCount(2);
});

test('moving a data table keeps its rows attached after a source edit', async ({ page }) => {
  const source = '@startjson\n{"fruit":"Apple","size":"Large","color":["Red","Green"]}\n@endjson';
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  const root = page.locator('.uml-node').filter({ has: page.locator('[aria-label="Object table"]') });
  const fruit = page.locator('.uml-node').filter({ has: page.locator('.node-name').filter({ hasText: /^fruit$/ }) });
  await expect(root).toBeVisible();
  const before = await root.boundingBox();
  const drag = await root.locator('.data-table-key').boundingBox();
  expect(drag).not.toBeNull();
  await page.mouse.move(drag!.x + 15, drag!.y + drag!.height / 2); await page.mouse.down();
  await page.mouse.move(drag!.x + 75, drag!.y + drag!.height / 2 + 35, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await root.boundingBox())!.x).toBeGreaterThan(before!.x + 30);
  await fruit.locator('.data-table-row').dblclick();
  await page.getByRole('textbox', { name: 'Element members', exact: true }).fill('"A much longer value that wraps onto several table lines"');
  await fruit.getByRole('button', { name: 'Apply', exact: true }).click();
  const rootAfter = await root.boundingBox(), rowAfter = await fruit.boundingBox();
  expect(Math.abs(rowAfter!.x - rootAfter!.x)).toBeLessThan(3);
  expect(Math.abs(rowAfter!.y - rootAfter!.y)).toBeLessThan(3);
  const size = await page.locator('.uml-node').filter({ has: page.locator('.node-name').filter({ hasText: /^size$/ }) }).boundingBox();
  expect(Math.abs(size!.y - rowAfter!.y - rowAfter!.height)).toBeLessThan(3);
});
