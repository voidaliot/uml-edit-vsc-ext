import { describe, expect, it } from 'vitest';
import { kindEvidence, parseDocument, umlFamilies } from '../src/core/parser';
import { applyDiagramEdit } from '../src/core/edits';
import { blankSource, getNativeTemplate, nativeTemplates, starterSource, supportsBlank } from '../src/core/templates';
import { validEdit, validWebviewMessage } from '../src/host/messages';
import type { DiagramKind } from '../src/shared/protocol';

const uml = (body: string) => `@startuml\n${body}\n@enduml\n`;
const block = (source: string, kind?: DiagramKind) => parseDocument(source, { kinds: kind ? { 'diagram-1': kind } : undefined }).diagrams[0];

describe('drawing a diagram from nothing', () => {
  it('lets the chosen family decide an empty UML block and every block that does not contradict it', () => {
    for (const kind of umlFamilies) {
      const empty = block(blankSource(kind), kind);
      expect(empty.kind, kind).toBe(kind);
      expect(empty.graphical, kind).toBe(true);
      expect(empty.meta?.openKind, kind).toBe(true);
    }
    // Without a choice an empty block still parses, and reports that its family is open.
    expect(block(uml('')).meta?.openKind).toBe(true);
    expect(kindEvidence(uml('actor Bob\ndatabase Store')).size).toBe(0);
    expect(block(uml('actor Bob'), 'usecase').kind).toBe('usecase');
    expect(block(uml('database Store'), 'component').kind).toBe('component');
    expect(block(uml('database Store'), 'deployment').kind).toBe('deployment');
  });

  it('never lets a stale choice override what the source says', () => {
    expect(block(uml('participant Web\nWeb -> Web : tick'), 'usecase').kind).toBe('sequence');
    expect(block(uml('class Order'), 'state').kind).toBe('class');
    expect(block(uml('[*] --> Idle'), 'class').kind).toBe('state');
    expect(block(uml('start\n:Work;\nstop'), 'class').kind).toBe('activity');
    expect(block(uml('class Order')).meta?.openKind).toBeUndefined();
    // SDL is activity syntax: a plain decision does not end it, another family's element does.
    expect(block(uml('if (Ready?) then (yes)\n:Go;\nendif'), 'sdl').kind).toBe('sdl');
    expect(block(uml('class Order'), 'sdl').kind).toBe('class');
    // Other markers name their family themselves.
    expect(parseDocument('@startmindmap\n@endmindmap\n', { kinds: { 'diagram-1': 'class' } }).diagrams[0].kind).toBe('mindmap');
    // The choice belongs to one diagram of the file.
    const two = parseDocument(uml('') + uml(''), { kinds: { 'diagram-2': 'sequence' } }).diagrams;
    expect(two.map(item => item.kind)).toEqual(['class', 'sequence']);
  });

  it('builds every UML family element by element and keeps it in that family', () => {
    for (const kind of umlFamilies) {
      let source = blankSource(kind);
      for (const element of getNativeTemplate(kind)!.palette) {
        source = applyDiagramEdit(source, 'diagram-1', { type: 'addElement', kind: element, name: `New ${element}` }, { kind });
        const current = block(source, kind);
        expect(current.kind, `${kind}/${element}`).toBe(kind);
        expect(current.graphical, `${kind}/${element}: ${current.warnings.join('; ')}`).toBe(true);
      }
      expect(block(source, kind).elements.length, kind).toBeGreaterThanOrEqual(getNativeTemplate(kind)!.palette.length);
    }
  });

  it('starts blank wherever a palette can fill the canvas, and from the example elsewhere', () => {
    for (const template of nativeTemplates) {
      const source = starterSource(template.kind, true)!;
      if (!supportsBlank(template.kind)) { expect(source, template.kind).toBe(template.source); continue; }
      const kind = umlFamilies.includes(template.kind) || template.kind === 'sdl' ? template.kind : undefined;
      const empty = block(source, kind);
      expect(empty.graphical, `${template.kind}: ${empty.warnings.join('; ')}`).toBe(true);
      let added: string;
      try { added = applyDiagramEdit(source, 'diagram-1', { type: 'addElement', kind: template.palette[0], name: 'First' }, { kind }); }
      catch (error) { throw new Error(`${template.kind}: ${String(error)}`); }
      const first = block(added, kind);
      expect(first.graphical, `${template.kind}: ${first.warnings.join('; ')}`).toBe(true);
      expect(first.kind, template.kind).toBe(template.kind === 'salt' ? first.kind : template.kind);
      expect(first.elements.length, template.kind).toBeGreaterThan(0);
    }
    expect(starterSource('class')).toBe(getNativeTemplate('class')!.source);
    expect(starterSource('unknown', true)).toBeUndefined();
  });

  it('gives an activity its start and stop, and a state machine its initial and final symbols', () => {
    let activity = applyDiagramEdit(uml('title Flow\n:Work;'), 'diagram-1', { type: 'addElement', kind: 'start', name: 'start' });
    activity = applyDiagramEdit(activity, 'diagram-1', { type: 'addElement', kind: 'stop', name: 'stop' });
    expect(activity).toBe(uml('title Flow\nstart\n:Work;\nstop'));
    expect(() => applyDiagramEdit(activity, 'diagram-1', { type: 'addElement', kind: 'start', name: 'start' })).toThrow(/already has a start/);

    let state = applyDiagramEdit(uml('state Idle\nstate Done'), 'diagram-1', { type: 'addRelation', source: '[*]', target: 'Idle', arrow: '-->', label: '' });
    state = applyDiagramEdit(state, 'diagram-1', { type: 'addRelation', source: 'Done', target: '[*]', arrow: '-->', label: 'finish' });
    expect(state).toBe(uml('state Idle\nstate Done\n[*] --> Idle\nDone --> [*] : finish'));
    expect(block(state).elements.map(element => element.kind).sort()).toEqual(['end', 'start', 'state', 'state']);
    expect(() => applyDiagramEdit(state, 'diagram-1', { type: 'addRelation', source: '[*]', target: '[*]', arrow: '-->', label: '' })).toThrow(/initial or final/);
    expect(() => applyDiagramEdit(uml('class A'), 'diagram-1', { type: 'addRelation', source: '[*]', target: 'A', arrow: '-->', label: '' })).toThrow(/no longer exists/);
  });
});

