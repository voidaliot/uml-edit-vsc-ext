import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { serializeAliotDocument } from '../src/core/aliot-document';
// The same file adapter used by the live browser server.
// @ts-expect-error Development server is deliberately native Node ESM.
import { openPreviewDocument } from '../scripts/preview-document.mjs';

const source = '@startuml\r\nclass "Account" as A\r\nclass "Ledger" as B\r\nA --> B\r\n@enduml\r\n';
const layout = { positions: { A: { x: -130, y: 240 }, B: { x: 380, y: 110 } }, viewport: { x: 13, y: 24, zoom: .8 } };
const folders: string[] = [], models: { close: () => void }[] = [];
const testRoot = resolve('.cache/preview-tests');
async function fixture(extension = '.aliotuml', content = serializeAliotDocument(source, {})) {
  await mkdir(testRoot, { recursive: true });
  const folder = await mkdtemp(join(testRoot, 'aliot-preview-'));
  folders.push(folder);
  const path = join(folder, `model${extension}`);
  await writeFile(path, content);
  const model = await openPreviewDocument(path);
  models.push(model);
  return { model, path };
}
afterEach(async () => {
  for (const model of models.splice(0)) model.close();
  for (const folder of folders.splice(0)) {
    if (dirname(resolve(folder)) !== testRoot) throw new Error('Fixture escaped its test directory.');
    await rm(folder, { recursive: true, force: true });
  }
});

describe('live Aliot documents', () => {
  it('persists positions, source edits and viewport in a copyable file across reopen', async () => {
    const { model, path } = await fixture();
    const initial = await model.snapshot();
    const positioned = await model.receive({ type: 'layout', version: initial.version, diagramId: 'diagram-1', layout });
    expect(positioned.version).toBe(initial.version);
    expect(positioned.revision).toBeGreaterThan(initial.revision);
    expect(positioned.format).toBe('aliot');
    const changed = await model.receive({ type: 'edit', version: initial.version, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'Customer' } });
    expect(changed.source).toContain('"Customer" as A');
    expect(changed.layouts['diagram-1']).toEqual(layout);
    model.close();
    const copy = await fixture('.aliotuml', await readFile(path, 'utf8'));
    expect((await copy.model.snapshot()).layouts['diagram-1']).toEqual(layout);
    expect((await copy.model.snapshot()).source).toBe(changed.source);
  });

  it('does not persist navigation alone or invalidate an inline source draft', async () => {
    const { model, path } = await fixture();
    const before = await readFile(path, 'utf8');
    const viewed = await model.receive({ type: 'layout', diagramId: 'diagram-1', layout: { positions: {}, viewport: layout.viewport } });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(viewed.version).toBe(1);
    const changed = await model.receive({ type: 'edit', version: 1, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'Customer' } });
    expect(changed.layouts['diagram-1'].viewport).toEqual(layout.viewport);
  });

  it('merges concurrent movements from two views without erasing either placement', async () => {
    const { model, path } = await fixture();
    await model.receive({ type: 'layout', version: 1, diagramId: 'diagram-1', basePositions: {}, layout: { positions: { A: layout.positions.A } } });
    await model.receive({ type: 'layout', version: 1, diagramId: 'diagram-1', basePositions: {}, layout: { positions: { B: layout.positions.B } } });
    expect(JSON.parse(await readFile(path, 'utf8')).layouts['diagram-1'].positions).toEqual(layout.positions);
    // Navigation from an older view is not a request to erase new placements.
    await model.receive({ type: 'layout', version: 1, diagramId: 'diagram-1', basePositions: {}, layout: { positions: {}, viewport: layout.viewport } });
    expect((await model.snapshot()).layouts['diagram-1'].positions).toEqual(layout.positions);
  });

  it('undoes and redoes placement and source as separate persisted edits', async () => {
    const { model, path } = await fixture();
    await model.receive({ type: 'layout', version: 1, diagramId: 'diagram-1', layout });
    await model.receive({ type: 'edit', version: 1, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'Customer' } });
    const sourceUndone = await model.receive({ type: 'undo' });
    expect(sourceUndone.source).toBe(source);
    expect(sourceUndone.layouts['diagram-1']).toEqual(layout);
    const placementUndone = await model.receive({ type: 'undo' });
    expect(placementUndone.layouts).toEqual({});
    expect(placementUndone.version).toBe(sourceUndone.version);
    await model.receive({ type: 'redo' });
    const redone = await model.receive({ type: 'redo' });
    expect(redone.source).toContain('Customer');
    expect(JSON.parse(await readFile(path, 'utf8')).layouts['diagram-1']).toEqual(layout);
  });

  it('reads external geometry updates, preserves metadata and rejects stale edits', async () => {
    const { model, path } = await fixture();
    const external = { ...JSON.parse(await readFile(path, 'utf8')), custom: { owner: 'Example' }, layouts: { 'diagram-1': { ...layout, color: 'blue' } } };
    await writeFile(path, JSON.stringify(external));
    const updated = await model.snapshot();
    expect(updated.version).toBe(1);
    expect(updated.layouts['diagram-1'].positions).toEqual(layout.positions);
    await model.receive({ type: 'edit', version: 1, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'Customer' } });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.custom).toEqual(external.custom);
    expect(saved.layouts['diagram-1'].color).toBe('blue');
    await expect(model.receive({ type: 'layout', version: 1, diagramId: 'diagram-1', layout })).rejects.toThrow('file changed');
    await expect(model.receive({ type: 'edit', version: 1, diagramId: 'diagram-1', edit: { type: 'deleteElement', elementId: 'A' } })).rejects.toThrow('file changed');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved);
  });

  it('leaves an invalid or future external file untouched until it is repaired', async () => {
    const { model, path } = await fixture();
    for (const bad of ['{broken', JSON.stringify({ format: 'aliot-uml', version: 100, source, layouts: {} })]) {
      await writeFile(path, bad);
      await expect(model.receive({ type: 'layout', diagramId: 'diagram-1', layout })).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(bad);
    }
    await writeFile(path, serializeAliotDocument(source, {}));
    expect((await model.snapshot()).source).toBe(source);
  });

  it('appends new diagrams inside the source without discarding placements', async () => {
    const { model, path } = await fixture('.aliotuml', serializeAliotDocument(source, { 'diagram-1': layout }));
    const created = await model.receive({ type: 'create', kind: 'activity' });
    expect(created.source).toContain(source.trimEnd());
    expect(created.source.match(/@startuml/g)).toHaveLength(2);
    expect(JSON.parse(await readFile(path, 'utf8')).layouts['diagram-1']).toEqual(layout);
  });

  it('keeps ordinary PlantUML as plain text with transient presentation state', async () => {
    const { model, path } = await fixture('.puml', source);
    await model.receive({ type: 'layout', diagramId: 'diagram-1', layout });
    expect(await readFile(path, 'utf8')).toBe(source);
    const changed = await model.receive({ type: 'edit', version: 1, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'Customer' } });
    expect(changed.format).toBe('plantuml');
    expect(await readFile(path, 'utf8')).toBe(changed.source);
    expect(changed.layouts['diagram-1']).toEqual(layout);
  });
});
