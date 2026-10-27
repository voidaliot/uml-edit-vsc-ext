import { describe, expect, it } from 'vitest';
import { isPlantUmlFile, layoutFileName, parseLayoutFile, positionsOf, serializeLayoutFile, validateSource } from '../src/core/layout-file';

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

  it('limits source size', () => {
    expect(() => validateSource('x'.repeat(2 * 1024 * 1024))).not.toThrow();
    expect(() => validateSource('x'.repeat(2 * 1024 * 1024 + 1))).toThrow('2 MiB');
    expect(() => validateSource('é'.repeat(1024 * 1024 + 1))).toThrow('2 MiB');
  });
});
