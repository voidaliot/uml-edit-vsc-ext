import { describe, expect, it } from 'vitest';
import { applyDiagramEdit } from '../src/core/edits';
import { parseDocument } from '../src/core/parser';
import { layoutDiagram } from '../src/core/layout';
import { relationHandles } from '../src/webview/connections';
import { parseLayoutFile, serializeLayoutFile } from '../src/core/layout-file';
import { mergeLayoutPositions, validWebviewMessage } from '../src/host/messages';

const wrap = (body: string) => `@startuml\n${body}\n@enduml\n`;
const labels = (source: string) => parseDocument(source).diagrams[0].relations.map(relation => relation.label);

describe('sequence row editing', () => {
  it('moves a message in either direction and keeps identities, comments, CRLF and adjacent diagrams', () => {
    const source = (`' Header\n${wrap('participant A\nparticipant B\nA -> B : One\nB -> A : Two\nA -> B : Three')}\n${wrap('class Other')}`).replace(/\n/g, '\r\n');
    const before = parseDocument(source).diagrams[0], message = before.relations[2];
    const moved = applyDiagramEdit(source, before.id, { type: 'moveSequenceEvent', eventId: message.id, row: 0 });
    expect(labels(moved)).toEqual(['Three', 'One', 'Two']);
    expect(moved).toContain("' Header\r\n");
    expect(moved.endsWith(wrap('class Other').replace(/\n/g, '\r\n'))).toBe(true);
    expect(parseDocument(moved).diagrams[0].relations[0].id).toBe(message.id);
    expect(applyDiagramEdit(moved, before.id, { type: 'moveSequenceEvent', eventId: message.id, row: 2 })).toBe(source);
  });

  it('keeps immediately attached activation directives with a moved message', () => {
    const source = wrap('participant A\nparticipant B\nA -> B : One\nactivate B\nB -> A : Two\nA -> B : Three');
    const block = parseDocument(source).diagrams[0];
    const moved = applyDiagramEdit(source, block.id, { type: 'moveSequenceEvent', eventId: block.relations[0].id, row: 2 });
    expect(labels(moved)).toEqual(['Two', 'Three', 'One']);
    expect(moved).toContain('A -> B : One\nactivate B\n@enduml');
  });

  it('keeps implicit participant order when first appearances change', () => {
    const source = wrap('A -> B : One\nB -> C : Two');
    const block = parseDocument(source).diagrams[0];
    const moved = applyDiagramEdit(source, block.id, { type: 'moveSequenceEvent', eventId: block.relations[1].id, row: 0 });
    expect(labels(moved)).toEqual(['Two', 'One']);
    expect(parseDocument(moved).diagrams[0].elements.map(element => element.id)).toEqual(['A', 'B', 'C']);
    expect(moved).toContain('participant A\nparticipant B\nparticipant C');
  });

  it('moves a divider while retaining its identity and keeps else inside its fragment', () => {
    const source = wrap('participant A\nparticipant B\nA -> B : One\n== Checkpoint ==\nB -> A : Two\nalt Ready\nA -> B : Three\nelse Wait\nB -> A : Four\nend');
    const block = parseDocument(source).diagrams[0], divider = block.elements.find(element => element.name === 'Checkpoint')!;
    const moved = applyDiagramEdit(source, block.id, { type: 'moveSequenceEvent', eventId: divider.id, row: 0 });
    expect(moved.indexOf('== Checkpoint ==')).toBeLessThan(moved.indexOf('A -> B : One'));
    expect(parseDocument(moved).diagrams[0].elements.find(element => element.name === 'Checkpoint')!.id).toBe(divider.id);
    const branch = block.elements.find(element => element.name === 'Wait')!;
    const branchMoved = applyDiagramEdit(source, block.id, { type: 'moveSequenceEvent', eventId: branch.id, row: 20000 });
    expect(branchMoved.indexOf('else Wait')).toBeLessThan(branchMoved.lastIndexOf('\nend\n'));
    expect(parseDocument(branchMoved).diagrams[0].graphical).toBe(true);
  });

  it('inserts a connection at the selected row and exposes handles at the actual endpoints', () => {
    const source = wrap('participant A\nparticipant B\nA -> B : One\n== Phase ==\nB -> A : Two\nA -> A : Self');
    const block = parseDocument(source).diagrams[0], points = layoutDiagram(block);
    const ports = block.elements[0].meta!.sequencePorts as { id: string; offset: number }[];
    for (const relation of block.relations) {
      const handles = relationHandles(relation, block, points);
      expect(ports.find(port => port.id === handles.sourceHandle)!.offset).toBe(78 + Number(relation.meta?.row) * 52);
      if (relation.source === relation.target) expect(ports.find(port => port.id === handles.targetHandle)!.offset).toBe(108 + Number(relation.meta?.row) * 52);
    }
    const inserted = applyDiagramEdit(source, block.id, { type: 'addRelation', source: 'A', target: 'B', label: 'Inserted', arrow: '->', sequenceRow: 1 });
    expect(inserted.indexOf('A -> B : Inserted')).toBeLessThan(inserted.indexOf('== Phase =='));
    expect(labels(inserted)).toEqual(['One', 'Inserted', 'Two', 'Self']);
    expect(() => applyDiagramEdit(source, block.id, { type: 'moveSequenceEvent', eventId: block.relations[0].id, row: NaN })).toThrow();
  });
});

describe('divider dimensions in the layout file', () => {
  it('round trips size changes, drops sizes on reset, and merges against the latest placements', () => {
    const changed = serializeLayoutFile({ 'diagram-1': { positions: { divider: { x: 60, y: 189, width: 480, height: 28 } } } })!;
    expect(parseLayoutFile(changed)['diagram-1'].positions.divider.width).toBe(480);
    const reset = serializeLayoutFile({ 'diagram-1': { positions: { divider: { x: 60, y: 189 } } } })!;
    expect(parseLayoutFile(reset)['diagram-1'].positions.divider).toEqual({ x: 60, y: 189 });
    const merged = mergeLayoutPositions({ positions: { divider: { x: 60, y: 189, width: 300 }, other: { x: 400, y: 10 } } }, { positions: { divider: { x: 60, y: 189, width: 480 } } }, { divider: { x: 60, y: 189, width: 300 } });
    expect(merged.positions).toEqual({ divider: { x: 60, y: 189, width: 480 }, other: { x: 400, y: 10 } });
  });

  it('validates dimensions and sequence edit requests at the host boundary', () => {
    const layout = (width: number) => ({ type: 'layout', diagramId: 'diagram-1', layout: { positions: { divider: { x: 60, y: 70, width } } } });
    expect(validWebviewMessage(layout(300))).toBe(true);
    for (const width of [0, -1, Infinity, NaN, 1e8]) {
      expect(validWebviewMessage(layout(width))).toBe(false);
      expect(() => serializeLayoutFile({ 'diagram-1': { positions: { divider: { x: 60, y: 70, width } } } })).toThrow();
    }
    expect(validWebviewMessage({ type: 'edit', version: 1, diagramId: 'diagram-1', edit: { type: 'moveSequenceEvent', eventId: 'message', row: 2 } })).toBe(true);
    expect(validWebviewMessage({ type: 'edit', version: 1, diagramId: 'diagram-1', edit: { type: 'moveSequenceEvent', eventId: 'message', row: -1 } })).toBe(false);
  });
});
