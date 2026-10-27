import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { parseDocument } from '../../src/core/parser';
import { center, geometry, crossesBox, collinearOverlap, crossesLine } from './graph-geometry';

// The optional reference corpus stays outside this MIT project (see third-party notices).
const reference = join(resolve(process.env.PLANTUML_EXAMPLES ?? '../plantuml-examples/doc'), 'area-diagram/area-diagram.plantuml');
const available = existsSync(reference);
const fixture = available ? readFileSync(reference, 'utf8') : '';
async function showArea(page: Page, lineType?: string) {
  const source = lineType ? fixture.replace('@startuml', `@startuml\nskinparam linetype ${lineType}`) : fixture;
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  await expect(page.locator('.uml-node')).toHaveCount(21);
  await expect(page.locator('.react-flow__edge-path')).toHaveCount(24);
  await page.getByRole('button', { name: 'Fit diagram (F)', exact: true }).click();
  return source;
}

test('area diagram preserves the reference bands and has clear direct relationships', async ({ page }) => {
  test.skip(!available, 'Set PLANTUML_EXAMPLES to the optional example checkout\'s doc directory.');
  const source = await showArea(page);
  const scene = await geometry(page, source), byId = new Map(scene.nodes.map(node => [node.id, node]));
  const at = (id: string) => center(byId.get(id)!);
  const pipeline = ['StackLeft', 'Pipeline1', 'Pipeline2', 'Pipeline3', 'StackRight'];
  const row = pipeline.map(id => at(id).y);
  expect(Math.max(...row) - Math.min(...row), 'The five pipeline shapes share one center line.').toBeLessThan(2);
  for (let index = 1; index < pipeline.length; index++) expect(at(pipeline[index]).x).toBeGreaterThan(at(pipeline[index - 1]).x);
  const upper = ['UseCase1', 'UseCase2', 'DiamondUpper', 'UseCase3', 'UseCase4'];
  for (let index = 1; index < upper.length; index++) expect(at(upper[index]).x).toBeGreaterThan(at(upper[index - 1]).x);
  for (let index = 1; index <= 4; index++) {
    expect(at(`Actor${index}`).y).toBeLessThan(at(`UseCase${index}`).y);
    expect(Math.abs(at(`Actor${index}`).x - at(`UseCase${index}`).x)).toBeLessThan(2);
    expect(at(`UseCase${index}`).y).toBeLessThan(at('Pipeline2').y);
  }
  expect(Math.abs(at('DiamondUpper').x - at('Pipeline2').x)).toBeLessThan(3);
  expect(Math.abs(at('DiamondLower').x - at('Pipeline2').x)).toBeLessThan(3);
  expect(at('DiamondLower').y).toBeGreaterThan(at('Pipeline2').y);
  for (const branch of [1, 3]) {
    const first = at(`Pipeline${branch}Control1`), second = at(`Pipeline${branch}Control2`);
    expect(first.y).toBeGreaterThan(at(`Pipeline${branch}`).y);
    expect(second.y).toBeGreaterThan(at(`Pipeline${branch}`).y);
    expect(first.x).toBeLessThan(second.x);
    expect(Math.abs((first.x + second.x) / 2 - at(`Pipeline${branch}`).x)).toBeLessThan(3);
  }
  const nodeOverlaps: string[] = [];
  for (let a = 0; a < scene.nodes.length; a++) for (let b = a + 1; b < scene.nodes.length; b++) {
    const p = scene.nodes[a], q = scene.nodes[b];
    if (Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x) > 1 && Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y) > 1) nodeOverlaps.push(`${p.id} / ${q.id}`);
  }
  expect(nodeOverlaps, 'No visible node bounding boxes overlap.').toEqual([]);
  const crossings: string[] = [], overlaps: string[] = [], lineCrossings: string[] = [];
  for (const link of scene.links) {
    expect(link.path, `${link.source} -> ${link.target} uses a direct default line`).not.toMatch(/[CQ]/i);
    const [start, end] = [link.points[0], link.points.at(-1)!];
    for (const node of scene.nodes) if (![link.source, link.target].includes(node.id) && crossesBox(start, end, node)) crossings.push(`${link.source} -> ${link.target} crosses ${node.id}`);
  }
  for (let a = 0; a < scene.links.length; a++) for (let b = a + 1; b < scene.links.length; b++) {
    const p = scene.links[a], q = scene.links[b];
    if (collinearOverlap(p.points[0], p.points.at(-1)!, q.points[0], q.points.at(-1)!) > 1.5) overlaps.push(`${p.source} -> ${p.target} / ${q.source} -> ${q.target}`);
    if (crossesLine(p.points[0], p.points.at(-1)!, q.points[0], q.points.at(-1)!)) lineCrossings.push(`${p.source} -> ${p.target} / ${q.source} -> ${q.target}`);
  }
  expect(crossings, 'Direct connectors stay outside unrelated node bounds.').toEqual([]);
  expect(overlaps, 'Distinct connectors do not share a collinear segment.').toEqual([]);
  expect(lineCrossings, 'The database and control fans remain separate, as in the reference.').toEqual([]);
});

