import { describe, expect, it } from 'vitest';
import { bendKey, bendKeyParts, isPlantUmlFile, layoutFileName, parseLayoutFile, positionsOf, relationBendKeys, serializeLayoutFile, validateSource } from '../src/core/layout-file';

describe('layout file', () => {
  it('names the companion file after the full PlantUML file name', () => {
    expect(layoutFileName('/work/order.puml')).toBe('/work/order.puml.layout.json');
    for (const name of ['a.puml', 'a.PlantUML', 'a.pu', 'a.iuml']) expect(isPlantUmlFile(name)).toBe(true);
    for (const name of ['a.puml.layout.json', 'a.aliotuml', 'a.txt']) expect(isPlantUmlFile(name)).toBe(false);
  });

  it('writes one element per line and reads the same placements back', () => {
    const layouts = { 'diagram-1': { positions: { Host: { x: 80, y: 80 }, divider: { x: -12.5, y: 189, width: 480, height: 28 } } }, 'diagram-2': { positions: { Done: { x: 1, y: 2 } } } };
    const text = serializeLayoutFile(layouts)!;
    expect(text).toBe([
      '{',
      '  "version": 1,',
      '  "diagrams": {',
      '    "diagram-1": {',
      '      "positions": {',
      '        "Host": { "x": 80, "y": 80 },',
      '        "divider": { "x": -12.5, "y": 189, "width": 480, "height": 28 }',
      '      }',
      '    },',
      '    "diagram-2": {',
      '      "positions": {',
      '        "Done": { "x": 1, "y": 2 }',
      '      }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));
    expect(JSON.parse(JSON.stringify(parseLayoutFile(text)))).toEqual(layouts);
  });

  it('writes nothing when no element is placed manually', () => {
    expect(serializeLayoutFile({})).toBeUndefined();
    expect(serializeLayoutFile({ 'diagram-1': { positions: {} }, 'diagram-2': { positions: {}, viewport: { x: 1, y: 2, zoom: 1 } } })).toBeUndefined();
    expect(serializeLayoutFile({ 'diagram-1': { positions: {} }, 'diagram-2': { positions: { A: { x: 1, y: 2 } } } })).not.toContain('diagram-1');
  });

  it('never stores the viewport, which is personal view state', () => {
    const text = serializeLayoutFile({ 'diagram-1': { positions: { A: { x: 1, y: 2 } }, viewport: { x: 5, y: 6, zoom: 2 } } })!;
    expect(text).not.toContain('viewport');
    expect(positionsOf({ 'diagram-1': { positions: { A: { x: 1, y: 2 } }, viewport: { x: 5, y: 6, zoom: 2 } } })['diagram-1']).toEqual({ positions: { A: { x: 1, y: 2 } } });
    const read = parseLayoutFile(JSON.stringify({ version: 1, diagrams: { 'diagram-1': { positions: { A: { x: 1, y: 2 } }, viewport: { x: 5, y: 6, zoom: 2 } } } }));
    expect(read['diagram-1']).not.toHaveProperty('viewport');
  });

  it('keeps prototype-like PlantUML aliases as inert data', () => {
    const text = serializeLayoutFile({ 'diagram-1': { positions: JSON.parse('{"__proto__":{"x":1,"y":2},"constructor":{"x":3,"y":4}}') } })!;
    const positions = parseLayoutFile(text)['diagram-1'].positions;
    expect(Object.keys(positions)).toEqual(['__proto__', 'constructor']);
    expect(positions['__proto__']).toEqual({ x: 1, y: 2 });
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('ignores unknown fields and rejects invalid files with a readable reason', () => {
    expect(parseLayoutFile(JSON.stringify({ version: 1, note: 'kept out', diagrams: { 'diagram-1': { color: 'blue', positions: { A: { x: 1, y: 2, note: 'x' } } } } }))['diagram-1'].positions.A).toEqual({ x: 1, y: 2 });
    const invalid: [string, string][] = [
      ['{broken', 'not valid JSON'],
      ['[]', 'JSON object'],
      [JSON.stringify({ version: 2, diagrams: {} }), 'version'],
      [JSON.stringify({ version: 1 }), '"diagrams"'],
      [JSON.stringify({ version: 1, diagrams: { prototype: { positions: {} } } }), 'reserved'],
      [JSON.stringify({ version: 1, diagrams: { 'diagram-1': { positions: { A: { x: 'a', y: 1 } } } } }), 'finite x and y'],
      [JSON.stringify({ version: 1, diagrams: { 'diagram-1': { positions: { A: { x: 1, y: 1, width: 0 } } } } }), 'positive'],
      [JSON.stringify({ version: 1, diagrams: { 'diagram-1': { positions: { A: { x: 1e8, y: 1 } } } } }), 'between'],
    ];
    for (const [text, reason] of invalid) expect(() => parseLayoutFile(text), text).toThrow(reason);
    for (const width of [0, -1, Infinity, NaN, 1e8]) expect(() => serializeLayoutFile({ 'diagram-1': { positions: { divider: { x: 60, y: 70, width } } } })).toThrow();
  });

  it('writes relationship bends after the positions, one relationship per line, and reads them back', () => {
    const bends = { [bendKey('Order', 'Line item', 0)]: [{ x: 10, y: 20 }, { x: 10.5, y: -40 }], [bendKey('Order', 'Line item', 1)]: [{ x: 0, y: 0 }] };
    const layouts = { 'diagram-1': { positions: { Order: { x: 1, y: 2 } }, bends }, 'diagram-2': { positions: {}, bends: { [bendKey('a', 'b', 0)]: [{ x: 3, y: 4 }] } } };
    const text = serializeLayoutFile(layouts)!;
    expect(text).toBe([
      '{',
      '  "version": 1,',
      '  "diagrams": {',
      '    "diagram-1": {',
      '      "positions": {',
      '        "Order": { "x": 1, "y": 2 }',
      '      },',
      '      "bends": [',
      '        { "source": "Order", "target": "Line item", "occurrence": 0, "points": [{ "x": 10, "y": 20 }, { "x": 10.5, "y": -40 }] },',
      '        { "source": "Order", "target": "Line item", "occurrence": 1, "points": [{ "x": 0, "y": 0 }] }',
      '      ]',
      '    },',
      '    "diagram-2": {',
      '      "positions": {},',
      '      "bends": [',
      '        { "source": "a", "target": "b", "occurrence": 0, "points": [{ "x": 3, "y": 4 }] }',
      '      ]',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));
    expect(JSON.parse(JSON.stringify(parseLayoutFile(text)))).toEqual(layouts);
    expect(positionsOf({ 'diagram-1': { positions: {}, bends, viewport: { x: 1, y: 1, zoom: 1 } } })['diagram-1']).toEqual({ positions: {}, bends });
    // No bends, no field: older files and files without bends keep their exact form.
    expect(serializeLayoutFile({ 'diagram-1': { positions: { A: { x: 1, y: 2 } }, bends: {} } })).toBe(serializeLayoutFile({ 'diagram-1': { positions: { A: { x: 1, y: 2 } } } }));
    expect(serializeLayoutFile({ 'diagram-1': { positions: {}, bends: {} } })).toBeUndefined();
  });

  it('rejects malformed bends with a readable reason and ignores unknown bend fields', () => {
    const file = (bends: unknown) => JSON.stringify({ version: 1, diagrams: { 'diagram-1': { positions: {}, bends } } });
    expect(parseLayoutFile(file([{ source: 'A', target: 'B', occurrence: 0, points: [{ x: 1, y: 2, note: 'x' }], color: 'red' }]))['diagram-1'].bends).toEqual({ [bendKey('A', 'B', 0)]: [{ x: 1, y: 2 }] });
    const invalid: [unknown, string][] = [
      [{}, 'list'],
      [[{ source: 'A', target: 'B', points: [{ x: 1, y: 2 }] }], 'occurrence'],
      [[{ source: 'A', target: 'B', occurrence: '0', points: [{ x: 1, y: 2 }] }], 'occurrence'],
      [[{ source: '', target: 'B', occurrence: 0, points: [{ x: 1, y: 2 }] }], 'identities'],
      [[{ source: 'A', target: 'B', occurrence: -1, points: [{ x: 1, y: 2 }] }], 'non-negative'],
      [[{ source: 'A', target: 'B', occurrence: 0, points: [] }], '1–200'],
      [[{ source: 'A', target: 'B', occurrence: 0, points: [{ x: 1 }] }], 'finite bend'],
      [[{ source: 'A', target: 'B', occurrence: 0, points: [{ x: 1, y: 1 }] }, { source: 'A', target: 'B', occurrence: 0, points: [{ x: 2, y: 2 }] }], 'repeats'],
    ];
    for (const [bends, reason] of invalid) expect(() => parseLayoutFile(file(bends)), JSON.stringify(bends)).toThrow(reason);
    expect(() => serializeLayoutFile({ 'diagram-1': { positions: {}, bends: { 'A->B': [{ x: 1, y: 2 }] } } })).toThrow('relationship identity');
  });

  it('identifies a relationship by its ends and occurrence, not by its line', () => {
    const relation = (id: string, source: string, target: string, startLine: number) => ({ id, source, target, label: '', arrow: '-->', startLine, endLine: startLine });
    const before = relationBendKeys([relation('relation-3-0', 'A', 'B', 3), relation('relation-4-1', 'A', 'B', 4), relation('relation-5-2', 'B', 'A', 5)]);
    expect([...before.values()]).toEqual([bendKey('A', 'B', 0), bendKey('A', 'B', 1), bendKey('B', 'A', 0)]);
    // A relationship inserted above, between other elements, changes every line number but no key.
    const after = relationBendKeys([relation('relation-3-0', 'C', 'D', 3), relation('relation-4-1', 'A', 'B', 4), relation('relation-5-2', 'A', 'B', 5), relation('relation-6-3', 'B', 'A', 6)]);
    expect([after.get('relation-4-1'), after.get('relation-5-2'), after.get('relation-6-3')]).toEqual([...before.values()]);
    expect(bendKeyParts(bendKey('a"b', 'c\nd', 2))).toEqual({ source: 'a"b', target: 'c\nd', occurrence: 2 });
    expect(bendKeyParts('["A","B"]')).toBeUndefined();
  });

  it('limits source size', () => {
    expect(() => validateSource('x'.repeat(2 * 1024 * 1024))).not.toThrow();
    expect(() => validateSource('x'.repeat(2 * 1024 * 1024 + 1))).toThrow('2 MiB');
    expect(() => validateSource('é'.repeat(1024 * 1024 + 1))).toThrow('2 MiB');
  });
});
