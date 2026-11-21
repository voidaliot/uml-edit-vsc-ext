import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { layoutGraph } from '../src/core/graph-layout';
import type { DiagramBlock, DiagramRelation, Point } from '../src/shared/protocol';

const diagram = (body: string) => parseDocument(`@startuml\n${body}\n@enduml`).diagrams[0];
interface Box { x: number; y: number; width: number; height: number }
const box = (block: DiagramBlock, points: Record<string, Point>, id: string): Box => {
  const element = block.elements.find(item => item.id === id)!;
  return { ...points[id], width: Number(element.meta?.width), height: Number(element.meta?.height) };
};
const center = (item: Box): Point => ({ x: item.x + item.width / 2, y: item.y + item.height / 2 });
/** Liang-Barsky: does the segment pass through the box? */
const crosses = (a: Point, b: Point, item: Box, margin = 0) => {
  let from = 0, to = 1;
  for (const [delta, low, high] of [[b.x - a.x, item.x - margin - a.x, item.x + item.width + margin - a.x], [b.y - a.y, item.y - margin - a.y, item.y + item.height + margin - a.y]]) {
    if (Math.abs(delta) < 1e-9) { if (low >= 0 || high <= 0) return false; continue; }
    from = Math.max(from, Math.min(low / delta, high / delta)); to = Math.min(to, Math.max(low / delta, high / delta));
    if (from >= to) return false;
  }
  return true;
};
/** The drawn line: both ends clipped to their boxes' centres, through the layout's bends. */
const path = (block: DiagramBlock, points: Record<string, Point>, relation: DiagramRelation) => [center(box(block, points, relation.source)), ...(relation.meta?.route as Point[] | undefined ?? []), center(box(block, points, relation.target))];
const blockedBy = (block: DiagramBlock, points: Record<string, Point>, relation: DiagramRelation) => {
  const line = path(block, points, relation);
  return block.elements.filter(element => !element.meta?.container && element.id !== relation.source && element.id !== relation.target && line.slice(1).some((point, index) => crosses(line[index], point, box(block, points, element.id), -2))).map(element => element.id);
};

describe('connector lanes around the ranks a link skips', () => {
  it('routes a link that spans several ranks beside the boxes between its ends', () => {
    const block = diagram('class A\nclass B\nclass C\nclass D\nA --> B\nB --> C\nC --> D\nA --> D\nA --> C');
    const points = layoutGraph(block);
    for (const relation of block.relations) expect(blockedBy(block, points, relation), `${relation.source}->${relation.target}`).toEqual([]);
    const long = block.relations.find(relation => relation.source === 'A' && relation.target === 'D')!;
    // One entry and one exit per skipped rank, in order from the source to the target.
    const bends = long.meta!.route as Point[];
    expect(bends).toHaveLength(4);
    expect(bends.map(point => point.y)).toEqual([...bends.map(point => point.y)].sort((a, b) => a - b));
    expect(long.meta!.routeAnchor).toEqual({ source: points.A, target: points.D });
    // Neighbouring ranks need no bends at all.
    expect(block.relations.find(relation => relation.source === 'A' && relation.target === 'B')!.meta?.route).toBeUndefined();
  });

  it('orders the bends from the source even when the arrow is written parent-first', () => {
    const block = diagram('class Base\nclass Mid\nclass Leaf\nBase <|-- Mid\nMid <|-- Leaf\nBase <|-- Leaf');
    const points = layoutGraph(block);
    const long = block.relations.find(relation => relation.source === 'Base' && relation.target === 'Leaf')!;
    const bends = long.meta!.route as Point[];
    expect(points.Base.y).toBeLessThan(points.Leaf.y);
    expect(bends[0].y).toBeLessThan(bends.at(-1)!.y);
    expect(blockedBy(block, points, long)).toEqual([]);
  });

  it('clears and recomputes routes on every layout', () => {
    const block = diagram('class A\nclass B\nclass C\nA --> B\nB --> C\nA --> C');
    layoutGraph(block);
    const first = structuredClone(block.relations.map(relation => relation.meta?.route));
    layoutGraph(block);
    expect(block.relations.map(relation => relation.meta?.route)).toEqual(first);
    expect(first.filter(Boolean)).toHaveLength(1);
  });

  it('breaks a cycle at its feedback edge, starting from the natural root', () => {
    const block = diagram('state Connected {\n  [*] --> Ready\n}\n[*] --> Idle\nIdle --> Connecting : connect\nConnecting --> Connected : ok\nConnected --> Idle : disconnect\nConnecting --> Idle : failure');
    const points = layoutGraph(block);
    expect(points.__start.y).toBeLessThan(points.Idle.y);
    expect(points.Idle.y).toBeLessThan(points.Connecting.y);
    expect(points.Connecting.y).toBeLessThan(points.Connected.y);
    const back = block.relations.find(relation => relation.label === 'disconnect')!;
    expect(blockedBy(block, points, back)).toEqual([]);
  });

  it('sinks a lone source next to what it points at instead of stranding it on the first rank', () => {
    const block = diagram('class A\nclass B\nclass C\nclass Helper\nA --> B\nB --> C\nHelper --> C');
    const points = layoutGraph(block);
    expect(points.Helper.y).toBe(points.B.y);
  });
});

