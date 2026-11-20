import type { DiagramElement, DiagramKind, Point } from '../shared/protocol';

export interface Box extends Point { width: number; height: number }

/** Families whose elements are placed freely, rather than by their source structure. */
export const freeformKinds: ReadonlySet<DiagramKind> = new Set<DiagramKind>(['class', 'object', 'component', 'deployment', 'usecase', 'state', 'entity', 'c4', 'archimate', 'dot']);

/** The same insets the automatic layout leaves around a container's contents. */
const inset = { left: 30, top: 70, right: 30, bottom: 30 };

/**
 * Containers drawn around wherever their contents sit now. A package follows a class that was
 * dragged across it instead of leaving it outside its frame. Empty containers keep their own box.
 */
export function containerBounds(elements: readonly DiagramElement[], box: (id: string) => Box | undefined): Map<string, Box> {
  const children = new Map<string, DiagramElement[]>();
  for (const element of elements) if (element.parentId) children.set(element.parentId, [...children.get(element.parentId) ?? [], element]);
  const bounds = new Map<string, Box>(), visiting = new Set<string>();
  const resolve = (element: DiagramElement): Box | undefined => {
    if (bounds.has(element.id)) return bounds.get(element.id);
    const inner = element.meta?.container && !visiting.has(element.id) ? children.get(element.id) : undefined;
    if (!inner?.length) return box(element.id);
    visiting.add(element.id);
    const boxes = inner.map(resolve).filter((item): item is Box => !!item);
    visiting.delete(element.id);
    if (!boxes.length) return box(element.id);
    const left = Math.min(...boxes.map(item => item.x)), top = Math.min(...boxes.map(item => item.y));
    const right = Math.max(...boxes.map(item => item.x + item.width)), bottom = Math.max(...boxes.map(item => item.y + item.height));
    const fitted = { x: left - inset.left, y: top - inset.top, width: Math.max(260, right - left + inset.left + inset.right), height: Math.max(150, bottom - top + inset.top + inset.bottom) };
    bounds.set(element.id, fitted);
    return fitted;
  };
  for (const element of elements) if (element.meta?.container) resolve(element);
  return bounds;
}

/** A clear spot for a new element beside what is already arranged. */
export function freeSpot(boxes: readonly Box[], siblings: readonly Box[] = []): Point {
  if (siblings.length) return { x: Math.min(...siblings.map(box => box.x)), y: Math.max(...siblings.map(box => box.y + box.height)) + 40 };
  if (!boxes.length) return { x: 80, y: 70 };
  const left = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width)), bottom = Math.max(...boxes.map(box => box.y + box.height));
  // Grow the shorter side, so the diagram stays close to the shape of the window.
  return right - left > (bottom - top) * 1.4 ? { x: left, y: bottom + 70 } : { x: right + 70, y: top };
}

export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'distribute-x' | 'distribute-y';

/** New positions for a selection lined up on one edge or axis, or spread evenly between its ends. */
export function alignBoxes(boxes: ReadonlyMap<string, Box>, how: Alignment): Map<string, Point> {
  const items = [...boxes], result = new Map<string, Point>();
  if (items.length < 2) return result;
  const left = Math.min(...items.map(([, box]) => box.x)), right = Math.max(...items.map(([, box]) => box.x + box.width));
  const top = Math.min(...items.map(([, box]) => box.y)), bottom = Math.max(...items.map(([, box]) => box.y + box.height));
  if (how === 'distribute-x' || how === 'distribute-y') {
    const axis = how === 'distribute-x' ? 'x' : 'y', extent = axis === 'x' ? 'width' : 'height';
    const ordered = items.sort(([, a], [, b]) => a[axis] + a[extent] / 2 - b[axis] - b[extent] / 2);
    const span = (axis === 'x' ? right - left : bottom - top) - ordered.reduce((sum, [, box]) => sum + box[extent], 0);
    // Overlapping boxes cannot share out a negative gap; give them a standard one.
    const between = ordered.length > 2 && span > 0 ? span / (ordered.length - 1) : Math.max(40, span / (ordered.length - 1));
    let cursor = axis === 'x' ? left : top;
    for (const [id, box] of ordered) { result.set(id, { ...box, [axis]: Math.round(cursor) }); cursor += box[extent] + between; }
    return new Map([...result].map(([id, point]) => [id, { x: point.x, y: point.y }]));
  }
  for (const [id, box] of items) {
    const x = how === 'left' ? left : how === 'right' ? right - box.width : how === 'center' ? (left + right) / 2 - box.width / 2 : box.x;
    const y = how === 'top' ? top : how === 'bottom' ? bottom - box.height : how === 'middle' ? (top + bottom) / 2 - box.height / 2 : box.y;
    result.set(id, { x: Math.round(x), y: Math.round(y) });
  }
  return result;
}

/** A line the dragged box was snapped to, drawn across the boxes that share it. */
export interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number }

const edges = (start: number, size: number) => [start, start + size / 2, start + size];

/**
 * The smallest shift, at most `threshold` per axis, that lines up the moving box's left, centre or
 * right (top, middle or bottom) with the same kind of line of another box, and the guides it makes.
 * Axes the caller keeps fixed are never shifted. Linear in the number of boxes, so it runs per frame.
 */
