import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { applyDiagramEdit } from '../src/core/edits';
import { copyFragment } from '../src/core/clipboard';
import { bendKey, parseLayoutFile, serializeLayoutFile, shiftBends, staleBendKeys } from '../src/core/layout-file';
import { validLayout } from '../src/host/messages';

const uml = (body: string) => `@startuml\n${body}\n@enduml\n`;
const block = (source: string) => parseDocument(source).diagrams[0];

describe('edits never leave source the canvas cannot read', () => {
  it('refuses a stereotype that would open a comment, instead of commenting out the file', () => {
    const source = uml('class A\nclass B\nA --> B') + '\n' + uml('class Z');
    for (const stereotype of ["see /'draft", "a 'b", "it's"]) expect(() => applyDiagramEdit(source, 'diagram-1', { type: 'properties', elementId: 'A', stereotype, color: '' }), stereotype).toThrow(/without quotes, apostrophes/);
    expect(parseDocument(applyDiagramEdit(source, 'diagram-1', { type: 'properties', elementId: 'A', stereotype: 'entity', color: 'red' })).diagrams).toHaveLength(2);
  });

  it('keeps a declaration\'s other text where it was, or leaves the line to the source editor', () => {
    // A generic type stays directly after the name.
    expect(applyDiagramEdit(uml('class Box<T> <<old>> {\n}'), 'diagram-1', { type: 'properties', elementId: 'Box', stereotype: 'new', color: '' })).toBe(uml('class Box<T> <<new>> {\n}'));
    for (const line of ['state S1 <<x>> : d', 'class A <<x>> hello']) {
      const source = uml(line), id = block(source).elements[0].id;
      expect(() => applyDiagramEdit(source, 'diagram-1', { type: 'properties', elementId: id, stereotype: 'y', color: 'red' }), line).toThrow(/more after its name/);
    }
  });

  it('treats unchanged properties as no edit', () => {
    const source = uml('class A   <<x>>    #red   {\n}');
    expect(applyDiagramEdit(source, 'diagram-1', { type: 'properties', elementId: 'A', stereotype: 'x', color: '#red' })).toBe(source);
  });

  it('refuses a move that would swallow the container\'s closing brace in a comment', () => {
    const source = uml("package P {\n}\nclass A /' open\n still '/\nclass B");
    expect(() => applyDiagramEdit(source, 'diagram-1', { type: 'moveToContainer', elementId: 'A', parentId: 'P' })).toThrow(/would leave syntax the canvas cannot edit/);
  });
});

describe('re-attaching a relationship', () => {
  it('does not pull an element that is only named in relationships out of its container', () => {
    const state = uml('[*] --> Idle\nIdle --> Connected\nstate Connected {\n  [*] --> Ready\n  Ready --> Busy\n}');
    const transition = block(state).relations.find(relation => relation.source === 'Idle' && relation.target === 'Connected')!;
    expect(() => applyDiagramEdit(state, 'diagram-1', { type: 'reconnectRelation', relationId: transition.id, end: 'target', elementId: 'Ready' })).toThrow(/would move "Ready" to another container/);
    const classes = uml('class A\nclass C\nA --> C\npackage P {\n  B --> C\n}');
    const link = block(classes).relations.find(relation => relation.source === 'A')!;
    expect(() => applyDiagramEdit(classes, 'diagram-1', { type: 'reconnectRelation', relationId: link.id, end: 'target', elementId: 'B' })).toThrow(/another container/);
    // Declared inside the container, the same element can be the new end.
    const declared = uml('class A\nclass C\nA --> C\npackage P {\n  class B\n}');
    expect(applyDiagramEdit(declared, 'diagram-1', { type: 'reconnectRelation', relationId: block(declared).relations[0].id, end: 'target', elementId: 'B' })).toContain('A --> B');
  });

  it('does not write a note\'s line number into the source as if it were a name', () => {
    const source = uml('class A\nclass B\nnote right of A : hi\nA --> B');
    const note = block(source).elements.find(element => element.kind === 'note')!;
    expect(() => applyDiagramEdit(source, 'diagram-1', { type: 'reconnectRelation', relationId: block(source).relations[0].id, end: 'target', elementId: note.id })).toThrow(/Give this note an alias/);
    const named = uml('class A\nclass B\nnote "hi" as N1\nA --> B');
    expect(applyDiagramEdit(named, 'diagram-1', { type: 'reconnectRelation', relationId: block(named).relations[0].id, end: 'target', elementId: 'N1' })).toContain('A --> N1');
  });
});

