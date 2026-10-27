import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { parseLayoutFile, serializeLayoutFile } from '../src/core/layout-file';
// The same file adapter used by the live browser server.
// @ts-expect-error Development server is deliberately native Node ESM.
import { openPreviewDocument } from '../scripts/preview-document.mjs';

const source = '@startuml\r\nclass "Account" as A\r\nclass "Ledger" as B\r\nA --> B\r\n@enduml\r\n';
const positions = { A: { x: -130, y: 240 }, B: { x: 380, y: 110 } };
const viewport = { x: 13, y: 24, zoom: .8 };
const folders: string[] = [], models: { close: () => void }[] = [];
const testRoot = resolve('.cache/preview-tests');
const exists = (path: string) => access(path).then(() => true, () => false);
async function fixture(layout?: string) {
  await mkdir(testRoot, { recursive: true });
  const folder = await mkdtemp(join(testRoot, 'aliot-preview-'));
  folders.push(folder);
  const path = join(folder, 'model.puml');
  await writeFile(path, source);
  if (layout !== undefined) await writeFile(path + '.layout.json', layout);
  const model = await openPreviewDocument(path);
  models.push(model);
  return { model, path, layoutPath: path + '.layout.json' };
}
afterEach(async () => {
  for (const model of models.splice(0)) model.close();
  for (const folder of folders.splice(0)) {
    if (dirname(resolve(folder)) !== testRoot) throw new Error('Fixture escaped its test directory.');
    await rm(folder, { recursive: true, force: true });
  }
});

describe('live PlantUML file with a layout file', () => {
  it('keeps the PlantUML file plain and writes placements to the layout file only', async () => {
    const { model, path, layoutPath } = await fixture();
    expect(await exists(layoutPath)).toBe(false);
    const positioned = await model.receive({ type: 'layout', version: 1, diagramId: 'diagram-1', layout: { positions, viewport } });
    expect(positioned.version).toBe(1);
    expect(await readFile(path, 'utf8')).toBe(source);
    expect(parseLayoutFile(await readFile(layoutPath, 'utf8'))['diagram-1'].positions).toEqual(positions);
    expect(await readFile(layoutPath, 'utf8')).not.toContain('viewport');
    const changed = await model.receive({ type: 'edit', version: 1, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'Customer' } });
    expect(await readFile(path, 'utf8')).toBe(changed.source);
    expect(changed.layouts['diagram-1']).toEqual({ positions, viewport });
    model.close();
    const reopened = await openPreviewDocument(path);
    models.push(reopened);
    expect((await reopened.snapshot()).layouts['diagram-1'].positions).toEqual(positions);
  });

  it('does not create a layout file for navigation alone', async () => {
    const { model, layoutPath } = await fixture();
    const viewed = await model.receive({ type: 'layout', diagramId: 'diagram-1', layout: { positions: {}, viewport } });
    expect(await exists(layoutPath)).toBe(false);
    expect(viewed.layouts['diagram-1'].viewport).toEqual(viewport);
  });

  it('removes the layout file when Re-layout clears every placement', async () => {
    const { model, layoutPath } = await fixture(serializeLayoutFile({ 'diagram-1': { positions } }));
    await model.receive({ type: 'layout', version: 1, diagramId: 'diagram-1', layout: { positions: {} } });
    expect(await exists(layoutPath)).toBe(false);
  });

  it('merges concurrent movements from two views without erasing either placement', async () => {
    const { model, layoutPath } = await fixture();
    await model.receive({ type: 'layout', version: 1, diagramId: 'diagram-1', basePositions: {}, layout: { positions: { A: positions.A } } });
    await model.receive({ type: 'layout', version: 1, diagramId: 'diagram-1', basePositions: {}, layout: { positions: { B: positions.B } } });
    expect(parseLayoutFile(await readFile(layoutPath, 'utf8'))['diagram-1'].positions).toEqual(positions);
    await model.receive({ type: 'layout', version: 1, diagramId: 'diagram-1', basePositions: {}, layout: { positions: {}, viewport } });
    expect((await model.snapshot()).layouts['diagram-1'].positions).toEqual(positions);
  });

  it('undoes and redoes placement and source in one history across both files', async () => {
    const { model, path, layoutPath } = await fixture();
    await model.receive({ type: 'layout', version: 1, diagramId: 'diagram-1', layout: { positions: { A: positions.A } } });
    await model.receive({ type: 'edit', version: 1, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'Customer' } });
    await model.receive({ type: 'layout', version: 2, diagramId: 'diagram-1', layout: { positions } });
    const secondMoveUndone = await model.receive({ type: 'undo' });
    expect(secondMoveUndone.source).toContain('Customer');
    expect(secondMoveUndone.layouts['diagram-1'].positions).toEqual({ A: positions.A });
    const renameUndone = await model.receive({ type: 'undo' });
    expect(renameUndone.source).toBe(source);
    expect(renameUndone.layouts['diagram-1'].positions).toEqual({ A: positions.A });
    const firstMoveUndone = await model.receive({ type: 'undo' });
    expect(firstMoveUndone.layouts).toEqual({});
    expect(await exists(layoutPath)).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(source);
    await model.receive({ type: 'redo' });
    await model.receive({ type: 'redo' });
    const redone = await model.receive({ type: 'redo' });
    expect(redone.source).toContain('Customer');
    expect(parseLayoutFile(await readFile(layoutPath, 'utf8'))['diagram-1'].positions).toEqual(positions);
  });

  it('reads external layout changes and rejects edits based on an older source', async () => {
    const { model, path, layoutPath } = await fixture();
    await writeFile(layoutPath, serializeLayoutFile({ 'diagram-1': { positions } })!);
    const updated = await model.snapshot();
    expect(updated.version).toBe(1);
    expect(updated.layouts['diagram-1'].positions).toEqual(positions);
    await writeFile(path, source.replace('Ledger', 'Journal'));
    await expect(model.receive({ type: 'edit', version: 1, diagramId: 'diagram-1', edit: { type: 'deleteElement', elementId: 'A' } })).rejects.toThrow('file changed');
    expect(await readFile(path, 'utf8')).toBe(source.replace('Ledger', 'Journal'));
  });

  it('leaves an invalid layout file untouched until it is repaired', async () => {
    const { model, layoutPath } = await fixture();
    for (const bad of ['{broken', JSON.stringify({ version: 100, diagrams: {} })]) {
      await writeFile(layoutPath, bad);
      await expect(model.receive({ type: 'layout', diagramId: 'diagram-1', layout: { positions } })).rejects.toThrow();
      expect(await readFile(layoutPath, 'utf8')).toBe(bad);
    }
    await writeFile(layoutPath, serializeLayoutFile({ 'diagram-1': { positions } })!);
    expect((await model.snapshot()).layouts['diagram-1'].positions).toEqual(positions);
  });

  it('appends new diagrams inside the source without discarding placements', async () => {
    const { model, layoutPath } = await fixture(serializeLayoutFile({ 'diagram-1': { positions } }));
    const created = await model.receive({ type: 'create', kind: 'activity' });
    expect(created.source).toContain(source.trimEnd());
    expect(created.source.match(/@startuml/g)).toHaveLength(2);
    expect(parseLayoutFile(await readFile(layoutPath, 'utf8'))['diagram-1'].positions).toEqual(positions);
  });
});
