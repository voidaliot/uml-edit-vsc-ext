import { describe, expect, it } from 'vitest';
import { alignBoxes, clearOfPinned, containerBounds, dropContainer, freeSpot, snapBox, type Box } from '../src/webview/arrange';
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

describe('dragging with guides', () => {
  const others = [{ x: 0, y: 0, width: 100, height: 40 }, { x: 300, y: 200, width: 200, height: 80 }];

  it('snaps the nearest edge or centre within the threshold and draws the shared lines', () => {
    // Left edge 3px right of the first box's left edge; top 4px below the second box's top.
    const { dx, dy, guides } = snapBox({ x: 3, y: 204, width: 100, height: 50 }, others, 6);
    expect([dx, dy]).toEqual([-3, -4]);
    // Same width as the first box: left, centre and right all line up, and the top meets the second box.
    expect(guides.filter(guide => guide.axis === 'x').map(guide => guide.at)).toEqual([0, 50, 100]);
    expect(guides.find(guide => guide.axis === 'x' && guide.at === 0)).toEqual({ axis: 'x', at: 0, from: 0, to: 250 });
    expect(guides.filter(guide => guide.axis === 'y')).toEqual([{ axis: 'y', at: 200, from: 0, to: 500 }]);
  });

  it('lines up centres with centres and edges with edges of different sizes', () => {
    expect(snapBox({ x: 352, y: 500, width: 100, height: 20 }, others, 6).dx).toBe(-2);
    expect(snapBox({ x: 520, y: 500, width: 20, height: 20 }, others, 6).dx).toBe(0);
    expect(snapBox({ x: 495, y: 500, width: 20, height: 20 }, others, 6).dx).toBe(5);
  });

  it('leaves boxes beyond the threshold, and fixed axes, alone', () => {
    expect(snapBox({ x: 120, y: 120, width: 30, height: 30 }, others, 6)).toEqual({ dx: 0, dy: 0, guides: [] });
    const fixed = snapBox({ x: 3, y: 204, width: 100, height: 50 }, others, 6, { x: false, y: true });
    expect([fixed.dx, fixed.dy]).toEqual([0, -4]);
    expect(fixed.guides.every(guide => guide.axis === 'y')).toBe(true);
    expect(snapBox({ x: 3, y: 3, width: 10, height: 10 }, [], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it('stays cheap for a large diagram', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ x: (index % 20) * 250, y: Math.floor(index / 20) * 160, width: 192, height: 80 }));
    const started = performance.now();
    for (let frame = 0; frame < 60; frame++) snapBox({ x: 1003 + frame, y: 482, width: 192, height: 80 }, many, 6);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('dropping into and out of containers', () => {
  const parents = new Map<string, string | undefined>([['Sales', undefined], ['Inner', 'Sales'], ['Billing', undefined], ['Locked', undefined]]);
  const containers = new Map<string, Box>([['Sales', { x: 0, y: 0, width: 600, height: 400 }], ['Inner', { x: 300, y: 100, width: 260, height: 200 }], ['Billing', { x: 800, y: 0, width: 300, height: 300 }], ['Locked', { x: 0, y: 600, width: 300, height: 200 }]]);
  const allowed = new Set(['Sales', 'Inner', 'Billing']);
  const at = (x: number, y: number, current?: string, margin = 0) => dropContainer({ pointer: { x, y }, box: { x: x - 50, y: y - 20, width: 100, height: 40 }, original: 'Sales', current, containers, parents, allowed, margin });

  it('keeps an element in its container while it is rearranged there', () => {
    expect(at(100, 100, 'Sales')).toEqual({ parentId: 'Sales' });
    // Hanging over the edge still belongs to the container, which grows around it.
    expect(at(640, 380, 'Sales')).toEqual({ parentId: 'Sales' });
  });

  it('joins another container under the pointer, the innermost first', () => {
    expect(at(900, 100, 'Sales')).toEqual({ parentId: 'Billing' });
    expect(at(400, 200, 'Sales')).toEqual({ parentId: 'Inner' });
    // Back over the outer container but still touching the inner one: it stays there.
    expect(at(290, 200, 'Inner')).toEqual({ parentId: 'Inner' });
    expect(at(150, 200, 'Inner')).toEqual({ parentId: 'Sales' });
  });

  it('falls to the top level once it is clear of its container', () => {
    expect(at(700, 500, 'Sales')).toEqual({});
    expect(at(700, 500)).toEqual({});
    // A short way past the edge only grows the container; the gap must be clear.
    expect(at(700, 500, 'Sales', 100)).toEqual({ parentId: 'Sales' });
    expect(at(760, 500, 'Sales', 100)).toEqual({});
  });

  it('refuses a container the source cannot nest it in', () => {
    expect(at(100, 700, 'Sales')).toEqual({ parentId: 'Sales', blocked: 'Locked' });
  });
});
