import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from '../src/core/parser';
import { layoutDiagram } from '../src/core/layout';
import { applyDiagramEdit } from '../src/core/edits';
import { DataContent } from '../src/webview/DataContent';

const source = (kind: 'json' | 'yaml') => kind === 'json'
  ? '@startjson\n{"fruit":"Apple","size":"Large","color":["Red","Green"]}\n@endjson'
  : '@startyaml\nfruit: Apple\nsize: Large\ncolor:\n  - Red\n  - Green\n@endyaml';

describe('PlantUML data table geometry', () => {
  it.each(['json', 'yaml'] as const)('places %s scalar rows inside their object and nested arrays beside it', kind => {
    const block = parseDocument(source(kind)).diagrams[0];
    const positions = layoutDiagram(block);
    const root = block.elements.find(item => item.meta?.root)!;
    const apple = block.elements.find(item => item.name === 'fruit')!;
    const size = block.elements.find(item => item.name === 'size')!;
    const color = block.elements.find(item => item.name === 'color')!;
    const red = block.elements.find(item => item.name === 'Red')!;
    expect(block.elements).toHaveLength(6);
    expect(root.meta?.tableCollection).toBe(true);
    expect(positions[apple.id].x).toBe(positions[root.id].x + 1);
    expect(positions[size.id].y).toBe(positions[apple.id].y + Number(apple.meta?.height));
    expect(positions[color.id].x).toBeGreaterThan(positions[root.id].x + Number(root.meta?.width));
    expect(positions[red.id].x).toBe(positions[color.id].x + 1);
    expect(red.meta?.tableArrayItem).toBe(true);
    expect(block.relations.filter(edge => edge.meta?.tableInternal)).toHaveLength(4);
    const external = block.relations.find(edge => edge.target === color.id)!;
    expect(external.meta?.sourceHandle).toBe(`table-${color.id}`);
    expect(root.meta?.tablePorts).toEqual([{ id: `table-${color.id}`, offset: Number(apple.meta?.height) + Number(size.meta?.height) + 18 }]);
  });

  it('keeps source-backed keys and values editable after embedding them in rows', () => {
    const original = source('json'), block = parseDocument(original).diagrams[0];
    const fruit = block.elements.find(item => item.name === 'fruit')!;
    const renamed = applyDiagramEdit(original, block.id, { type: 'rename', elementId: fruit.id, name: 'food' });
    expect(renamed).toContain('"food":"Apple"');
    const next = parseDocument(renamed).diagrams[0];
    const food = next.elements.find(item => item.name === 'food')!;
    const changed = applyDiagramEdit(renamed, next.id, { type: 'members', elementId: food.id, members: ['"Pear"'] });
    expect(changed).toContain('"food":"Pear"');
    expect(parseDocument(changed).diagrams[0].graphical).toBe(true);
  });

  it('renders a real key/value grid and plain primitive rows without implementation labels', () => {
    const block = parseDocument(source('json')).diagrams[0];
    const html = block.elements.map(element => renderToStaticMarkup(createElement(DataContent, { element }))).join('');
    expect(html).toContain('data-table-grid');
    expect(html).toContain('Object table');
    expect(html).toContain('Array table');
    expect(html).toContain('Nested collection color');
    expect(html).toContain('>Apple</code>');
    expect(html).not.toContain('data-kind-icon');
  });

  it('separates sibling nested collection subtrees and measures multiline rows', () => {
    const block = parseDocument('@startjson\n{"first":{"deep":[1,2,3,4,5]},"second":{"value":"one\\ntwo\\nthree"}}\n@endjson').diagrams[0];
    const points = layoutDiagram(block);
    const tables = block.elements.filter(item => item.meta?.tableCollection);
    const sameColumn = tables.filter(item => (item.meta?.path as unknown[]).length === 1);
    const [first, second] = sameColumn;
    expect(points[second.id].y).toBeGreaterThan(points[first.id].y + Number(first.meta?.height));
    const value = block.elements.find(item => item.name === 'value')!;
    expect(value.meta?.height).toBeGreaterThanOrEqual(66);
    expect(Object.keys(points)).toHaveLength(block.elements.length);
    expect(Object.values(points).every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.y >= 70)).toBe(true);
    const empty = parseDocument('@startjson\n{}\n@endjson').diagrams[0];
    expect(renderToStaticMarkup(createElement(DataContent, { element: empty.elements[0] }))).toContain('{}');
  });
});
