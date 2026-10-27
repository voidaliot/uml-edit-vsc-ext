import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ALIOT_EXTENSION, ALIOT_MAX_SOURCE_BYTES, isAliotFile, readEditorDocument,
  serializeAliotDocument, writeEditorLayout, writeEditorSource,
} from '../src/core/aliot-document';
import { applyDiagramEdit } from '../src/core/edits';
import type { DiagramLayout, Layouts } from '../src/shared/protocol';

const file = 'E:\\Diagrams\\example.aliotuml';
const source = "@startuml\r\n' Customer details remain unchanged\r\nclass \"Grüße 東京 😀\" as Customer\r\nCustomer --> Store : submit\r\n@enduml\r\n";
const layout: DiagramLayout = { positions: { Customer: { x: 120.5, y: -35.25 }, Store: { x: 320, y: 200 } }, viewport: { x: -50, y: 90, zoom: 1.25 } };
const envelope = (extra: Record<string, unknown> = {}) => ({ format: 'aliot-uml', version: 1, source, layouts: { 'diagram-1': layout }, ...extra });
const encode = (extra: Record<string, unknown> = {}) => JSON.stringify(envelope(extra), null, 2) + '\n';

describe('portable Aliot UML documents', () => {
  it('uses an explicit extension, including Windows paths and uppercase filenames', () => {
    expect(ALIOT_EXTENSION).toBe('.aliotuml');
    for (const name of [file, 'diagram.ALIOTUML', 'untitled:New.aliotuml']) expect(isAliotFile(name)).toBe(true);
    for (const name of ['diagram.puml', 'diagram.aliotuml.bak', 'aliotuml', 'diagram.json']) expect(isAliotFile(name)).toBe(false);
  });

  it('serializes exact PlantUML source, node placement, and viewport in strict JSON', () => {
    const text = serializeAliotDocument(source, { 'diagram-1': layout });
    expect(JSON.parse(text)).toEqual(envelope());
    const decoded = readEditorDocument(text, file);
    expect(decoded.format).toBe('aliot');
    expect(decoded.source).toBe(source);
    expect(decoded.layouts).toEqual({ 'diagram-1': layout });
    expect(readEditorDocument(serializeAliotDocument(decoded.source, decoded.layouts), file)).toEqual(decoded);
  });

  it('keeps ordinary PlantUML readable and editable without guessing JSON from its contents', () => {
    expect(readEditorDocument(source, 'diagram.puml')).toEqual({ format: 'plantuml', source, layouts: {} });
    expect(readEditorDocument('{ malformed JSON', 'diagram.puml').source).toBe('{ malformed JSON');
    expect(writeEditorSource(source, 'diagram.puml', 'changed\r\n')).toBe('changed\r\n');
    expect(() => writeEditorLayout(source, 'diagram.puml', 'diagram-1', layout)).toThrow(/Save as Aliot/);
    expect(readEditorDocument(serializeAliotDocument('', {}), file).source).toBe('');
  });

  it('preserves unrelated envelope bytes, CRLF, escapes, and unknown metadata when source changes', () => {
    const original = '{\r\n\t"format" : "aliot-uml",\r\n\t"version": 1,\r\n\t"source" : ' + JSON.stringify(source) + ',\r\n\t"layouts" : {"diagram-1": {"positions": {"Customer": {"x":1,"y":2,"locked":true}},"metadata":{"color":"#ff0"}}},\r\n\t"metadata" : {"owner":"\\u0041", "nested": [1, {"preserve":true}]},\r\n\t"custom.future" : "keep exactly"\r\n}\r\n';
    const next = source.replace('Grüße 東京 😀', 'Updated 名前 🌱');
    expect(writeEditorSource(original, file, next)).toBe(original.replace(JSON.stringify(source), JSON.stringify(next)));
    expect(writeEditorSource(original, file, source)).toBe(original);
  });

  it('preserves the encoded PlantUML token exactly while layout coordinates change', () => {
    const original = encode().replace('Grüße', 'Gr\\u00fcße');
    const changed = writeEditorLayout(original, file, 'diagram-1', { ...layout, positions: { ...layout.positions, Customer: { x: 999, y: -35.25 } } });
    expect(changed).toBe(original.replace('120.5', '999'));
    expect(readEditorDocument(changed, file).source).toBe(source);
    expect(readEditorDocument(changed, file).layouts['diagram-1'].positions.Customer.x).toBe(999);
    expect(writeEditorLayout(original, file, 'diagram-1', layout)).toBe(original);
  });

  it('retains unknown layout, point, and viewport metadata during geometry updates', () => {
    const original = encode({ layouts: { 'diagram-1': { ...layout, positions: { Customer: { x: 120.5, y: -35.25, snap: 'grid', metadata: { author: 'Alice' } }, Store: layout.positions.Store }, viewport: { ...layout.viewport, animation: { mode: 'smooth' } }, metadata: { grid: 12 } } }, rootFuture: { value: 'keep' } });
    const updated = writeEditorLayout(original, file, 'diagram-1', { positions: { Customer: { x: 130, y: 45 }, Store: layout.positions.Store }, viewport: { x: 20, y: 30, zoom: 2 } });
    const parsed = JSON.parse(updated);
    expect(parsed.layouts['diagram-1']).toMatchObject({ positions: { Customer: { x: 130, y: 45, snap: 'grid', metadata: { author: 'Alice' } } }, viewport: { x: 20, y: 30, zoom: 2, animation: { mode: 'smooth' } }, metadata: { grid: 12 } });
    expect(parsed.rootFuture).toEqual({ value: 'keep' });
    expect(parsed.source).toBe(source);
  });

  it('adds, updates, and resets layouts while retaining unrelated diagrams and metadata', () => {
    let text = encode({ layouts: { 'diagram-1': { ...layout, metadata: { keep: true } }, 'diagram-2': { positions: { Other: { x: 3, y: 4 } } } } });
    text = writeEditorLayout(text, file, 'diagram-3', { positions: { New: { x: 70, y: 80 } } });
    expect(readEditorDocument(text, file).layouts['diagram-3'].positions.New).toEqual({ x: 70, y: 80 });
    text = writeEditorLayout(text, file, 'diagram-1', { positions: {} });
    expect(JSON.parse(text).layouts['diagram-1']).toEqual({ positions: {}, metadata: { keep: true } });
    expect(readEditorDocument(text, file).layouts['diagram-2']).toEqual({ positions: { Other: { x: 3, y: 4 } } });
  });

  it('performs diagram edits without regenerating or dropping the embedded source', () => {
    const original = encode();
    const document = readEditorDocument(original, file);
    const editedSource = applyDiagramEdit(document.source, 'diagram-1', { type: 'rename', elementId: 'Customer', name: 'Customer account' });
    const changed = writeEditorSource(original, file, editedSource);
    const reopened = readEditorDocument(changed, file);
    expect(reopened.source).toBe(source.replace('Grüße 東京 😀', 'Customer account'));
    expect(reopened.layouts).toEqual(document.layouts);
    expect(reopened.source).toContain("' Customer details remain unchanged\r\n");
    expect(reopened.source).toContain('Customer --> Store : submit');
  });

  it('supports prototype-like element aliases as safe own entries when saving and reopening', () => {
    const aliases = JSON.parse('{"__proto__":{"x":1,"y":2},"constructor":{"x":3,"y":4},"prototype":{"x":5,"y":6},"toString":{"x":7,"y":8}}');
    const text = serializeAliotDocument(source, { 'diagram-1': { positions: aliases } });
    const document = readEditorDocument(text, file);
    expect(Object.getPrototypeOf(document.layouts)).toBeNull();
    expect(Object.getPrototypeOf(document.layouts['diagram-1'].positions)).toBeNull();
    expect(Object.keys(document.layouts['diagram-1'].positions)).toEqual(['__proto__', 'constructor', 'prototype', 'toString']);
    const changed = writeEditorLayout(text, file, 'diagram-1', { positions: { ...aliases, ['__proto__']: { x: 90, y: 91 } } });
    expect(readEditorDocument(changed, file).layouts['diagram-1'].positions['__proto__']).toEqual({ x: 90, y: 91 });
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('adds prototype-like aliases to an empty position map without changing its prototype', () => {
    const text = serializeAliotDocument(source, { 'diagram-1': { positions: {} } });
    const positions = Object.fromEntries([['__proto__', { x: 10, y: 20 }], ['constructor', { x: 30, y: 40 }]]);
    const changed = writeEditorLayout(text, file, 'diagram-1', { positions });
    expect(Object.keys(readEditorDocument(changed, file).layouts['diagram-1'].positions)).toEqual(['__proto__', 'constructor']);
    expect(JSON.parse(changed).layouts['diagram-1'].positions.__proto__).toEqual({ x: 10, y: 20 });
  });
});

describe('Aliot format validation before any write', () => {
  it('rejects invalid JSON, comments, trailing commas, and duplicate keys anywhere', () => {
    const valid = encode();
    for (const invalid of ['', '{', 'null', '[]', valid.replace('"format"', '// comment\n"format"'), valid.replace(/}\n$/, ',}\n'), valid.replace('"version": 1,', '"version": 1,"version": 1,'), valid.replace('"x": 120.5,', '"x": 120.5,"x": 9,'), valid.replace('"source":', '"metadata":{"a":1,"a":2},"source":')]) {
      expect(() => readEditorDocument(invalid, file), invalid.slice(0, 100)).toThrow();
      expect(() => writeEditorSource(invalid, file, source), invalid.slice(0, 100)).toThrow();
      expect(() => writeEditorLayout(invalid, file, 'diagram-1', layout), invalid.slice(0, 100)).toThrow();
    }
  });

  it('rejects unknown versions without treating them as new or plain PlantUML documents', () => {
    for (const version of [0, 2, 100, '1', null, true]) {
      const future = encode({ version });
      expect(() => readEditorDocument(future, file)).toThrow(/version/);
      expect(() => writeEditorSource(future, file, '')).toThrow(/file has not been changed/);
      expect(() => writeEditorLayout(future, file, 'diagram-1', layout)).toThrow(/version/);
    }
  });

  it('requires the complete schema and correct format marker', () => {
    for (const field of ['format', 'version', 'source', 'layouts']) {
      const document: Record<string, unknown> = envelope(); delete document[field];
      expect(() => readEditorDocument(JSON.stringify(document), file)).toThrow();
    }
    for (const extra of [{ format: 'plantuml' }, { source: [] }, { source: null }, { layouts: [] }, { layouts: null }, { layouts: { a: {} } }]) expect(() => readEditorDocument(encode(extra), file)).toThrow();
  });

  it('rejects reserved diagram keys but retains other ordinary keys safely', () => {
    for (const key of ['__proto__', 'constructor', 'prototype', '', 'x'.repeat(1001)]) {
      const layouts = Object.fromEntries([[key, layout]]);
      expect(() => serializeAliotDocument(source, layouts)).toThrow(/identity/);
      expect(() => readEditorDocument(encode({ layouts }), file)).toThrow(/identity/);
      expect(() => writeEditorLayout(encode(), file, key, layout)).toThrow(/identity/);
    }
    const accepted = serializeAliotDocument(source, { toString: layout, 'diagram-2': layout } as unknown as Layouts);
    expect(readEditorDocument(accepted, file).layouts.toString).toEqual(layout);
  });

  it('rejects missing, inherited, nonfinite, out-of-bounds, and nonnumeric coordinates', () => {
    for (const point of [null, [], { x: 1 }, { x: '1', y: 0 }, { x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 1e7 + 1, y: 0 }, Object.create({ x: 1, y: 2 })]) {
      expect(() => writeEditorLayout(encode(), file, 'diagram-1', { positions: { A: point } } as DiagramLayout)).toThrow(/coordinates/);
    }
    expect(() => readEditorDocument(encode().replace('120.5', '1e400'), file)).toThrow(/finite/);
  });

  it('rejects invalid viewport values and accepts explicit undefined in runtime optional fields', () => {
    for (const viewport of [null, {}, { x: 1, y: 2 }, { x: 1, y: 2, zoom: 0 }, { x: 1, y: 2, zoom: 11 }, { x: 1, y: Infinity, zoom: 1 }, { x: 1, y: 2, zoom: NaN }]) {
      expect(() => writeEditorLayout(encode(), file, 'diagram-1', { positions: {}, viewport } as DiagramLayout)).toThrow(/viewport/);
    }
    expect(() => writeEditorLayout(encode(), file, 'diagram-1', { positions: {}, viewport: undefined })).not.toThrow();
  });

  it('enforces the source limit in UTF-8 bytes, preserving valid Unicode at the boundary', () => {
    const ascii = 'a'.repeat(ALIOT_MAX_SOURCE_BYTES), unicode = 'é'.repeat(ALIOT_MAX_SOURCE_BYTES / 2);
    expect(readEditorDocument(serializeAliotDocument(ascii, {}), file).source.length).toBe(ALIOT_MAX_SOURCE_BYTES);
    expect(readEditorDocument(serializeAliotDocument(unicode, {}), file).source).toBe(unicode);
    for (const oversized of [ascii + 'a', unicode + 'é']) {
      expect(() => serializeAliotDocument(oversized, {})).toThrow(/2 MiB/);
      expect(() => writeEditorSource(encode(), file, oversized)).toThrow(/2 MiB/);
      expect(() => readEditorDocument(oversized, 'large.puml')).toThrow(/2 MiB/);
    }
  });

  it('rejects excessively nested metadata before recursive editing can overflow', () => {
    const nested = encode().replace('"version": 1,', '"version": 1,"nested":' + '['.repeat(130) + '0' + ']'.repeat(130) + ',');
    expect(() => readEditorDocument(nested, file)).toThrow(/nesting/);
  });

  it('publishes a schema with the same format, version, required data, and geometry limits', () => {
    const schema = JSON.parse(readFileSync(new URL('../schemas/aliot-uml.schema.json', import.meta.url), 'utf8'));
    expect(schema.properties.format.const).toBe('aliot-uml');
    expect(schema.properties.version.const).toBe(1);
    expect(schema.required).toEqual(['format', 'version', 'source', 'layouts']);
    expect(schema.$defs.coordinate).toMatchObject({ minimum: -1e7, maximum: 1e7 });
    expect(schema.additionalProperties).toBe(true);
    expect(schema.$defs.point.additionalProperties).toBe(true);
  });
});
