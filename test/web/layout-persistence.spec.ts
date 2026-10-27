import { test, expect, type Page, type Locator } from '@playwright/test';
import { parseDocument } from '../../src/core/parser';
import { layoutDiagram } from '../../src/core/layout';
import type { DiagramLayout, Point, WebviewMessage } from '../../src/shared/protocol';

const initial = '@startuml\nclass A\nclass B\nA --> B\n@enduml\n';
type TestWindow = Window & { __aliotLayoutMessages: WebviewMessage[] };

async function openDocument(page: Page, source = initial, layouts: Record<string, DiagramLayout> = {}) {
  await page.addInitScript(value => {
    const target = window as unknown as TestWindow;
    target.__aliotLayoutMessages = [];
    target.acquireVsCodeApi = () => ({
      getState: () => undefined, setState: () => {},
      postMessage: message => {
        target.__aliotLayoutMessages.push(structuredClone(message));
        if (message.type === 'ready') queueMicrotask(() => window.postMessage({ type: 'document', source: value.source, version: 1, fileName: 'layout.puml', layouts: value.layouts, trusted: true }, '*'));
      },
    });
  }, { source, layouts });
  await page.goto('/');
  await expect(page.locator('.react-flow__node')).toHaveCount(parseDocument(source).diagrams[0].elements.length);
  await page.waitForTimeout(350);
}

async function latestLayout(page: Page): Promise<DiagramLayout> {
  return await page.evaluate(() => {
    const messages = (window as unknown as TestWindow).__aliotLayoutMessages;
    const latest = [...messages].reverse().find(message => message.type === 'layout' && message.diagramId === 'diagram-1');
    return latest?.type === 'layout' ? latest.layout : { positions: {} };
  });
}

async function updateSource(page: Page, source: string, version: number) {
  const layout = await latestLayout(page);
  await page.evaluate(value => window.postMessage({ type: 'document', source: value.source, version: value.version, fileName: 'layout.puml', layouts: { 'diagram-1': value.layout }, trusted: true }, '*'), { source, version, layout });
  await expect(page.locator('.react-flow__node')).toHaveCount(parseDocument(source).diagrams[0].elements.length);
}

async function position(page: Page, id: string): Promise<Point> {
  return await page.locator(`.react-flow__node[data-id=${JSON.stringify(id)}]`).evaluate(element => {
    const matrix = new DOMMatrix((element as HTMLElement).style.transform);
    return { x: matrix.e, y: matrix.f };
  });
}

async function drag(page: Page, node: Locator, dx = 75, dy = 45) {
  const box = await node.locator('.node-title').boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up();
}

test('fit, pan, and zoom persist only the viewport and leave automatic node coordinates free', async ({ page }) => {
  await openDocument(page);
  await page.getByRole('button', { name: 'Fit diagram (F)', exact: true }).click();
  await expect.poll(async () => (await latestLayout(page)).viewport?.zoom ?? 0).toBeGreaterThan(0);
  expect((await latestLayout(page)).positions).toEqual({});
  const before = (await latestLayout(page)).viewport!;
  await page.mouse.move(1100, 650); await page.mouse.wheel(0, 90);
  await expect.poll(async () => (await latestLayout(page)).viewport?.y ?? before.y).toBeLessThan(before.y - 30);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => (await latestLayout(page)).viewport?.zoom ?? before.zoom).toBeGreaterThan(before.zoom);
  expect((await latestLayout(page)).positions).toEqual({});
});

