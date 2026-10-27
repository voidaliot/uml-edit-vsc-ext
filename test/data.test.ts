import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse as parseYaml } from 'yaml';
import type { DiagramBlock, DiagramEdit, DiagramKind } from '../src/shared/protocol';
import { dataFamily, asciiMathToTex, parseRailroad, railroadSize } from '../src/core/families/data';
import { DataContent } from '../src/webview/DataContent';

const wrap = (kind: string, body: string) => `@start${kind}\n${body}\n@end${kind}\n`;
function project(kind: DiagramKind, source: string): DiagramBlock {
  const lines = source.split(/\r?\n/), startLine = lines.findIndex(line => /^\s*@start/.test(line));
  const endLine = lines.findIndex((line, index) => index > startLine && /^\s*@end/.test(line));
  const block: DiagramBlock = { id: 'diagram-1', kind, source: lines.slice(startLine, endLine + 1).join(source.includes('\r\n') ? '\r\n' : '\n'), startLine, endLine, title: `${kind} diagram`, elements: [], relations: [], warnings: [], graphical: true };
  dataFamily.parse(block, lines); return block;
}
function edit(kind: DiagramKind, source: string, value: DiagramEdit): string {
  const output = dataFamily.edit(source, project(kind, source), value); expect(output).toBeTypeOf('string'); return output!;
}
const pathItem = (block: DiagramBlock, path: (string | number)[]) => block.elements.find(item => JSON.stringify(item.meta?.path) === JSON.stringify(path))!;
const body = (source: string) => source.split(/\r?\n/).slice(1, -2).join('\n');

describe('native data family templates', () => {
  it.each(dataFamily.templates.map(template => [template.kind, template.source] as const))('projects %s to editable geometry without images', (kind, source) => {
    const block = project(kind, source);
    expect(block.graphical, block.warnings.join('\n')).toBe(true);
    expect(block.elements.length).toBeGreaterThan(0);
    const positions = dataFamily.layout!(block)!;
    expect(Object.keys(positions)).toHaveLength(block.elements.length);
    for (const point of Object.values(positions)) expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    const html = block.elements.map(element => renderToStaticMarkup(createElement(DataContent, { element }))).join('');
    expect(html).not.toContain('<img');
    if (['regex', 'ebnf', 'chart'].includes(kind)) expect(html).toContain('<svg');
    if (['math', 'latex'].includes(kind)) expect(html).toContain('<math');
    if (kind === 'salt') expect(html).toContain('<input');
  });
  it('keeps every offered insertion operation native', () => {
    for (const template of dataFamily.templates) for (const kind of template.palette) {
      const added = edit(template.kind, template.source, { type: 'addElement', kind, name: 'NewItem' });
      const block = project(template.kind, added);
      expect(block.graphical, `${template.kind}/${kind}: ${block.warnings.join('\n')}`).toBe(true);
    }
  });
});

describe('JSON source-backed native tree', () => {
  it('builds nested object/array relationships and typed values', () => {
    const block = project('json', wrap('json', '{"order":{"items":["pen",2,true,null]}}'));
    expect(block.graphical).toBe(true);
    expect(pathItem(block, ['order', 'items', 2]).meta?.value).toBe(true);
    expect(block.relations).toHaveLength(block.elements.length - 1);
  });
  it('renames keys without changing values, comments, surrounding text, or CRLF', () => {
    const source = 'before\r\n@startjson\r\n{\r\n  "old": "old", // keep old\r\n  "keep": 1\r\n}\r\n@endjson\r\nafter';
    const block = project('json', source);
    const renamed = edit('json', source, { type: 'rename', elementId: pathItem(block, ['old']).id, name: 'new' });
    expect(renamed).toBe(source.replace('"old":', '"new":'));
  });
  it('adds, changes, and removes properties with narrow patches', () => {
    let source = wrap('json', '{\n  "keep": 1,\n  "parent": {}\n}');
    source = edit('json', source, { type: 'addElement', kind: 'data-array', name: 'items', parentId: pathItem(project('json', source), ['parent']).id });
    source = edit('json', source, { type: 'addElement', kind: 'data-value', name: 'pen', parentId: pathItem(project('json', source), ['parent', 'items']).id });
    expect(JSON.parse(body(source))).toEqual({ keep: 1, parent: { items: ['pen'] } });
    source = edit('json', source, { type: 'members', elementId: pathItem(project('json', source), ['keep']).id, members: ['42'] });
    expect(JSON.parse(body(source)).keep).toBe(42);
    source = edit('json', source, { type: 'deleteElement', elementId: pathItem(project('json', source), ['parent', 'items', 0]).id });
    expect(JSON.parse(body(source)).parent.items).toEqual([]);
  });
  it('rejects duplicate keys, invalid values, and duplicate renames', () => {
    expect(project('json', wrap('json', '{"x":1,"x":2}')).graphical).toBe(false);
    const source = wrap('json', '{"a":1,"b":2}'), elementId = pathItem(project('json', source), ['a']).id;
    expect(() => edit('json', source, { type: 'rename', elementId, name: 'b' })).toThrow(/already/);
    expect(() => edit('json', source, { type: 'members', elementId, members: ['not JSON'] })).toThrow(/valid JSON/);
  });
});

