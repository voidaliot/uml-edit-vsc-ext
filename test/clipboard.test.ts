import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { applyDiagramEdit } from '../src/core/edits';
import { clipboardBlocker, copyFragment, pasteInsertionLine } from '../src/core/clipboard';
import { propertiesError } from '../src/core/properties';
import { validEdit } from '../src/host/messages';
import type { DiagramKind } from '../src/shared/protocol';

const uml = (body: string) => `@startuml\n${body}\n@enduml\n`;
const block = (source: string, id = 'diagram-1', kind?: DiagramKind) => parseDocument(source, { kinds: kind ? { [id]: kind } : undefined }).diagrams.find(item => item.id === id)!;
const copy = (source: string, ids: string[], id = 'diagram-1') => copyFragment(source, block(source, id), ids);
const paste = (source: string, fragment: ReturnType<typeof copy>, id = 'diagram-1') => applyDiagramEdit(source, id, { type: 'paste', kind: fragment.kind, source: fragment.source });
const duplicate = (source: string, ids: string[]) => paste(source, copy(source, ids));

describe('copying and pasting elements', () => {
  it('pastes a copy beside the original with a fresh alias and the same display name', () => {
    const source = uml('class Order {\n  +number: String\n}\nclass "Line item" as LineItem\nOrder *-- LineItem : contains');
    expect(duplicate(source, ['Order'])).toBe(uml('class Order {\n  +number: String\n}\nclass "Line item" as LineItem\nOrder *-- LineItem : contains\nclass "Order" as Order2 {\n  +number: String\n}'));
    // Relationships come along only when both of their ends are copied.
    const both = duplicate(source, ['Order', 'LineItem']);
    expect(both).toBe(uml('class Order {\n  +number: String\n}\nclass "Line item" as LineItem\nOrder *-- LineItem : contains\nclass "Order" as Order2 {\n  +number: String\n}\nclass "Line item" as LineItem2\nOrder2 *-- LineItem2 : contains'));
    // A copy of a copy counts on instead of growing the suffix.
    expect(duplicate(both, ['Order2'])).toContain('class "Order" as Order3 {');
    const result = block(both);
    expect(result.graphical).toBe(true);
    expect(result.relations.map(relation => `${relation.source}>${relation.target}`)).toEqual(['Order>LineItem', 'Order2>LineItem2']);
  });

  it('copies containers with their contents and keeps comments, member statements and shorthand', () => {
    const source = uml("package Shop {\n  class Cart ' the basket\n  class Item\n  Cart --> Item\n  Cart --> Outside\n}\nclass Outside\nCart : +total()");
    const fragment = copy(source, ['Shop']);
    expect(fragment.source).toBe("package Shop {\n  class Cart ' the basket\n  class Item\n  Cart --> Item\n}\nCart : +total()");
    expect(Object.values(fragment.origins)).toEqual(['Shop', 'Cart', 'Item']);
    const pasted = paste(source, fragment);
    expect(pasted).toContain("package \"Shop\" as Shop2 {\n  class \"Cart\" as Cart2 ' the basket\n  class \"Item\" as Item2\n  Cart2 --> Item2\n}\nCart2 : +total()\n@enduml");
    const result = block(pasted);
    expect(result.graphical).toBe(true);
    expect(result.elements.find(element => element.id === 'Cart2')).toMatchObject({ parentId: 'Shop2', members: ['+total()'] });
    // Snippet line i lands on document line insertion + i, so copies can be placed by their origin.
    const insertion = pasteInsertionLine(block(source));
    for (const [line, origin] of Object.entries(fragment.origins)) expect(result.elements.find(element => element.startLine === insertion + Number(line))?.name).toBe(block(source).elements.find(element => element.id === origin)?.name);

    const components = uml('[Web] as web\n[Api]\nweb --> [Api]\nweb --> [Store]');
    const copied = paste(components, copy(components, ['web', 'Api', 'Store']));
    expect(copied).toContain('[Web] as web2\n[Api] as Api2\nweb2 --> Api2\ncomponent "Store" as Store2\nweb2 --> Store2\n@enduml');
    expect(block(copied).graphical).toBe(true);
  });

  it('copies state machines with their initial transitions and composite states', () => {
    const source = uml('[*] --> Idle\nstate Idle\nstate Busy {\n  [*] --> Working\n  state Working\n}\nIdle --> Busy : go');
    const all = block(source).elements.map(element => element.id);
    const pasted = paste(source, copy(source, all));
    expect(pasted).toContain('[*] --> Idle\nstate Idle\nstate Busy {\n  [*] --> Working\n  state Working\n}\nIdle --> Busy : go\n[*] --> Idle2\nstate "Idle" as Idle2\nstate "Busy" as Busy2 {\n  [*] --> Working2\n  state "Working" as Working2\n}\nIdle2 --> Busy2 : go\n@enduml');
    expect(block(pasted).graphical).toBe(true);
  });

  it('pastes into another diagram of the same family and refuses other families', () => {
    const source = uml('class Order\nclass Customer\nCustomer --> Order') + uml('class Invoice') + uml('[*] --> Idle');
    const fragment = copy(source, ['Order', 'Customer']);
    const pasted = paste(source, fragment, 'diagram-2');
    // Free names stay as they were.
    expect(block(pasted, 'diagram-2').source).toBe('@startuml\nclass Invoice\nclass Order\nclass Customer\nCustomer --> Order\n@enduml');
    expect(() => paste(source, fragment, 'diagram-3')).toThrow('copied from a class diagram and cannot be pasted into a state machine diagram');
    expect(() => applyDiagramEdit(source, 'diagram-1', { type: 'paste', kind: 'class', source: '@enduml\nclass X' })).toThrow('nothing to paste');
  });

  it('is unavailable where statements depend on their order or on a family adapter', () => {
    expect(clipboardBlocker(block(uml('participant A\nA -> A : hi')))).toContain('sequence diagrams');
    expect(clipboardBlocker(block(uml('start\n:Work;\nstop')))).toContain('order of its source');
    expect(clipboardBlocker(block('@startmindmap\n* Root\n@endmindmap\n'))).toContain('order of its source');
    expect(clipboardBlocker(block('@startjson\n{"a": 1}\n@endjson\n'))).toContain('not available in json');
    expect(() => copy(uml('participant A'), ['A'])).toThrow('sequence diagrams');
    expect(() => applyDiagramEdit(uml('participant A'), 'diagram-1', { type: 'paste', kind: 'sequence', source: 'participant B' })).toThrow('sequence diagrams');
  });

  it('refuses a selection cut through by a block comment', () => {
    const source = uml("class A /' starts here\n'/ class B");
    expect(() => copy(source, ['A'])).toThrow('block comment');
  });
});