describe('containers and what lies outside them', () => {
  const usecase = 'left to right direction\nactor Customer\nactor Admin\nactor PSP\nrectangle Shop {\n  usecase Browse\n  usecase Order\n  usecase Pay\n  usecase Manage\n  usecase Refund\n}\nCustomer --> Browse\nCustomer --> Order\nCustomer --> Pay\nOrder ..> Pay : include\nPay --> PSP\nAdmin --> Manage\nAdmin --> Refund\nRefund --> PSP';

  it('lets outside relationships decide which children face their side', () => {
    const block = diagram(usecase), points = layoutGraph(block);
    // Everything an actor reaches directly forms the first column, however the source lists it.
    for (const id of ['Order', 'Manage', 'Refund']) expect(points[id].x, id).toBe(points.Browse.x);
    expect(points.Pay.x).toBeGreaterThan(points.Order.x);
    expect(points.Customer.x).toBeLessThan(points.Shop.x);
    expect(points.PSP.x).toBeGreaterThan(points.Shop.x + Number(block.elements.find(item => item.id === 'Shop')!.meta!.width));
    for (const relation of block.relations) expect(blockedBy(block, points, relation), `${relation.source}->${relation.target}`).toEqual([]);
  });

  it('keeps children inside their container and independent groups apart', () => {
    const block = diagram(usecase + '\nactor Auditor\nusecase Report\nAuditor --> Report'), points = layoutGraph(block);
    const shop = box(block, points, 'Shop');
    for (const id of ['Browse', 'Order', 'Pay', 'Manage', 'Refund']) {
      const child = box(block, points, id);
      expect(child.x).toBeGreaterThan(shop.x); expect(child.y).toBeGreaterThan(shop.y);
      expect(child.x + child.width).toBeLessThan(shop.x + shop.width); expect(child.y + child.height).toBeLessThan(shop.y + shop.height);
    }
    for (const id of ['Auditor', 'Report']) { const item = box(block, points, id); expect(item.x >= shop.x + shop.width || item.y >= shop.y + shop.height || item.x + item.width <= shop.x || item.y + item.height <= shop.y, id).toBe(true); }
  });

  it('carries a relationship that enters a container through the ranks inside it', () => {
    const block = diagram('package Domain {\n  class Entity\n  class Customer\n  class Order\n  Entity <|-- Customer\n  Customer --> Order\n}\nnote "Aggregate root" as N1\nN1 .. Order');
    const points = layoutGraph(block);
    const link = block.relations.find(relation => relation.source === 'N1')!;
    expect((link.meta?.route as Point[]).length).toBeGreaterThan(0);
    expect(blockedBy(block, points, link)).toEqual([]);
  });

  it('wraps many independent groups instead of laying them out in one endless row', () => {
    const groups = Array.from({ length: 12 }, (_, index) => `class A${index}\nclass B${index}\nA${index} --> B${index}`).join('\n');
    const block = diagram(groups), points = layoutGraph(block);
    const xs = Object.values(points).map(point => point.x), ys = Object.values(points).map(point => point.y);
    const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
    expect(width / height).toBeLessThan(4);
    expect(new Set(ys).size).toBeGreaterThan(2);
  });
});

describe('links that return into a container', () => {
  it('enter from the side their far end is on, whichever way the arrow points', () => {
    const block = diagram('package Backend {\n  component Gateway\n  component Orders\n  component Billing\n  Gateway --> Orders\n  Gateway --> Billing\n}\nqueue Bus\nOrders --> Bus : publishes\nBus --> Billing');
    const points = layoutGraph(block);
    const backend = box(block, points, 'Backend');
    // The bus is ranked below the package it both reads from and feeds.
    expect(points.Bus.y).toBeGreaterThan(backend.y + backend.height);
    for (const relation of block.relations) {
      expect(blockedBy(block, points, relation), `${relation.source}->${relation.target}`).toEqual([]);
      // No bend may lie on the far side of the package from the bus.
      for (const bend of relation.meta?.route as Point[] | undefined ?? []) expect(bend.y, `${relation.source}->${relation.target}`).toBeGreaterThan(points.Gateway.y);
    }
  });
});
