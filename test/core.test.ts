import { describe, expect, it } from 'vitest';
import { parseDocument, detectDiagramKind } from '../src/core/parser';
import { applyDiagramEdit } from '../src/core/edits';
import { layoutDiagram } from '../src/core/layout';
import { templates, nativeTemplates, unsupportedTemplates, getNativeTemplate, getTemplate } from '../src/core/templates';
import { nativeDiagramKinds, nativeCoverage, supportsNativeKind } from '../src/core/coverage';
import { parseDeclaration, parseRelation, codeLines, quote, unquote } from '../src/core/syntax';

const uml = (body: string) => `@startuml\n${body}\n@enduml\n`;
const diagram = (body: string) => parseDocument(uml(body)).diagrams[0];

describe('source-aware PlantUML parsing', () => {
  it('round-trips literal backslashes and escaped quotes without interpreting them twice', () => {
    for (const name of ['C:\\work\\notes', 'C:\\', 'Say "hello"', 'literal \\n', 'two\nlines']) expect(unquote(quote(name))).toBe(name);
  });
  it('reads display names in either alias order', () => {
    expect(parseDeclaration('class "Order line" as Line')?.id).toBe('Line');
    expect(parseDeclaration('class Line as "Order line"')?.name).toBe('Order line');
    expect(parseDeclaration('participant Customer as buyer')?.id).toBe('buyer');
  });
  it.each(['A --> B : sends', 'A-->B', 'A <|-- B', 'A *-- B', 'A ||--o{ B', 'A }o-down-o{ B', 'A "1" *-- "many" B : items', '(Place order) --> (Pay)', '[Service] --> DB', 'A --> A : loop'])('lexes relationships: %s', line => {
    const edge = parseRelation(line);
    expect(edge, line).toBeDefined();
    expect(edge!.source).toBeTruthy();
    expect(edge!.target).toBeTruthy();
  });
  it('keeps cardinalities separate from the label', () => {
    const parsed = diagram('class A\nclass B\nA "1" *-- "many" B : contains');
    expect(parsed.relations[0]).toMatchObject({ source: 'A', target: 'B', sourceMultiplicity: '1', targetMultiplicity: 'many', label: 'contains' });
  });
  it('does not parse fake blocks in comments or consume adjacent diagrams', () => {
    const source = "' @startuml fake\n/'\n@startuml\nclass Hidden\n@enduml\n'/\n" + uml('class First') + '\ntext between\n' + uml('class Second');
    const parsed = parseDocument(source);
    expect(parsed.diagrams).toHaveLength(2);
    expect(parsed.diagrams.map(block => block.elements[0].id)).toEqual(['First', 'Second']);
    expect(parsed.diagrams[1].id).toBe('diagram-2');
  });
  it('retains unknown dialect blocks without claiming native support', () => {
    const source = '@startfuture\ncustom syntax\n@endfuture';
    expect(parseDocument(source).diagrams[0]).toMatchObject({ source, kind: 'unknown', graphical: false });
    expect(parseDocument('@startconstructor\ntext\n@endconstructor').diagrams[0].kind).toBe('unknown');
  });
  it('marks unclosed blocks without swallowing the next one', () => {
    const parsed = parseDocument('@startuml\nclass A\n' + uml('class B'));
    expect(parsed.diagrams).toHaveLength(2);
    expect(parsed.diagrams[0].graphical).toBe(false);
    expect(parsed.diagrams[1].elements[0].id).toBe('B');
  });
  it('gives sequence participants and state sentinels distinct identities', () => {
    expect(diagram('reader -> api : read\napi --> reader : value').kind).toBe('sequence');
    const state = diagram('[*] --> Waiting\nWaiting --> [*]');
    expect(state.kind).toBe('state');
    expect(state.elements.map(element => element.id)).toContain('__start');
    expect(state.elements.map(element => element.id)).toContain('__end');
  });
  it('preserves underscore names and avoids collisions with control symbol identities', () => {
    const sequence = diagram('__service -> __database : query');
    expect(sequence.elements.map(element => element.name)).toEqual(['__service', '__database']);
    const state = diagram('state __start\n[*] --> __start\n__start --> [*]');
    expect(state.elements.filter(element => element.kind === 'state').map(element => element.id)).toEqual(['__start']);
    expect(state.elements.find(element => element.kind === 'start')?.id).not.toBe('__start');
  });
  it('recognizes hierarchy parents and activity branches', () => {
    const tree = parseDocument('@startwbs\n* Delivery\n** Build\n*** Test\n** Ship\n@endwbs').diagrams[0];
    expect(tree.elements[2].parentId).toBe(tree.elements[1].id);
    const activity = diagram('start\nif (Ready?) then (yes)\n:Ship;\nelse (no)\n:Wait;\nendif\nstop');
    expect(activity.graphical).toBe(true);
    expect(activity.elements[1].name).toBe('Ready?');
    expect(activity.elements.map(element => element.kind)).toEqual(['start', 'decision', 'activity', 'activity', 'merge', 'end']);
    expect(activity.relations.filter(edge => edge.source === activity.elements[1].id).map(edge => edge.label)).toEqual(['yes', 'no']);
  });
  it('never draws outgoing flow from a terminating activity branch', () => {
    const block = diagram('start\nif (failed) then (yes)\nstop\nelse (no)\n:Continue;\nendif\n:Complete;\nstop');
    expect(block.elements.find(element => element.kind === 'decision')?.name).toBe('failed');
    const finals = block.elements.filter(element => element.kind === 'end');
    expect(block.relations.filter(edge => finals.some(final => final.id === edge.source))).toEqual([]);
    expect(block.relations.filter(edge => edge.source === block.elements.find(element => element.kind === 'decision')?.id).map(edge => edge.label)).toEqual(['yes', 'no']);
  });
  it('reports unsupported preprocessors, custom syntax and unbound sprites', () => {
    for (const source of ['!include local.puml\nclass A', 'class A\nunknown custom statement', 'class "<$icon> Item" as A']) expect(diagram(source).graphical).toBe(false);
    const nested = diagram('package P {\nclass A\n}');
    expect(nested.graphical).toBe(true);
    expect(nested.elements.find(element => element.id === 'A')?.parentId).toBe('P');
    layoutDiagram(nested);
    expect(nested.elements.find(element => element.id === 'P')?.meta?.width).toBeGreaterThan(192);
  });
  it.each([
    'title: <&cloud> Availability',
    'class "<&key> Credentials" as C',
    'class C {\n  +token: String <&key>\n}',
    'class C\nC: <b>Important</b>',
    'A -> B : <&cloud> Send',
    '"<&cloud> Service" -> B : Send',
    'start\n:<b>Execute</b>;\nstop',
    'start\nif (Ready?) then (<&check>)\n:Execute;\nendif\nstop',
  ])('preserves safe icon and formatted label syntax for native typography: %s', body => {
    const source = uml(body);
    const block = parseDocument(source).diagrams[0];
    expect(block.graphical).toBe(true);
    expect(block.source).toBe(source.trimEnd());
  });
  it('keeps styling limitations visible and projects visibility and numbering syntax', () => {
    const styled = diagram('skinparam monochrome true\nskinparam linetype ortho\nclass A');
    expect(styled.graphical).toBe(true);
    expect(styled.warnings).toHaveLength(1);
    expect(styled.warnings[0]).toContain('Source styling is preserved');
    expect(styled.warnings[0]).toContain('Other styling uses VS Code theme colors');
    for (const body of ['hide members\nclass A', 'show methods\nclass A', 'autonumber\nA -> B : request']) {
      expect(diagram(body).graphical).toBe(true);
    }
    expect(diagram('hide members\nclass A').elements[0].meta?.hiddenMembers).toBe(true);
    expect(diagram('autonumber 5\nA -> B : request').relations[0].meta?.number).toBe(5);
  });
  it('retains distinct deployment shape kinds for native geometry', () => {
    const block = diagram('node Host\nhexagon Worker\nHost --> Worker');
    expect(block.graphical).toBe(true);
    expect(block.elements.find(element => element.id === 'Worker')?.kind).toBe('hexagon');
  });
  it('detects declared families before ambiguous actor or usecase shapes', () => {
    expect(detectDiagramKind(uml('artifact App\nnode Host\nusecase Example'))).toBe('deployment');
    expect(detectDiagramKind(uml('!include <C4/C4_Container>\nPerson(p,"Name")'))).toBe('c4');
  });
  it('preserves columns while removing line and block comments', () => {
    const lines = codeLines('class "User\'s order" as O \' note\n/\' comment\nclass Hidden\n\'/\nclass Visible');
    expect(lines[0].trim()).toBe('class "User\'s order" as O');
    expect(lines[2].trim()).toBe('');
    expect(lines[4]).toBe('class Visible');
  });
});

