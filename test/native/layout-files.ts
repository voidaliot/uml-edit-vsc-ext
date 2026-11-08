import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { UmlEditorProvider } from '../../src/extension';
import { parseLayoutFile, serializeLayoutFile } from '../../src/core/layout-file';
import type { HostMessage } from '../../src/shared/protocol';

const source = '@startuml\nclass "Account" as A\nclass "Ledger" as B\nA --> B : records\n@enduml\n';
async function eventually(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!await predicate()) { if (Date.now() > deadline) assert.fail(message); await new Promise(resolve => setTimeout(resolve, 50)); }
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
      cspSource: 'vscode-webview://layout-test', html: '', options: {}, asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: async (message: HostMessage) => { messages.push(structuredClone(message)); return true; },
      onDidReceiveMessage: (listener: (message: unknown) => void) => { receive = listener; return new vscode.Disposable(() => {}); },
    },
    onDidChangeViewState: () => new vscode.Disposable(() => {}),
    onDidDispose: (listener: () => void) => { disposals.push(listener); return new vscode.Disposable(() => {}); },
  } as unknown as vscode.WebviewPanel;
  return { panel, messages, send: (message: unknown) => receive(message), close: () => disposals.forEach(dispose => dispose()) };
}
function latest(messages: HostMessage[]) {
  const message = [...messages].reverse().find(message => message.type === 'document');
  assert.ok(message?.type === 'document', 'The editor must receive a document snapshot.'); return message;
}
async function read(uri: vscode.Uri): Promise<string | null> {
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return null; }
}
// Polls may observe a write in progress; an unreadable moment is simply not the expected state yet.
const placement = async (uri: vscode.Uri) => { const text = await read(uri); if (text === null) return null; try { return parseLayoutFile(text)['diagram-1']?.positions ?? null; } catch { return undefined; } };

