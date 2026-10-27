import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { layoutDiagram } from '../src/core/layout';
import type { DiagramElement } from '../src/shared/protocol';

function arrange(body: string) {
  const block = parseDocument(`@startuml\n${body}\n@enduml\n`).diagrams[0];
  expect(block.graphical, block.warnings.join('\n')).toBe(true);
  const points = layoutDiagram(block);
  const rect = (node: DiagramElement) => ({ ...points[node.id], width: Number(node.meta?.width), height: Number(node.meta?.height) });
  const center = (node: DiagramElement) => points[node.id].x + Number(node.meta?.width) / 2;
  const named = (name: string) => block.elements.find(element => element.name === name)!;
  const noOverlap = () => {
    const leaves = block.elements.filter(element => !element.meta?.container);
    for (const [index, a] of leaves.entries()) for (const b of leaves.slice(index + 1)) {
      const ra = rect(a), rb = rect(b);
      expect(ra.x < rb.x + rb.width && ra.x + ra.width > rb.x && ra.y < rb.y + rb.height && ra.y + ra.height > rb.y, `${a.name || a.kind} overlaps ${b.name || b.kind}`).toBe(false);
    }
  };
  return { block, points, rect, center, named, noOverlap };
}

const starter = 'start\n:Receive order;\nif (Items available?) then (yes)\n:Ship order;\nelse (no)\n:Notify customer;\nendif\n:Record outcome;\nstop';