describe('narrow graphical source edits', () => {
  it('allows deliberate whole-document source edits for include files and malformed blocks', () => {
    const original = 'skinparam monochrome true';
    expect(applyDiagramEdit(original, 'document', { type: 'replaceSource', source: 'skinparam monochrome false\r\n' })).toBe('skinparam monochrome false\r\n');
    expect(() => applyDiagramEdit(original, 'document', { type: 'addElement', kind: 'class', name: 'No' })).toThrow(/Only explicit/);
  });
  it('renames a display label and preserves alias, body, relation, comments, and CRLF', () => {
    const source = 'preamble\r\n@startuml\r\n\' retain this\r\nclass "Old" as Item {\r\n  text: "Old"\r\n}\r\nItem --> Other : Old\r\n@enduml\r\n';
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'rename', elementId: 'Item', name: 'New label' });
    expect(updated).toBe(source.replace('class "Old"', 'class "New label"'));
    expect(parseDocument(updated).diagrams[0].elements[0].id).toBe('Item');
  });
  it('makes an unaliased declaration editable without changing its reference identity', () => {
    const source = uml('class Original\nclass Other\nOriginal --> Other : Original');
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'rename', elementId: 'Original', name: 'New display name' });
    expect(updated).toContain('class "New display name" as Original');
    expect(updated).toContain('Original --> Other : Original');
  });
  it('renames reverse aliases and shorthand without losing declaration syntax', () => {
    const source = uml('class Item as "Old"\n[Service] as svc');
    const changed = applyDiagramEdit(source, 'diagram-1', { type: 'rename', elementId: 'Item', name: 'New' });
    expect(changed).toContain('class Item as "New"');
    expect(applyDiagramEdit(changed, 'diagram-1', { type: 'rename', elementId: 'svc', name: 'API' })).toContain('component "API" as svc');
  });
  it('creates a valid alias for an unaliased name with spaces and patches only its references', () => {
    const source = uml('class "Old name"\nclass B\n"Old name" --> B : Old name');
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'rename', elementId: 'Old name', name: 'New label' });
    expect(updated).toContain('class "New label" as class_1');
    expect(updated).toContain('class_1 --> B : Old name');
  });
  it('renames an implicit state without rewriting transition labels', () => {
    const source = uml('[*] --> Waiting : Waiting\nWaiting --> Done : finish\nWaiting : Waiting for input\nDone --> [*]');
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'rename', elementId: 'Waiting', name: 'Awaiting input' });
    expect(updated).toContain('state "Awaiting input" as Waiting');
    expect(updated).toContain('[*] --> Waiting : Waiting');
    expect(updated).toContain('Waiting : Waiting for input');
  });
  it('renames shorthand use cases by replacing only endpoint spans', () => {
    const source = uml('(Place order) --> (Pay) : Place order');
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'rename', elementId: 'Place order', name: 'Submit basket' });
    expect(updated).toContain('usecase "Submit basket" as usecase_1');
    expect(updated).toContain('usecase_1 --> (Pay) : Place order');
  });
  it('changes only the selected diagram block', () => {
    const first = uml('class A');
    const second = uml('class A');
    const source = first + '\n' + second;
    const updated = applyDiagramEdit(source, 'diagram-2', { type: 'rename', elementId: 'A', name: 'Second' });
    expect(updated.startsWith(first + '\n')).toBe(true);
    expect(updated).toContain('class "Second" as A');
  });
  it('preserves comments outside and inside a member block', () => {
    const source = uml("' file comment\nclass A {\n  ' domain note\n  +old: String\n}\n' next comment\nclass B");
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'members', elementId: 'A', members: ['+value: Integer', '+run()'] });
    expect(updated).toContain("' file comment\nclass A {\n  ' domain note\n  +value: Integer\n  +run()\n}\n' next comment\nclass B");
  });
  it('retains inline comments on unchanged member lines while patching a different member', () => {
    const source = uml("class A {\n  +id: int ' KEEP THIS COMMENT\n  +name: String\n}");
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'members', elementId: 'A', members: ['+id: int', '+name: Text'] });
    expect(updated).toContain("  +id: int ' KEEP THIS COMMENT\n  +name: Text");
  });
  it('retains inline comments from edited member lines as standalone comments', () => {
    const source = uml("class A {\n  +old: int ' Important context\n}");
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'members', elementId: 'A', members: ['+new: int'] });
    expect(updated).toContain("  ' Important context\n  +new: int");
  });
  it('adds members without hiding an existing inline comment', () => {
    const updated = applyDiagramEdit(uml("class A ' keep"), 'diagram-1', { type: 'members', elementId: 'A', members: ['+name: String'] });
    expect(updated).toContain("class A { ' keep\n  +name: String\n}");
    expect(parseDocument(updated).diagrams[0].elements[0].members).toEqual(['+name: String']);
  });
  it('adds safe escaped names and stable unique aliases', () => {
    const source = uml('class "One" as class_1');
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'addElement', kind: 'class', name: 'The "second" item' });
    expect(updated).toContain('class "The \\"second\\" item" as class_2');
    expect(parseDocument(updated).diagrams[0].elements.at(-1)?.id).toBe('class_2');
  });
  it('places new sequence participants before the first message', () => {
    const updated = applyDiagramEdit(uml('A -> B : request'), 'diagram-1', { type: 'addElement', kind: 'participant', name: 'Worker' });
    expect(updated.indexOf('participant "Worker"')).toBeLessThan(updated.indexOf('A -> B'));
  });
  it('uses diagram-specific declarations for entity participants and component interfaces', () => {
    const sequence = applyDiagramEdit(uml('A -> B : request'), 'diagram-1', { type: 'addElement', kind: 'entity', name: 'Record' });
    expect(sequence).toContain('entity "Record" as entity_1\n');
    expect(sequence).not.toContain('entity_1 {');
    const component = applyDiagramEdit(uml('component A'), 'diagram-1', { type: 'addElement', kind: 'interface', name: 'API' });
    expect(component).toContain('interface "API" as interface_1\n');
    expect(component).not.toContain('interface_1 {');
  });
  it('retains cardinalities and inline comments when editing relationships', () => {
    const source = uml("class A\nclass B\nA \"1\" *-- \"many\" B : old ' keep");
    const relation = parseDocument(source).diagrams[0].relations[0];
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'editRelation', relationId: relation.id, label: 'new', arrow: 'o--' });
    expect(updated).toContain("A \"1\" o-- \"many\" B : new ' keep");
  });
  it('deletes one element and its relations, preserving similarly named elements and comments', () => {
    const source = uml("class A\nclass AB\nclass B\nA --> B : remove\nAB --> B : retain\n' A comment stays");
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'deleteElement', elementId: 'A' });
    expect(updated).not.toContain('class A\n');
    expect(updated).toContain("AB --> B : retain\n' A comment stays");
  });
  it('deletes all compact shorthand members without recreating the removed class', () => {
    const source = uml('class A\nclass B\nA: field\nA : method()\nB: retain');
    const updated = applyDiagramEdit(source, 'diagram-1', { type: 'deleteElement', elementId: 'A' });
    expect(updated).toBe(uml('class B\nB: retain'));
    expect(() => applyDiagramEdit(source, 'diagram-1', { type: 'members', elementId: 'A', members: ['changed'] })).toThrow(/separate member/);
  });
  it('refuses potentially destructive edits when unknown references exist', () => {
    expect(() => applyDiagramEdit(uml('class A\n!include custom.puml'), 'diagram-1', { type: 'deleteElement', elementId: 'A' })).toThrow(/advanced syntax/);
    expect(() => applyDiagramEdit(uml('class A'), 'diagram-1', { type: 'members', elementId: 'A', members: ['}\n!include secret'] })).toThrow();
    expect(() => applyDiagramEdit(uml('class A'), 'diagram-1', { type: 'rename', elementId: 'A', name: 'A\nclass Injected' })).toThrow();
  });
  it('adds and renames activity actions without serializing other control flow', () => {
    const source = uml('start\n:Accept;\nstop');
    const added = applyDiagramEdit(source, 'diagram-1', { type: 'addElement', kind: 'activity', name: 'Store $value' });
    expect(added).toContain(':Accept;\n:Store $value;\nstop');
    const element = parseDocument(added).diagrams[0].elements.find(item => item.name === 'Store $value')!;
    expect(applyDiagramEdit(added, 'diagram-1', { type: 'rename', elementId: element.id, name: 'Store $other' })).toContain(':Store $other;');
    const before = parseDocument(source).diagrams[0];
    const after = parseDocument(added).diagrams[0];
    for (const element of before.elements) expect(after.elements.find(candidate => candidate.name === element.name)?.id).toBe(element.id);
    expect(after.elements.filter(element => !before.elements.some(old => old.id === element.id)).map(element => element.name)).toEqual(['Store $value']);
  });
  it('adds hierarchy children to the intended parent and removes descendants only', () => {
    const source = '@startwbs\n* Project\n** Build\n*** Compile\n** Ship\n@endwbs\n';
    const parentId = parseDocument(source).diagrams[0].elements.find(element => element.name === 'Build')!.id;
    const added = applyDiagramEdit(source, 'diagram-1', { type: 'addElement', kind: 'task', name: 'Test', parentId });
    expect(added).toContain('*** Compile\n*** Test\n** Ship');
    const deleted = applyDiagramEdit(added, 'diagram-1', { type: 'deleteElement', elementId: parentId });
    expect(deleted).toBe('@startwbs\n* Project\n** Ship\n@endwbs\n');
    expect(parseDocument(deleted).diagrams[0].elements.find(element => element.name === 'Ship')?.id).toBe(parseDocument(source).diagrams[0].elements.find(element => element.name === 'Ship')?.id);
  });
  it('keeps unsupported source intact when editing a source block explicitly', () => {
    const source = 'before\n@startjson\n{"name":"before"}\n@endjson\nafter';
    expect(applyDiagramEdit(source, 'diagram-1', { type: 'replaceSource', source: '@startjson\n{"name":"after"}\n@endjson' })).toBe('before\n@startjson\n{"name":"after"}\n@endjson\nafter');
  });
});

