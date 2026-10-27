import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { applyDiagramEdit } from '../src/core/edits';
import { layoutDiagram } from '../src/core/layout';
import { nativeTemplates } from '../src/core/templates';

const uml = (text: string) => `@startuml\n${text}\n@enduml\n`;
const parse = (text: string) => parseDocument(uml(text)).diagrams[0];
describe('native UML control and grouping semantics', () => {
  it('projects nested packages, places boundaries around children, and preserves source on rename', () => {
    const source = uml('package "Outer" as P {\n  package "Inner" as Q {\n    class "Item" as I {\n      +values: List<String>\n    }\n  }\n}\nclass Consumer\nConsumer --> I');
    const block = parseDocument(source).diagrams[0];
    expect(block.graphical).toBe(true);
    const points = layoutDiagram(block);
    const item = block.elements.find(item => item.id === 'I')!;
    expect(item.parentId).toBe('Q'); expect(points.I.x).toBeGreaterThan(points.Q.x); expect(points.Q.x).toBeGreaterThan(points.P.x);
    expect(applyDiagramEdit(source, block.id, { type: 'rename', elementId: 'I', name: 'Product' })).toBe(source.replace('"Item"', '"Product"'));
  });
  it('scopes composite-state initial/final nodes to their own regions', () => {
    const block = parse('state Running {\n state Ready\n [*] --> Ready\n Ready --> [*]\n --\n state Waiting\n [*] --> Waiting\n Waiting --> [*]\n}');
    expect(block.graphical, block.warnings.join('\n')).toBe(true);
    expect(block.elements.filter(element => element.kind === 'start')).toHaveLength(2);
    expect(new Set(block.elements.filter(element => element.kind === 'start').map(element => element.parentId)).size).toBe(2);
  });
  it('represents loop backward edges and fork joins without connecting terminated paths', () => {
    const block = parse('start\nwhile (More?) is (yes)\n fork\n :Read;\n fork again\n :Check;\n end fork\nendwhile (no)\n:Publish;\nstop');
    expect(block.graphical, block.warnings.join('\n')).toBe(true);
    const condition = block.elements.find(element => element.name === 'More?')!;
    expect(block.relations.filter(edge => edge.target === condition.id)).toHaveLength(2);
    expect(block.elements.filter(element => element.kind === 'fork')).toHaveLength(1);
    expect(block.elements.filter(element => element.kind === 'join')).toHaveLength(1);
    const positions = layoutDiagram(block); expect(Object.values(positions).every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });
  it('preserves multiline actions and SDL stereotypes during inline rename', () => {
    const source = uml('start\n:Receive\npacket; <<input>>\n:Send response; <<output>>\nstop');
    const block = parseDocument(source).diagrams[0]; expect(block.graphical).toBe(true);
    const action = block.elements.find(element => element.kind === 'sdl-input')!; expect(action).toBeDefined();
    const changed = applyDiagramEdit(source, block.id, { type: 'rename', elementId: action.id, name: 'Receive order' });
    expect(changed).toContain(':Receive order; <<input>>'); expect(changed).toContain(':Send response; <<output>>');
  });
  it('projects sequence fragments, dividers, activations, notes, and explicit message rows', () => {
    const block = parse('participant Client\nparticipant API\nautonumber 2\nClient -> API : request\nactivate API\nalt available\nAPI --> Client : result\nelse unavailable\nAPI --> Client : error\nend\ndeactivate API\n== Next ==\nnote over Client : Continue');
    expect(block.graphical, block.warnings.join('\n')).toBe(true);
    expect(block.elements.find(element => element.kind === 'sequence-fragment')?.name).toBe('available');
    expect(block.elements.find(element => element.id === 'API')?.meta?.activations).toBeTruthy();
    expect(block.relations.map(relation => relation.meta?.number)).toEqual([2, 3, 4]);
    expect(Number(block.relations[1].meta?.row)).toBeGreaterThan(Number(block.relations[0].meta?.row) + 1);
  });
  it('retains malformed-block diagnostics for every native adapter', () => {
    for (const template of nativeTemplates) {
      const incomplete = template.source.replace(/^@end\w+.*$/m, '');
      expect(() => parseDocument(incomplete), template.kind).not.toThrow();
      expect(parseDocument(incomplete).diagrams[0].graphical, template.kind).toBe(false);
    }
  });
});
