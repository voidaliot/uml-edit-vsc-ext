import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { applyDiagramEdit } from '../src/core/edits';
import { containerTargets } from '../src/core/containment';
import { validEdit } from '../src/host/messages';

const uml = (body: string) => `@startuml\n${body}\n@enduml\n`;
const block = (source: string) => parseDocument(source).diagrams[0];
const move = (source: string, elementId: string, parentId?: string) => applyDiagramEdit(source, 'diagram-1', { type: 'moveToContainer', elementId, ...(parentId ? { parentId } : {}) });
const parentOf = (source: string, id: string) => block(source).elements.find(element => element.id === id)?.parentId;

const model = uml([
  "' Ordering model",
  'package Sales {',
  "  ' The aggregate root",
  '  class Order {',
  '    +id : int',
  '  }',
  '  class Line',
  '}',
  'package Billing {',
  '    class Invoice',
  '}',
  'package Empty {',
  '}',
  'class Customer',
  'Order *-- Line',
  'Customer --> Order : places',
  'Order : total()',
].join('\n'));

describe('moving an element between containers', () => {
  it('cuts the declaration with its body and comments and writes it inside the target, in its indentation', () => {
    const result = move(model, 'Order', 'Billing');
    expect(result).toBe(uml([
      "' Ordering model",
      'package Sales {',
      '  class Line',
      '}',
      'package Billing {',
      '    class Invoice',
      "    ' The aggregate root",
      '    class Order {',
      '      +id : int',
      '    }',
      '}',
      'package Empty {',
      '}',
      'class Customer',
      'Order *-- Line',
      'Customer --> Order : places',
      'Order : total()',
    ].join('\n')));
    const after = block(result);
    expect(after.graphical).toBe(true);
    expect(parentOf(result, 'Order')).toBe('Billing');
    // Relationships and member statements refer to the alias, which did not change.
    expect(after.relations.map(relation => [relation.source, relation.target])).toEqual([['Order', 'Line'], ['Customer', 'Order']]);
    expect(after.elements.find(element => element.id === 'Order')?.members).toEqual(['+id : int', 'total()']);
  });

  it('indents a move into an empty container one step inside it, and takes elements out to block level', () => {
    expect(move(model, 'Customer', 'Empty')).toContain('package Empty {\n  class Customer\n}\nOrder *-- Line');
    const out = move(model, 'Line');
    expect(parentOf(out, 'Line')).toBeUndefined();
    // Out of its package, it is written just above it and its comment, so nothing inside refers to a later declaration.
    expect(out).toContain("@startuml\nclass Line\n' Ordering model\npackage Sales {\n  ' The aggregate root\n  class Order {");
  });

  it('moves a container with all of its contents, and nested containers in and out', () => {
    const nested = move(model, 'Billing', 'Sales');
    expect(nested).toContain('  class Line\n  package Billing {\n      class Invoice\n  }\n}\npackage Empty');
    expect(parentOf(nested, 'Invoice')).toBe('Billing');
    expect(parentOf(nested, 'Billing')).toBe('Sales');
    // Back out of the outer package, and into its former position again as a round trip of the structure.
    const back = move(nested, 'Billing');
    expect(parentOf(back, 'Billing')).toBeUndefined();
    expect(back).toContain('class Line\n}');
    expect(block(back).elements.map(element => [element.id, element.parentId]).sort()).toEqual(block(model).elements.map(element => [element.id, element.parentId]).sort());
  });

  it('keeps CRLF line endings', () => {
    const crlf = model.replace(/\n/g, '\r\n');
    const result = move(crlf, 'Customer', 'Sales');
    expect(result.replace(/\r\n/g, '')).not.toContain('\n');
    expect(parentOf(result, 'Customer')).toBe('Sales');
  });

  it('leaves the source alone when the element already sits there', () => {
    expect(move(model, 'Line', 'Sales')).toBe(model);
    expect(move(model, 'Customer')).toBe(model);
  });

  it('refuses moves that have no single source meaning', () => {
    expect(() => move(model, 'Sales', 'Sales')).toThrow(/into itself/);
    expect(() => move(move(model, 'Billing', 'Sales'), 'Sales', 'Billing')).toThrow(/into itself/);
    expect(() => move(model, 'Line', 'Customer')).toThrow(/Only packages/);
    expect(() => move(model, 'Gone', 'Sales')).toThrow(/no longer exists/);
    const implicit = uml('package P {\n}\nclass C\nA --> B');
    expect(() => move(implicit, 'A', 'P')).toThrow(/Declare it/);
    const bodyless = uml('package P {\n}\nclass A\nrectangle R');
    expect(() => move(bodyless, 'A', 'R')).toThrow(/Only packages/);
    const namespaced = uml('namespace net.shop {\n  class Cart\n}\nclass A');
    expect(() => move(namespaced, 'Cart')).toThrow(/Namespaces/);
    expect(() => move(namespaced, 'A', 'net.shop')).toThrow(/no block|Only packages/);
    expect(() => applyDiagramEdit(uml('participant A\nparticipant B\nA -> B'), 'diagram-1', { type: 'moveToContainer', elementId: 'A' })).toThrow(/does not nest/);
    expect(() => applyDiagramEdit(uml('start\n:Work;\nstop'), 'diagram-1', { type: 'moveToContainer', elementId: block(uml('start\n:Work;\nstop')).elements[1].id })).toThrow(/does not nest/);
  });

  it('moves states between composite states but leaves concurrent regions to the source', () => {
    const machine = uml('state Idle\nstate Active {\n  state Working\n  [*] --> Working\n}\nstate Parallel {\n  state Left\n  --\n  state Right\n}\n[*] --> Idle\nIdle --> Active');
    const moved = move(machine, 'Idle', 'Active');
    expect(parentOf(moved, 'Idle')).toBe('Active');
    expect(moved).toContain('state Active {\n  state Working\n  [*] --> Working\n  state Idle\n}');
    expect(parentOf(move(machine, 'Working'), 'Working')).toBeUndefined();
    expect(() => move(machine, 'Left')).toThrow(/concurrent regions/);
    expect(() => move(machine, 'Idle', 'Parallel')).toThrow(/regions/);
    const parsed = block(machine);
    expect(containerTargets(machine, parsed, 'Idle')?.map(element => element.id)).toEqual(['Active']);
    expect(containerTargets(machine, parsed, 'Left')).toBeUndefined();
    // A whole concurrent state still moves as one block.
    expect(parentOf(move(machine, 'Parallel', 'Active'), 'Parallel')).toBe('Active');
  });

  it('lists the containers an element may enter, never itself or its contents', () => {
    const parsed = block(model);
    expect(containerTargets(model, parsed, 'Order')?.map(element => element.id)).toEqual(['Sales', 'Billing', 'Empty']);
    expect(containerTargets(model, parsed, 'Sales')?.map(element => element.id)).toEqual(['Billing', 'Empty']);
    expect(containerTargets(uml('class C\nA --> B'), block(uml('class C\nA --> B')), 'A')).toBeUndefined();
  });

  it('is validated by the host', () => {
    expect(validEdit({ type: 'moveToContainer', elementId: 'A' })).toBe(true);
    expect(validEdit({ type: 'moveToContainer', elementId: 'A', parentId: 'P' })).toBe(true);
    expect(validEdit({ type: 'moveToContainer', elementId: '' })).toBe(false);
    expect(validEdit({ type: 'moveToContainer', elementId: 'A', parentId: 3 })).toBe(false);
  });
});
