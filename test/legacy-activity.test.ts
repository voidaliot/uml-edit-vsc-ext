import { describe, expect, it } from 'vitest';
import { parseLegacyActivity, editLegacyActivity } from '../src/core/legacy-activity';
import { codeLines } from '../src/core/syntax';
import type { DiagramBlock, DiagramEdit } from '../src/shared/protocol';

const uml = (body: string) => `@startuml\n${body}\n@enduml\n`;
function parse(source: string): DiagramBlock {
  const lines = codeLines(source), startLine = lines.findIndex(line => /^@startuml/.test(line)), endLine = lines.findIndex((line, index) => index > startLine && /^@enduml/.test(line));
  const block: DiagramBlock = { id: 'diagram-1', title: 'Activity', kind: 'activity', startLine, endLine, source: source.split(/\r?\n/).slice(startLine, endLine + 1).join('\n'), elements: [], relations: [], graphical: true, warnings: [] };
  parseLegacyActivity(block, lines); return block;
}
function edit(source: string, operation: DiagramEdit) { return editLegacyActivity(source, parse(source), operation)!; }
function node(source: string, name: string) { return parse(source).elements.find(element => element.name === name)!; }
function edges(source: string) { const block = parse(source); return block.relations.map(relation => [block.elements.find(element => element.id === relation.source)!.name, block.elements.find(element => element.id === relation.target)!.name, relation.label]); }

describe('legacy activity native graph', () => {
  it('parses start/end, quoted labels, implicit previous source, and compact chains', () => {
    const source = uml('(*top) --> "Read request"\n-->[ready] "Validate" as check\ncheck-right->Commit--> (*)');
    const block = parse(source);
    expect(block.warnings).toEqual([]);
    expect(block.elements.map(element => element.kind)).toEqual(['start', 'activity', 'activity', 'activity', 'end']);
    expect(edges(source)).toEqual([['Start', 'Read request', ''], ['Read request', 'Validate', 'ready'], ['Validate', 'Commit', ''], ['Commit', 'End', '']]);
    expect(block.meta).toMatchObject({ legacy: true, derivedRelations: false });
  });
  it('preserves shared quoted-action identity at conditional convergence', () => {
    const source = uml('(*) --> "Inspect"\nif "Needs review?" then\n-->[yes] "Review"\n--> "Publish"\nelse\n-->[no] "Publish"\nendif\n--> (*)');
    const block = parse(source);
    expect(block.warnings).toEqual([]);
    expect(block.elements.filter(element => element.name === 'Publish')).toHaveLength(1);
    expect(block.elements.filter(element => element.kind === 'merge')).toHaveLength(0);
    expect(edges(source)).toContainEqual(['Needs review?', 'Review', 'yes']);
    expect(edges(source)).toContainEqual(['Needs review?', 'Publish', 'no']);
    expect(edges(source)).toContainEqual(['Publish', 'End', '']);
  });
  it('creates native decisions and merge nodes for nested branches with different endpoints', () => {
    const source = uml('(*) --> if "Authenticated?" then\n--> "Prepare"\nif "Cached?" then\n--> "Read cache"\nelse\n--> "Calculate"\nendif\nelse\n--> "Reject"\nendif\n--> "Respond"\n--> (*)');
    const block = parse(source);
    expect(block.warnings).toEqual([]);
    expect(block.elements.filter(element => element.kind === 'decision')).toHaveLength(2);
    expect(block.elements.filter(element => element.kind === 'merge')).toHaveLength(2);
    expect(edges(source)).toContainEqual(['Start', 'Authenticated?', '']);
    expect(edges(source)).toContainEqual(['Authenticated?', 'Prepare', 'yes']);
    expect(edges(source)).toContainEqual(['Authenticated?', 'Reject', 'no']);
  });
  it('does not emit outgoing paths after both conditional branches terminate', () => {
    const source = uml('(*) --> if "Ready?" then\n--> "Accept"\n--> (*)\nelse\n--> "Decline"\n--> (*)\nendif\n--> "Unreachable"');
    const block = parse(source);
    expect(block.relations.some(relation => relation.source === 'legacy-end')).toBe(false);
    expect(block.relations.some(relation => relation.target === node(source, 'Unreachable').id)).toBe(false);
  });
  it('uses synchronization bars as shared fork/join nodes', () => {
    const source = uml('(*) --> ===begin===\n--> "Load profile"\n--> ===finish===\n===begin=== --> "Load settings"\n--> ===finish===\n--> (*)');
    const block = parse(source);
    expect(node(source, 'begin').kind).toBe('fork');
    expect(node(source, 'finish').kind).toBe('join');
    expect(block.relations.filter(relation => relation.source === node(source, 'begin').id)).toHaveLength(2);
    expect(block.relations.filter(relation => relation.target === node(source, 'finish').id)).toHaveLength(2);
  });
  it('projects partition membership, multiline labels, notes, and forward aliases', () => {
    const source = uml('partition "Client" #LightBlue {\n(*) --> send\n}\npartition "Service" {\nsend --> "Record\nthe request" as record\nnote right: persist before replying\nrecord --> (*)\n}\n"Send request" as send');
    const block = parse(source);
    expect(block.warnings).toEqual([]);
    const client = node(source, 'Client'), service = node(source, 'Service');
    expect(node(source, 'Send request').parentId).toBe(client.id);
    expect(node(source, 'Record\nthe request').parentId).toBe(service.id);
    expect(node(source, 'persist before replying').meta!.attachTo).toBe('legacy:record');
  });
  it('retains unknown statements with an honest warning', () => {
    const block = parse(uml('(*) --> "A"\nunsupported ??\n--> (*)'));
    expect(block.warnings.length).toBeGreaterThan(0);
  });
});

