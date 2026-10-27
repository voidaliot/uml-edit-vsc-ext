import { describe, expect, it } from 'vitest';
import { projectProcedures, editProcedure } from '../src/core/procedures';
import { codeLines } from '../src/core/syntax';
import { parseDocument } from '../src/core/parser';
import { applyDiagramEdit } from '../src/core/edits';
import type { DiagramBlock } from '../src/shared/protocol';

const uml = (body: string) => `@startuml\n${body}\n@enduml\n`;
function project(source: string) {
  const lines = source.split(/\r?\n/), startLine = lines.findIndex(line => line.startsWith('@start')), endLine = lines.findIndex(line => line.startsWith('@end'));
  const block: DiagramBlock = { id: 'diagram-1', kind: 'class', title: 'Procedure test', source: lines.slice(startLine, endLine + 1).join('\n'), startLine, endLine, elements: [], relations: [], warnings: [], graphical: true };
  const result = projectProcedures(block, codeLines(source)); block.elements = result.elements; return { block, ...result };
}
const sample = uml('!procedure $card($id, $heading, $detail)\n  card $id as "<b>$heading</b>\\n$detail"\n!endprocedure\n\n$card(Order, "Checkout", "Ready to submit")');

describe('finite local procedure projection', () => {
  it('substitutes literal parameters into native declarations and tracks call ownership', () => {
    const { block, ignored, elements } = project(sample);
    expect(block.graphical, block.warnings.join('\n')).toBe(true);
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ id: 'Order', kind: 'card', name: '<b>Checkout</b>\nReady to submit', startLine: 5 });
    expect(elements[0].meta?.renameValue).toBe('Checkout');
    expect(elements[0].members).toEqual(['$id = Order', '$heading = "Checkout"', '$detail = "Ready to submit"']);
    expect([...ignored]).toEqual([1, 2, 3, 5]);
  });
  it('supports literal shape parameters, icons, multiline labels, and quoted commas', () => {
    const source = uml('!procedure $box($shape, $id, $icon, $title, $body)\n $shape $id as "<&$icon>\\n<size:18>$title</size>\\n$body"\n!endprocedure\n$box(node, Api, cloud, "Orders, API", "A \\"quoted\\" label")');
    const { block, elements } = project(source);
    expect(block.graphical, block.warnings.join('\n')).toBe(true);
    expect(elements[0].kind).toBe('node');
    expect(elements[0].name).toContain('Orders, API');
    expect(elements[0].name).toContain('A "quoted" label');
    expect(elements[0].meta?.renameParameter).toBe('$title');
  });
  it('projects multiple standalone declarations from one call', () => {
    const source = uml('!procedure $pair($first, $second)\nclass $first\nclass $second\n!endprocedure\n$pair(Request, Response)');
    expect(project(source).elements.map(element => element.id)).toEqual(['Request', 'Response']);
  });
  it('does not execute includes, loops, conditions, functions, or nested procedure calls', () => {
    for (const statement of ['!include secrets.puml', '!if 1 == 1', '!while true', '$other($id)', 'card %getenv("SECRET")', 'card $unknown']) {
      const { block, elements } = project(uml(`!procedure $unsafe($id)\n${statement}\n!endprocedure\n$unsafe(A)`));
      expect(block.graphical, statement).toBe(false);
      expect(elements, statement).toEqual([]);
      expect(block.warnings.length).toBeGreaterThan(0);
    }
  });
  it('refuses argument expressions and missing or duplicate identities', () => {
    for (const argument of ['%getenv("SECRET")', '$call()', '"a" + "b"']) {
      expect(project(uml(`!procedure $plain($id)\nclass $id\n!endprocedure\n$plain(${argument})`)).block.graphical).toBe(false);
    }
    expect(project(sample.replace('$card(Order, "Checkout", "Ready to submit")', '$card(Order)')).block.graphical).toBe(false);
    expect(project(sample.replace('@enduml', '$card(Order, "Again", "Details")\n@enduml')).block.graphical).toBe(false);
  });
  it('leaves unrelated source lines to the ordinary parser', () => {
    const source = sample.replace('@enduml', 'class Other\nOrder --> Other\n@enduml');
    const result = project(source);
    expect(result.ignored.has(6)).toBe(false);
    expect(result.ignored.has(7)).toBe(false);
  });
});