describe('pasting', () => {
  it('pastes elements that alone would read as another family of the same syntax', () => {
    const source = uml('[Web app] as web\ndatabase "Orders DB" as odb\ncloud Net\nweb --> odb');
    const diagram = block(source);
    expect(diagram.kind).toBe('deployment');
    const fragment = copyFragment(source, diagram, ['web']);
    const pasted = applyDiagramEdit(source, 'diagram-1', { type: 'paste', kind: fragment.kind, source: fragment.source });
    expect(pasted).toContain('[Web app] as web2');
    expect(block(pasted).kind).toBe('deployment');
  });

  it('refuses text that could end the diagram early or mix line endings', () => {
    const source = uml('class A');
    for (const fragment of ["class X\n /' '/ @enduml\nclass Q", 'class X\r\nclass Y', '@startuml\nclass X']) expect(() => applyDiagramEdit(source, 'diagram-1', { type: 'paste', kind: 'class', source: fragment }), JSON.stringify(fragment)).toThrow(/cannot be pasted into a diagram/);
  });
});

describe('bends a host accepts can always be read back', () => {
  it('accepts only the one spelling of a relationship identity', () => {
    const points = [{ x: 1, y: 2 }];
    expect(validLayout({ positions: {}, bends: { [bendKey('a', 'b', 0)]: points } })).toBe(true);
    for (const key of ['[ "a","b",0]', '["a","b",-0]', '["a","b",1e0]', '["a", "b", 0]']) expect(validLayout({ positions: {}, bends: { [key]: points } }), key).toBe(false);
    const text = serializeLayoutFile({ 'diagram-1': { positions: {}, bends: { [bendKey('a', 'b', 0)]: points, [bendKey('a', 'b', 1)]: points } } })!;
    expect(parseLayoutFile(text)['diagram-1'].bends).toEqual({ [bendKey('a', 'b', 0)]: points, [bendKey('a', 'b', 1)]: points });
  });

  it('bounds the bend points of one diagram', () => {
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [bendKey('a', 'b', index), Array.from({ length: 200 }, (_, at) => ({ x: at, y: index }))]));
    expect(validLayout({ positions: {}, bends: many })).toBe(false);
    expect(validLayout({ positions: {}, bends: Object.fromEntries(Object.entries(many).slice(0, 1000)) })).toBe(true);
  });
});

describe('bends stay with the relationship they were drawn for', () => {
  const state = (source: string) => ({ source, relations: block(source).relations });
  const before = uml('class A\nclass B\nclass C\nA --> B : one\nA --> B : two\nB --> C');
  const keys = [bendKey('A', 'B', 0), bendKey('A', 'B', 1), bendKey('B', 'C', 0)];

  it('drops the bends of a pair whose relationships changed, and only those', () => {
    // Deleting "one" would hand its identity, and its bends, to "two".
    expect(staleBendKeys(keys, state(before), state(before.replace('A --> B : one\n', '')))).toEqual([keys[0], keys[1]]);
    expect(staleBendKeys(keys, state(before), state(before.replace('A --> B : one', 'A --> C : one')))).toEqual([keys[0], keys[1]]);
    // Renaming an end leaves no relationship behind its old identity.
    expect(staleBendKeys(keys, state(before), state(before.replace(/\bC\b/g, 'D')))).toEqual([keys[2]]);
    expect(staleBendKeys(keys, state(before), undefined)).toEqual(keys);
  });

  it('keeps bends through edits that leave their relationships alone', () => {
    for (const after of [before.replace('class C', 'class C\nclass E'), before.replace('B --> C', 'B --> C\nA --> C'), `' note\n${before}`]) expect(staleBendKeys(keys, state(before), state(after)), after).toEqual([]);
  });

  it('moves bends with a relationship whose two ends moved together', () => {
    const bends = { [keys[0]]: [{ x: 10, y: 20 }], [keys[2]]: [{ x: 5, y: 5 }] };
    expect(shiftBends(bends, { A: { x: 30, y: -10 }, B: { x: 30, y: -10 } })).toEqual({ [keys[0]]: [{ x: 40, y: 10 }], [keys[2]]: [{ x: 5, y: 5 }] });
    // One end alone, ends moved differently, or nothing moved: the route is left as drawn.
    expect(shiftBends(bends, { A: { x: 30, y: 0 } })).toBeUndefined();
    expect(shiftBends(bends, { A: { x: 30, y: 0 }, B: { x: 0, y: 30 } })).toBeUndefined();
    expect(shiftBends(bends, { A: { x: 0, y: 0 }, B: { x: 0, y: 0 } })).toBeUndefined();
  });
});
