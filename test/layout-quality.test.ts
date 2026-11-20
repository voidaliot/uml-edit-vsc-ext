import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDocument } from '../src/core/parser';
import { layoutGraph } from '../src/core/graph-layout';
import type { Point } from '../src/shared/protocol';

interface Box { x: number; y: number; width: number; height: number }
/** Liang-Barsky clip of a segment against a box shrunk by two pixels. */
const hits = (a: Point, b: Point, box: Box) => {
  let from = 0, to = 1;
  for (const [delta, low, high] of [[b.x - a.x, box.x + 2 - a.x, box.x + box.width - 2 - a.x], [b.y - a.y, box.y + 2 - a.y, box.y + box.height - 2 - a.y]]) {
    if (Math.abs(delta) < 1e-9) { if (low >= 0 || high <= 0) return false; continue; }
    from = Math.max(from, Math.min(low / delta, high / delta)); to = Math.min(to, Math.max(low / delta, high / delta));
    if (from >= to) return false;
  }
  return true;
};
const intersect = (p: Point, q: Point, r: Point, s: Point) => {
  const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d, u = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d;
  return t > .02 && t < .98 && u > .02 && u < .98;
};

/** What a reader sees: links crossing each other, links drawn through a box, boxes on top of each other. */
function measure(name: string) {
  const block = parseDocument(readFileSync(new URL(`./fixtures/layout/${name}.puml`, import.meta.url), 'utf8')).diagrams[0];
  const started = performance.now(), points = layoutGraph(block), milliseconds = performance.now() - started;
  const box = (id: string): Box => { const element = block.elements.find(item => item.id === id)!; return { ...points[id], width: Number(element.meta?.width), height: Number(element.meta?.height) }; };
  const centre = (id: string) => { const item = box(id); return { x: item.x + item.width / 2, y: item.y + item.height / 2 }; };
  const leaves = block.elements.filter(element => !element.meta?.container);
  // A link that ends on a container stops at its frame, so only links between plain boxes are traced.
  const lines = block.relations.filter(relation => relation.source !== relation.target && [relation.source, relation.target].every(id => leaves.some(element => element.id === id)))
    .map(relation => ({ relation, path: [centre(relation.source), ...(relation.meta?.route as Point[] | undefined ?? []), centre(relation.target)] }));
  let through = 0, crossings = 0, overlaps = 0;
  for (const { relation, path } of lines) for (const element of leaves) if (element.id !== relation.source && element.id !== relation.target && path.slice(1).some((point, index) => hits(path[index], point, box(element.id)))) through++;
  for (let a = 0; a < lines.length; a++) for (let b = a + 1; b < lines.length; b++) {
    const first = lines[a], second = lines[b];
    if ([first.relation.source, first.relation.target].some(id => id === second.relation.source || id === second.relation.target)) continue;
    if (first.path.slice(1).some((point, index) => second.path.slice(1).some((other, at) => intersect(first.path[index], point, second.path[at], other)))) crossings++;
  }
  for (let a = 0; a < leaves.length; a++) for (let b = a + 1; b < leaves.length; b++) { const p = box(leaves[a].id), q = box(leaves[b].id); if (p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height) overlaps++; }
  return { through, crossings, overlaps, milliseconds, again: () => layoutGraph(block), points };
}

describe('layout quality on whole diagrams', () => {
  // Crossing counts are ceilings with a little headroom, not targets: a change that raises one
  // should be looked at on the canvas before the number is.
  it.each([
    ['class', 3], ['component', 0], ['usecase', 0], ['state', 0], ['x-inherit', 1], ['x-dense', 12], ['x-tree30', 18], ['x-big40', 38], ['x-big80', 70],
  ])('%s: no overlapping boxes, no link through a box, at most %i crossings', (name, ceiling) => {
    const result = measure(name);
    expect(result.overlaps).toBe(0);
    expect(result.through).toBe(0);
    expect(result.crossings).toBeLessThanOrEqual(ceiling);
  });

  it('is deterministic and stays interactive on a large diagram', () => {
    const result = measure('x-big80');
    expect(result.again()).toEqual(result.points);
    expect(result.milliseconds).toBeLessThan(1500);
  });
});