describe('deleting', () => {
  const model = uml("' Model\npackage Core {\n  class A {\n    +id\n  }\n  class B\n}\nclass C\nA --> B : first\nB --> C\nC --> Outside\nA : extra()");

  it('removes a whole selection in one edit, with everything that referred to it', () => {
    const relation = block(model).relations.find(item => item.label === 'first')!;
    expect(applyDiagramEdit(model, 'diagram-1', { type: 'deleteElements', elementIds: ['C'], relationIds: [relation.id] })).toBe(uml("' Model\npackage Core {\n  class A {\n    +id\n  }\n  class B\n}\nA : extra()"));
    // Deleting a container takes its contents; a duplicate or vanished id changes nothing more.
    expect(applyDiagramEdit(model, 'diagram-1', { type: 'deleteElements', elementIds: ['Core', 'A', 'A', 'Gone'], relationIds: [] })).toBe(uml("' Model\nclass C\nC --> Outside"));
    // An element that only exists as the end of a relationship goes with that relationship.
    expect(applyDiagramEdit(model, 'diagram-1', { type: 'deleteElements', elementIds: ['Outside'], relationIds: [] })).not.toContain('Outside');
    expect(applyDiagramEdit(model, 'diagram-1', { type: 'deleteElements', elementIds: block(model).elements.map(element => element.id), relationIds: block(model).relations.map(item => item.id) })).toBe(uml("' Model"));
  });

  it('keeps line endings and rejects an empty or malformed selection', () => {
    const crlf = model.replace(/\n/g, '\r\n');
    const result = applyDiagramEdit(crlf, 'diagram-1', { type: 'deleteElements', elementIds: ['C'], relationIds: [] });
    expect(result).not.toMatch(/[^\r]\n/);
    expect(() => applyDiagramEdit(model, 'diagram-1', { type: 'deleteElements', elementIds: [], relationIds: [] })).toThrow(/Select something/);
    expect(validEdit({ type: 'deleteElements', elementIds: ['A'], relationIds: [] })).toBe(true);
    expect(validEdit({ type: 'deleteElements', elementIds: 'A', relationIds: [] })).toBe(false);
    expect(validEdit({ type: 'deleteElements', elementIds: [''], relationIds: [] })).toBe(false);
    expect(validWebviewMessage({ type: 'edit', version: 1, diagramId: 'diagram-1', kind: 'state', edit: { type: 'deleteElement', elementId: 'A' } })).toBe(true);
    expect(validWebviewMessage({ type: 'edit', version: 1, diagramId: 'diagram-1', kind: 7, edit: { type: 'deleteElement', elementId: 'A' } })).toBe(false);
    expect(validWebviewMessage({ type: 'create', kind: 'class', blank: true })).toBe(true);
    expect(validWebviewMessage({ type: 'create', kind: 'class', blank: 'yes' })).toBe(false);
  });

  it('removes the initial and final symbols of a state machine', () => {
    const source = uml('[*] --> Idle\nIdle --> Done\nDone --> [*]');
    const start = block(source).elements.find(element => element.kind === 'start')!;
    expect(applyDiagramEdit(source, 'diagram-1', { type: 'deleteElement', elementId: start.id })).toBe(uml('Idle --> Done\nDone --> [*]'));
  });

  const flow = uml('start\n:Receive;\nif (Paid?) then (yes)\n  :Pack;\n  while (More?) is (yes)\n    :Next;\n  endwhile (no)\nelseif (Retry?) then (yes)\n  :Charge again;\nelse (no)\n  :Cancel;\nendif\nrepeat\n  :Poll;\nrepeat while (Busy?) is (yes) not (no)\nfork\n  :Mail;\nfork again\n  :Log;\nend fork\nstop');
  const find = (source: string, kind: string, name = '') => block(source).elements.find(element => element.kind === kind && (!name || element.name === name))!;

  it('removes an activity control structure as a whole, from any of its symbols', () => {
    const withoutIf = uml('start\n:Receive;\nrepeat\n  :Poll;\nrepeat while (Busy?) is (yes) not (no)\nfork\n  :Mail;\nfork again\n  :Log;\nend fork\nstop');
    expect(applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElement', elementId: find(flow, 'decision', 'Paid?').id })).toBe(withoutIf);
    // The merge that closes the decision stands for the same structure.
    const merge = block(flow).elements.find(element => element.kind === 'merge' && /^endif/.test(flow.split('\n')[element.startLine].trim()))!;
    expect(applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElement', elementId: merge.id })).toBe(withoutIf);
    expect(applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElement', elementId: find(flow, 'decision', 'More?').id })).not.toMatch(/while \(More|endwhile|Next/);
    expect(applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElement', elementId: find(flow, 'decision', 'Busy?').id })).not.toMatch(/repeat|Poll/);
    expect(applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElement', elementId: find(flow, 'fork').id })).not.toMatch(/fork|Mail|Log/);
    expect(applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElement', elementId: find(flow, 'join').id })).not.toMatch(/fork|Mail|Log/);
    // One alternative of a chain goes alone; the rest of the decision stays valid.
    const withoutRetry = applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElement', elementId: find(flow, 'decision', 'Retry?').id });
    expect(withoutRetry).not.toMatch(/Retry|Charge again/);
    expect(withoutRetry).toContain('else (no)\n  :Cancel;\nendif');
    expect(block(withoutRetry).graphical).toBe(true);
  });

  it('removes start, stop and a mixed selection, and leaves a diagram that still draws', () => {
    expect(applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElement', elementId: find(flow, 'start').id })).not.toMatch(/^start$/m);
    expect(applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElement', elementId: find(flow, 'end').id })).not.toMatch(/^stop$/m);
    const selection = [find(flow, 'activity', 'Receive').id, find(flow, 'decision', 'Paid?').id, find(flow, 'activity', 'Pack').id, find(flow, 'fork').id];
    const result = applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElements', elementIds: selection, relationIds: block(flow).relations.map(item => item.id) });
    expect(result).toBe(uml('start\nrepeat\n  :Poll;\nrepeat while (Busy?) is (yes) not (no)\nstop'));
    expect(block(result).graphical).toBe(true);
    const everything = applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElements', elementIds: block(flow).elements.map(element => element.id), relationIds: [] });
    expect(everything).toBe('@startuml\n@enduml\n');
    // Its flow lines follow the structure and cannot be removed on their own.
    expect(() => applyDiagramEdit(flow, 'diagram-1', { type: 'deleteElements', elementIds: [], relationIds: [block(flow).relations[0].id] })).toThrow(/derived from the diagram structure/);
  });

  it('dissolves a sequence frame and keeps the messages inside it', () => {
    const source = uml('A -> B : ask\nalt ok\n  B --> A : yes\nelse failed\n  B --> A : no\nend\nA -> B : bye');
    const frame = block(source).elements.find(element => element.kind === 'sequence-fragment')!;
    expect(applyDiagramEdit(source, 'diagram-1', { type: 'deleteElement', elementId: frame.id })).toBe(uml('A -> B : ask\n  B --> A : yes\n  B --> A : no\nA -> B : bye'));
  });

  it('removes a selection from the families that patch one item at a time', () => {
    for (const kind of ['mindmap', 'c4', 'gantt', 'chen', 'board', 'network'] as const) {
      const source = getNativeTemplate(kind)!.source, before = block(source);
      const removable = before.elements.filter(element => { try { return applyDiagramEdit(source, 'diagram-1', { type: 'deleteElement', elementId: element.id }) !== source; } catch { return false; } });
      expect(removable.length, kind).toBeGreaterThan(1);
      const result = applyDiagramEdit(source, 'diagram-1', { type: 'deleteElements', elementIds: before.elements.map(element => element.id), relationIds: [] });
      const after = block(result);
      expect(after.graphical, `${kind}: ${after.warnings.join('; ')}`).toBe(true);
      expect(after.elements.filter(element => removable.some(item => item.id === element.id)), kind).toEqual([]);
    }
  });
});
