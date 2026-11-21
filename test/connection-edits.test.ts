import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { applyDiagramEdit } from '../src/core/edits';
import { mergeLayoutPositions, validEdit, validWebviewMessage } from '../src/host/messages';
import { bendKey } from '../src/core/layout-file';
import { bentHandles, interactiveEdges, snapBend } from '../src/webview/connections';
import type { DiagramEdit } from '../src/shared/protocol';

const uml = (body: string) => `@startuml\n${body}\n@enduml\n`;
const block = (source: string) => parseDocument(source).diagrams[0];
const edit = (source: string, change: DiagramEdit) => applyDiagramEdit(source, 'diagram-1', change);
const relationAt = (source: string, line: number) => block(source).relations.find(relation => relation.startLine === line)!;
const reconnect = (source: string, line: number, end: 'source' | 'target', elementId: string) => edit(source, { type: 'reconnectRelation', relationId: relationAt(source, line).id, end, elementId });

describe('adding a connected element', () => {
  it('declares the element and links it from the source in one change', () => {
    const source = uml('class Order\nclass Customer\nOrder --> Customer');
    const next = edit(source, { type: 'addConnectedElement', source: 'Order', kind: 'class', name: 'Line item', arrow: '-->', label: 'contains' });
    expect(next).toBe(uml('class Order\nclass Customer\nOrder --> Customer\nclass "Line item" as LineItem {\n}\nOrder --> LineItem : contains'));
    expect(block(next).relations.at(-1)).toMatchObject({ source: 'Order', target: 'LineItem', label: 'contains' });
  });

  it('keeps CRLF line endings and comments', () => {
    const source = "@startuml\r\nclass A ' the first\r\n@enduml\r\n";
    expect(edit(source, { type: 'addConnectedElement', source: 'A', kind: 'interface', name: 'B', arrow: '..>', label: '' })).toBe("@startuml\r\nclass A ' the first\r\ninterface B {\r\n}\r\nA ..> B\r\n@enduml\r\n");
  });

  it('adds a sequence participant and a message to it at the chosen row', () => {
    const source = uml('participant Web\nparticipant Api\nWeb -> Api : first\nApi --> Web : second');
    const next = edit(source, { type: 'addConnectedElement', source: 'Api', kind: 'database', name: 'Store', arrow: '->', label: 'save', sequenceRow: 1 });
    expect(next).toBe(uml('participant Web\nparticipant Api\ndatabase Store\nWeb -> Api : first\nApi -> Store : save\nApi --> Web : second'));
  });

  it('starts a state machine transition from the initial symbol, never from the final one', () => {
    const source = uml('[*] --> Idle\nIdle --> [*]');
    const start = block(source).elements.find(element => element.kind === 'start')!, end = block(source).elements.find(element => element.kind === 'end')!;
    expect(edit(source, { type: 'addConnectedElement', source: start.id, kind: 'state', name: 'Busy', arrow: '-->', label: '' })).toBe(uml('[*] --> Idle\nIdle --> [*]\nstate Busy\n[*] --> Busy'));
    expect(() => edit(source, { type: 'addConnectedElement', source: end.id, kind: 'state', name: 'Busy', arrow: '-->', label: '' })).toThrow('final state');
  });

  it('works through family adapters that create relationships', () => {
    const source = '@startdot\ndigraph g {\n  a [label="A"];\n}\n@enddot\n';
    const next = edit(source, { type: 'addConnectedElement', source: 'a', kind: 'box', name: 'B', arrow: '-->', label: 'go' });
    expect(block(next).relations).toEqual([expect.objectContaining({ source: 'a', label: 'go' })]);
    expect(block(next).elements).toHaveLength(2);
  });

  it('rejects what cannot become one endpoint, and leaves nothing behind', () => {
    const source = uml('class A');
    expect(() => edit(source, { type: 'addConnectedElement', source: 'A', kind: 'package', name: 'P', arrow: '-->', label: '' })).toThrow('one step');
    expect(() => edit(source, { type: 'addConnectedElement', source: 'Missing', kind: 'class', name: 'B', arrow: '-->', label: '' })).toThrow('no longer exists');
    expect(() => edit(source, { type: 'addConnectedElement', source: 'A', kind: 'class', name: 'B', arrow: '~~>', label: '' })).toThrow('supported relationship style');
    expect(() => edit('@startmindmap\n* Root\n@endmindmap\n', { type: 'addConnectedElement', source: block('@startmindmap\n* Root\n@endmindmap\n').elements[0].id, kind: 'idea', name: 'B', arrow: '-->', label: '' })).toThrow();
  });
});

