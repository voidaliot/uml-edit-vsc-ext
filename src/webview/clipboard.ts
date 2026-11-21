import type { ClipFragment } from '../core/clipboard';
import type { DiagramElement, ElementPlacement, Point } from '../shared/protocol';
import { overlaps, type Box } from './arrange';

/** What the canvas holds after a copy: the source fragment and where its elements were drawn. */
export interface Clip {
  fragment: ClipFragment;
  /** Snippet line → the drawn box of the element declared there. */
  boxes: Record<number, Box>;
  /** Copies are placed by hand only when their originals were; otherwise the automatic layout ranks them. */
  placed: boolean;
}

/** A paste on its way to the host: where each snippet line's element should appear once it exists. */
export interface PendingPaste { diagramId: string; knownIds: Set<string>; insertLine: number; points: Record<number, Point> }

interface DrawnNode { id: string; position: Point; measured?: { width?: number; height?: number }; data: { element: DiagramElement } }

export const drawnBox = (node: DrawnNode): Box => ({ ...node.position, width: node.measured?.width ?? Number(node.data.element.meta?.width ?? 192), height: node.measured?.height ?? Number(node.data.element.meta?.height ?? 80) });

export function captureClip(fragment: ClipFragment, nodes: readonly DrawnNode[], saved: Record<string, ElementPlacement>): Clip {
  const boxes: Record<number, Box> = {};
  let placed = false;
  for (const [line, id] of Object.entries(fragment.origins)) {
    const node = nodes.find(item => item.id === id);
    if (node) boxes[Number(line)] = drawnBox(node);
    if (Object.hasOwn(saved, id) && !node?.data.element.meta?.container) placed = true;
  }
  return { fragment, boxes, placed };
}


/**
 * How far to move a copied group so that none of its boxes touches what is already drawn. The group
 * keeps its own arrangement and lands right of, below, or diagonally beside the originals.
 */
export function pasteOffset(group: readonly Box[], taken: readonly Box[], margin = 16): Point {
  if (!group.length) return { x: 0, y: 0 };
  const left = Math.min(...group.map(box => box.x)), top = Math.min(...group.map(box => box.y));
  const width = Math.max(...group.map(box => box.x + box.width)) - left, height = Math.max(...group.map(box => box.y + box.height)) - top;
  const clear = (dx: number, dy: number) => group.every(box => !taken.some(other => overlaps({ ...box, x: box.x + dx, y: box.y + dy }, other, margin)));
  for (let step = 0; step <= 40; step++) for (const [fx, fy] of [[1, 0], [0, 1], [1, 1], [-1, 0], [0, -1]]) {
    const dx = fx * (width + 40 + step * 40), dy = fy * (height + 40 + step * 40);
    if (clear(dx, dy)) return { x: dx, y: dy };
  }
  return { x: Math.max(left, ...taken.map(box => box.x + box.width)) + 80 - left, y: 0 };
}

/** Target points for a placed clip, by snippet line, clear of the boxes already in the diagram. */
export function pastePoints(clip: Clip, taken: readonly Box[]): Record<number, Point> {
  if (!clip.placed) return {};
  const offset = pasteOffset(Object.values(clip.boxes), taken);
  return Object.fromEntries(Object.entries(clip.boxes).map(([line, box]) => [line, { x: Math.round(box.x + offset.x), y: Math.round(box.y + offset.y) }]));
}

/** Elements whose name, kind or alias contains the query, for the outline's find box. */
export function filterOutline(elements: readonly DiagramElement[], query: string): DiagramElement[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...elements];
  return elements.filter(element => [element.name, element.kind, element.id].some(value => value.toLowerCase().includes(needle)));
}
