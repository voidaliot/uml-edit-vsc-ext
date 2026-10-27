import { describe, expect, it } from 'vitest';
import { minimalTextChange, requireDocumentVersion, validWebviewMessage } from '../src/host/messages';

describe('host message boundary', () => {
  it('accepts valid edits and rejects malformed or oversized requests', () => {
    expect(validWebviewMessage({ type: 'edit', version: 3, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'user', name: 'Customer' } })).toBe(true);
    expect(validWebviewMessage({ type: 'edit', version: 3, diagramId: 'diagram-1', edit: { type: 'members', elementId: 'user', members: [42] } })).toBe(false);
    expect(validWebviewMessage({ type: 'edit', version: -1, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'user', name: 'Customer' } })).toBe(false);
    expect(validWebviewMessage({ type: 'edit', version: 3, diagramId: 'diagram-1', edit: { type: 'replaceSource', source: 'x'.repeat(2 * 1024 * 1024 + 1) } })).toBe(false);
    expect(validWebviewMessage(null)).toBe(false);
    expect(validWebviewMessage({ type: 'execute', command: 'arbitrary' })).toBe(false);
  });

  it('rejects invalid geometry and reserved diagram keys', () => {
    expect(validWebviewMessage({ type: 'layout', diagramId: 'diagram-1', layout: { positions: { A: { x: 100, y: 200 } }, viewport: { x: 0, y: 0, zoom: 1 } } })).toBe(true);
    expect(validWebviewMessage({ type: 'layout', diagramId: 'diagram-1', layout: { positions: { A: { x: Infinity, y: 0 } } } })).toBe(false);
    expect(validWebviewMessage({ type: 'layout', diagramId: '__proto__', layout: { positions: {} } })).toBe(false);
    expect(validWebviewMessage({ type: 'layout', diagramId: 'constructor', layout: { positions: {} } })).toBe(false);
    expect(validWebviewMessage({ type: 'layout', diagramId: 'prototype', layout: { positions: {} } })).toBe(false);
  });

  it('accepts prototype-like source aliases as inert own position entries', () => {
    const message = JSON.parse('{"type":"layout","diagramId":"diagram-1","layout":{"positions":{"__proto__":{"x":1,"y":2},"constructor":{"x":3,"y":4},"prototype":{"x":5,"y":6},"toString":{"x":7,"y":8}}}}');
    expect(validWebviewMessage(message)).toBe(true);
    const positions = message.layout.positions;
    expect(Object.keys(positions)).toEqual(['__proto__', 'constructor', 'prototype', 'toString']);
    expect(Object.hasOwn(positions, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(positions)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(positions['__proto__'])).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('x');
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });

  it('requires finite own coordinates even for prototype-like aliases', () => {
    const message = (point: unknown) => ({ type: 'layout', diagramId: 'diagram-1', layout: { positions: Object.fromEntries([['__proto__', point]]) } });
    expect(validWebviewMessage(message(null))).toBe(false);
    expect(validWebviewMessage(message('invalid'))).toBe(false);
    expect(validWebviewMessage(message({ x: NaN, y: 0 }))).toBe(false);
    expect(validWebviewMessage(message({ x: 0, y: Infinity }))).toBe(false);
    expect(validWebviewMessage(message(Object.create({ x: 1, y: 2 })))).toBe(false);
  });

  it('rejects stale source edits', () => {
    expect(() => requireDocumentVersion(4, 3)).toThrow('file changed');
    expect(() => requireDocumentVersion(4, 4)).not.toThrow();
  });
  it('rejects retired external renderer requests', () => {
    expect(validWebviewMessage({ type: 'installRenderer' })).toBe(false);
    expect(validWebviewMessage({ type: 'render', diagramId: 'diagram-1', version: 1 })).toBe(false);
    expect(validWebviewMessage({ type: 'exportSvg', diagramId: 'diagram-1', version: 1 })).toBe(false);
  });
});

describe('minimal source changes', () => {
  for (const [before, after] of [
    ['class A\nA --> B\n', 'class "Customer" as A\nA --> B\n'],
    ['@startuml\r\nclass A\r\n@enduml\r\n', '@startuml\r\nclass A\r\nclass B\r\n@enduml\r\n'],
    ['a\r\nb', 'a\nb'],
    ['a\r\nb', 'a\r\nx\r\nb'],
    ['', '@startuml\n@enduml\n'],
    ['abc', ''],
    ['😀A', '😃A'],
  ]) {
    it(`round trips ${JSON.stringify(before)}`, () => {
      const change = minimalTextChange(before!, after!)!;
      expect(before!.slice(0, change.start) + change.text + before!.slice(change.end)).toBe(after);
    });
  }
  it('does not create an undo entry for an unchanged document', () => expect(minimalTextChange('a', 'a')).toBeUndefined());
});