describe('reconnecting a relationship', () => {
  it('rewrites only the moved endpoint and keeps arrow, multiplicities, label and comment', () => {
    const source = uml('class A\nclass B\nclass C\nA "1" *-- "many" B : owns \' keep me');
    expect(reconnect(source, 4, 'target', 'C')).toBe(uml('class A\nclass B\nclass C\nA "1" *-- "many" C : owns \' keep me'));
    expect(reconnect(source, 4, 'source', 'C')).toBe(uml('class A\nclass B\nclass C\nC "1" *-- "many" B : owns \' keep me'));
    expect(reconnect(source, 4, 'target', 'B')).toBe(source);
  });

  it('uses the form an element is already written in', () => {
    const components = uml('[Web shop] --> [Orders]\ncomponent "Billing" as bill\n[Stock]\n[Orders] --> bill');
    expect(reconnect(components, 1, 'target', 'bill')).toBe(uml('[Web shop] --> bill\ncomponent "Billing" as bill\n[Stock]\n[Orders] --> bill'));
    expect(reconnect(components, 1, 'target', 'Stock')).toBe(uml('[Web shop] --> [Stock]\ncomponent "Billing" as bill\n[Stock]\n[Orders] --> bill'));
    // Implicit elements are named the way their other references name them.
    const usecases = uml(':Customer: --> (Pay)\n:Clerk: --> (Refund)\n:Customer: --> (Refund)');
    expect(reconnect(usecases, 1, 'source', 'Clerk')).toBe(uml(':Clerk: --> (Pay)\n:Clerk: --> (Refund)\n:Customer: --> (Refund)'));
    expect(reconnect(usecases, 2, 'target', 'Pay')).toBe(uml(':Customer: --> (Pay)\n:Clerk: --> (Pay)\n:Customer: --> (Refund)'));
    const quoted = uml('class "Line item" as LineItem\nclass "Big Order"\nOrder --> LineItem');
    expect(reconnect(quoted, 3, 'target', 'Big Order')).toBe(uml('class "Line item" as LineItem\nclass "Big Order"\nOrder --> "Big Order"'));
  });

  it('refuses to drop an element that exists only through this relationship', () => {
    const source = uml('class A\nclass C\nA --> B');
    expect(() => reconnect(source, 3, 'target', 'C')).toThrow('exists only through this relationship');
  });

  it('moves state machine transitions between states and their pseudo-states', () => {
    const source = uml('[*] --> Idle\nIdle --> Busy\nBusy --> [*]');
    const states = block(source).elements;
    const start = states.find(element => element.kind === 'start')!.id, end = states.find(element => element.kind === 'end')!.id;
    expect(reconnect(source, 1, 'target', 'Busy')).toBe(uml('[*] --> Busy\nIdle --> Busy\nBusy --> [*]'));
    expect(reconnect(source, 2, 'target', end)).toBe(uml('[*] --> Idle\nIdle --> [*]\nBusy --> [*]'));
    // The initial symbol may disappear with its only transition; it has no content to lose.
    expect(reconnect(source, 1, 'source', 'Busy')).toBe(uml('Busy --> Idle\nIdle --> Busy\nBusy --> [*]'));
    expect(() => reconnect(source, 2, 'source', end)).toThrow('final state can only end');
    expect(() => reconnect(source, 2, 'target', start)).toThrow('initial state can only start');
  });

  it('refuses a pseudo-state of another composite state', () => {
    const source = uml('state Outer {\n  [*] --> Inner\n  state Inner\n}\n[*] --> Outer\nOuter --> Done');
    const nested = block(source).elements.find(element => element.kind === 'start' && element.parentId === 'Outer')!;
    expect(() => reconnect(source, 6, 'source', nested.id)).toThrow('unambiguously');
  });

  it('re-targets a sequence message without moving it', () => {
    const source = uml('participant Web\nparticipant Api\nparticipant Store\nWeb -> Api : load\nApi --> Web : done');
    expect(reconnect(source, 4, 'target', 'Store')).toBe(uml('participant Web\nparticipant Api\nparticipant Store\nWeb -> Store : load\nApi --> Web : done'));
  });

  it('leaves structure-derived connections and family syntax to the source panel', () => {
    const activity = uml('start\n:One;\n:Two;\nstop');
    const parsed = block(activity);
    expect(() => edit(activity, { type: 'reconnectRelation', relationId: parsed.relations[0].id, end: 'target', elementId: parsed.elements[2].id })).toThrow('diagram structure');
    const dot = '@startdot\ndigraph g {\n  a -> b;\n  c;\n}\n@enddot\n';
    expect(() => edit(dot, { type: 'reconnectRelation', relationId: block(dot).relations[0].id, end: 'target', elementId: 'c' })).toThrow('diagram structure');
  });
});