for (const lineType of ['ortho', 'spline', 'polyline']) test(`area diagram honors explicit ${lineType} source routing`, async ({ page }) => {
  test.skip(!available, 'Set PLANTUML_EXAMPLES to the optional example checkout\'s doc directory.');
  const source = await showArea(page, lineType);
  const { links } = await geometry(page, source);
  if (lineType === 'spline') expect(links.some(link => /[CQ]/i.test(link.path))).toBe(true);
  else if (lineType === 'polyline') for (const link of links) expect(link.path).not.toMatch(/[CQ]/i);
  else for (const link of links) {
    expect(link.path).not.toMatch(/[CQ]/i);
    const points = [...link.path.matchAll(/[ML]\s*([-\d.e+]+)[,\s]+([-\d.e+]+)/gi)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
    expect(points.length).toBeGreaterThan(1);
    for (let index = 1; index < points.length; index++) {
      const before = points[index - 1], point = points[index];
      expect(Math.min(Math.abs(point.x - before.x), Math.abs(point.y - before.y))).toBeLessThan(.01);
    }
  }
});

test('graph fan attachments follow manual moves and reset with Re-layout', async ({ page }) => {
  const source = '@startuml\nclass Parent\nclass Left\nclass Right\nParent --> Left\nParent --> Right\n@enduml';
  const relations = parseDocument(source).diagrams[0].relations;
  await page.addInitScript(value => Object.defineProperty(window, '__ALIOT_INITIAL_SOURCE__', { value }), source);
  await page.goto('/');
  await expect(page.locator('.react-flow__edge-path')).toHaveCount(2);
  const sourceX = (id: string) => page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`).evaluate(element => {
    const path = element as SVGPathElement, point = path.getPointAtLength(0), matrix = path.getScreenCTM()!;
    return matrix.a * point.x + matrix.c * point.y + matrix.e;
  });
  await expect.poll(async () => (await sourceX(relations[0].id)) - (await sourceX(relations[1].id))).toBeLessThan(-5);
  const left = await page.locator('.uml-node[data-element-id="Left"] .node-name').boundingBox();
  const right = await page.locator('.uml-node[data-element-id="Right"] .node-name').boundingBox();
  expect(left).not.toBeNull(); expect(right).not.toBeNull();
  const from = { x: left!.x + left!.width / 2, y: left!.y + left!.height / 2 };
  const to = { x: right!.x + right!.width + 100, y: from.y };
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => (await sourceX(relations[0].id)) - (await sourceX(relations[1].id))).toBeGreaterThan(5);
  await page.getByRole('button', { name: 'Re-layout diagram', exact: true }).click();
  await expect.poll(async () => (await sourceX(relations[0].id)) - (await sourceX(relations[1].id))).toBeLessThan(-5);
});
