import { describe, expect, it } from 'vitest';
import { alignBoxes, clearOfPinned, containerBounds, freeSpot, type Box } from '../src/webview/arrange';
import type { DiagramElement } from '../src/shared/protocol';

const element = (id: string, parentId?: string, container = false): DiagramElement => ({ id, name: id, kind: container ? 'package' : 'class', members: [], startLine: 0, endLine: 0, parentId, meta: container ? { container: true } : {} });
const apart = (a: Box, b: Box) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

describe('arranging by hand', () => {
  it('draws a container around its contents wherever they were dragged', () => {
    const elements = [element('Outer', undefined, true), element('Inner', 'Outer', true), element('A', 'Inner'), element('B', 'Outer'), element('Empty', undefined, true), element('Free')];
    const boxes: Record<string, Box> = { A: { x: 100, y: 200, width: 192, height: 100 }, B: { x: 700, y: 50, width: 192, height: 100 }, Empty: { x: 0, y: 900, width: 260, height: 150 }, Free: { x: 0, y: 0, width: 10, height: 10 }, Outer: { x: 5, y: 5, width: 1, height: 1 }, Inner: { x: 5, y: 5, width: 1, height: 1 } };
    const bounds = containerBounds(elements, id => boxes[id]);
    // The automatic layout leaves 30px at the sides and bottom and 70px for the header.
    expect(bounds.get('Inner')).toEqual({ x: 70, y: 130, width: 260, height: 200 });
    expect(bounds.get('Outer')).toEqual({ x: 40, y: -20, width: 882, height: 380 });
    // An empty container keeps its own box, and nothing else is touched.
    expect([...bounds.keys()].sort()).toEqual(['Inner', 'Outer']);
  });

  it('survives a parent cycle in malformed input', () => {
    const elements = [{ ...element('A', 'B', true) }, { ...element('B', 'A', true) }];
    expect(() => containerBounds(elements, () => ({ x: 0, y: 0, width: 10, height: 10 }))).not.toThrow();
  });

  it('finds a clear place for a new element beside the arrangement', () => {
    expect(freeSpot([])).toEqual({ x: 80, y: 70 });
    const tall = [{ x: 0, y: 0, width: 200, height: 100 }, { x: 0, y: 300, width: 200, height: 100 }];
    const wide = [{ x: 0, y: 0, width: 200, height: 100 }, { x: 900, y: 0, width: 200, height: 100 }];
    for (const boxes of [tall, wide]) { const spot = freeSpot(boxes); for (const box of boxes) expect(apart({ ...spot, width: 192, height: 108 }, box)).toBe(true); }
    expect(freeSpot(tall).x).toBeGreaterThan(200);
    expect(freeSpot(wide).y).toBeGreaterThan(100);
    // Inside a container it goes under its siblings, not out beside the whole diagram.
    expect(freeSpot(wide, [{ x: 40, y: 500, width: 192, height: 80 }])).toEqual({ x: 40, y: 620 });
  });

  it('aligns and distributes a selection', () => {
    const boxes = new Map<string, Box>([['a', { x: 0, y: 0, width: 100, height: 40 }], ['b', { x: 300, y: 100, width: 200, height: 80 }], ['c', { x: 130, y: 260, width: 60, height: 60 }]]);
    expect([...alignBoxes(boxes, 'left').values()].map(point => point.x)).toEqual([0, 0, 0]);
    expect(alignBoxes(boxes, 'right').get('a')).toEqual({ x: 400, y: 0 });
    expect(alignBoxes(boxes, 'center').get('c')).toEqual({ x: 220, y: 260 });
    expect([...alignBoxes(boxes, 'top').values()].map(point => point.y)).toEqual([0, 0, 0]);
    expect(alignBoxes(boxes, 'bottom').get('a')).toEqual({ x: 0, y: 280 });
    expect(alignBoxes(boxes, 'middle').get('b')).toEqual({ x: 300, y: 120 });
    // Equal gaps between neighbours, keeping the outermost boxes where they are.
    const spread = alignBoxes(boxes, 'distribute-x');
    expect(spread.get('a')).toEqual({ x: 0, y: 0 });
    expect(spread.get('c')).toEqual({ x: 170, y: 260 });
    expect(spread.get('b')).toEqual({ x: 300, y: 100 });
    expect(alignBoxes(boxes, 'distribute-y').get('b')).toEqual({ x: 300, y: 110 });
    expect(alignBoxes(new Map([['a', boxes.get('a')!]]), 'left').size).toBe(0);
  });

  it('separates stacked boxes when they are distributed', () => {
    const stacked = new Map<string, Box>([['a', { x: 0, y: 0, width: 100, height: 40 }], ['b', { x: 0, y: 0, width: 100, height: 40 }], ['c', { x: 0, y: 0, width: 100, height: 40 }]]);
    const result = [...alignBoxes(stacked, 'distribute-x')].map(([id, point]) => ({ ...stacked.get(id)!, ...point }));
    for (let a = 0; a < result.length; a++) for (let b = a + 1; b < result.length; b++) expect(apart(result[a], result[b])).toBe(true);
  });

  it('moves a re-ranked element off a hand-placed one and leaves clear elements alone', () => {
    const pinned = [{ x: 100, y: 100, width: 192, height: 108 }];
    const ranked = new Map<string, Box>([['clear', { x: 600, y: 100, width: 192, height: 108 }], ['hit', { x: 150, y: 130, width: 192, height: 108 }], ['alsoHit', { x: 120, y: 90, width: 192, height: 108 }]]);
    const moved = clearOfPinned(ranked, pinned);
    expect(moved.has('clear')).toBe(false);
    const placed = [...pinned, ranked.get('clear')!, ...['hit', 'alsoHit'].map(id => ({ ...ranked.get(id)!, ...moved.get(id)! }))];
    for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) expect(apart(placed[a], placed[b]), `${a}/${b}`).toBe(true);
    expect(clearOfPinned(ranked, []).size).toBe(0);
  });
});
