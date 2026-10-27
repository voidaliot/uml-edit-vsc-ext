import { describe, expect, it } from 'vitest';
import { architectureFamily } from '../src/core/families/architecture';
import { parseDocument } from '../src/core/parser';
import { applyDiagramEdit } from '../src/core/edits';
import type { DiagramBlock, DiagramEdit, DiagramKind } from '../src/shared/protocol';

function parse(source: string, kind: DiagramKind): DiagramBlock {
  const lines = source.split(/\r?\n/), startLine = lines.findIndex(s => /^@start/.test(s)), endLine = lines.findIndex(s => /^@end/.test(s));
  const block: DiagramBlock = { id: 'diagram-1', title: kind, kind, source: lines.slice(startLine, endLine + 1).join(source.includes('\r\n') ? '\r\n' : '\n'), elements: [], relations: [], startLine, endLine, graphical: true, warnings: [] };
  architectureFamily.parse(block, lines); return block;
}
function edit(source: string, kind: DiagramKind, operation: DiagramEdit) { return architectureFamily.edit(source, parse(source, kind), operation)!; }

describe('native architecture families', () => {
  for (const template of architectureFamily.templates) {
    it(`projects original ${template.kind} template into geometry with valid relationships`, () => {
      const block = parse(template.source, template.kind); expect(block.elements.length).toBeGreaterThan(0);
      for (const e of block.elements) { expect(e.kind).toMatch(/^(?:c4|archimate|network|chen|dot|ditaa|board|git|chart-jcckit)/); expect(Number(e.meta?.width)).toBeGreaterThan(0); const p = architectureFamily.layout!(block)![e.id]; expect(p).toBeDefined(); expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true); }
      for (const r of block.relations) { expect(block.elements.some(e => e.id === r.source)).toBe(true); expect(block.elements.some(e => e.id === r.target)).toBe(true); }
    });
    it(`round trips in-place ${template.kind} rename, create and delete with surrounding text intact`, () => {
      const source = `' preserved preface\r\n${template.source.replace(/\n/g, '\r\n')}' preserved epilogue\r\n`;
      const first = parse(source, template.kind).elements[0];
      const renamed = edit(source, template.kind, { type: 'rename', elementId: first.id, name: template.kind === 'ditaa' ? 'Edited' : 'Edited label' });
      expect(parse(renamed, template.kind).elements.some(e => e.name === (template.kind === 'ditaa' ? 'Edited' : 'Edited label'))).toBe(true);
      expect(renamed.startsWith("' preserved preface\r\n")).toBe(true); expect(renamed.endsWith("' preserved epilogue\r\n")).toBe(true); expect(renamed.replace(/\r\n/g, '')).not.toContain('\n');
      const added = edit(renamed, template.kind, { type: 'addElement', kind: template.palette[0], name: 'Added item' });
      const parsed = parse(added, template.kind); const created = parsed.elements.find(e => e.name === 'Added item');
      if (template.kind === 'jcckit') expect(parsed.elements[0].members).toContain('curve1.title = Added item'); else { expect(created).toBeDefined(); const deleted = edit(added, template.kind, { type: 'deleteElement', elementId: created!.id }); expect(parse(deleted, template.kind).elements.some(e => e.name === 'Added item')).toBe(false); }
    });
    it(`edits ${template.kind} through the integrated registry without touching adjacent diagrams`, () => {
      const prefix = '@startuml\nclass Before\n@enduml\n\n', suffix = '\n\' untouched separator\n@startuml\nclass After\n@enduml\n'; const source = prefix + template.source + suffix;
      const block = parseDocument(source).diagrams[1]; expect(block.kind).toBe(template.kind); expect(block.graphical).toBe(true);
      const changed = applyDiagramEdit(source, block.id, { type: 'rename', elementId: block.elements[0].id, name: 'Updated' }); expect(changed.startsWith(prefix)).toBe(true); expect(changed.endsWith(suffix)).toBe(true); expect(parseDocument(changed).diagrams[1].elements.some(e => e.name === 'Updated')).toBe(true);
    });
  }
  it('keeps C4 aliases, quoted punctuation and untouched description during rename', () => {
    const source = '@startuml\n!include <C4/C4_Container>\nContainer(api, "API, v1", "TypeScript", "Keeps (details)") \' note\n@enduml';
    const changed = edit(source, 'c4', { type: 'rename', elementId: 'api', name: 'New "API"' });
    expect(changed).toContain('Container(api, "New \\"API\\"", "TypeScript", "Keeps (details)")'.replace(/\\\\/g, '\\')); expect(changed).toContain("' note"); expect(parse(changed, 'c4').elements[0].id).toBe('api');
  });
  it('retains C4 containment geometry and edits relationship labels narrowly', () => {
    const source = architectureFamily.templates.find(t => t.kind === 'c4')!.source; const block = parse(source, 'c4'); expect(block.elements.find(e => e.id === 'catalog')?.parentId).toBe('library');
    const r = block.relations[0]; const updated = edit(source, 'c4', { type: 'editRelation', relationId: r.id, label: 'Looks up', arrow: '-->' }); expect(updated).toContain('Rel(reader, catalog, "Looks up")');
    const connected = edit(updated, 'c4', { type: 'addRelation', source: 'reader', target: 'index', label: 'Queries', arrow: '-->' }); expect(parse(connected, 'c4').relations.length).toBe(3);
  });
  it('projects Chen key, multivalue, derived and weak shapes as separate nodes', () => {
    const source = '@startchen\nentity "Profile" as PROFILE <<weak>> {\nId <<key>>\nTags <<multi>>\nAge <<derived>>\n}\n@endchen'; const block = parse(source, 'chen'); expect(block.elements.length).toBe(4); expect(block.elements[0].meta?.weak).toBe(true); expect(block.elements[1].meta?.key).toBe(true); expect(block.elements[2].meta?.multi).toBe(true); expect(block.elements[3].meta?.derived).toBe(true); expect(block.relations.length).toBe(3);
    const renamed = edit(source, 'chen', { type: 'rename', elementId: 'PROFILE', name: 'Public profile' }); expect(renamed).toContain('"Public profile" as PROFILE <<weak>>');
  });
  it('parses multiple DOT statements on one line and only changes selected label', () => {
    const source = '@startdot\ndigraph G { a [label="First"]; b [label="Other"]; a -> b [label="uses"]; }\n@enddot'; const block = parse(source, 'dot'); expect(block.elements.map(e => e.id)).toEqual(['a', 'b']); expect(block.relations.length).toBe(1);
    const changed = edit(source, 'dot', { type: 'rename', elementId: 'a', name: 'Renamed' }); expect(changed).toBe(source.replace('First', 'Renamed'));
    const deleted = edit(source, 'dot', { type: 'deleteElement', elementId: 'a' }); expect(deleted).toContain('b [label="Other"]'); expect(parse(deleted, 'dot').elements.map(e => e.id)).toEqual(['b']);
  });
  it('adds DOT labels to implicit endpoints without replacing connected edges', () => {
    const source = '@startdot\ndigraph G { a -> b; }\n@enddot'; const changed = edit(source, 'dot', { type: 'rename', elementId: 'a', name: 'New name' }); expect(changed).toContain('a -> b'); expect(parse(changed, 'dot').elements.find(e => e.id === 'a')?.name).toBe('New name');
  });
  it('renames an unlabeled DOT cluster without rewriting child declarations', () => {
    const source = '@startdot\ndigraph G {\nsubgraph cluster_a {\na [label="A"];\n}\n}\n@enddot'; const changed = edit(source,'dot',{type:'rename',elementId:'cluster_a',name:'Group'}); expect(changed).toContain('a [label="A"]'); expect(parse(changed,'dot').elements.find(e=>e.id==='cluster_a')?.name).toBe('Group');
  });
  it('models shared network devices once and associates each network bus', () => {
    const source = architectureFamily.templates.find(t => t.kind === 'network')!.source, block = parse(source, 'network'); expect(block.elements.filter(e => e.id === 'portal')).toHaveLength(1); expect(block.relations.filter(e => e.target === 'portal')).toHaveLength(2);
    const updated = edit(source, 'network', { type: 'rename', elementId: 'portal', name: 'Public portal' }); expect(updated).toContain('portal [address = ".20", description = "Public portal"]'); expect(updated).toContain('    portal;');
  });
  it('keeps ASCII box edges aligned when changing a label and finds its connector', () => {
    const source = architectureFamily.templates.find(t => t.kind === 'ditaa')!.source, block = parse(source, 'ditaa'); expect(block.elements).toHaveLength(2); expect(block.relations).toHaveLength(1);
    const updated = edit(source, 'ditaa', { type: 'rename', elementId: block.elements[0].id, name: 'Review' }); expect(updated.split('\n')[2].length).toBe(source.split('\n')[2].length); expect(parse(updated, 'ditaa').relations).toHaveLength(1);
    expect(() => edit(source, 'ditaa', { type: 'rename', elementId: block.elements[0].id, name: 'This label does not fit inside the box' })).toThrow(/room/);
  });
  it('renames multiline ASCII labels once while keeping shape markers intact', () => {
    const source = '@startditaa\n+-------------+\n| First       |\n| Second {d}  |\n+-------------+\n@endditaa'; const block = parse(source,'ditaa'); expect(block.elements[0].name).toBe('First Second'); const changed = edit(source,'ditaa',{type:'rename',elementId:block.elements[0].id,name:'Whole'}); expect(parse(changed,'ditaa').elements[0].name).toBe('Whole'); expect(changed).toContain('{d}');
  });
  it('edits native chart coordinates without changing chart settings', () => {
    const source = architectureFamily.templates.find(t => t.kind === 'jcckit')!.source, block = parse(source, 'jcckit'); const updated = edit(source, 'jcckit', { type: 'members', elementId: block.elements[0].id, members: block.elements[0].members.map(s => s.startsWith('loans.y') ? 'loans.y = 9 8 7 6 5' : s) }); expect(updated).toContain('data/loans/y = 9 8 7 6 5'); expect(updated).toContain('axisLabel = Books');
  });
  it('preserves parentheses, comments and aliases during C4 detail edits', () => {
    const source = '@startuml\nContainer(api, "Service (v2)", "TypeScript", "Keeps (details)") \' retained\n@enduml'; const updated = edit(source, 'c4', { type: 'members', elementId: 'api', members: ['Rust', 'Owns (records)'] }); expect(updated).toBe('@startuml\nContainer(api, "Service (v2)", "Rust", "Owns (records)") \' retained\n@enduml');
  });
  it('removes external C4 edges to descendants when a boundary is deleted', () => {
    const source = architectureFamily.templates.find(t => t.kind === 'c4')!.source; const updated = edit(source, 'c4', { type: 'deleteElement', elementId: 'library' }); expect(parse(updated, 'c4').elements.map(e => e.id)).toEqual(['reader']); expect(parse(updated, 'c4').relations).toHaveLength(0);
  });
  it('recognizes known architecture libraries but blocks unknown semantic includes and macros', () => {
    expect(parse('@startuml\n!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Context.puml\nPerson(a,"A")\n@enduml','c4').graphical).toBe(true);
    expect(parse('@startuml\n!include custom-definitions.puml\nPerson(a,"A")\n@enduml','c4').graphical).toBe(false);
    expect(parse('@startuml\nMySystem(a,"A")\n@enduml','c4').graphical).toBe(false);
  });
  it('does not project commented C4 or DOT declarations and preserves comment offsets', () => {
    const source = '@startuml\n/\'\nPerson(hidden,"Hidden")\n\'/\nPerson(shown,"Visible")\n@enduml'; expect(parse(source,'c4').elements.map(e => e.id)).toEqual(['shown']); const changed = edit(source,'c4',{type:'rename',elementId:'shown',name:'Updated'}); expect(changed).toBe(source.replace('"Visible"','"Updated"'));
    expect(parse('@startdot\ndigraph G { /* ignored a -> b; */ a [label="One"]; }\n@enddot','dot').elements.map(e => e.id)).toEqual(['a']);
  });
  it('projects branch and merge paths from the Git graph', () => {
    const source = '@startgit\n* aaa Merge\n|\\\n| * bbb Feature\n* | ccc Main\n|/\n* ddd Base\n@endgit'; const block = parse(source,'git'); expect(block.elements).toHaveLength(4); expect(block.relations.map(r => [r.source,r.target])).toEqual(expect.arrayContaining([['aaa','bbb'],['aaa','ccc'],['bbb','ddd'],['ccc','ddd']]));
  });
  it('deletes a commit while preserving adjacent native history links', () => {
    const source = architectureFamily.templates.find(t=>t.kind==='git')!.source, before = parse(source,'git'); const updated = edit(source,'git',{type:'deleteElement',elementId:before.elements[1].id}), after = parse(updated,'git'); expect(after.elements).toHaveLength(2); expect(after.relations.map(r=>[r.source,r.target])).toEqual([[before.elements[0].id,before.elements[2].id]]);
  });
  it('assigns compound Chen attributes and network groups finite native positions', () => {
    for (const [source,kind] of [['@startchen\nentity A {\nName {\nFirst\nLast\n}\n}\n@endchen','chen'], ['@startnwdiag\nnwdiag {\nnetwork lan {\ngroup team {\na;\nb;\n}\n}\n}\n@endnwdiag','network']] as const) { const block = parse(source,kind); for (const e of block.elements) expect(architectureFamily.layout!(block)![e.id]).toMatchObject({x:expect.any(Number),y:expect.any(Number)}); }
  });
});