describe('connection edit messages', () => {
  it('accepts well-formed gestures and rejects malformed ones', () => {
    expect(validEdit({ type: 'addConnectedElement', source: 'A', kind: 'class', name: 'B', arrow: '-->', label: '' })).toBe(true);
    expect(validEdit({ type: 'addConnectedElement', source: 'A', kind: 'class', name: 'B', arrow: '-->', label: '', sequenceRow: 3 })).toBe(true);
    expect(validEdit({ type: 'addConnectedElement', source: 'A', kind: 'class', name: 'B', arrow: '-->' })).toBe(false);
    expect(validEdit({ type: 'addConnectedElement', source: '', kind: 'class', name: 'B', arrow: '-->', label: '' })).toBe(false);
    expect(validEdit({ type: 'addConnectedElement', source: 'A', kind: 'class', name: 'B', arrow: '-->', label: '', sequenceRow: -1 })).toBe(false);
    expect(validEdit({ type: 'reconnectRelation', relationId: 'relation-3-0', end: 'target', elementId: 'C' })).toBe(true);
    expect(validEdit({ type: 'reconnectRelation', relationId: 'relation-3-0', end: 'middle', elementId: 'C' })).toBe(false);
    expect(validEdit({ type: 'reconnectRelation', relationId: 'relation-3-0', end: 'source' })).toBe(false);
    expect(validWebviewMessage({ type: 'edit', version: 1, diagramId: 'diagram-1', edit: { type: 'reconnectRelation', relationId: 'r', end: 'source', elementId: 'A' } })).toBe(true);
  });
});