export async function verifyLayoutFiles(extensionUri: vscode.Uri, workspace: vscode.Uri): Promise<void> {
  const prefix = `layout-${Date.now()}`;
  const uri = vscode.Uri.joinPath(workspace, prefix + '.puml'), layoutUri = vscode.Uri.joinPath(workspace, prefix + '.puml.layout.json');
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source));
  const document = await vscode.workspace.openTextDocument(uri);
  // Source undo is VS Code's own stack; the text editor makes this document the undo target.
  await vscode.window.showTextDocument(document);
  const provider = new UmlEditorProvider(context(extensionUri)), first = channel(), second = channel();
  try {
    await provider.resolveCustomTextEditor(document, first.panel);
    await provider.resolveCustomTextEditor(document, second.panel);
    first.send({ type: 'ready' }); second.send({ type: 'ready' });
    await eventually(() => first.messages.some(message => message.type === 'document'), 'The editor must load.');
    assert.equal(await read(layoutUri), null, 'Opening a diagram must not create a layout file.');

    const A = { x: 110, y: 90 }, B = { x: 370, y: 90 };
    first.send({ type: 'layout', version: document.version, diagramId: 'diagram-1', layout: { positions: { A }, viewport: { x: 1, y: 2, zoom: 1 } } });
    await eventually(async () => JSON.stringify(await placement(layoutUri)) === JSON.stringify({ A }), 'A move must write the layout file.');
    assert.equal(document.getText(), source, 'Placement must never touch the PlantUML file.');
    assert.equal(document.isDirty, false);
    assert.ok(!(await read(layoutUri))!.includes('viewport'), 'The viewport is not shared in the layout file.');
    assert.equal(JSON.stringify(latest(second.messages).layouts['diagram-1'].positions), JSON.stringify({ A }));
    console.log('PASS placement writes only the layout file and reaches split views');

    first.send({ type: 'edit', version: document.version, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'Customer' } });
    await eventually(() => document.getText().includes('"Customer" as A'), 'The rename must reach the source.');
    const renamed = document.getText();
    first.send({ type: 'layout', version: document.version, diagramId: 'diagram-1', layout: { positions: { A, B } } });
    await eventually(async () => JSON.stringify(await placement(layoutUri)) === JSON.stringify({ A, B }), 'The second move must be written.');

    first.send({ type: 'undo' });
    await eventually(async () => JSON.stringify(await placement(layoutUri)) === JSON.stringify({ A }), 'Undo must first revert the latest move.');
    assert.equal(document.getText(), renamed);
    await eventually(() => JSON.stringify(latest(first.messages).layouts['diagram-1']?.positions) === JSON.stringify({ A }), 'Undoing a move must refresh the panel that made it.');
    first.send({ type: 'undo' });
    await eventually(() => document.getText() === source, 'Undo must then revert the rename.');
    assert.equal(JSON.stringify(await placement(layoutUri)), JSON.stringify({ A }));
    first.send({ type: 'undo' });
    await eventually(async () => await read(layoutUri) === null, 'Undoing the first move removes the now empty layout file.');
    assert.equal(document.getText(), source);
    for (let step = 0; step < 3; step++) first.send({ type: 'redo' });
    await eventually(async () => document.getText() === renamed && JSON.stringify(await placement(layoutUri)) === JSON.stringify({ A, B }), 'Redo must replay the move, the rename and the second move.');
    console.log('PASS source edits and placement share one undo/redo history in order');

    // Undo from the text editor or Edit menu reverts the rename only; the move made after it stays next.
    await vscode.commands.executeCommand('undo');
    await eventually(() => document.getText() === source, 'Native undo reverts the source.');
    first.send({ type: 'undo' });
    await eventually(async () => JSON.stringify(await placement(layoutUri)) === JSON.stringify({ A }), 'The diagram history continues with the move after a native undo.');
    assert.equal(document.getText(), source);
    console.log('PASS native undo outside the diagram keeps the shared history consistent');

    const external = serializeLayoutFile({ 'diagram-1': { positions: { B } } })!;
    await vscode.workspace.fs.writeFile(layoutUri, new TextEncoder().encode(external));
    await eventually(() => JSON.stringify(latest(second.messages).layouts['diagram-1']?.positions) === JSON.stringify({ B }), 'External layout file changes must reach every panel.');
    console.log('PASS external layout file changes reload live');

    await vscode.workspace.fs.writeFile(layoutUri, new TextEncoder().encode('{ broken'));
    await eventually(() => second.messages.some(message => message.type === 'error' && message.message.includes('not valid JSON')), 'An invalid layout file is reported.');
    assert.equal(await read(layoutUri), '{ broken', 'An invalid layout file is left as it is.');
    await vscode.workspace.fs.writeFile(layoutUri, new TextEncoder().encode(external));
    await eventually(() => JSON.stringify(latest(second.messages).layouts['diagram-1']?.positions) === JSON.stringify({ B }), 'A repaired layout file reloads.');
    console.log('PASS invalid layout files are reported and left untouched');
  } finally { first.close(); second.close(); provider.dispose(); }

  assert.ok(await document.save());
  const movedUri = vscode.Uri.joinPath(workspace, prefix + '-renamed.puml'), movedLayout = vscode.Uri.joinPath(workspace, prefix + '-renamed.puml.layout.json');
  const rename = new vscode.WorkspaceEdit();
  rename.renameFile(uri, movedUri);
  assert.ok(await vscode.workspace.applyEdit(rename));
  await eventually(async () => await read(movedLayout) !== null && await read(layoutUri) === null, 'Renaming the diagram must move its layout file.');
  const remove = new vscode.WorkspaceEdit();
  remove.deleteFile(movedUri);
  assert.ok(await vscode.workspace.applyEdit(remove));
  await eventually(async () => await read(movedLayout) === null, 'Deleting the diagram must remove its layout file.');
  console.log('PASS layout files follow renames and deletes in VS Code');
}

