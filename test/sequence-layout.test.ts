import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { layoutDiagram } from '../src/core/layout';
import type { DiagramBlock, Point } from '../src/shared/protocol';

const diagram = (body: string) => parseDocument(`@startuml\n${body}\n@enduml`).diagrams[0];
const center = (block: DiagramBlock, points: Record<string, Point>, id: string) => points[id].x + Number(block.elements.find(element => element.id === id)!.meta?.width) / 2;

describe('compact source-driven sequence layout', () => {
  it('keeps a two-participant example compact and aligns the lifelines', () => {
    const block = diagram('Alpha -> Bravo\nBravo -> Alpha'), points = layoutDiagram(block);
    expect(points.Alpha.y).toBe(70); expect(points.Bravo.y).toBe(70);
    expect(points.Bravo.x - points.Alpha.x).toBeGreaterThan(60);
    expect(points.Bravo.x - points.Alpha.x).toBeLessThan(120);
    expect(block.meta?.sequenceHeight).toBe(204);
    expect(layoutDiagram(block)).toEqual(points);
  });

  it('fits eight participant shapes in adaptive columns instead of fixed 260px tracks', () => {
    const block = diagram('participant Participant as Foo\nactor Actor as Foo1\nboundary Boundary as Foo2\ncontrol Control as Foo3\nentity Entity as Foo4\ndatabase Database as Foo5\ncollections Collections as Foo6\nqueue Queue as Foo7\nFoo -> Foo1 : To actor\nFoo -> Foo2 : To boundary\nFoo -> Foo3 : To control\nFoo -> Foo4 : To entity\nFoo -> Foo5 : To database\nFoo -> Foo6 : To collections\nFoo -> Foo7 : To queue');
    const points = layoutDiagram(block), participants = block.elements;
    expect(Number(block.meta?.sequenceWidth)).toBeLessThan(950);
    expect(new Set(Object.values(points).map(point => point.y))).toEqual(new Set([70]));
    for (let index = 1; index < participants.length; index++) {
      const before = participants[index - 1], after = participants[index];
      expect(points[after.id].x).toBeGreaterThan(points[before.id].x + Number(before.meta?.width));
    }
  });

  it('reserves message-label space between the relevant lifelines in either direction', () => {
    const label = 'Confirm reservation and payment';
    const block = diagram(`A -> B : ${label}\nB -> A : accepted`), points = layoutDiagram(block);
    expect(center(block, points, 'B') - center(block, points, 'A')).toBeGreaterThanOrEqual(label.length * 6 + 46);
  });

  it('leaves room for self-message labels before the next lifeline', () => {
    const block = diagram('participant A\nparticipant B\nA -> A : repeat check\nA -> B : next'), points = layoutDiagram(block);
    expect(center(block, points, 'B') - center(block, points, 'A')).toBeGreaterThanOrEqual(85 + ('repeat check'.length * 6 + 22) / 2);
  });

  it('places side notes in clear gaps, centers spanning notes, and anchors destruction to the lifeline', () => {
    const block = diagram('participant A\nparticipant B\nparticipant C\nA -> B : request\nnote right of A : A side note\nnote over B,C : shared\nB -> C : forward\ndestroy C'), points = layoutDiagram(block);
    const side = block.elements.find(element => element.name === 'A side note')!, over = block.elements.find(element => element.name === 'shared')!, destroy = block.elements.find(element => element.kind === 'sequence-destroy')!;
    expect(points[side.id].x).toBeGreaterThan(center(block, points, 'A'));
    expect(points[side.id].x + Number(side.meta?.width)).toBeLessThan(center(block, points, 'B'));
    expect(points[over.id].x + Number(over.meta?.width) / 2).toBeCloseTo((center(block, points, 'B') + center(block, points, 'C')) / 2);
    expect(points[destroy.id].x + 10).toBeCloseTo(center(block, points, 'C'));
  });

  it('sizes fragment and divider spans to the diagram while preserving source row numbers', () => {
    const block = diagram('A -> B : begin\nalt ready\nB -> A : accepted\nelse wait\nnote left of A : hold\nA -> A : retry\nend\n== Finished ==\nA -> B : complete');
    const rows = block.relations.map(relation => relation.meta?.row), points = layoutDiagram(block);
    expect(block.relations.map(relation => relation.meta?.row)).toEqual(rows);
    const frame = block.elements.find(element => element.kind === 'sequence-fragment')!;
    expect(points[frame.id].x).toBe(60);
    expect(Number(frame.meta?.width)).toBe(Number(block.meta?.sequenceWidth));
    expect(points[frame.id].y).toBe(137 + Number(frame.meta?.row) * 52);
    expect(Number(frame.meta?.height)).toBe((Number(frame.meta?.endRow) - Number(frame.meta?.row) + 1) * 52);
    const note = block.elements.find(element => element.kind === 'sequence-note')!;
    expect(points[note.id].x).toBe(80);
    expect(layoutDiagram(block)).toEqual(points);
  });

  it('keeps activation bars above the footer when an activation lasts to the final row', () => {
    const block = diagram('participant A\nparticipant B\nactivate A\nA -> B : request\nB -> A : result');
    layoutDiagram(block);
    const participant = block.elements.find(element => element.id === 'A')!, activations = participant.meta?.activations as { start: number; end: number }[];
    const activationEnd = 78 + activations[0].end * 52;
    expect(Number(block.meta?.sequenceHeight) - 34).toBeGreaterThan(activationEnd);
  });
});
