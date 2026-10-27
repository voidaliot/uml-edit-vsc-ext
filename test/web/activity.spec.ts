import { test, expect, type Page } from '@playwright/test';
import { getTemplate } from '../../src/core/templates';

async function openActivity(page: Page, source = getTemplate('activity')!.source) {
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  await expect(page.locator('.activity-node').first()).toBeVisible();
  await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click();
  await page.waitForTimeout(250);
}

async function boxes(page: Page) {
  return page.locator('.activity-node').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { name: node.querySelector('.node-name')?.textContent ?? '', kind: node.getAttribute('data-element-kind'), x: rect.x, y: rect.y, width: rect.width, height: rect.height, cx: rect.x + rect.width / 2 };
  }));
}

test('activity starter has a centered compact trunk, balanced branches and straight vertical connectors', async ({ page }) => {
  await openActivity(page);
  const nodes = await boxes(page);
  const decision = nodes.find(node => node.kind === 'decision')!;
  const trunk = nodes.filter(node => ['start', 'end', 'decision', 'merge'].includes(node.kind!) || ['Receive order', 'Record result'].includes(node.name));
  for (const node of trunk) expect(Math.abs(node.cx - decision.cx)).toBeLessThan(1);
  const left = nodes.find(node => node.name === 'Reserve stock')!, right = nodes.find(node => node.name === 'Notify customer')!;
  expect(Math.abs((decision.cx - left.cx) - (right.cx - decision.cx))).toBeLessThan(1);
  expect(Math.abs(left.y - right.y)).toBeLessThan(1);
  expect(Math.max(...nodes.map(node => node.y + node.height)) - Math.min(...nodes.map(node => node.y))).toBeLessThan(440);
  expect(Math.max(...nodes.map(node => node.x + node.width)) - Math.min(...nodes.map(node => node.x))).toBeLessThan(400);
  const straight = await page.locator('.react-flow__edge-path').evaluateAll(paths => paths.map(path => path.getAttribute('d')!).filter(path => /^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+$/.test(path)));
  expect(straight).toHaveLength(4);
  await expect(page.locator('.kind-decision .node-name')).toHaveCSS('font-size', '12px');
});

test('long inline activity edits resize and reflow the automatic layout', async ({ page }) => {
  await openActivity(page);
  await page.locator('.activity-node .node-name').filter({ hasText: /^Receive order$/ }).dblclick();
  const input = page.getByRole('textbox', { name: 'Element name', exact: true });
  await input.fill('Receive and validate the complete order before processing the request');
  await input.press('Enter'); await expect(input).toBeHidden();
  const nodes = await boxes(page), renamed = nodes.find(node => node.name.startsWith('Receive and'))!, decision = nodes.find(node => node.kind === 'decision')!;
  expect(renamed.height).toBeGreaterThan(36);
  expect(renamed.y + renamed.height).toBeLessThan(decision.y);
  expect(Math.abs(renamed.cx - decision.cx)).toBeLessThan(1);
  const fits = await page.locator('.activity-node .node-name').filter({ hasText: /^Receive and/ }).evaluate(label => {
    const text = label.getBoundingClientRect(), shape = label.closest('.uml-node')!.getBoundingClientRect();
    return text.top > shape.top && text.bottom < shape.bottom && text.left > shape.left && text.right < shape.right;
  });
  expect(fits).toBe(true);
});

test('multiline SDL labels stay inside their native shapes', async ({ page }) => {
  await openActivity(page, '@startuml\nstart\n:Receive request\nfrom the work queue; <<input>>\n:Validate the submitted request and record any missing required fields; <<task>>\n:Send response; <<output>>\nstop\n@enduml');
  await expect(page.locator('.activity-control .node-stereotype')).toHaveCount(0);
  const fits = await page.locator('.activity-control .node-name').evaluateAll(labels => labels.every(label => {
    const text = label.getBoundingClientRect(), shape = label.closest('.uml-node')!.getBoundingClientRect();
    return text.top >= shape.top + 2 && text.bottom <= shape.bottom - 2;
  }));
  expect(fits).toBe(true);
});