describe('YAML source-backed native tree', () => {
  it('builds maps, sequences, block scalars, and alias references', () => {
    const source = wrap('yaml', 'default: &base\n  count: 2\ncopy: *base\ntext: |\n  first\n  second\nitems:\n  - one\n  - two');
    const block = project('yaml', source);
    expect(block.graphical, block.warnings.join('\n')).toBe(true);
    expect(pathItem(block, ['copy']).kind).toBe('data-reference');
    expect(block.relations.some(edge => edge.label === 'alias')).toBe(true);
    expect(pathItem(block, ['text']).meta?.value).toBe('first\nsecond\n');
    expect(project('yaml', wrap('yaml', 'item: *missing')).graphical).toBe(false);
  });
  it('renames one key and one scalar while preserving comments', () => {
    const source = wrap('yaml', '# retain\nname: Old # comment\ncount: 2\n');
    let changed = edit('yaml', source, { type: 'rename', elementId: pathItem(project('yaml', source), ['name']).id, name: 'label' });
    expect(changed).toBe(source.replace('name:', 'label:'));
    changed = edit('yaml', changed, { type: 'members', elementId: pathItem(project('yaml', changed), ['label']).id, members: ['New'] });
    expect(changed).toContain('label: New # comment');
    expect(changed).toContain('# retain');
  });
  it('inserts into root and nested block mappings without moving sibling keys', () => {
    let source = wrap('yaml', 'parent:\n  keep: 1\nafter: 9');
    source = edit('yaml', source, { type: 'addElement', kind: 'data-value', name: 'added', parentId: pathItem(project('yaml', source), ['parent']).id });
    expect(parseYaml(body(source))).toEqual({ parent: { keep: 1, added: null }, after: 9 });
    source = edit('yaml', source, { type: 'addElement', kind: 'data-object', name: 'extra' });
    expect(parseYaml(body(source))).toEqual({ parent: { keep: 1, added: null }, after: 9, extra: {} });
  });
  it('inserts and removes flow mapping members and sequence items', () => {
    let source = wrap('yaml', 'object: { first: 1, second: 2 }\narray: [a, b, c]');
    source = edit('yaml', source, { type: 'addElement', kind: 'data-value', name: 'third', parentId: pathItem(project('yaml', source), ['object']).id });
    source = edit('yaml', source, { type: 'deleteElement', elementId: pathItem(project('yaml', source), ['object', 'second']).id });
    source = edit('yaml', source, { type: 'deleteElement', elementId: pathItem(project('yaml', source), ['array', 1]).id });
    expect(parseYaml(body(source))).toEqual({ object: { first: 1, third: null }, array: ['a', 'c'] });
  });
  it('removes nested block members and keeps the remaining document intact', () => {
    const source = wrap('yaml', 'parent:\n  first: 1\n  second: 2\nkeep: true');
    const changed = edit('yaml', source, { type: 'deleteElement', elementId: pathItem(project('yaml', source), ['parent', 'first']).id });
    expect(changed).toBe(wrap('yaml', 'parent:\n  second: 2\nkeep: true'));
  });
});