describe('element properties', () => {
  const set = (source: string, elementId: string, stereotype: string, color: string) => applyDiagramEdit(source, 'diagram-1', { type: 'properties', elementId, stereotype, color });

  it('sets and clears the stereotype and colour on the declaration line only', () => {
    const source = uml("class \"Order\" as Order <<entity>> #LightBlue { ' keep\n  +id\n}\nclass Plain ' note");
    expect(set(source, 'Order', 'aggregate', '#FFAA00')).toBe(uml("class \"Order\" as Order <<aggregate>> #FFAA00 { ' keep\n  +id\n}\nclass Plain ' note"));
    expect(set(source, 'Order', '', '')).toBe(uml("class \"Order\" as Order { ' keep\n  +id\n}\nclass Plain ' note"));
    const plain = set(source, 'Plain', 'service', 'red');
    expect(plain).toContain("class Plain <<service>> #red ' note");
    expect(block(plain).elements.find(element => element.id === 'Plain')?.meta).toMatchObject({ stereotype: 'service', color: 'red' });
    expect(block(set(source, 'Order', 'x', 'abc')).elements[0].meta?.color).toBe('#abc');
  });

  it('rejects values that would break the line and elements without a declaration', () => {
    const source = uml('class A\nA --> B');
    expect(() => set(source, 'A', 'a>>b', '')).toThrow('stereotype');
    expect(() => set(source, 'A', 'two\nlines', '')).toThrow('stereotype');
    expect(() => set(source, 'A', '{x}', '')).toThrow('stereotype');
    expect(() => set(source, 'A', '', '#12')).toThrow('colour');
    expect(() => set(source, 'A', '', 'red; x')).toThrow('colour');
    expect(() => set(source, 'B', 'x', '')).toThrow('Declare it in the source');
    expect(() => set(uml('class A [[http://x]]'), 'A', 'x', '')).toThrow('source editor');
    expect(() => applyDiagramEdit(uml('participant A'), 'diagram-1', { type: 'properties', elementId: 'A', stereotype: 'x', color: '' })).toThrow('Editing properties is not available in sequence');
    expect(propertiesError({ stereotype: 'Value Object', color: 'LightBlue' })).toBeUndefined();
  });

  it('is validated by the host', () => {
    expect(validEdit({ type: 'paste', kind: 'class', source: 'class A' })).toBe(true);
    expect(validEdit({ type: 'paste', kind: '', source: 'class A' })).toBe(false);
    expect(validEdit({ type: 'paste', source: 'class A' })).toBe(false);
    expect(validEdit({ type: 'properties', elementId: 'A', stereotype: 'x', color: '' })).toBe(true);
    expect(validEdit({ type: 'properties', elementId: 'A', stereotype: 'x' })).toBe(false);
    expect(validEdit({ type: 'properties', elementId: '', stereotype: '', color: '' })).toBe(false);
  });
});
