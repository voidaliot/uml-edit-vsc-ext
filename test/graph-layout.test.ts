import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { layoutGraph } from '../src/core/graph-layout';
import type { DiagramBlock, Point } from '../src/shared/protocol';

const diagram = (body: string) => parseDocument(`@startuml\n${body}\n@enduml`).diagrams[0];
const center = (block: DiagramBlock, points: Record<string, Point>, id: string) => {
  const element = block.elements.find(item => item.id === id)!;
  return { x: points[id].x + Number(element.meta?.width) / 2, y: points[id].y + Number(element.meta?.height) / 2 };
};
const separated = (block: DiagramBlock, points: Record<string, Point>) => {
  const ordinary = block.elements.filter(item => !item.meta?.container);
  for (let a = 0; a < ordinary.length; a++) for (let b = a + 1; b < ordinary.length; b++) {
    const first = ordinary[a], second = ordinary[b], p = points[first.id], q = points[second.id];
    expect(p.x + Number(first.meta?.width) <= q.x || q.x + Number(second.meta?.width) <= p.x || p.y + Number(first.meta?.height) <= q.y || q.y + Number(second.meta?.height) <= p.y, `${first.id}/${second.id}`).toBe(true);
  }
};

describe('PlantUML-oriented graph layout', () => {
  it('places generalizations above their descendants for either textual arrow order', () => {
    const block = diagram('class Parent\nclass Left\nclass Right\nParent <|-- Left\nRight --|> Parent');
    const points = layoutGraph(block);
    expect(points.Parent.y).toBeLessThan(points.Left.y);
    expect(points.Parent.y).toBeLessThan(points.Right.y);
    expect(points.Left.y).toBe(points.Right.y);
    expect(center(block, points, 'Parent').x).toBeCloseTo((center(block, points, 'Left').x + center(block, points, 'Right').x) / 2);
    separated(block, points);
  });

  it('matches the state gallery with horizontal short links and vertical initial/final links', () => {
    const block = diagram('[*] --> State1\nState1 -> State2\nState2 -> State3\nState3 --> [*]\nState1 : Description 1\nState2 : Description 2\nState3 : Description 3');
    const points = layoutGraph(block);
    expect(points.State1.y).toBe(points.State2.y);
    expect(points.State2.y).toBe(points.State3.y);
    expect(points.State1.x).toBeLessThan(points.State2.x);
    expect(points.State2.x).toBeLessThan(points.State3.x);
    expect(points.__start.y).toBeLessThan(points.State1.y);
    expect(points.__end.y).toBeGreaterThan(points.State3.y);
    expect(center(block, points, '__start').x).toBeCloseTo(center(block, points, 'State1').x);
    expect(center(block, points, '__end').x).toBeCloseTo(center(block, points, 'State3').x);
    separated(block, points);
  });

  it.each(['component', 'node', 'usecase'])('defaults %s graphs to top-to-bottom and obeys the last direction directive', kind => {
    const vertical = diagram(`${kind} A\n${kind} B\nA --> B`), horizontal = diagram(`left to right direction\n${kind} A\n${kind} B\nA --> B`);
    expect(layoutGraph(vertical).B.y).toBeGreaterThan(layoutGraph(vertical).A.y);
    expect(layoutGraph(horizontal).B.x).toBeGreaterThan(layoutGraph(horizontal).A.x);
    const restored = diagram(`left to right direction\ntop to bottom direction\n${kind} A\n${kind} B\nA --> B`);
    expect(layoutGraph(restored).B.y).toBeGreaterThan(layoutGraph(restored).A.y);
  });

  it.each([['left', 'x', -1], ['right', 'x', 1], ['up', 'y', -1], ['down', 'y', 1]] as const)('honors the explicit %s direction', (direction, axis, sign) => {
    const block = diagram(`class A\nclass B\nA -${direction}-> B`), points = layoutGraph(block);
    expect((center(block, points, 'B')[axis] - center(block, points, 'A')[axis]) * sign).toBeGreaterThan(0);
  });

  it('does not treat member, note, or uncalled procedure text as layout directives', () => {
    const block = diagram('!procedure $unused()\nleft to right direction\n!endprocedure\nclass A {\nleft to right direction\n}\nclass B\nnote right of A\nleft to right direction\nend note\nA --> B');
    const points = layoutGraph(block);
    expect(points.B.y).toBeGreaterThan(points.A.y);
    expect(center(block, points, 'A').x).toBeCloseTo(center(block, points, 'B').x);
  });

  it('packs the deployment symbol catalogue into a compact gallery', () => {
    const kinds = ['action', 'actor', 'agent', 'artifact', 'boundary', 'card', 'circle', 'cloud', 'collections', 'component', 'control', 'database', 'entity', 'file', 'folder', 'frame', 'hexagon', 'interface', 'label', 'node', 'package', 'person', 'queue', 'rectangle', 'stack', 'storage', 'usecase'];
    const block = diagram(kinds.map(kind => `${kind} ${kind}`).join('\n')), points = layoutGraph(block);
    expect(new Set(Object.values(points).map(point => point.x)).size).toBeLessThanOrEqual(6);
    expect(new Set(Object.values(points).map(point => point.y)).size).toBe(5);
    separated(block, points);
  });

  it('ranks relationships within and between containers and sizes them around their contents', () => {
    const block = diagram('package First {\nclass A\nclass B\nA --> B\n}\npackage Second {\nclass C\n}\nB --> C');
    const points = layoutGraph(block);
    expect(points.B.y).toBeGreaterThan(points.A.y);
    expect(points.Second.y).toBeGreaterThan(points.First.y);
    for (const element of block.elements.filter(item => item.parentId)) {
      const parent = block.elements.find(item => item.id === element.parentId)!;
      expect(points[element.id].x).toBeGreaterThan(points[parent.id].x);
      expect(points[element.id].y).toBeGreaterThan(points[parent.id].y);
      expect(points[element.id].x + Number(element.meta?.width)).toBeLessThan(points[parent.id].x + Number(parent.meta?.width));
      expect(points[element.id].y + Number(element.meta?.height)).toBeLessThan(points[parent.id].y + Number(parent.meta?.height));
    }
    separated(block, points);
    expect(layoutGraph(block)).toEqual(points);
  });

  it('keeps cyclic graphs stable and separates large wrapped bodies', () => {
    const block = diagram(`state A\nstate B\nstate C\nstate D\nA --> B\nB --> C\nC --> A\nC --> D\nA : ${'long description '.repeat(40)}`);
    const points = layoutGraph(block);
    separated(block, points);
    expect(points.B.y).toBeGreaterThan(points.A.y + Number(block.elements.find(item => item.id === 'A')!.meta?.height));
    expect(layoutGraph(block)).toEqual(points);
  });

  it('projects C4 directional relations and hidden Lay ordering constraints', () => {
    const block = diagram('!include <C4/C4_Container>\nPerson(user, "User")\nSystem(api, "API")\nSystem(db, "Database")\nRel_R(user, api, "uses")\nLay_D(api, db)');
    const points = layoutGraph(block);
    expect(points.api.x).toBeGreaterThan(points.user.x);
    expect(points.db.y).toBeGreaterThan(points.api.y);
    separated(block, points);
  });

  it('keeps mixed-direction chains rigid and balances fan-in branches around their attachments', () => {
    const block = diagram(`stack Entry
card "Processing stage" as First
queue "Processing stage" as Middle
card "Processing stage" as Last
stack Exit
Entry -r-> First
First -r-> Middle
Middle -r-> Last
Last -r-> Exit
usecase One
usecase Two
cloud Hub
usecase Three
usecase Four
One -d-> First
Two -d-> First
Hub -d-> First
Hub -d-> Middle
Hub -d-> Last
Three -d-> Last
Four -d-> Last
One -[hidden]r- Two
Two -[hidden]r- Hub
Hub -[hidden]r- Three
Three -[hidden]r- Four
actor PersonOne
actor PersonTwo
actor PersonThree
actor PersonFour
PersonOne -d-> One
PersonTwo -d-> Two
PersonThree -d-> Three
PersonFour -d-> Four
interface Input
interface Output
Input -u-> Entry
Output -u-> Exit
database Monitor
Monitor -u-> First
Monitor -u-> Middle
Monitor -u-> Last
control CheckA
control CheckB
control CheckC
control CheckD
CheckA -u-> First
CheckB -u-> First
CheckC -u-> Last
CheckD -u-> Last`);
    for (const element of block.elements) if (['control', 'interface'].includes(element.kind)) element.meta = { ...element.meta, symbolNotation: true };
    const points = layoutGraph(block), at = (id: string) => center(block, points, id);
    const pipeline = ['Entry', 'First', 'Middle', 'Last', 'Exit'].map(at);
    expect(new Set(pipeline.map(point => point.y)).size).toBe(1);
    const pipelineIds = ['Entry', 'First', 'Middle', 'Last', 'Exit'];
    const clearances = pipelineIds.slice(1).map((id, index) => points[id].x - points[pipelineIds[index]].x - Number(block.elements.find(element => element.id === pipelineIds[index])!.meta?.width));
    expect(Math.max(...clearances) - Math.min(...clearances)).toBeLessThan(1);
    const top = ['One', 'Two', 'Hub', 'Three', 'Four'].map(at);
    expect(top.every((point, index) => !index || point.x > top[index - 1].x)).toBe(true);
    for (const [actor, target] of [['PersonOne', 'One'], ['PersonTwo', 'Two'], ['PersonThree', 'Three'], ['PersonFour', 'Four']]) {
      expect(at(actor).x).toBeCloseTo(at(target).x);
      expect(at(actor).y).toBeLessThan(at(target).y);
    }
    expect(at('Hub').x).toBeCloseTo(at('Middle').x);
    expect(at('Monitor').x).toBeCloseTo(at('Middle').x);
    expect((at('CheckA').x + at('CheckB').x) / 2).toBeCloseTo(at('First').x);
    expect((at('CheckC').x + at('CheckD').x) / 2).toBeCloseTo(at('Last').x);
    expect(at('Input').x).toBeCloseTo(at('Entry').x);
    expect(at('Output').x).toBeCloseTo(at('Exit').x);
    separated(block, points);
    expect(layoutGraph(block)).toEqual(points);
  });

  it('reserves larger formatted labels and standalone-symbol labels without class compartments', () => {
    const plain = diagram('class Plain\nclass "<size:30>Heading</size>\\ntext" as Formatted\ncontrol "<size:20>Check</size>\\n\\nexample\\nexample" as Symbol');
    plain.elements.find(element => element.id === 'Symbol')!.meta = { symbolNotation: true };
    layoutGraph(plain);
    const formatted = plain.elements.find(element => element.id === 'Formatted')!, symbol = plain.elements.find(element => element.id === 'Symbol')!;
    expect(Number(formatted.meta?.height)).toBeGreaterThan(Number(plain.elements[0].meta?.height));
    expect(Number(symbol.meta?.width)).toBeLessThan(151);
    expect(Number(symbol.meta?.height)).toBeGreaterThan(120);
  });

  it('fits rich shape labels naturally, keeps use cases wide, and reserves named horizontal connector space', () => {
    const block = diagram('stack "<size:20>Example</size>\\nexample\\nexample" as Start\ncard "<size:22>Example</size>\\nexample, example, example" as Work\nqueue "<size:22>Example</size>\\nexample, example, example" as Finish\nStart -r-> Work : "Example"\nWork -r-> Finish\nusecase "<size:20>Example</size>\\n\\nexample\\nexample\\nexample\\n\\n" as Case\nclass Class');
    const points = layoutGraph(block), element = (id: string) => block.elements.find(item => item.id === id)!;
    expect(Number(element('Start').meta?.width)).toBeLessThan(130);
    expect(Number(element('Work').meta?.width)).toBeGreaterThan(192);
    expect(Number(element('Finish').meta?.width)).toBeGreaterThan(192);
    expect(Number(element('Case').meta?.width)).toBeGreaterThanOrEqual(Number(element('Case').meta?.height) * 1.25);
    expect(Number(element('Class').meta?.width)).toBe(192);
    expect(points.Work.x - points.Start.x - Number(element('Start').meta?.width)).toBeGreaterThanOrEqual(90);
    expect(points.Finish.x - points.Work.x - Number(element('Work').meta?.width)).toBeCloseTo(70);
    separated(block, points);
  });
});