describe('Salt controls', () => {
  it('creates real control kinds, grid positions, and panel boundaries', () => {
    const block = project('salt', wrap('salt', '{+\nName | "Ada  "\n[X] Enabled | () Standard\n[Save] | ^System^\n}'));
    expect(block.graphical).toBe(true);
    expect(block.elements.map(item => item.kind)).toEqual(['salt-panel', 'salt-label', 'salt-input', 'salt-checkbox', 'salt-radio', 'salt-button', 'salt-select']);
    expect(block.elements[2].meta?.x).toBeGreaterThan(Number(block.elements[1].meta?.x));
    expect(block.elements[3].meta?.checked).toBe(true);
  });
  it('renames, toggles, and deletes one control without rewriting neighboring cells', () => {
    let source = wrap('salt', '{\n[Save] | [Cancel]\n[] Enabled\n}');
    source = edit('salt', source, { type: 'rename', elementId: project('salt', source).elements.find(item => item.name === 'Save')!.id, name: 'Apply' });
    expect(source).toContain('[Apply] | [Cancel]');
    source = edit('salt', source, { type: 'members', elementId: project('salt', source).elements.find(item => item.kind === 'salt-checkbox')!.id, members: ['checked'] });
    expect(source).toContain('[X] Enabled');
    source = edit('salt', source, { type: 'deleteElement', elementId: project('salt', source).elements.find(item => item.name === 'Cancel')!.id });
    expect(source).toContain('[Apply] ');
    expect(source).not.toContain('Cancel');
  });
});

describe('native railroads and formulas', () => {
  it('models alternation, groups, optional paths, and bounded repetition', () => {
    expect(parseRailroad('"begin", [ item ], { ",", item }').type).toBe('seq');
    const regex = parseRailroad('(cat|dog)[0-9]{2,4}?', true);
    expect(regex.type).toBe('seq');
    expect(JSON.stringify(regex)).toContain('"max":4');
    expect(railroadSize(regex).width).toBeGreaterThan(150);
    expect(() => parseRailroad('[abc', true)).toThrow(/Close/);
  });
  it('renames EBNF identifiers and references, retaining quoted literals and comments', () => {
    const source = wrap('ebnf', 'entry = token, "token";\n(* token stays *)\ntoken = "x";');
    const block = project('ebnf', source);
    const changed = edit('ebnf', source, { type: 'rename', elementId: block.elements.find(item => item.name === 'token')!.id, name: 'symbol' });
    expect(changed).toContain('entry = symbol, "token";');
    expect(changed).toContain('(* token stays *)');
    expect(changed).toContain('symbol = "x";');
  });
  it('updates one grammar rule expression without touching a neighboring rule', () => {
    const source = wrap('ebnf', 'first = "a";\nsecond = "b";');
    const changed = edit('ebnf', source, { type: 'members', elementId: project('ebnf', source).elements[0].id, members: ['"x" | "y"'] });
    expect(changed).toContain('first = "x" | "y";\nsecond = "b";');
    expect(project('ebnf', changed).graphical).toBe(true);
  });
  it('preserves mathematical grouping and typesets fractions/scripts as MathML', () => {
    expect(asciiMathToTex('2*(a+b)')).toContain('\\left(');
    expect(asciiMathToTex('sum_(i=1)^n x_i')).toContain('\\sum_{i = 1}^{n}');
    const block = project('math', wrap('math', 'sqrt(a^2+b^2)/2'));
    expect(block.graphical, block.warnings.join('\n')).toBe(true);
    expect(block.elements[0].meta?.mathml).toContain('<mfrac>');
    expect(block.elements[0].meta?.mathml).toContain('<msqrt>');
  });
  it('edits a formula in place and does not allow raw HTML through MathML rendering', () => {
    const source = wrap('latex', '\\frac{a}{b}');
    const changed = edit('latex', source, { type: 'members', elementId: project('latex', source).elements[0].id, members: ['x^2 + y^2'] });
    expect(changed).toBe(wrap('latex', 'x^2 + y^2'));
    const block = project('latex', wrap('latex', '\\text{<script>alert</script>}'));
    const html = String(block.elements[0].meta?.mathml);
    expect(html).not.toContain('<script>');
  });
});