describe('targeted procedure argument edits', () => {
  it('renames only the heading argument and preserves definitions, call spacing, comments, and CRLF', () => {
    const source = sample.replace('$card(Order, "Checkout", "Ready to submit")', '$card( Order ,  "Checkout" , "Ready to submit" ) \' keep').replace(/\n/g, '\r\n');
    const { block } = project(source);
    const changed = editProcedure(source, block, { type: 'rename', elementId: 'Order', name: 'Review basket' });
    expect(changed).toBe(source.replace('"Checkout"', '"Review basket"'));
  });
  it('updates named parameters without changing unrelated arguments or escaped quotes', () => {
    const { block } = project(sample);
    const changed = editProcedure(sample, block, { type: 'members', elementId: 'Order', members: ['$detail = "Use \\"confirm\\" now"'] })!;
    expect(changed).toBe(sample.replace('"Ready to submit"', '"Use \\"confirm\\" now"'));
    expect(project(changed).elements[0].name).toContain('Use "confirm" now');
  });
  it('can materialize an edited literal default without rewriting the definition', () => {
    const source = uml('!procedure $badge($id, $heading = "Ready")\ncard $id as "$heading"\n!endprocedure\n$badge(Status)');
    const { block } = project(source);
    const changed = editProcedure(source, block, { type: 'rename', elementId: 'Status', name: 'Complete' })!;
    expect(changed).toContain('$heading = "Ready"');
    expect(changed).toContain('$badge(Status, "Complete")');
  });
  it('rejects ambiguous label renames and invalid parameter edits', () => {
    const source = uml('!procedure $label($id, $first, $second)\ncard $id as "$first $second"\n!endprocedure\n$label(A, "One", "Two")');
    const { block } = project(source);
    expect(() => editProcedure(source, block, { type: 'rename', elementId: 'A', name: 'Three' })).toThrow(/heading argument/);
    expect(() => editProcedure(source, block, { type: 'members', elementId: 'A', members: ['$unknown = "x"'] })).toThrow(/Unknown parameter/);
    expect(() => editProcedure(source, block, { type: 'members', elementId: 'A', members: ['$first = %getenv("secret")'] })).toThrow(/not evaluated/);
  });
  it('does not silently rename an identity argument and disconnect external relationships', () => {
    const source = uml('!procedure $item($id)\nclass $id\n!endprocedure\n$item(A)\nA --> B');
    const { block } = project(source);
    expect(() => editProcedure(source, block, { type: 'rename', elementId: 'A', name: 'Changed' })).toThrow(/heading argument/);
  });
  it('deletes only the call while preserving the reusable definition', () => {
    const { block } = project(sample);
    const changed = editProcedure(sample, block, { type: 'deleteElement', elementId: 'Order' })!;
    expect(changed).toContain('!procedure $card');
    expect(changed).not.toContain('$card(Order');
    expect(project(changed).elements).toEqual([]);
  });
});