describe('legacy activity source edits', () => {
  it('renames all shared literal occurrences and leaves aliases, comments, and CRLF intact', () => {
    const source = 'preamble\r\n' + uml('(*) --> "Check" \' keep\n"Check" --> "Store" as store\nstore --> (*)').replaceAll('\n', '\r\n') + 'tail\r\n';
    let updated = edit(source, { type: 'rename', elementId: node(source, 'Check').id, name: 'Validate' });
    expect(updated).toContain('(*) --> "Validate" \' keep\r\n"Validate" -->');
    updated = edit(updated, { type: 'rename', elementId: 'legacy:store', name: 'Persist' });
    expect(updated).toContain('"Persist" as store\r\nstore --> (*)');
    expect(updated.startsWith('preamble\r\n')).toBe(true);
    expect(updated.endsWith('tail\r\n')).toBe(true);
  });
  it('renames implicit identifiers by introducing a stable alias and keeps forward references intact', () => {
    const source = uml('(*) --> A\nA --> B\nB --> (*)');
    const updated = edit(source, { type: 'rename', elementId: 'legacy:A', name: 'Collect data' });
    expect(updated).toContain('(*) --> "Collect data" as A');
    expect(updated).toContain('A --> B');
    expect(node(updated, 'Collect data').id).toBe('legacy:A');
    const forward = uml('(*) --> A\nA --> B\n"Capture" as A\nB --> (*)');
    const changed = edit(forward, { type: 'rename', elementId: 'legacy:A', name: 'Capture input' });
    expect(changed).toContain('(*) --> A');
    expect(changed).toContain('"Capture input" as A');
  });
  it('edits decision text and partition names without replacing their control bodies', () => {
    const source = uml('partition Team {\n(*) --> if "Allowed?" then\n--> "Continue"\nelse\n--> "Reject"\nendif\n--> (*)\n}');
    let updated = edit(source, { type: 'rename', elementId: node(source, 'Allowed?').id, name: 'Authorized?' });
    updated = edit(updated, { type: 'rename', elementId: node(updated, 'Team').id, name: 'Delivery team' });
    expect(updated).toContain('partition "Delivery team" {');
    expect(updated).toContain('if "Authorized?" then\n--> "Continue"');
    expect(parse(updated).warnings).toEqual([]);
  });
  it('keeps distinct actions distinct when a rename matches another action label', () => {
    const source = uml('(*) --> "Receive"\n"Receive" --> "Persist"\n--> (*)');
    const updated = edit(source, { type: 'rename', elementId: node(source, 'Receive').id, name: 'Persist' });
    expect(parse(updated).elements.filter(element => element.name === 'Persist')).toHaveLength(2);
    expect(parse(updated).relations.some(relation => relation.source === relation.target)).toBe(false);
  });
  it('adds an action or a decision immediately before the existing final node', () => {
    const source = uml('(*) --> "Read"\n--> (*)');
    const action = edit(source, { type: 'addElement', kind: 'activity', name: 'Archive' });
    expect(edges(action)).toEqual([['Start', 'Read', ''], ['Read', 'Archive', ''], ['Archive', 'End', '']]);
    const branched = edit(source, { type: 'addElement', kind: 'decision', name: 'Valid?' });
    expect(parse(branched).warnings).toEqual([]);
    expect(edges(branched)).toContainEqual(['Read', 'Valid?', '']);
    expect(node(branched, 'Valid?').kind).toBe('decision');
  });
  it('deletes a simple action and reconnects explicit and implicit outgoing paths', () => {
    for (const body of ['(*) --> "Read" --> "Check" --> "Store" --> (*)', '(*) --> "Read"\n--> "Check" as check\ncheck --> "Store"\n--> (*)']) {
      const source = uml(body), updated = edit(source, { type: 'deleteElement', elementId: node(source, 'Check').id });
      expect(parse(updated).warnings).toEqual([]);
      expect(parse(updated).elements.some(element => element.name === 'Check')).toBe(false);
      expect(edges(updated)).toEqual([['Start', 'Read', ''], ['Read', 'Store', ''], ['Store', 'End', '']]);
    }
  });
  it('deletes a single branch action without redirecting another branch', () => {
    const source = uml('(*) --> if "Retry?" then\n--> "Pause"\n--> "Try again"\nelse\n--> "Cancel"\nendif\n--> (*)');
    const updated = edit(source, { type: 'deleteElement', elementId: node(source, 'Pause').id });
    expect(edges(updated)).toContainEqual(['Retry?', 'Try again', 'yes']);
    expect(edges(updated)).toContainEqual(['Retry?', 'Cancel', 'no']);
    expect(parse(updated).warnings).toEqual([]);
  });
  it('rejects ambiguous converging deletions before changing text', () => {
    const source = uml('(*) --> if "Route?" then\n--> "Shared"\nelse\n--> "Shared"\nendif\n--> (*)');
    expect(() => edit(source, { type: 'deleteElement', elementId: node(source, 'Shared').id })).toThrow(/incoming/);
  });
  it('edits and removes explicit arrow labels without replacing neighboring chain elements', () => {
    const source = uml('(*) --> "Read" -->[valid] "Store" --> (*)');
    const relation = parse(source).relations[1];
    const changed = edit(source, { type: 'editRelation', relationId: relation.id, arrow: '-right->', label: 'accepted' });
    expect(changed).toContain('"Read" -right->[accepted] "Store"');
    expect(edges(changed)).toContainEqual(['Read', 'Store', 'accepted']);
    const disconnected = edit(source, { type: 'deleteRelation', relationId: relation.id });
    expect(parse(disconnected).warnings).toEqual([]);
    expect(edges(disconnected)).not.toContainEqual(['Read', 'Store', 'valid']);
    expect(node(disconnected, 'Store')).toBeDefined();
  });
});