describe('templates and deterministic layout', () => {
  it('advertises exactly the native diagram families and reports their syntax limits', () => {
    expect(nativeDiagramKinds).toHaveLength(33);
    expect(new Set(nativeDiagramKinds).size).toBe(33);
    expect(nativeTemplates.map(template => template.kind)).toEqual([...nativeDiagramKinds]);
    expect(nativeCoverage.map(entry => entry.kind)).toEqual([...nativeDiagramKinds]);
    for (const entry of nativeCoverage) expect(entry.supported && entry.limitations).toBeTruthy();
    for (const template of nativeTemplates) {
      expect(supportsNativeKind(template.kind)).toBe(true);
      expect(parseDocument(template.source).diagrams[0].graphical, template.kind).toBe(true);
      expect(getNativeTemplate(template.kind)).toBe(template);
    }
    for (const template of unsupportedTemplates) {
      expect(getNativeTemplate(template.kind)).toBeUndefined();
      const block = parseDocument(template.source).diagrams[0];
      expect(block.graphical, template.kind).toBe(false);
      expect(block.warnings.join('\n')).toContain('not implemented');
      expect(block.warnings.join('\n')).not.toMatch(/renderer|fallback|PlantUML view/i);
    }
    expect(getTemplate('unknown')).toBeUndefined();
    expect(getNativeTemplate('unknown')).toBeUndefined();
  });
  it('only offers palette operations that remain natively editable', () => {
    for (const template of nativeTemplates) {
      for (const kind of template.palette) {
        const source = applyDiagramEdit(template.source, 'diagram-1', { type: 'addElement', kind, name: 'AddedElement' });
        const block = parseDocument(source).diagrams[0];
        expect(block.graphical, `${template.kind}/${kind}: ${block.warnings.join('; ')}`).toBe(true);
        expect(block.elements.some(element => element.name.includes('AddedElement') || element.members.some(member => member.includes('AddedElement'))) || kind === 'salt-separator' && block.elements.some(element => element.kind === kind), `${template.kind}/${kind}`).toBe(true);
      }
    }
  });
  it('supports aliases matching JavaScript object prototype properties', () => {
    const layout = layoutDiagram(diagram('class constructor\nclass toString\nclass __proto__'));
    expect(Object.keys(layout)).toEqual(['constructor', 'toString', '__proto__']);
    for (const point of Object.values(layout)) expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
  });
  it('provides a parseable document for every creation entry', () => {
    const kinds = new Set<string>();
    for (const template of templates) {
      expect(kinds.has(template.kind)).toBe(false);
      kinds.add(template.kind);
      const parsed = parseDocument(template.source);
      expect(parsed.diagrams, template.kind).toHaveLength(1);
      expect(parsed.diagrams[0].kind, template.kind).toBe(template.kind);
    }
  });
  it('lays out cycles and disconnected nodes without overlapping positions', () => {
    const block = diagram('state A\nstate B\nstate C\nstate D\nA --> B\nB --> A\nC --> D');
    const layout = layoutDiagram(block);
    expect(Object.keys(layout)).toHaveLength(4);
    expect(new Set(Object.values(layout).map(point => `${point.x},${point.y}`)).size).toBe(4);
    expect(layoutDiagram(block)).toEqual(layout);
  });
});
