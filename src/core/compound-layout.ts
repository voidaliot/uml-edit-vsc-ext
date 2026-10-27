import type { DiagramBlock, Point } from '../shared/protocol';

interface Box extends Point { width: number; height: number; root: string; container: boolean }
interface Segment { source: string; target: string; a: Point; b: Point }

function occludedLength(a: Point, b: Point, box: Box): number {
  let from = 0, to = 1;
  for (const axis of ['x', 'y'] as const) {
    const low = box[axis] - 6, high = low + (axis === 'x' ? box.width : box.height) + 12;
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < .001) { if (a[axis] <= low || a[axis] >= high) return 0; }
    else {
      const p = (low - a[axis]) / delta, q = (high - a[axis]) / delta;
      from = Math.max(from, Math.min(p, q)); to = Math.min(to, Math.max(p, q));
      if (from >= to) return 0;
    }
  }
  return Math.max(0, to - from) * Math.hypot(b.x - a.x, b.y - a.y);
}

function intersectsLine(p: Segment, q: Segment): boolean {
  const rx = p.b.x - p.a.x, ry = p.b.y - p.a.y, sx = q.b.x - q.a.x, sy = q.b.y - q.a.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < .001) return false;
  const dx = q.a.x - p.a.x, dy = q.a.y - p.a.y;
  const t = (dx * sy - dy * sx) / denominator, u = (dx * ry - dy * rx) / denominator;
  return t > .001 && t < .999 && u > .001 && u < .999;
}

/** Keep compound subtrees rigid while giving long cross-boundary links clear sightlines.
 * Only the cross axis changes; rank order and nested placements remain intact.
 */
export function clearCompoundSightlines(block: DiagramBlock, points: Record<string, Point>, across: boolean, links: { source: string; target: string; axis: 'x' | 'y' }[]): void {
  const elements = new Map(block.elements.map(element => [element.id, element]));
  const rootOf = (id: string) => {
    const seen = new Set<string>();
    while (elements.get(id)?.parentId && elements.has(elements.get(id)!.parentId!)) {
      if (seen.has(id)) break;
      seen.add(id); id = elements.get(id)!.parentId!;
    }
    return id;
  };
  const roots = [...new Set(block.elements.map(element => rootOf(element.id)))];
  if (roots.length < 2 || !block.elements.some(element => element.parentId)) return;
  const axis = across ? 'y' : 'x', extent = across ? 'height' : 'width';
  const coordinate = (id: string) => points[id][axis] + Number(elements.get(id)?.meta?.[extent] ?? 0) / 2;
  const constraints = links.filter(link => link.axis === axis && points[link.source] && points[link.target] && coordinate(link.target) > coordinate(link.source));
  const initial = new Map(roots.map(id => [id, points[id][axis]]));
  const members = new Map(roots.map(id => [id, block.elements.filter(element => rootOf(element.id) === id).map(element => element.id)]));
  const relations = block.relations.filter(edge => edge.source !== edge.target && !/hidden/i.test(edge.arrow) && points[edge.source] && points[edge.target]);
  // Bound geometric work as models grow, without using timing-dependent exits
  // that could give the same source a different layout on another machine.
  let evaluations = 0;
  const budget = Math.max(2, Math.min(2048, Math.floor(2_000_000 / (block.elements.length ** 2 + relations.length ** 2))));
  const boxes = () => new Map(block.elements.map(element => [element.id, {
    ...points[element.id], width: Number(element.meta?.width ?? 220), height: Number(element.meta?.height ?? 130),
    root: rootOf(element.id), container: Boolean(element.meta?.container),
  }]));
  const endpoint = (box: Box, other: Box): Point => {
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const dx = other.x + other.width / 2 - x, dy = other.y + other.height / 2 - y;
    const t = Math.min(dx ? box.width / 2 / Math.abs(dx) : Infinity, dy ? box.height / 2 / Math.abs(dy) : Infinity);
    return Number.isFinite(t) ? { x: x + dx * t, y: y + dy * t } : { x, y };
  };
  const score = (): number[] => {
    evaluations++;
    const bounds = boxes(), entries = [...bounds.values()];
    let overlaps = 0, blocked = 0, crossings = 0, occluded = 0, length = 0;
    for (let a = 0; a < entries.length; a++) for (let b = a + 1; b < entries.length; b++) {
      const p = entries[a], q = entries[b];
      if (p.root !== q.root && Math.min(p.x + p.width, q.x + q.width) > Math.max(p.x, q.x) - 20 && Math.min(p.y + p.height, q.y + q.height) > Math.max(p.y, q.y) - 20) overlaps++;
    }
    const segments = relations.map(edge => {
      const source = bounds.get(edge.source)!, target = bounds.get(edge.target)!;
      return { source: edge.source, target: edge.target, a: endpoint(source, target), b: endpoint(target, source) };
    });
    for (const segment of segments) {
      length += Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
      for (const [id, box] of bounds) if (!box.container && id !== segment.source && id !== segment.target) {
        const hidden = occludedLength(segment.a, segment.b, box);
        if (hidden > .01) { blocked++; occluded += hidden; }
      }
    }
    for (let a = 0; a < segments.length; a++) for (let b = a + 1; b < segments.length; b++) {
      const p = segments[a], q = segments[b];
      if (![p.source, p.target].some(id => id === q.source || id === q.target) && intersectsLine(p, q)) crossings++;
    }
    const displacement = roots.reduce((sum, id) => sum + Math.abs(points[id][axis] - initial.get(id)!), 0);
    const reversed = constraints.filter(link => coordinate(link.target) <= coordinate(link.source)).length;
    return [reversed, overlaps, blocked, crossings, occluded, length + displacement * .3];
  };
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > .01) return a[i] < b[i];
    return false;
  };
  const move = (root: string, delta: number) => { for (const id of members.get(root)!) points[id][axis] += delta; };
  // Bounded coordinate search evaluates whole subtrees, including their leaf
  // endpoints. A boundary's center is never mistaken for its connected child.
  for (let pass = 0; pass < 6; pass++) {
    const current = score();
    if (current.slice(0, 4).every(value => value === 0)) break;
    let best = current, choice: { root: string; delta: number } | undefined;
    const bounds = boxes();
    for (const root of roots) {
      if (evaluations >= budget) break;
      const here = points[root][axis], size = bounds.get(root)![extent];
      const candidates = new Set([here - 80, here + 80, here - 160, here + 160, here - 320, here + 320, here - 640, here + 640, here - 1280, here + 1280]);
      for (const id of roots) if (id !== root) {
        const other = bounds.get(id)!;
        candidates.add(other[axis] - size - 90);
        candidates.add(other[axis] + other[extent] + 90);
      }
      for (const candidate of candidates) {
        if (evaluations >= budget) break;
        const delta = candidate - here;
        move(root, delta);
        const value = score();
        move(root, -delta);
        if (better(value, best)) { best = value; choice = { root, delta }; }
      }
    }
    if (!choice) break;
    move(choice.root, choice.delta);
  }
  const min = Math.min(...Object.values(points).map(point => point[axis]));
  for (const point of Object.values(points)) point[axis] -= min;
}
