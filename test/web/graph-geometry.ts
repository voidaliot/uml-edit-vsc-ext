import type { Page } from '@playwright/test';
import { parseDocument } from '../../src/core/parser';

export type Point = { x: number; y: number };
export type Box = { id: string; x: number; y: number; width: number; height: number };
export type Link = { id: string; source: string; target: string; path: string; points: Point[] };
export const center = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

export async function geometry(page: Page, source: string): Promise<{ nodes: Box[]; links: Link[] }> {
  const nodes = await page.locator('.uml-node').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { id: element.getAttribute('data-element-id')!, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
  const paths = await page.locator('.react-flow__edge').evaluateAll(groups => groups.map(group => {
    const path = group.querySelector<SVGPathElement>('.react-flow__edge-path')!;
    const matrix = path.getScreenCTM()!;
    const length = path.getTotalLength(), count = Math.max(1, Math.ceil(length / 2));
    const points = Array.from({ length: count + 1 }, (_, index) => {
      const point = path.getPointAtLength(index * length / count);
      return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f };
    });
    return { id: group.getAttribute('data-id')!, path: path.getAttribute('d')!, points };
  }));
  const relations = new Map(parseDocument(source).diagrams[0].relations.map(relation => [relation.id, relation]));
  return { nodes, links: paths.map(path => ({ ...path, source: relations.get(path.id)!.source, target: relations.get(path.id)!.target })) };
}

/** Strict rectangle interior clipping; endpoint tangencies do not count as crossings. */
export function crossesBox(a: Point, b: Point, box: Box): boolean {
  const inset = .8, min = { x: box.x + inset, y: box.y + inset }, max = { x: box.x + box.width - inset, y: box.y + box.height - inset };
  let from = 0, to = 1;
  for (const axis of ['x', 'y'] as const) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < .0001) { if (a[axis] <= min[axis] || a[axis] >= max[axis]) return false; }
    else {
      const p = (min[axis] - a[axis]) / delta, q = (max[axis] - a[axis]) / delta;
      from = Math.max(from, Math.min(p, q)); to = Math.min(to, Math.max(p, q));
      if (from >= to) return false;
    }
  }
  return to > 0 && from < 1 && (to - from) * Math.hypot(b.x - a.x, b.y - a.y) > .5;
}

export function collinearOverlap(a: Point, b: Point, c: Point, d: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy), other = Math.hypot(d.x - c.x, d.y - c.y);
  if (length < 1 || other < 1) return 0;
  if (Math.abs(dx * (d.y - c.y) - dy * (d.x - c.x)) > length * other * .001) return 0;
  if (Math.abs(dx * (c.y - a.y) - dy * (c.x - a.x)) / length > .6) return 0;
  const project = (point: Point) => ((point.x - a.x) * dx + (point.y - a.y) * dy) / length;
  return Math.max(0, Math.min(length, Math.max(project(c), project(d))) - Math.max(0, Math.min(project(c), project(d))));
}

export function crossesLine(a: Point, b: Point, c: Point, d: Point): boolean {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const cross = (p: Point, q: Point) => p.x * q.y - p.y * q.x, denominator = cross(r, s);
  if (Math.abs(denominator) < .001) return false;
  const delta = { x: c.x - a.x, y: c.y - a.y }, t = cross(delta, s) / denominator, u = cross(delta, r) / denominator;
  const length = Math.hypot(r.x, r.y), other = Math.hypot(s.x, s.y);
  return t * length > 1.5 && (1 - t) * length > 1.5 && u * other > 1.5 && (1 - u) * other > 1.5;
}