export function snapBox(moving: Box, others: readonly Box[], threshold: number, free: { x: boolean; y: boolean } = { x: true, y: true }): { dx: number; dy: number; guides: Guide[] } {
  const shift = (axis: 'x' | 'y'): number | undefined => {
    const extent = axis === 'x' ? 'width' : 'height', own = edges(moving[axis], moving[extent]);
    let best: number | undefined;
    for (const other of others) for (const line of edges(other[axis], other[extent])) for (const mine of own) {
      const delta = line - mine;
      if (Math.abs(delta) <= threshold && (best === undefined || Math.abs(delta) < Math.abs(best))) best = delta;
    }
    return best;
  };
  const dx = free.x ? shift('x') : undefined, dy = free.y ? shift('y') : undefined;
  const snapped = { ...moving, x: moving.x + (dx ?? 0), y: moving.y + (dy ?? 0) }, guides: Guide[] = [];
  for (const [axis, delta] of [['x', dx], ['y', dy]] as const) {
    if (delta === undefined) continue;
    const extent = axis === 'x' ? 'width' : 'height', across = axis === 'x' ? 'y' : 'x', span = axis === 'x' ? 'height' : 'width';
    for (const at of edges(snapped[axis], snapped[extent])) {
      const sharing = others.filter(other => edges(other[axis], other[extent]).some(line => Math.abs(line - at) < .5));
      if (!sharing.length) continue;
      const all = [snapped, ...sharing];
      guides.push({ axis, at, from: Math.min(...all.map(box => box[across])), to: Math.max(...all.map(box => box[across] + box[span])) });
    }
  }
  return { dx: dx ?? 0, dy: dy ?? 0, guides };
}

export interface DropScene {
  /** Pointer and dragged box in flow coordinates. */
  pointer: Point; box: Box;
  /** Where the element sits in the source, and where the drag currently shows it. */
  original?: string; current?: string;
  /** Every other container as it was drawn when the drag started. */
  containers: ReadonlyMap<string, Box>; parents: ReadonlyMap<string, string | undefined>;
  /** Containers the source edit accepts this element into. */
  allowed: ReadonlySet<string>;
  /** The clear gap past its container's box that takes an element out, so a short drag only grows the container. */
  margin: number;
}

/**
 * The container a dragged element belongs to while it is dragged. It stays in its container until it
 * is a clear gap away from the box that container had, so it can be rearranged inside; it joins a different
 * container under the pointer at once; once it is clear of its container it falls to the container
 * under the pointer or the top level. A container that cannot take it blocks the move instead.
 */
export function dropContainer(scene: DropScene): { parentId?: string; blocked?: string } {
  const { pointer, box, current, original, containers, parents, allowed, margin } = scene;
  const inside = (outer: Box, x: number, y: number) => x >= outer.x && x <= outer.x + outer.width && y >= outer.y && y <= outer.y + outer.height;
  const touches = (other: Box) => box.x < other.x + other.width + margin && other.x - margin < box.x + box.width && box.y < other.y + other.height + margin && other.y - margin < box.y + box.height;
  const chain = (id: string | undefined) => { const ids: string[] = []; for (let at = id; at !== undefined && !ids.includes(at); at = parents.get(at)) ids.push(at); return ids; };
  let hit: string | undefined, depth = -1, area = Infinity;
  for (const [id, bounds] of containers) {
    if (!inside(bounds, pointer.x, pointer.y)) continue;
    const level = chain(id).length, size = bounds.width * bounds.height;
    if (level > depth || level === depth && size < area) { hit = id; depth = level; area = size; }
  }
  const join = (id: string) => allowed.has(id) ? { parentId: id } : { parentId: original, blocked: id };
  if (hit !== undefined && !chain(current).includes(hit)) return join(hit);
  const home = current === undefined ? undefined : containers.get(current);
  if (home && touches(home)) return { parentId: current };
  return hit === undefined ? {} : join(hit);
}

const overlaps = (a: Box, b: Box, margin: number) => a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;

/**
 * Automatic positions for elements that would otherwise sit on a hand-placed one. The layout ranks
 * the whole graph without knowing what was dragged where, so an unpinned box that lands on a pinned
 * one slides to the nearest clear place. Boxes that are already clear are left exactly as ranked.
 */
export function clearOfPinned(automatic: ReadonlyMap<string, Box>, pinned: readonly Box[], margin = 16): Map<string, Point> {
  const moved = new Map<string, Point>();
  if (!pinned.length) return moved;
  const settled = new Map(automatic);
  for (const [id, box] of automatic) {
    if (!pinned.some(other => overlaps(box, other, margin))) continue;
    const blocked = (candidate: Box) => pinned.some(other => overlaps(candidate, other, margin)) || [...settled].some(([other, at]) => other !== id && overlaps(candidate, at, margin));
    search: for (let step = 1; step <= 60; step++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const candidate = { ...box, x: box.x + dx * step * 40, y: box.y + dy * step * 40 };
      if (blocked(candidate)) continue;
      moved.set(id, { x: candidate.x, y: candidate.y }); settled.set(id, candidate);
      break search;
    }
  }
  return moved;
}
