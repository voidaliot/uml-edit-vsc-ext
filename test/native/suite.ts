import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { UmlEditorProvider } from '../../src/extension';
import type { HostMessage } from '../../src/shared/protocol';
import { nativeTemplates } from '../../src/core/templates';
import { parseDocument } from '../../src/core/parser';
import { verifyPortableDocuments } from './portable';

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function customTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'aliot.umlEditor');
}

/** Exercise the real text-document event/WorkspaceEdit boundary with controlled webview channels. */
async function verifyProviderSynchronization(extensionUri: vscode.Uri, workspaceUri: vscode.Uri): Promise<void> {
  const resource = vscode.Uri.joinPath(workspaceUri, 'sync.puml');
  await vscode.workspace.fs.writeFile(resource, Buffer.from('@startuml\nclass A\n@enduml\n'));
  const document = await vscode.workspace.openTextDocument(resource);
  const values = new Map<string, unknown>();
  const context = {
    extensionUri,
    workspaceState: { get: (key: string, fallback?: unknown) => values.get(key) ?? fallback, update: async (key: string, value: unknown) => { values.set(key, value); } },
  } as unknown as vscode.ExtensionContext;
  const provider = new UmlEditorProvider(context);
  const channel = () => {
    const messages: HostMessage[] = [];
    let receive: (message: unknown) => void = () => {};
    const panel = {
      active: true,
      webview: {
        cspSource: 'vscode-webview://test', html: '', options: {},
        asWebviewUri: (uri: vscode.Uri) => uri,
        postMessage: async (message: HostMessage) => { messages.push(structuredClone(message)); return true; },
        onDidReceiveMessage: (listener: (message: unknown) => void) => { receive = listener; return new vscode.Disposable(() => {}); },
      },
      onDidChangeViewState: () => new vscode.Disposable(() => {}),
      onDidDispose: () => new vscode.Disposable(() => {}),
    } as unknown as vscode.WebviewPanel;
    return { panel, messages, send: (message: unknown) => receive(message) };
  };
  const first = channel(), second = channel();
  try {
    await provider.resolveCustomTextEditor(document, first.panel);
    await provider.resolveCustomTextEditor(document, second.panel);
    const initialVersion = document.version;
    first.send({ type: 'edit', version: initialVersion, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'First change' } });
    second.send({ type: 'edit', version: initialVersion, diagramId: 'diagram-1', edit: { type: 'rename', elementId: 'A', name: 'Stale change' } });
    await eventually(() => second.messages.some(message => message.type === 'error'), 'The second edit based on a stale source version must be rejected.');
    assert.ok(document.getText().includes('First change'));
    assert.ok(!document.getText().includes('Stale change'));
    assert.equal(first.messages.filter(message => message.type === 'document').length, 1, 'A successful edit should produce exactly one source snapshot in its originating panel.');
    assert.equal(second.messages.filter(message => message.type === 'document').length, 1, 'The source change should broadcast once to the other panel.');
    console.log('PASS concurrent stale edits are rejected and successful edits broadcast once');

    const sourceBeforeLayout = document.getText(), versionBeforeLayout = document.version;
    const layout = { positions: { A: { x: 321, y: 123 } }, viewport: { x: 40, y: 50, zoom: 1 } };
    first.send({ type: 'layout', diagramId: 'diagram-1', layout });
    await eventually(() => second.messages.filter(message => message.type === 'document').length === 2, 'A layout edit should reach the peer panel.');
    const peer = second.messages.at(-1);
    assert.ok(peer?.type === 'document');
    assert.equal(peer.version, versionBeforeLayout);
    assert.equal(peer.source, sourceBeforeLayout);
    assert.deepEqual(peer.layouts['diagram-1'], layout);
    assert.equal(first.messages.filter(message => message.type === 'document').length, 1, 'Layout updates should not echo into the dragging panel.');
    assert.equal(document.version, versionBeforeLayout);
    assert.equal(document.getText(), sourceBeforeLayout);
    console.log('PASS same-version layout broadcasts synchronize peers without changing source');

    const externalEdit = new vscode.WorkspaceEdit();
    externalEdit.insert(resource, new vscode.Position(1, 0), "' live source update\n");
    assert.ok(await vscode.workspace.applyEdit(externalEdit));
    await eventually(() => first.messages.filter(message => message.type === 'document').length === 2 && second.messages.filter(message => message.type === 'document').length === 3, 'External source changes must reach every diagram panel.');
    for (const messages of [first.messages, second.messages]) {
      const snapshot = messages.at(-1);
      assert.ok(snapshot?.type === 'document');
      assert.equal(snapshot.source, document.getText());
      assert.equal(snapshot.version, document.version);
      assert.deepEqual(snapshot.layouts['diagram-1'], layout);
    }
    assert.ok(await document.save());
    console.log('PASS external source changes broadcast live to every diagram panel');

    const expanded = nativeTemplates.map(template => template.source).join('\n');
    const expandedEdit = new vscode.WorkspaceEdit();
    expandedEdit.replace(resource, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), expanded);
    assert.ok(await vscode.workspace.applyEdit(expandedEdit));
    const blocks = parseDocument(document.getText()).diagrams;
    assert.equal(blocks.length, nativeTemplates.length);
    assert.ok(nativeTemplates.length >= 33, 'The native host must load the expanded diagram catalogue.');
    for (const block of blocks) { assert.ok(block.graphical, `${block.kind}: ${block.warnings.join('; ')}`); assert.ok(block.elements.length > 0, `${block.kind} must project to native elements.`); }
    const finalBlock = blocks.at(-1)!;
    first.send({ type: 'layout', diagramId: finalBlock.id, layout: { positions: {} } });
    await eventually(() => second.messages.some(message => message.type === 'document' && Object.hasOwn(message.layouts, finalBlock.id)), 'The host must parse the expanded document while accepting a layout update.');
    console.log(`PASS all ${nativeTemplates.length} native diagram families load in the VS Code host`);

    for (const kind of ['json', 'yaml', 'math'] as const) {
      const block = parseDocument(document.getText()).diagrams.find(block => block.kind === kind)!;
      assert.ok(block, `${kind} fixture must be present.`);
      const target = kind === 'math' ? block.elements.find(element => element.meta?.editable !== false) : block.elements.find(element => Array.isArray(element.meta?.path) && element.meta.path.length === 1);
      assert.ok(target, `${kind} needs an editable fixture element.`);
      const beforeVersion = document.version, beforeErrors = first.messages.filter(message => message.type === 'error').length;
      first.send({ type: 'edit', version: document.version, diagramId: block.id, edit: kind === 'math' ? { type: 'members', elementId: target.id, members: ['x^2 + 3'] } : { type: 'rename', elementId: target.id, name: `native_${kind}` } });
      await eventually(() => document.version > beforeVersion || first.messages.filter(message => message.type === 'error').length > beforeErrors, `${kind} source editing should complete in the actual extension host.`);
      assert.equal(first.messages.filter(message => message.type === 'error').length, beforeErrors, `${kind} edits must load their bundled dependencies without errors.`);
      assert.ok(document.getText().includes(kind === 'math' ? 'x^2 + 3' : `native_${kind}`));
    }
    assert.ok(await document.save());
    console.log('PASS JSON, YAML, and KaTeX-backed math source edits use the bundled native dependencies');
  } finally { provider.dispose(); }
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('aliot.aliot-uml-editor');
  assert.ok(extension, 'The development extension should be installed in the isolated host.');
  await extension.activate();
  assert.ok(extension.isActive, 'The extension activates without throwing.');
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['aliotUml.openEditor', 'aliotUml.newDiagram', 'aliotUml.openSource', 'aliotUml.saveAliotDocument', 'aliotUml.openAliotDocument', 'aliotUml.exportPlantUml']) {
    assert.ok(commands.includes(command), `${command} must be registered.`);
  }
  assert.ok(!commands.includes('aliotUml.installRenderer'), 'No external renderer installation command may be registered.');
  console.log('PASS extension activates and registers all commands');

  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, 'The smoke suite needs its isolated fixture workspace.');
  const resource = vscode.Uri.joinPath(workspace.uri, 'smoke.puml');
  const document = await vscode.workspace.openTextDocument(resource);
  assert.equal(document.languageId, 'plantuml');
  const original = document.getText();
  await vscode.commands.executeCommand('aliotUml.openEditor', resource);
  await eventually(() => customTabs().some(tab => (tab.input as vscode.TabInputCustom).uri.toString() === resource.toString()), 'A PlantUML file should open in the Aliot custom text editor.');
  assert.equal(document.getText(), original, 'Opening a diagram must not rewrite its source.');
  console.log('PASS a .puml file opens in the custom editor without rewriting source');

  await vscode.commands.executeCommand('vscode.openWith', resource, 'aliot.umlEditor', { viewColumn: vscode.ViewColumn.Beside });
  await eventually(() => customTabs().filter(tab => (tab.input as vscode.TabInputCustom).uri.toString() === resource.toString()).length === 2, 'The same document should support two diagram editors.');
  console.log('PASS two diagram panels share the same document');

  await vscode.commands.executeCommand('aliotUml.openSource', resource);
  await eventually(() => vscode.window.activeTextEditor?.document.uri.toString() === resource.toString(), 'The source command should reveal the same text document.');
  assert.ok(customTabs().some(tab => (tab.input as vscode.TabInputCustom).uri.toString() === resource.toString()), 'The diagram stays open beside its source.');
  console.log('PASS source opens beside its diagram');

  const edit = new vscode.WorkspaceEdit();
  const previousVersion = document.version;
  const sourceChanges: number[] = [];
  const subscription = vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.uri.toString() === resource.toString() && event.contentChanges.length) sourceChanges.push(event.document.version);
  });
  edit.insert(resource, new vscode.Position(1, 0), "' externally edited in source\n");
  assert.ok(await vscode.workspace.applyEdit(edit));
  await eventually(() => sourceChanges.length > 0, 'A source edit must emit a live text-document change.');
  subscription.dispose();
  assert.ok(document.version > previousVersion, 'The live source version must advance for both diagram panels.');
  assert.ok(document.isDirty);
  assert.ok(document.getText().includes('externally edited in source'));
  assert.ok(await document.save(), 'The custom editor must share the writable text document.');
  console.log('PASS source edits remain on the shared native text document');

  await vscode.commands.executeCommand('aliotUml.openEditor', resource);
  await eventually(() => customTabs().some(tab => tab.isActive && (tab.input as vscode.TabInputCustom).uri.toString() === resource.toString()), 'The diagram should become the active editor.');
  await vscode.commands.executeCommand('undo');
  await eventually(() => document.getText() === original, 'Native undo from the custom editor should restore the source.');
  await vscode.commands.executeCommand('redo');
  await eventually(() => document.getText().includes('externally edited in source'), 'Native redo from the custom editor should reapply the source edit.');
  await document.save();
  console.log('PASS native undo and redo work while the custom editor is active');

  await verifyProviderSynchronization(extension.extensionUri, workspace.uri);
  await verifyPortableDocuments(extension.extensionUri, workspace.uri);

  const previousUris = new Set(customTabs().map(tab => (tab.input as vscode.TabInputCustom).uri.toString()));
  await vscode.commands.executeCommand('aliotUml.newDiagram');
  await eventually(() => customTabs().some(tab => (tab.input as vscode.TabInputCustom).uri.scheme === 'untitled' && !previousUris.has((tab.input as vscode.TabInputCustom).uri.toString())), 'New Diagram should open an untitled custom text editor for the template gallery.');
  const fresh = customTabs().find(tab => (tab.input as vscode.TabInputCustom).uri.scheme === 'untitled' && !previousUris.has((tab.input as vscode.TabInputCustom).uri.toString()))!;
  const freshDocument = await vscode.workspace.openTextDocument((fresh.input as vscode.TabInputCustom).uri);
  assert.equal(freshDocument.getText(), '', 'A new diagram starts with an empty template gallery.');
  assert.equal(freshDocument.languageId, 'plantuml');
  console.log('PASS New Diagram opens a blank untitled custom editor');

  // Native suites run in their own profile/workspace; leave no dirty fixtures behind.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('Aliot UML native smoke: 20 checks passed.');
}