describe('chart and files editing', () => {
  it('projects categorical, numeric pair, stacked, and secondary-axis series', () => {
    const block = project('chart', wrap('chart', 'h-axis "Time" 0 --> 10\nv-axis 0 --> 100 grid\nv2-axis 0 --> 1\nline "Measured" [(0,20),(5,60),(10,90)] #blue\nscatter "Ratio" [(0,0.2),(5,0.7)] v2\nstackMode stacked'));
    expect(block.graphical).toBe(true);
    expect(block.elements.find(item => item.kind === 'chart-line')?.meta?.values).toEqual([[0, 20], [5, 60], [10, 90]]);
    expect((block.meta?.chart as { series: { secondary?: boolean }[] }).series[1].secondary).toBe(true);
  });
  it('does not mistake explicit numeric tick labels for categories or lose data after one-line styles', () => {
    const block = project('chart', wrap('chart', '<style> chartDiagram { FontSize 12 } </style>\nh-axis [A,B]\nv-axis 0 --> 100 ticks [0:"Low",100:"High"]\nbar "Value" [15,80]'));
    expect(block.graphical).toBe(true);
    const model = block.meta?.chart as { vertical: { categories?: string[]; ticks: { value: number; label: string }[] }; series: unknown[] };
    expect(model.vertical.categories).toBeUndefined();
    expect(model.vertical.ticks).toEqual([{ value: 0, label: 'Low' }, { value: 100, label: 'High' }]);
    expect(model.series).toHaveLength(1);
    expect(project('chart', wrap('chart', 'bar "Broken" [not-a-number]')).graphical).toBe(false);
  });
  it('renames and edits chart values without losing source color or data-label options', () => {
    let source = wrap('chart', 'h-axis [A,B]\nv-axis 0 --> 50\nbar "Before" [10,20] #4c8eda labels');
    source = edit('chart', source, { type: 'rename', elementId: project('chart', source).elements.find(item => item.kind === 'chart-bar')!.id, name: 'After' });
    source = edit('chart', source, { type: 'members', elementId: project('chart', source).elements.find(item => item.kind === 'chart-bar')!.id, members: ['15', '25'] });
    expect(source).toContain('bar "After" [15, 25] #4c8eda labels');
  });
  it('merges file directories and renames an entire subtree by source path spans', () => {
    const source = wrap('files', '/src/a.ts\n/docs/guide.md\n/src/nested/b.ts');
    const block = project('files', source);
    expect(block.elements.filter(item => item.meta?.path === '/src')).toHaveLength(1);
    const changed = edit('files', source, { type: 'rename', elementId: block.elements.find(item => item.meta?.path === '/src')!.id, name: 'lib' });
    expect(changed).toBe(wrap('files', '/lib/a.ts\n/docs/guide.md\n/lib/nested/b.ts'));
  });
  it('edits file notes and deletes only the chosen file and its note', () => {
    let source = wrap('files', '/src/a.ts\n/src/b.ts');
    source = edit('files', source, { type: 'members', elementId: project('files', source).elements.find(item => item.meta?.path === '/src/a.ts')!.id, members: ['Entry point'] });
    expect(source).toContain('/src/a.ts\n<note>\nEntry point\n</note>');
    source = edit('files', source, { type: 'deleteElement', elementId: project('files', source).elements.find(item => item.meta?.path === '/src/a.ts')!.id });
    expect(source).toBe(wrap('files', '/src/b.ts'));
  });
  it('preserves path-like note text while renaming actual source paths', () => {
    const source = wrap('files', '/src/main.ts\n<note>\n/src/main.ts remains documentation text\n</note>');
    const block = project('files', source);
    const changed = edit('files', source, { type: 'rename', elementId: block.elements.find(item => item.meta?.path === '/src')!.id, name: 'lib' });
    expect(changed).toBe(wrap('files', '/lib/main.ts\n<note>\n/src/main.ts remains documentation text\n</note>'));
  });
});