describe('relationship bends in layout messages', () => {
  const ab = bendKey('A', 'B', 0), bc = bendKey('B', 'C', 0);
  it('merges a bend change against its baseline, so bends shaped in another panel survive', () => {
    const latest = { positions: { A: { x: 1, y: 1 } }, bends: { [ab]: [{ x: 5, y: 5 }], [bc]: [{ x: 9, y: 9 }] } };
    const merged = mergeLayoutPositions(latest, { positions: { A: { x: 1, y: 1 } }, bends: { [ab]: [{ x: 6, y: 6 }] } }, { A: { x: 1, y: 1 } }, { [ab]: [{ x: 5, y: 5 }] });
    expect(merged).toEqual({ positions: { A: { x: 1, y: 1 } }, bends: { [ab]: [{ x: 6, y: 6 }], [bc]: [{ x: 9, y: 9 }] } });
    // Removing the last bend removes the field.
    expect(mergeLayoutPositions({ positions: {}, bends: { [ab]: [{ x: 5, y: 5 }] } }, { positions: {}, bends: {} }, {}, { [ab]: [{ x: 5, y: 5 }] })).toEqual({ positions: {} });
  });

  it('keeps the latest bends for every message that does not name a bend baseline', () => {
    const latest = { positions: {}, bends: { [ab]: [{ x: 5, y: 5 }] } };
    expect(mergeLayoutPositions(latest, { positions: { A: { x: 2, y: 2 } } }, {}).bends).toEqual(latest.bends);
    expect(mergeLayoutPositions(latest, { positions: { A: { x: 2, y: 2 } }, bends: {} }).bends).toEqual(latest.bends);
    expect(mergeLayoutPositions({ positions: {} }, { positions: {}, bends: { [ab]: [{ x: 1, y: 1 }] } })).toEqual({ positions: {} });
  });

  it('leaves each element toward its nearest bend and snaps a dragged bend onto its neighbours', () => {
    const box = { x: 0, y: 0, width: 200, height: 80 }, far = { x: 600, y: 0, width: 200, height: 80 };
    expect(bentHandles([{ x: 100, y: -200 }, { x: 700, y: 300 }], box, far)).toEqual({ sourceHandle: 'top', targetHandle: 'bottom' });
    expect(bentHandles([{ x: -100, y: 40 }], box, far)).toEqual({ sourceHandle: 'left', targetHandle: 'left' });
    expect(snapBend({ x: 104, y: 57 }, [{ x: 100, y: 10 }, { x: 300, y: 60 }], 6)).toEqual({ x: 100, y: 60 });
    expect(snapBend({ x: 120, y: 30 }, [{ x: 100, y: 10 }], 6)).toEqual({ x: 120, y: 30 });
  });

  it('offers end grips and bend grips only on the selected relationship of a diagram that allows them', () => {
    const relation = { id: 'relation-3-0', source: 'A', target: 'B', label: '', arrow: '-->', startLine: 3, endLine: 3 };
    const edge = (selected: boolean) => ({ id: relation.id, source: 'A', target: 'B', type: 'uml' as const, selected, data: { relation, onEdit: () => {} } });
    const node = (id: string, x: number) => ({ id, type: 'uml' as const, position: { x, y: 0 }, data: { element: { id, name: id, kind: 'class', members: [], startLine: 1, endLine: 1 }, diagramId: 'diagram-1', version: 1, onRename: async () => true, onMembers: async () => true } });
    const options = { relinkable: true, bendable: true, bends: { [ab]: [{ x: 300, y: -100 }] }, keys: new Map([[relation.id, ab]]), onBends: () => {} };
    const [selected] = interactiveEdges([edge(true)], [node('A', 0), node('B', 600)], options);
    expect(selected).toMatchObject({ reconnectable: true, sourceHandle: 'top', targetHandle: 'left', data: { reconnectable: true, bends: [{ x: 300, y: -100 }] } });
    expect(selected.data?.onBends).toBe(options.onBends);
    const unselected = edge(false), [idle] = interactiveEdges([unselected], [node('A', 0), node('B', 600)], { ...options, bends: {} });
    expect(idle).toBe(unselected);
    // Where neither gesture applies, stored bends are not drawn either and the edge is left as built.
    const chosen = edge(true), [locked] = interactiveEdges([chosen], [node('A', 0), node('B', 600)], { ...options, relinkable: false, bendable: false });
    expect(locked).toBe(chosen);
  });

  it('validates bends and their baseline in layout messages', () => {
    const message = (layout: unknown, extra: Record<string, unknown> = {}) => validWebviewMessage({ type: 'layout', diagramId: 'diagram-1', layout, ...extra });
    expect(message({ positions: {}, bends: { [ab]: [{ x: 1, y: 2 }] } }, { baseBends: {} })).toBe(true);
    expect(message({ positions: {}, bends: { 'A->B': [{ x: 1, y: 2 }] } })).toBe(false);
    expect(message({ positions: {}, bends: { [ab]: [] } })).toBe(false);
    expect(message({ positions: {}, bends: { [ab]: [{ x: 'a', y: 2 }] } })).toBe(false);
    expect(message({ positions: {} }, { baseBends: { [ab]: [{ x: Infinity, y: 2 }] } })).toBe(false);
  });
});