describe('compact structured activity layout', () => {
  it('centers the entire trunk and balances both branches within compact bounds', () => {
    const { block, points, named, center, rect, noOverlap } = arrange(starter);
    const decision = named('Items available?'), merge = block.elements.find(element => element.kind === 'merge')!;
    for (const node of [named('Start'), named('Receive order'), merge, named('Record outcome'), named('End')]) expect(center(node)).toBe(center(decision));
    const left = named('Ship order'), right = named('Notify customer');
    expect(center(decision) - center(left)).toBe(center(right) - center(decision));
    expect(points[left.id].y).toBe(points[right.id].y);
    expect(rect(decision).width).toBeGreaterThanOrEqual(140);
    expect(rect(decision).height).toBe(36);
    expect(rect(named('Start'))).toMatchObject({ width: 18, height: 18 });
    expect(rect(named('End'))).toMatchObject({ width: 22, height: 22 });
    expect(rect(merge)).toMatchObject({ width: 20, height: 20 });
    const boxes = block.elements.map(rect);
    expect(Math.max(...boxes.map(box => box.x + box.width)) - Math.min(...boxes.map(box => box.x))).toBeLessThan(400);
    expect(Math.max(...boxes.map(box => box.y + box.height)) - Math.min(...boxes.map(box => box.y))).toBeLessThan(440);
    expect(block.relations.find(edge => edge.source === decision.id && edge.target === left.id)?.meta).toMatchObject({ sourceHandle: 'left', targetHandle: 'top', activityRoute: { kind: 'branch' } });
    expect(block.relations.find(edge => edge.source === right.id && edge.target === merge.id)?.meta).toMatchObject({ sourceHandle: 'bottom', targetHandle: 'right', activityRoute: { kind: 'merge' } });
    noOverlap();
  });

  it('places nested and unequal branches in separate envelopes and joins below the deepest path', () => {
    const { block, points, named, center, noOverlap } = arrange('start\nif (Authenticated?) then (yes)\n:Load profile;\nif (Cached?) then (yes)\n:Read cache;\nelse (no)\n:Fetch source;\n:Validate response;\n:Cache result;\nendif\n:Build view;\nelse (no)\n:Reject request;\nendif\n:Reply;\nstop');
    const outer = named('Authenticated?'), inner = named('Cached?'), merges = block.elements.filter(element => element.kind === 'merge');
    expect(center(merges[0])).toBe(center(inner));
    expect(center(merges[1])).toBe(center(outer));
    expect(points[merges[0].id].y).toBeGreaterThan(points[named('Cache result').id].y + 36);
    expect(points[merges[1].id].y).toBeGreaterThan(points[named('Build view').id].y + 36);
    expect(center(named('Reply'))).toBe(center(outer));
    noOverlap();
  });

  it('keeps a continuing path centered after an early terminating branch', () => {
    const { block, points, center, named, noOverlap } = arrange('start\nif (Invalid?) then (yes)\n:Reject;\nstop\nelse (no)\n:Process;\nendif\n:Archive;\nstop');
    const merge = block.elements.find(element => element.kind === 'merge')!;
    expect(center(merge)).toBe(center(named('Invalid?')));
    expect(center(named('Archive'))).toBe(center(merge));
    expect(points[merge.id].y).toBeGreaterThan(points[named('Process').id].y + 36);
    expect(block.relations.filter(edge => block.elements.find(element => element.id === edge.source)?.kind === 'end')).toEqual([]);
    noOverlap();
  });

  it('routes while return and exit paths outside the compact centered loop body', () => {
    const { block, points, center, named, rect, noOverlap } = arrange('start\nwhile (More jobs?) is (yes)\n:Read job;\n:Run job;\nendwhile (no)\n:Report results;\nstop');
    const head = named('More jobs?');
    for (const name of ['Read job', 'Run job', 'Report results']) expect(center(named(name))).toBe(center(head));
    const backward = block.relations.find(edge => edge.target === head.id && edge.source === named('Run job').id)!;
    const exit = block.relations.find(edge => edge.source === head.id && edge.label === 'no')!;
    expect(backward.meta?.activityRoute).toMatchObject({ kind: 'loop', side: 'right' });
    expect(Number((backward.meta?.activityRoute as { laneX: number }).laneX)).toBeGreaterThan(rect(head).x + rect(head).width);
    expect(exit.meta?.activityRoute).toMatchObject({ kind: 'loop', side: 'left' });
    expect(points[exit.target].y).toBeGreaterThan(points[named('Run job').id].y + 36);
    noOverlap();
  });

  it('keeps repeat loops and legacy backward aliases finite and routes cycle closures', () => {
    for (const body of ['start\nrepeat\n:Read batch;\n:Apply batch;\nrepeat while (Again?) is (yes) not (no)\n:Done;\nstop', '(*) --> "Read" as read\nread --> "Process" as process\nprocess --> read\nprocess --> "Finish"\n--> (*)']) {
      const { block, points, noOverlap } = arrange(body);
      expect(Object.keys(points)).toHaveLength(block.elements.length);
      expect(block.relations.some(edge => (edge.meta?.activityRoute as { kind?: string })?.kind === 'loop')).toBe(true);
      expect(Object.values(points).every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
      noOverlap();
    }
  });

  it('uses distinct handles for legacy self-loops instead of hiding them on one point', () => {
    const { block, noOverlap } = arrange('(*) --> "Retry" as retry\nretry --> retry\nretry --> "Complete"\n--> (*)');
    const loop = block.relations.find(edge => edge.source === edge.target)!;
    expect(loop.meta).toMatchObject({ sourceHandle: 'bottom', targetHandle: 'right', activityRoute: { kind: 'loop' } });
    noOverlap();
  });

  it('takes a merged loop return from the bottom, away from converging branch arms', () => {
    const { block, named, noOverlap } = arrange('start\n:Read job queue;\nwhile (More jobs?) is (yes)\n:Claim next job;\nif (Valid input?) then (yes)\n:Process job;\nelse (no)\n:Record validation error;\nendif\nendwhile (no)\n:Publish summary;\nstop');
    const loop = block.relations.find(edge => edge.target === named('More jobs?').id && block.elements.find(node => node.id === edge.source)?.kind === 'merge')!;
    expect(loop.meta?.sourceHandle).toBe('bottom');
    expect(loop.meta?.activityRoute).toMatchObject({ kind: 'loop', sourceHandle: 'bottom' });
    const incoming = block.relations.filter(edge => edge.target === loop.source);
    expect(incoming.map(edge => edge.meta?.targetHandle).sort()).toEqual(['left', 'right']);
    noOverlap();
  });

  it('gives parallel bars ports directly over and under their branch centers', () => {
    const { block, points, center, named, noOverlap } = arrange('start\nfork\n:Load profile;\nfork again\n:Load settings;\n:Check settings;\nfork again\n:Load permissions;\nend fork\n:Show page;\nstop');
    const fork = block.elements.find(element => element.kind === 'fork')!, join = block.elements.find(element => element.kind === 'join')!;
    expect(center(fork)).toBe(center(join));
    expect(Number(fork.meta?.width)).toBeGreaterThan(260);
    expect(fork.meta?.height).toBe(6);
    expect(points[join.id].y).toBeGreaterThan(points[named('Check settings').id].y + 36);
    for (const bar of [fork, join]) {
      const ports = bar.meta?.activityPorts as { id: string; offset: number }[];
      expect(ports).toHaveLength(3);
      for (const edge of block.relations.filter(edge => bar === fork ? edge.source === bar.id : edge.target === bar.id)) {
        const id = String(bar === fork ? edge.meta?.sourceHandle : edge.meta?.targetHandle);
        const port = ports.find(port => port.id === id)!;
        expect(points[bar.id].x + port.offset).toBe(center(block.elements.find(node => node.id === (bar === fork ? edge.target : edge.source))!));
      }
    }
    noOverlap();
  });

  it('wraps nested partitions around flow and leaves space for headers and following nodes', () => {
    const { block, named, rect, noOverlap } = arrange('start\npartition "Intake" {\n:Read message;\npartition "Validation" {\nif (Valid?) then (yes)\n:Accept;\nelse (no)\n:Reject;\nendif\n}\n}\npartition "Delivery" {\n:Send outcome;\n}\nstop');
    for (const child of block.elements.filter(node => node.parentId)) {
      const parent = block.elements.find(node => node.id === child.parentId)!, outer = rect(parent), inner = rect(child);
      expect(inner.x).toBeGreaterThanOrEqual(outer.x + 16);
      expect(inner.y).toBeGreaterThanOrEqual(outer.y + 32);
      expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width - 16);
      expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height - 16);
    }
    expect(rect(named('Delivery')).y).toBeGreaterThanOrEqual(rect(named('Intake')).y + rect(named('Intake')).height + 20);
    noOverlap();
  });

  it('keeps parallel partition boundaries separate without losing branch alignment', () => {
    const { named, rect, center, noOverlap } = arrange('start\nfork\npartition "Read side" {\n:Read profile;\n}\nfork again\npartition "Write side" {\n:Write audit;\n}\nend fork\nstop');
    expect(rect(named('Read side')).x + rect(named('Read side')).width).toBeLessThan(rect(named('Write side')).x);
    expect(rect(named('Read profile')).y).toBe(rect(named('Write audit')).y);
    expect(center(named('Read profile'))).toBeLessThan(center(named('Write audit')));
    noOverlap();
  });

  it('respects swimlane membership while retaining parallel branches and compact rows', () => {
    const { block, points, rect, named, noOverlap } = arrange('|Client|\nstart\n:Submit;\n|Service|\nfork\n:Validate;\nfork again\n:Authorize;\nend fork\n|Client|\n:Display;\nstop');
    const lanes = block.elements.filter(node => node.kind === 'swimlane');
    expect(lanes).toHaveLength(2);
    expect(rect(lanes[0]).x + rect(lanes[0]).width).toBeLessThanOrEqual(rect(lanes[1]).x);
    for (const node of block.elements.filter(node => node.kind !== 'swimlane')) {
      const lane = lanes.find(lane => lane.name === node.meta?.lane)!;
      expect(rect(node).x).toBeGreaterThan(rect(lane).x);
      expect(rect(node).x + rect(node).width).toBeLessThan(rect(lane).x + rect(lane).width);
    }
    expect(points[named('Validate').id].y).toBe(points[named('Authorize').id].y);
    noOverlap();
  });

  it('measures multiline SDL labels and places notes without overlapping the flow', () => {
    const { block, rect, named, noOverlap } = arrange('start\n:Receive a long message\nwith explicit detail; <<input>>\nnote right: This message is received from an external queue\n:Check whether a very long action label wraps into multiple lines safely;\nstop');
    expect(block.kind).toBe('sdl');
    expect(rect(named('Receive a long message\nwith explicit detail')).height).toBeGreaterThan(36);
    expect(rect(named('Check whether a very long action label wraps into multiple lines safely')).height).toBeGreaterThan(36);
    noOverlap();
  });

  it('is deterministic on repeated layouts and preserves all original source and topology', () => {
    const { block, points } = arrange(starter);
    const source = block.source, topology = block.relations.map(edge => [edge.source, edge.target]);
    expect(layoutDiagram(block)).toEqual(points);
    expect(block.source).toBe(source);
    expect(block.relations.map(edge => [edge.source, edge.target])).toEqual(topology);
    expect(block.elements.every(node => node.meta?.activityLayout)).toBe(true);
  });
});
