import { describe, expect, it } from 'vitest';
import { graphPortPosition, prepareGraphPorts, relationHandles } from '../src/webview/connections';
import { orthogonalPath, routeActivityEdge } from '../src/webview/routing';
import { parseDocument } from '../src/core/parser';
import { layoutDiagram } from '../src/core/layout';

describe('native connector geometry', () => {
  it('separates graph fan-in ports in endpoint order and updates them after a manual move', () => {
    const block = parseDocument('@startuml\nclass Left\nclass Center\nclass Right\nclass Hub\nLeft -d-> Hub\nCenter -d-> Hub\nRight -d-> Hub\nLeft -[hidden]r- Right\n@enduml').diagrams[0];
    layoutDiagram(block);
    const points = { Left: { x: 0, y: 0 }, Center: { x: 300, y: 0 }, Right: { x: 600, y: 0 }, Hub: { x: 300, y: 400 } };
    prepareGraphPorts(block, points);
    const hub = block.elements.find(element => element.id === 'Hub')!;
    const endpoints = () => block.relations.slice(0, 3).map(relation => {
      const handles = relationHandles(relation, block, points);
      const port = (hub.meta!.graphPorts as import('../src/webview/connections').GraphPort[]).find(port => port.id === handles.targetHandle)!;
      return graphPortPosition(hub, port).x;
    });
    const before = endpoints();
    expect(before[0]).toBeLessThan(before[1]); expect(before[1]).toBeLessThan(before[2]);
    expect(block.relations[3].meta?.graphSourceHandle).toBeUndefined();
    points.Left.x = 900;
    prepareGraphPorts(block, points);
    const after = endpoints();
    expect(after[1]).toBeLessThan(after[2]); expect(after[2]).toBeLessThan(after[0]);
    expect(block.source).not.toContain('graph-source');
  });
  it('honors a vertical arrow hint even for a wide diagonal fan', () => {
    const block = parseDocument('@startuml\nclass A\nclass B\nA -d-> B\n@enduml').diagrams[0];
    expect(relationHandles(block.relations[0], block, { A: { x: 0, y: 0 }, B: { x: 700, y: 200 } })).toEqual({ sourceHandle: 'bottom', targetHandle: 'top' });
  });
  it('attaches ellipse fan ports to the ellipse outline', () => {
    const element = { id: 'case', name: 'Case', kind: 'usecase', members: [], startLine: 0, endLine: 0, meta: { width: 200, height: 120 } };
    const point = graphPortPosition(element, { id: 'test', side: 'top', fraction: .25 });
    expect(Math.pow((point.x - 100) / 100, 2) + Math.pow((point.y - 60) / 60, 2)).toBeCloseTo(1);
    expect(point.y).toBeGreaterThan(0);
  });
  it('switches mind-map ports when a branch is moved across the root', () => {
    const block = parseDocument('@startmindmap\n+ Root\n++ Child\n@endmindmap').diagrams[0];
    const points = layoutDiagram(block), relation = block.relations[0];
    expect(relationHandles(relation, block, points)).toEqual({ sourceHandle: 'right', targetHandle: 'left' });
    points[relation.target] = { x: points[relation.source].x - 200, y: points[relation.source].y };
    expect(relationHandles(relation, block, points)).toEqual({ sourceHandle: 'left', targetHandle: 'right' });
  });
  it('attaches differently sized shapes by their centers, including short vertical gaps', () => {
    const block = parseDocument('@startuml\n[*] --> Ready\nReady --> [*]\n@enduml').diagrams[0];
    const edge = block.relations[0], start = block.elements.find(element => element.id === edge.source)!;
    expect(start.kind).toBe('start');
    expect(relationHandles(edge, block, { [edge.source]: { x: 84, y: 0 }, Ready: { x: 0, y: 42 } })).toEqual({ sourceHandle: 'bottom', targetHandle: 'top' });
  });
  it('keeps a vertical activity trunk straight with no added shoulders', () => {
    const route = routeActivityEdge({ sourceX: 150, sourceY: 40, targetX: 150, targetY: 64, sourcePosition: 'bottom', targetPosition: 'top' }, { kind: 'flow' });
    expect(route.path).toBe('M 150 40 L 150 64');
  });
  it('routes balanced decision arms above the actions and labels above the connectors', () => {
    const left = routeActivityEdge({ sourceX: 90, sourceY: 100, targetX: 50, targetY: 128, sourcePosition: 'left', targetPosition: 'top' }, { kind: 'branch' });
    const right = routeActivityEdge({ sourceX: 210, sourceY: 100, targetX: 250, targetY: 128, sourcePosition: 'right', targetPosition: 'top' }, { kind: 'branch' });
    expect(left.points).toEqual([{ x: 90, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 128 }]);
    expect(right.points.map(point => ({ x: 300 - point.x, y: point.y }))).toEqual(left.points);
    expect(left.labelY).toBeLessThan(100); expect(left.labelY).toBe(right.labelY);
  });
  it('brings branch tails directly into the sides of the merge', () => {
    const route = routeActivityEdge({ sourceX: 50, sourceY: 164, targetX: 140, targetY: 198, sourcePosition: 'bottom', targetPosition: 'left' }, { kind: 'merge' });
    expect(route.points).toEqual([{ x: 50, y: 164 }, { x: 50, y: 198 }, { x: 140, y: 198 }]);
    expect(route.path).not.toContain('NaN');
  });
  it('keeps backward paths on the outer track after an endpoint is moved beyond it', () => {
    const route = routeActivityEdge({ sourceX: -30, sourceY: 200, targetX: 90, targetY: 60, sourcePosition: 'left', targetPosition: 'left' }, { kind: 'loop', side: 'left', laneX: 0, clearance: 28 });
    expect(route.points[1].x).toBeLessThan(-30);
    expect(route.points[1].x).toBe(route.points[2].x);
    expect(route.path).not.toContain('NaN');
  });
  it('does not produce invalid curves when consecutive points coincide', () => {
    expect(orthogonalPath([{ x: 20, y: 30 }, { x: 20, y: 30 }, { x: 20, y: 50 }])).toBe('M 20 30 L 20 50');
  });
  it('leaves a merge downward before the return track without reaching the following node', () => {
    const route = routeActivityEdge({ sourceX: 150, sourceY: 210, targetX: 210, targetY: 60, sourcePosition: 'bottom', targetPosition: 'right' }, { kind: 'loop', side: 'right', laneX: 280, clearance: 28 });
    expect(route.points[1]).toEqual({ x: 150, y: 222 });
    expect(route.points[2]).toEqual({ x: 280, y: 222 });
  });
});