describe('procedure integration with ordinary relationships', () => {
  const linked = uml('!procedure $card($id, $heading)\ncard $id as "$heading"\n!endprocedure\nBefore --> Order : first\n$card(Order, "Checkout")\n$card(Receipt, "Confirmation")\nOrder --> Receipt : next\nReceipt --> After : last');

  it('resolves crosslinks to exactly one projected element regardless of call order', () => {
    const block = parseDocument(linked).diagrams[0];
    expect(block.graphical, block.warnings.join('\n')).toBe(true);
    expect(block.elements.map(element => element.id).sort()).toEqual(['After', 'Before', 'Order', 'Receipt']);
    expect(block.elements.find(element => element.id === 'Order')).toMatchObject({ name: 'Checkout', kind: 'card', meta: { procedure: true } });
    expect(block.relations.map(relation => [relation.source, relation.target])).toEqual([['Before', 'Order'], ['Order', 'Receipt'], ['Receipt', 'After']]);
  });

  it('keeps scoped procedure calls inside their declared container', () => {
    const source = linked.replace('Before --> Order : first', 'package CheckoutFlow {\nBefore --> Order : first').replace('@enduml', '}\n@enduml');
    const block = parseDocument(source).diagrams[0];
    expect(block.graphical, block.warnings.join('\n')).toBe(true);
    expect(block.elements.find(element => element.id === 'Order' && element.meta?.procedure)?.parentId).toBe('CheckoutFlow');
    expect(block.elements.find(element => element.id === 'Receipt' && element.meta?.procedure)?.parentId).toBe('CheckoutFlow');
  });

  it('diagnoses collisions between procedure projections and explicit declarations without duplicate IDs', () => {
    for (const source of [linked.replace('Before -->', 'class Order\nBefore -->'), linked.replace('@enduml', 'class Order\n@enduml')]) {
      const block = parseDocument(source).diagrams[0];
      expect(block.graphical).toBe(false);
      expect(block.warnings.join('\n')).toContain('Repeated declaration of Order');
      expect(block.elements.filter(element => element.id === 'Order')).toHaveLength(1);
    }
  });

  it('edits a linked heading through the public API without altering aliases or relations', () => {
    const block = parseDocument(linked).diagrams[0];
    const changed = applyDiagramEdit(linked, block.id, { type: 'rename', elementId: 'Order', name: 'Review basket' });
    expect(changed).toBe(linked.replace('"Checkout"', '"Review basket"'));
    const after = parseDocument(changed).diagrams[0];
    expect(after.elements.filter(element => element.id === 'Order')).toHaveLength(1);
    expect(after.elements.find(element => element.id === 'Order')?.name).toBe('Review basket');
    expect(after.relations.map(relation => [relation.source, relation.target])).toEqual(block.relations.map(relation => [relation.source, relation.target]));
  });

  it('updates only endpoint spans when an explicit parameter edit changes an identity', () => {
    const source = linked.replace('Order --> Receipt : next', 'Order --> Receipt : Order remains label \' Order remains comment').replace(/\n/g, '\r\n');
    const block = parseDocument(source).diagrams[0];
    const changed = applyDiagramEdit(source, block.id, { type: 'members', elementId: 'Order', members: ['$id = Basket', '$heading = "Checkout"'] });
    expect(changed).toBe(source.replace('$card(Order,', '$card(Basket,').replace('Before --> Order', 'Before --> Basket').replace('Order --> Receipt', 'Basket --> Receipt'));
    const after = parseDocument(changed).diagrams[0];
    expect(after.graphical, after.warnings.join('\n')).toBe(true);
    expect(after.elements.some(element => element.id === 'Order')).toBe(false);
    expect(after.elements.filter(element => element.id === 'Basket')).toHaveLength(1);
    expect(after.relations.map(relation => [relation.source, relation.target])).toEqual([['Before', 'Basket'], ['Basket', 'Receipt'], ['Receipt', 'After']]);
  });

  it('refuses identity parameter edits that collide with an unrelated explicit node', () => {
    const source = linked.replace('@enduml', 'class Existing\n@enduml');
    const block = parseDocument(source).diagrams[0];
    expect(() => applyDiagramEdit(source, block.id, { type: 'members', elementId: 'Order', members: ['$id = Existing'] })).toThrow(/identity.*Existing|Existing.*identity/);
  });

  it('rewrites both endpoints atomically when one call swaps two declaration identities', () => {
    const source = uml('!procedure $pair($first, $second)\nclass $first\nclass $second\n!endprocedure\n$pair(Request, Response)\nRequest --> Response : Request and Response remain labels\nResponse --> Request');
    const block = parseDocument(source).diagrams[0];
    const changed = applyDiagramEdit(source, block.id, { type: 'members', elementId: 'Request', members: ['$first = Response', '$second = Request'] });
    expect(changed).toBe(source.replace('$pair(Request, Response)', '$pair(Response, Request)').replace('Request --> Response :', 'Response --> Request :').replace('\nResponse --> Request\n', '\nRequest --> Response\n'));
    const after = parseDocument(changed).diagrams[0];
    expect(after.graphical, after.warnings.join('\n')).toBe(true);
    expect(after.elements.map(element => element.id).sort()).toEqual(['Request', 'Response']);
  });
});
