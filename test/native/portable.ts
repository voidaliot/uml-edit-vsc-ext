import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { UmlEditorProvider } from '../../src/extension';
import { readEditorDocument, serializeAliotDocument, writeEditorLayout, writeEditorSource } from '../../src/core/aliot-document';
import type { DiagramLayout, HostMessage } from '../../src/shared/protocol';

const source = '@startuml\nclass "Account" as A\nclass "Ledger" as B\nA --> B : records\n@enduml\n';
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const geometry = (layout: DiagramLayout): DiagramLayout => ({ positions: Object.fromEntries(Object.entries(layout.positions).map(([id, point]) => [id, { x: point.x, y: point.y }])), ...(layout.viewport ? { viewport: { ...layout.viewport } } : {}) });
async function eventually(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail(message); await new Promise(resolve => setTimeout(resolve, 50)); }
}
function context(extensionUri: vscode.Uri): vscode.ExtensionContext {
  const values = new Map<string, unknown>();
  return { extensionUri, workspaceState: { get: (key: string, fallback?: unknown) => values.get(key) ?? fallback, update: async (key: string, value: unknown) => { values.set(key, value); } } } as unknown as vscode.ExtensionContext;
}
function channel() {
  const messages: HostMessage[] = [], disposals: (() => void)[] = [];
  let receive: (message: unknown) => void = () => {};
  const panel = {
    active: true,
    webview: {
      cspSource: 'vscode-webview://portable-test', html: '', options: {}, asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: async (message: HostMessage) => { messages.push(structuredClone(message)); return true; },
      onDidReceiveMessage: (listener: (message: unknown) => void) => { receive = listener; return new vscode.Disposable(() => {}); },
    },
    onDidChangeViewState: () => new vscode.Disposable(() => {}),
    onDidDispose: (listener: () => void) => { disposals.push(listener); return new vscode.Disposable(() => {}); },
  } as unknown as vscode.WebviewPanel;
  return { panel, messages, send: (message: unknown) => receive(message), close: () => disposals.forEach(dispose => dispose()) };
}
function snapshot(messages: HostMessage[]) {
  const message = [...messages].reverse().find(message => message.type === 'document');
  assert.ok(message?.type === 'document', 'The editor must receive a source snapshot.'); return message;
}
export async function verifyPortableDocuments(extensionUri: vscode.Uri, workspace: vscode.Uri): Promise<void> {
  const prefix = `portable-${Date.now()}`;
  const uri = vscode.Uri.joinPath(workspace, prefix + '.aliotuml');
  const stored: DiagramLayout = { positions: { A: { x: 110, y: 90 }, B: { x: 370, y: 90 } }, viewport: { x: 25, y: 35, zoom: 1 } };
  const envelope = JSON.parse(serializeAliotDocument(source, { 'diagram-1': stored }));
  envelope.extensionMetadata = { team: 'Example' };
  envelope.layouts['diagram-1'].positions.A.note = 'Retain point metadata';
  const original = JSON.stringify(envelope, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(original));
  const document = await vscode.workspace.openTextDocument(uri);
  const provider = new UmlEditorProvider(context(extensionUri)), first = channel(), second = channel();
  try {
    await provider.resolveCustomTextEditor(document, first.panel);
    await provider.resolveCustomTextEditor(document, second.panel);
    first.send({ type: 'ready' }); second.send({ type: 'ready' });
    const initial = snapshot(first.messages);
    assert.equal(initial.source, source); assert.equal(initial.format, 'aliot');
    assert.deepEqual(geometry(initial.layouts['diagram-1']), stored);
    assert.equal(document.languageId, 'json');
    await provider.openAliotDocument(uri);
    first.send({ type: 'layout', version: initial.version, diagramId: 'diagram-1', layout: { ...stored, viewport: { x: 60, y: 70, zoom: 0.9 } } });
    await eventually(() => snapshot(second.messages).layouts['diagram-1'].viewport?.x === 60, 'Viewport-only changes should reach split views.');
    assert.equal(document.getText(), original); assert.equal(document.isDirty, false, 'Opening/fitting a portable document must not dirty it.');
    first.send({ type: 'openSource' });
    await eventually(() => first.messages.some(message => message.type === 'showSource'), 'The source action should open the embedded PlantUML editor.');
    console.log('PASS .aliotuml opens with embedded source and placements without dirtying on fit');

    const moved: DiagramLayout = { positions: { A: { x: 240, y: 160 }, B: { x: 370, y: 90 } }, viewport: { x: 60, y: 70, zoom: 0.9 } };
    first.send({ type: 'layout', version: initial.version, diagramId: 'diagram-1', layout: moved });
    await eventually(() => document.isDirty && readEditorDocument(document.getText(), document.fileName).layouts['diagram-1'].positions.A.x === 240, 'A deliberate move must edit the real Aliot text document.');
    assert.equal(snapshot(first.messages).version, initial.version, 'Layout edits must not invalidate an inline source draft.');
    assert.deepEqual(geometry(snapshot(second.messages).layouts['diagram-1']), moved);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'aliot.umlEditor');
    await vscode.commands.executeCommand('undo');
    await eventually(() => readEditorDocument(document.getText(), document.fileName).layouts['diagram-1'].positions.A.x === 110, 'Native undo must restore stored geometry.');
    await vscode.commands.executeCommand('redo');
    await eventually(() => readEditorDocument(document.getText(), document.fileName).layouts['diagram-1'].positions.A.x === 240, 'Native redo must reapply stored geometry.');
    assert.equal(snapshot(first.messages).version, initial.version);
    const resized: DiagramLayout = { ...moved, positions: { ...moved.positions, A: { ...moved.positions.A, width: 420, height: 28 } } };
    first.send({ type: 'layout', version: initial.version, diagramId: 'diagram-1', basePositions: plain(moved.positions), layout: resized });
    await eventually(() => readEditorDocument(document.getText(), document.fileName).layouts['diagram-1'].positions.A.width === 420, 'A size-only edit must persist through the native document.');
    await eventually(() => snapshot(second.messages).layouts['diagram-1'].positions.A.width === 420, 'Size changes must reach peer panels.');
    assert.equal(snapshot(first.messages).version, initial.version, 'Resizing must not invalidate source drafts.');
    await vscode.commands.executeCommand('undo');
    await eventually(() => readEditorDocument(document.getText(), document.fileName).layouts['diagram-1'].positions.A.width === undefined, 'Native undo must restore the previous dimensions.');
    await vscode.commands.executeCommand('redo');
    await eventually(() => readEditorDocument(document.getText(), document.fileName).layouts['diagram-1'].positions.A.width === 420, 'Native redo must restore resized dimensions.');
    await vscode.commands.executeCommand('undo');
    await eventually(() => readEditorDocument(document.getText(), document.fileName).layouts['diagram-1'].positions.A.width === undefined, 'Restore the position-only fixture for subsequent checks.');
    const base = plain(moved.positions);
    first.send({ type: 'layout', version: initial.version, diagramId: 'diagram-1', basePositions: base, layout: { ...moved, positions: { ...base, A: { x: 280, y: 180 } } } });
    second.send({ type: 'layout', version: initial.version, diagramId: 'diagram-1', basePositions: base, layout: { ...moved, positions: { ...base, B: { x: 480, y: 210 } } } });
    await eventually(() => readEditorDocument(document.getText(), document.fileName).layouts['diagram-1'].positions.B.x === 480, 'The second independent split-view move should apply.');
    assert.equal(readEditorDocument(document.getText(), document.fileName).layouts['diagram-1'].positions.A.x, 280, 'Concurrent moves of different nodes must both survive.');
    console.log('PASS portable moves support native undo/redo and preserve concurrent split-view placements');

    const layoutBeforeRename = plain(readEditorDocument(document.getText(), document.fileName).layouts);
    first.send({ type: 'edit', version: initial.version, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'Customer account' } });
    await eventually(() => readEditorDocument(document.getText(), document.fileName).source.includes('Customer account'), 'A source draft remains valid after layout-only changes.');
    assert.deepEqual(plain(readEditorDocument(document.getText(), document.fileName).layouts), layoutBeforeRename);
    const metadata = JSON.parse(document.getText());
    assert.deepEqual(metadata.extensionMetadata, { team: 'Example' });
    assert.equal(metadata.layouts['diagram-1'].positions.A.note, 'Retain point metadata');
    const errors = first.messages.filter(message => message.type === 'error').length;
    first.send({ type: 'layout', version: initial.version, diagramId: 'diagram-1', layout: stored });
    first.send({ type: 'edit', version: initial.version, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'Stale rename' } });
    await eventually(() => first.messages.filter(message => message.type === 'error').length === errors + 2, 'Old source versions must reject both stale edits and stale geometry.');
    assert.ok(!readEditorDocument(document.getText(), document.fileName).source.includes('Stale rename'));
    assert.deepEqual(plain(readEditorDocument(document.getText(), document.fileName).layouts), layoutBeforeRename);
    console.log('PASS portable source edits preserve placements and metadata while rejecting stale changes');

    assert.ok(await document.save(), 'Ctrl+S/native save must persist layout and source edits together.');
    const saved = await vscode.workspace.fs.readFile(uri), savedDocument = readEditorDocument(Buffer.from(saved).toString('utf8'), uri.path);
    assert.equal(savedDocument.source, readEditorDocument(document.getText(), document.fileName).source);
    assert.deepEqual(plain(savedDocument.layouts), layoutBeforeRename);
    const copy = vscode.Uri.joinPath(workspace, prefix + '-copy.aliotuml');
    await vscode.workspace.fs.writeFile(copy, saved);
    const copiedDocument = await vscode.workspace.openTextDocument(copy), freshProvider = new UmlEditorProvider(context(extensionUri)), copiedPanel = channel();
    try {
      await freshProvider.resolveCustomTextEditor(copiedDocument, copiedPanel.panel); copiedPanel.send({ type: 'ready' });
      assert.deepEqual(snapshot(copiedPanel.messages).layouts, layoutBeforeRename);
      assert.equal(snapshot(copiedPanel.messages).source, savedDocument.source);
      await freshProvider.openAliotDocument(copy);
    } finally { copiedPanel.close(); freshProvider.dispose(); }
    console.log('PASS saved and copied Aliot files reopen with placements independent of workspace state');

    const externalSource = savedDocument.source.replace('Customer account', 'Externally named account');
    let external = writeEditorSource(document.getText(), document.fileName, externalSource);
    const externalLayout: DiagramLayout = { positions: { A: { x: 510, y: 260 }, B: { x: 760, y: 260 } }, viewport: { x: 10, y: 20, zoom: 0.8 } };
    external = writeEditorLayout(external, document.fileName, 'diagram-1', externalLayout);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(external));
    await eventually(() => snapshot(first.messages).source === externalSource && snapshot(second.messages).layouts['diagram-1'].positions.A.x === 510, 'External Aliot file edits must reach all open diagram panels.');
    assert.equal(document.isDirty, false);
    first.send({ type: 'layout', version: snapshot(first.messages).version, diagramId: 'diagram-1', layout: { ...externalLayout, viewport: { x: 999, y: 888, zoom: 0.6 } } });
    await eventually(() => snapshot(second.messages).layouts['diagram-1'].viewport?.x === 999, 'A temporary view change should reach peers.');
    first.close(); second.close();
    const reopened = channel();
    await provider.resolveCustomTextEditor(document, reopened.panel); reopened.send({ type: 'ready' });
    assert.deepEqual(snapshot(reopened.messages).layouts['diagram-1'].viewport, externalLayout.viewport, 'Reopening the last closed view restores the saved viewport.');
    reopened.close();
    console.log('PASS external portable edits synchronize source and geometry, and reopen restores the saved view');

    const plantuml = vscode.Uri.joinPath(workspace, prefix + '.puml'), imported = vscode.Uri.joinPath(workspace, prefix + '-imported.aliotuml'), exported = vscode.Uri.joinPath(workspace, prefix + '-export.puml');
    await vscode.workspace.fs.writeFile(plantuml, Buffer.from(source));
    const plainDocument = await vscode.workspace.openTextDocument(plantuml), plainPanel = channel();
    await provider.resolveCustomTextEditor(plainDocument, plainPanel.panel); plainPanel.send({ type: 'ready' });
    plainPanel.send({ type: 'layout', version: plainDocument.version, diagramId: 'diagram-1', layout: moved });
    // Saving is queued behind placement writes, so migration does not depend on
    // the workspace-state debounce completing first.
    await provider.saveAliotDocument(plantuml, imported);
    const importedText = Buffer.from(await vscode.workspace.fs.readFile(imported)).toString('utf8');
    assert.deepEqual(plain(readEditorDocument(importedText, imported.path).layouts['diagram-1']), moved);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(plantuml)).toString('utf8'), source, 'Saving Aliot must not rewrite its original PlantUML input.');
    await assert.rejects(async () => vscode.workspace.fs.stat(exported));
    await provider.exportPlantUml(uri, exported);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(exported)).toString('utf8'), externalSource);
    assert.equal(document.getText(), external, 'An explicit export must not rewrite the portable document.');
    const focusedExport = vscode.Uri.joinPath(workspace, prefix + '-focused-export.puml');
    const focusedAliot = vscode.Uri.joinPath(workspace, prefix + '-focused-save.aliotuml');
    await vscode.window.showTextDocument(plainDocument);
    await vscode.commands.executeCommand('aliotUml.exportPlantUml', undefined, focusedExport);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(focusedExport)).toString('utf8'), source, 'Command palette export should use the focused text tab, not the last diagram.');
    await vscode.commands.executeCommand('aliotUml.saveAliotDocument', undefined, focusedAliot);
    assert.equal(readEditorDocument(Buffer.from(await vscode.workspace.fs.readFile(focusedAliot)).toString('utf8'), focusedAliot.path).source, source, 'Command palette save should use the focused text tab.');
    plainPanel.close();
    console.log('PASS Save Aliot migrates PlantUML placements and explicit export writes only PlantUML source');

    const blank = vscode.Uri.joinPath(workspace, prefix + '-blank.aliotuml');
    await vscode.workspace.fs.writeFile(blank, Buffer.from(serializeAliotDocument('', {})));
    const blankDocument = await vscode.workspace.openTextDocument(blank), blankPanel = channel();
    await provider.resolveCustomTextEditor(blankDocument, blankPanel.panel); blankPanel.send({ type: 'ready' });
    assert.equal(snapshot(blankPanel.messages).source, '');
    blankPanel.send({ type: 'create', kind: 'class' });
    await eventually(() => readEditorDocument(blankDocument.getText(), blankDocument.fileName).source.includes('@startuml'), 'The gallery must create source inside an empty portable document.');
    assert.equal(readEditorDocument(blankDocument.getText(), blankDocument.fileName).format, 'aliot');
    assert.ok(await blankDocument.save()); blankPanel.close();
    console.log('PASS blank Aliot documents create native diagrams inside their portable envelope');

    const malformed = vscode.Uri.joinPath(workspace, prefix + '-invalid.aliotuml');
    await vscode.workspace.fs.writeFile(malformed, Buffer.from('{"format":"aliot-uml","version":99}'));
    const malformedDocument = await vscode.workspace.openTextDocument(malformed), invalidPanel = channel();
    await provider.resolveCustomTextEditor(malformedDocument, invalidPanel.panel); invalidPanel.send({ type: 'ready' });
    await eventually(() => invalidPanel.messages.some(message => message.type === 'error'), 'Malformed/future documents must produce a readable error.');
    assert.equal(malformedDocument.isDirty, false); assert.equal(malformedDocument.getText(), '{"format":"aliot-uml","version":99}');
    invalidPanel.close();
    console.log('PASS unsupported Aliot documents are rejected without mutation');
  } finally { provider.dispose(); }
}