test('source insertion reflows automatic nodes, preserves a deliberate drag, and Re-layout releases that override', async ({ page }) => {
  await openDocument(page);
  await page.mouse.move(1100, 650); await page.mouse.wheel(0, 60);
  const inserted = '@startuml\nclass Intro\nclass A\nclass B\nIntro --> A\nA --> B\n@enduml\n';
  await updateSource(page, inserted, 2);
  const automatic = layoutDiagram(parseDocument(inserted).diagrams[0]);
  await expect.poll(() => position(page, 'B')).toEqual(automatic.B);
  await page.getByRole('button', { name: 'Fit diagram (F)', exact: true }).click(); await page.waitForTimeout(250);
  await drag(page, page.locator('.react-flow__node[data-id="A"]'));
  await expect.poll(async () => Object.keys((await latestLayout(page)).positions)).toEqual(['A']);
  const deliberate = (await latestLayout(page)).positions.A;
  expect(deliberate).not.toEqual(automatic.A);

  const expanded = inserted.replace('class Intro', 'class Stage\nclass Intro').replace('Intro --> A', 'Stage --> Intro\nIntro --> A');
  await updateSource(page, expanded, 3);
  const expandedAutomatic = layoutDiagram(parseDocument(expanded).diagrams[0]);
  await expect.poll(() => position(page, 'A')).toEqual(deliberate);
  await expect.poll(() => position(page, 'B')).toEqual(expandedAutomatic.B);
  expect(expandedAutomatic.B).not.toEqual(automatic.B);

  await page.getByRole('button', { name: 'Re-layout diagram', exact: true }).click();
  await expect.poll(async () => (await latestLayout(page)).positions).toEqual({});
  await expect.poll(() => position(page, 'A')).toEqual(expandedAutomatic.A);
  const final = expanded.replace('class Stage', 'class Entry\nclass Stage').replace('Stage --> Intro', 'Entry --> Stage\nStage --> Intro');
  await updateSource(page, final, 4);
  await expect.poll(() => position(page, 'A')).toEqual(layoutDiagram(parseDocument(final).diagrams[0]).A);
});

test('a container drag persists its moved descendants but does not freeze unrelated automatic nodes', async ({ page }) => {
  const source = '@startuml\npackage "Domain" as Domain {\n class "Item" as Item\n}\nclass Other\n@enduml\n';
  await openDocument(page, source);
  await drag(page, page.locator('.react-flow__node[data-id="Domain"]'));
  await expect.poll(async () => Object.keys((await latestLayout(page)).positions).sort()).toEqual(['Domain', 'Item']);
  expect(Object.hasOwn((await latestLayout(page)).positions, 'Other')).toBe(false);
});

test('Re-layout does not replace the saved viewport of a newly selected diagram', async ({ page }) => {
  const source = '@startuml\nclass First\n@enduml\n@startuml\nclass Second\n@enduml\n';
  const stored = { x: 90, y: 40, zoom: .75 };
  await openDocument(page, source, { 'diagram-2': { positions: {}, viewport: stored } });
  // Both actions happen together, before a delayed re-layout fit could run.
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Re-layout diagram"]')!.click();
    const selector = document.querySelector<HTMLSelectElement>('select[aria-label="Current diagram"]')!;
    selector.value = 'diagram-2'; selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.getByRole('combobox', { name: 'Current diagram', exact: true })).toHaveValue('diagram-2');
  const viewport = () => page.locator('.react-flow__viewport').evaluate(element => {
    const matrix = new DOMMatrix((element as HTMLElement).style.transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
  await expect.poll(viewport).toEqual(stored);
  await page.waitForTimeout(350);
  expect(await viewport()).toEqual(stored);
});

test('a multiple selection drag persists only the selected moved nodes', async ({ page }) => {
  await openDocument(page, '@startuml\nclass A\nclass B\nclass C\n@enduml\n');
  await page.locator('.react-flow__node[data-id="A"] .node-title').click();
  await page.keyboard.down('Control');
  await page.locator('.react-flow__node[data-id="B"] .node-title').click();
  await page.keyboard.up('Control');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await drag(page, page.locator('.react-flow__node[data-id="A"]'));
  await expect.poll(async () => Object.keys((await latestLayout(page)).positions).sort()).toEqual(['A', 'B']);
  expect(Object.hasOwn((await latestLayout(page)).positions, 'C')).toBe(false);
});
