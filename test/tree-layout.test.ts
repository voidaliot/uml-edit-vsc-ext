import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { layoutTree } from '../src/core/tree-layout';
import type { DiagramElement } from '../src/shared/protocol';

function arrange(kind: 'mindmap' | 'wbs', body: string) {
  const block = parseDocument(`@start${kind}\n${body}\n@end${kind}`).diagrams[0];
  const points = layoutTree(block);
  const named = (name: string) => block.elements.find(node => node.name === name)!;
  const rect = (node: DiagramElement) => ({ ...points[node.id], width: Number(node.meta?.width), height: Number(node.meta?.height) });
  const cx = (node: DiagramElement) => rect(node).x + rect(node).width / 2;
  const cy = (node: DiagramElement) => rect(node).y + rect(node).height / 2;
  const noOverlap = () => {
    expect(Object.keys(points)).toHaveLength(block.elements.length);
    for (const [index, a] of block.elements.entries()) for (const b of block.elements.slice(index + 1)) {
      const ra = rect(a), rb = rect(b);
      expect(ra.x < rb.x + rb.width && ra.x + ra.width > rb.x && ra.y < rb.y + rb.height && ra.y + ra.height > rb.y, `${a.name} overlaps ${b.name}`).toBe(false);
    }
  };
  return { block, points, named, rect, cx, cy, noOverlap };
}

describe('PlantUML hierarchy layouts', () => {
  it('places the corpus mind-map branches on their declared side of the centered root', () => {
    const { block, named, rect, cx, cy, noOverlap } = arrange('mindmap', '+ C\n++ D\n++ E\n-- A\n-- B');
    const root = named('C');
    for (const name of ['A', 'B']) expect(rect(named(name)).x + rect(named(name)).width).toBeLessThan(rect(root).x);
    for (const name of ['D', 'E']) expect(rect(named(name)).x).toBeGreaterThan(rect(root).x + rect(root).width);
    expect(cy(root)).toBe((cy(named('A')) + cy(named('B'))) / 2);
    expect(cy(named('A'))).toBe(cy(named('D')));
    expect(cx(root) - cx(named('A'))).toBe(cx(named('D')) - cx(root));
    expect(block.relations.find(edge => edge.target === named('A').id)?.meta).toMatchObject({ sourceHandle: 'left', targetHandle: 'right' });
    expect(rect(root).width).toBeLessThan(50);
    noOverlap();
  });

  it('inherits branch sides for star syntax and separates unequal nested envelopes', () => {
    const { named, rect, block, noOverlap } = arrange('mindmap', '* Root\n-- Left branch\n*** A long left leaf name\n*** Another left leaf\n++ Right branch\n*** Right leaf\n**** Deeper right leaf\n++ Second right branch');
    expect(named('A long left leaf name').meta?.treeSide).toBe('left');
    expect(rect(named('A long left leaf name')).x).toBeLessThan(rect(named('Left branch')).x);
    expect(rect(named('Deeper right leaf')).x).toBeGreaterThan(rect(named('Right leaf')).x);
    expect(block.graphical).toBe(true);
    noOverlap();
  });

  it('matches the corpus WBS with balanced branch roots and vertical terminal stacks', () => {
    const { block, named, rect, cx, noOverlap } = arrange('wbs', '* Top\n** A\n*** A1\n*** A2\n** B\n*** B1\n*** B2');
    expect(cx(named('Top'))).toBe((cx(named('A')) + cx(named('B'))) / 2);
    expect(rect(named('A')).y).toBe(rect(named('B')).y);
    for (const branch of ['A', 'B']) {
      const parent = named(branch), first = named(`${branch}1`), second = named(`${branch}2`);
      expect(rect(first).x).toBe(rect(second).x);
      expect(rect(first).x).toBeGreaterThan(cx(parent));
      expect(rect(second).y).toBeGreaterThan(rect(first).y + rect(first).height);
      expect(block.relations.find(edge => edge.target === second.id)?.meta).toMatchObject({ sourceHandle: 'bottom', targetHandle: 'left' });
    }
    noOverlap();
  });

  it('reserves full WBS subtree widths for unbalanced trees and long wrapped labels', () => {
    const { block, rect, noOverlap } = arrange('wbs', '* Delivery\n** Design\n*** Small\n*** A much longer terminal requirement\n** Build\n*** Services\n**** API\n**** Worker\n*** UI\n** Ship\n*** Release notes');
    expect(block.elements.every(node => Number.isFinite(rect(node).width) && rect(node).height >= 44)).toBe(true);
    noOverlap();
    const huge = arrange('wbs', `* ${'Wide label '.repeat(30)}\n** Child`);
    expect(huge.rect(huge.block.elements[0]).width).toBe(340);
    expect(huge.rect(huge.block.elements[0]).height).toBeGreaterThan(44);
    huge.noOverlap();
  });

  it('keeps multiple roots finite and vertically separated', () => {
    for (const kind of ['mindmap', 'wbs'] as const) {
      const { points, noOverlap } = arrange(kind, '* First\n** A\n* Second\n** B\n*** C');
      expect(Object.values(points).every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 80)).toBe(true);
      noOverlap();
    }
  });
});