/** A real registered filesystem lets write failures cross the VS Code API boundary. */
export async function verifyLayoutWriteFailures(extensionUri: vscode.Uri): Promise<void> {
  const uri = vscode.Uri.parse(`aliot-layout-failure:/retry-${Date.now()}.puml`);
  const layoutUri = uri.with({ path: uri.path + '.layout.json' });
  const files = new Map<string, Uint8Array>([[uri.toString(), new TextEncoder().encode(source)]]);
  const changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  let failNextOperation = false;
  const checkFailure = () => {
    if (failNextOperation) { failNextOperation = false; throw vscode.FileSystemError.Unavailable('Simulated layout persistence failure'); }
  };
  const registration = vscode.workspace.registerFileSystemProvider(uri.scheme, {
    onDidChangeFile: changes.event,
    watch: () => new vscode.Disposable(() => {}),
    stat: resource => {
      if (resource.path === '/') return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      const bytes = files.get(resource.toString());
      if (!bytes) throw vscode.FileSystemError.FileNotFound(resource);
      return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.length };
    },
    readDirectory: () => [], createDirectory: () => {},
    readFile: resource => {
      const bytes = files.get(resource.toString());
      if (!bytes) throw vscode.FileSystemError.FileNotFound(resource);
      return bytes;
    },
    writeFile: async (resource, bytes) => { checkFailure(); files.set(resource.toString(), bytes); },
    delete: async resource => { checkFailure(); files.delete(resource.toString()); },
    rename: async (from, to) => {
      // The source rename fails, but sidecar renames would succeed. A provider
      // must not move the sidecar until the source rename has actually finished.
      if (!from.path.endsWith('.layout.json')) throw vscode.FileSystemError.Unavailable('Simulated source rename failure');
      const bytes = files.get(from.toString());
      if (!bytes) throw vscode.FileSystemError.FileNotFound(from);
      files.set(to.toString(), bytes); files.delete(from.toString());
    },
  }, { isCaseSensitive: true });
  const provider = new UmlEditorProvider(context(extensionUri)), first = channel();
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await provider.resolveCustomTextEditor(document, first.panel);
    first.send({ type: 'ready' });
    const A = { x: 100, y: 100 }, B = { x: 300, y: 200 };
    const move = (positions: Record<string, { x: number; y: number }>) => first.send({ type: 'layout', version: document.version, diagramId: 'diagram-1', layout: { positions } });
    const snapshot = async () => {
      const before = first.messages.length;
      first.send({ type: 'ready' });
      await eventually(() => first.messages.slice(before).some(message => message.type === 'document'), 'The host must return its current persisted layout.');
      return latest(first.messages).layouts['diagram-1']?.positions;
    };
    const expectFailure = async (operation: () => void) => {
      const before = first.messages.filter(message => message.type === 'error').length;
      failNextOperation = true;
      operation();
      await eventually(() => first.messages.filter(message => message.type === 'error').length > before, 'Filesystem failures must reach the originating panel.');
    };
    move({ A });
    await eventually(async () => JSON.stringify(await placement(layoutUri)) === JSON.stringify({ A }), 'The initial move must persist.');
    await expectFailure(() => move({ A, B }));
    assert.equal(JSON.stringify(await snapshot()), JSON.stringify({ A }), 'Failed writes must not change the host layout.');
    move({ A, B });
    await eventually(async () => JSON.stringify(await placement(layoutUri)) === JSON.stringify({ A, B }), 'An identical move must retry a failed write.');

    await expectFailure(() => first.send({ type: 'undo' }));
    assert.equal(JSON.stringify(await snapshot()), JSON.stringify({ A, B }), 'Failed undo writes must leave the current placement intact.');
    first.send({ type: 'undo' });
    await eventually(async () => JSON.stringify(await placement(layoutUri)) === JSON.stringify({ A }), 'A failed undo must remain on the undo stack for retry.');
    await expectFailure(() => first.send({ type: 'redo' }));
    first.send({ type: 'redo' });
    await eventually(async () => JSON.stringify(await placement(layoutUri)) === JSON.stringify({ A, B }), 'A failed redo must remain on the redo stack for retry.');

    await expectFailure(() => move({}));
    assert.equal(JSON.stringify(await snapshot()), JSON.stringify({ A, B }), 'A failed layout deletion must not discard placements.');
    move({});
    await eventually(async () => await read(layoutUri) === null, 'An identical clear must retry a failed deletion.');
    first.send({ type: 'undo' });
    await eventually(async () => JSON.stringify(await placement(layoutUri)) === JSON.stringify({ A, B }), 'One undo must restore the cleared placements after a successful retry.');
    console.log('PASS layout write/delete failures preserve placements and undo/redo, and identical retries persist');

    const renamedUri = uri.with({ path: uri.path.replace('.puml', '-renamed.puml') });
    const rename = new vscode.WorkspaceEdit();
    rename.renameFile(uri, renamedUri);
    assert.equal(await vscode.workspace.applyEdit(rename), false, 'The simulated source rename must fail.');
    assert.ok(files.has(uri.toString()));
    assert.ok(files.has(layoutUri.toString()), 'A failed source rename must leave its layout beside the original source.');
    assert.ok(!files.has(renamedUri.with({ path: renamedUri.path + '.layout.json' }).toString()));
    console.log('PASS failed source renames leave companion layouts in place');
  } finally { first.close(); provider.dispose(); registration.dispose(); changes.dispose(); }
}
