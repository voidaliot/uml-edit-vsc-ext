import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPORT_MARGIN, LIGHT_PALETTE, MAX_EXPORT_PIXELS, MAX_EXPORT_SIDE, exportFileName, exportFrame, rasterScale } from '../src/webview/export';
import { MAX_EXPORT_CHARS, validExportName, validWebviewMessage } from '../src/host/messages';

describe('exporting a diagram as an image', () => {
  it('frames everything drawn with a margin, on whole pixels', () => {
    const frame = exportFrame([{ x: 10.4, y: -20, width: 100, height: 50 }, { x: 300, y: 40.2, width: 50.3, height: 60 }]);
    expect(frame).toEqual({ x: 10 - EXPORT_MARGIN, y: -20 - EXPORT_MARGIN, width: 351 + EXPORT_MARGIN - (10 - EXPORT_MARGIN), height: 101 + EXPORT_MARGIN - (-20 - EXPORT_MARGIN) });
    expect(exportFrame([{ x: 0, y: 0, width: 10, height: 10 }], 0)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    // A straight horizontal connector has no height but is still drawn.
    expect(exportFrame([{ x: 0, y: 5, width: 40, height: 0 }], 2)).toEqual({ x: -2, y: 3, width: 44, height: 4 });
  });

  it('ignores collapsed or broken boxes and refuses an empty diagram', () => {
    expect(exportFrame([{ x: 0, y: 0, width: 0, height: 0 }, { x: Number.NaN, y: 0, width: 5, height: 5 }, { x: 5, y: 5, width: 5, height: 5 }], 0)).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(() => exportFrame([])).toThrow(/nothing to export/);
  });

  it('draws PNGs at 2×, falls back to 1× for large diagrams and refuses huge ones', () => {
    expect(rasterScale(800, 600)).toBe(2);
    expect(rasterScale(MAX_EXPORT_SIDE / 2, 100)).toBe(2);
    expect(rasterScale(MAX_EXPORT_SIDE / 2 + 1, 100)).toBe(1);
    expect(rasterScale(Math.sqrt(MAX_EXPORT_PIXELS), Math.sqrt(MAX_EXPORT_PIXELS))).toBe(1);
    expect(() => rasterScale(MAX_EXPORT_SIDE + 1, 10)).toThrow(/too large for a PNG \(16385 × 10 px.*Export it as SVG/);
    expect(() => rasterScale(9000, 9000)).toThrow(/too large/);
  });

  it('names the file after the diagram file, and after the diagram when the file has several', () => {
    expect(exportFileName('orders.puml', 'svg')).toBe('orders.svg');
    expect(exportFileName('C:\\work\\model.PlantUML', 'png', { index: 0, title: 'Anything', count: 1 })).toBe('model.png');
    expect(exportFileName('/a/b/all.puml', 'svg', { index: 1, title: 'Order flow: v2', count: 3 })).toBe('all-order-flow-v2.svg');
    expect(exportFileName('all.puml', 'png', { index: 2, title: '', count: 3 })).toBe('all-3.png');
    expect(exportFileName('', 'svg')).toBe('diagram.svg');
    expect(exportFileName('..', 'svg')).toBe('diagram.svg');
    expect(exportFileName('Untitled-1', 'png')).toBe('Untitled-1.png');
    expect(exportFileName(`${'x'.repeat(300)}.puml`, 'svg')).toHaveLength(154);
    for (const name of ['orders.svg', 'all-order-flow-v2.svg', 'diagram.svg', exportFileName('a<b>|c?.puml', 'svg')]) expect(validExportName(name, 'svg')).toBe(true);
  });

  it('accepts only well-formed export messages from the webview', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    expect(validWebviewMessage({ type: 'export', format: 'svg', name: 'orders.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"/>' })).toBe(true);
    expect(validWebviewMessage({ type: 'export', format: 'png', name: 'orders.png', data: png })).toBe(true);
    for (const invalid of [
      { type: 'export', format: 'pdf', name: 'orders.pdf', data: png },
      { type: 'export', format: 'png', name: 'orders.svg', data: png },
      { type: 'export', format: 'png', name: '../orders.png', data: png },
      { type: 'export', format: 'png', name: 'sub/orders.png', data: png },
      { type: 'export', format: 'png', name: '.png', data: png },
      { type: 'export', format: 'png', name: 'orders.png', data: 'not base64!' },
      { type: 'export', format: 'png', name: 'orders.png', data: '' },
      { type: 'export', format: 'png', name: 'orders.png', data: 'abc' },
      { type: 'export', format: 'svg', name: 'orders.svg', data: '<html></html>' },
      { type: 'export', format: 'svg', name: 'orders.svg', data: `<svg>${'x'.repeat(MAX_EXPORT_CHARS)}</svg>` },
      { type: 'export', format: 'svg', name: 'orders.svg' },
    ]) expect(validWebviewMessage(invalid), JSON.stringify(invalid).slice(0, 80)).toBe(false);
  });

  it('keeps a light palette for every theme colour the canvas reads', () => {
    const dir = fileURLToPath(new URL('../src/webview/', import.meta.url));
    const read = readdirSync(dir).filter(file => /\.(?:css|tsx)$/.test(file)).map(file => readFileSync(join(dir, file), 'utf8')).join('\n');
    const colours = new Set([...read.matchAll(/--vscode-[\w-]+/g)].map(match => match[0]).filter(name => !name.endsWith('font-family')));
    expect(colours.size).toBeGreaterThan(10);
    expect([...colours].filter(name => !Object.hasOwn(LIGHT_PALETTE, name))).toEqual([]);
    for (const value of Object.values(LIGHT_PALETTE)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });
});
