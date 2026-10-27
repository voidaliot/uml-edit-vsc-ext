import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { parseDocument } from './core/parser';
import { applyDiagramEdit } from './core/edits';
import { nativeTemplates } from './core/templates';
import { isAliotFile, readEditorDocument, serializeAliotDocument, writeEditorLayout, writeEditorSource } from './core/aliot-document';
import type { DiagramKind, DiagramLayout, HostMessage, Layouts, WebviewMessage } from './shared/protocol';
import { mergeLayoutPositions, minimalTextChange, requireDocumentVersion, validWebviewMessage } from './host/messages';

export const EDITOR_VIEW_TYPE = 'aliot.umlEditor';

interface EditorSession {
  document: vscode.TextDocument;
  panel: vscode.WebviewPanel;
  disposed: boolean;
  ready: boolean;
  showSourceOnReady?: boolean;
}

interface DocumentSnapshot {
  documentVersion: number;
  version: number;
  format: 'plantuml' | 'aliot';
  source: string;
  layouts: Layouts;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new UmlEditorProvider(context);
  context.subscriptions.push(provider,
    vscode.window.registerCustomEditorProvider(EDITOR_VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('aliotUml.openEditor', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri ?? provider.activeUri;
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, EDITOR_VIEW_TYPE);
      else await provider.newDiagram();
    }),
    vscode.commands.registerCommand('aliotUml.newDiagram', () => provider.newDiagram()),
    vscode.commands.registerCommand('aliotUml.openSource', (uri?: vscode.Uri) => provider.openSource(uri ?? vscode.window.activeTextEditor?.document.uri ?? provider.activeUri)),
    vscode.commands.registerCommand('aliotUml.saveAliotDocument', (uri?: vscode.Uri, destination?: vscode.Uri) => provider.saveAliotDocument(uri ?? vscode.window.activeTextEditor?.document.uri ?? provider.activeUri, destination)),
    vscode.commands.registerCommand('aliotUml.openAliotDocument', (uri?: vscode.Uri) => provider.openAliotDocument(uri)),
    vscode.commands.registerCommand('aliotUml.exportPlantUml', (uri?: vscode.Uri, destination?: vscode.Uri) => provider.exportPlantUml(uri ?? vscode.window.activeTextEditor?.document.uri ?? provider.activeUri, destination)),
  );
}

export class UmlEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private readonly sessions = new Set<EditorSession>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly editQueues = new Map<string, Promise<void>>();
  private readonly layoutCache = new Map<string, Layouts>();
  private readonly layoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly documentSnapshots = new WeakMap<vscode.TextDocument, DocumentSnapshot>();
  private readonly portableViewports = new Map<string, Map<string, DiagramLayout['viewport']>>();
  private activeSession?: EditorSession;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!event.contentChanges.length) return;
        for (const session of this.sessions) {
          if (session.document.uri.toString() !== event.document.uri.toString()) continue;
          this.sendDocument(session);
        }
      }),
    );
  }

  get activeUri(): vscode.Uri | undefined { return this.activeSession?.document.uri; }

  dispose(): void {
    for (const session of this.sessions) session.disposed = true;
    for (const [key, timer] of this.layoutTimers) {
      clearTimeout(timer);
      void this.context.workspaceState.update(key, this.layoutCache.get(key));
    }
    this.layoutTimers.clear();
    this.portableViewports.clear();
    this.sessions.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const session: EditorSession = { document, panel, disposed: false, ready: false };
    this.sessions.add(session);
    this.activeSession = session;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const localSubscriptions: vscode.Disposable[] = [];
    localSubscriptions.push(panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!validWebviewMessage(message)) { void this.post(session, { type: 'error', message: 'The editor sent an invalid request. Reload the editor to recover.' }); return; }
      void this.handleMessage(session, message).catch(error => this.post(session, { type: 'error', message: errorMessage(error) }));
    }));
    localSubscriptions.push(panel.onDidChangeViewState(event => {
      if (event.webviewPanel.active) this.activeSession = session;
    }));
    panel.onDidDispose(() => {
      session.disposed = true;
      this.sessions.delete(session);
      if (![...this.sessions].some(item => item.document.uri.toString() === document.uri.toString())) this.portableViewports.delete(document.uri.toString());
      if (this.activeSession === session) this.activeSession = [...this.sessions].find(item => item.panel.active);
      for (const disposable of localSubscriptions) disposable.dispose();
    });
    panel.webview.html = this.html(panel.webview);
  }

  async newDiagram(kind?: DiagramKind): Promise<void> {
    const template = kind ? nativeTemplates.find(item => item.kind === kind) : undefined;
    if (kind && !template) throw new Error('That diagram type is not available in the native editor yet.');
    const document = await vscode.workspace.openTextDocument({ language: 'plantuml', content: template?.source ?? '' });
    await vscode.commands.executeCommand('vscode.openWith', document.uri, EDITOR_VIEW_TYPE);
  }

  async openSource(uri?: vscode.Uri, line?: number): Promise<void> {
    if (!uri) return;
    if (isAliotFile(uri.path)) {
      await vscode.commands.executeCommand('vscode.openWith', uri, EDITOR_VIEW_TYPE);
      const session = [...this.sessions].find(item => item.document.uri.toString() === uri.toString() && item.panel.active) ?? [...this.sessions].find(item => item.document.uri.toString() === uri.toString());
      if (session?.ready) await this.post(session, { type: 'showSource' });
      else if (session) session.showSourceOnReady = true;
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
    if (line !== undefined) {
      const position = new vscode.Position(Math.max(0, Math.min(line, document.lineCount - 1)), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  async openAliotDocument(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const target = uri ?? (await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: 'Open diagram', filters: { 'Aliot UML document': ['aliotuml'] } }))?.[0];
    if (!target) return;
    if (!isAliotFile(target.path)) throw new Error('Choose an .aliotuml diagram document.');
    const document = await vscode.workspace.openTextDocument(target);
    this.documentSnapshot(document); // Validate before replacing the editor surface.
    await vscode.commands.executeCommand('vscode.openWith', target, EDITOR_VIEW_TYPE);
    return target;
  }

  async saveAliotDocument(uri?: vscode.Uri, destination?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const input = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!input) return;
    const document = await vscode.workspace.openTextDocument(input);
    let target = destination;
    if (!target && isAliotFile(input.path) && input.scheme !== 'untitled') target = input;
    if (!target) target = await vscode.window.showSaveDialog({ defaultUri: this.defaultDestination(document, '.aliotuml'), saveLabel: 'Save Aliot document', filters: { 'Aliot UML document': ['aliotuml'] } });
    if (!target) return;
    if (!isAliotFile(target.path)) target = target.with({ path: target.path + '.aliotuml' });
    const output = target;
    await this.enqueueEdit(document, async () => {
      const before = document.getText(), snapshot = this.documentSnapshot(document), layouts = this.editorLayouts(document, snapshot);
      let text = snapshot.format === 'aliot' ? before : serializeAliotDocument(snapshot.source, layouts);
      if (snapshot.format === 'aliot') for (const [diagramId, layout] of Object.entries(layouts)) text = writeEditorLayout(text, document.fileName, diagramId, layout);
      if (output.toString() === document.uri.toString()) {
        await this.replaceText(document, before, text, document.version);
        if (!await document.save()) throw new Error('VS Code could not save the Aliot document.');
      } else await this.writeDestination(output, text);
    });
    await vscode.commands.executeCommand('vscode.openWith', output, EDITOR_VIEW_TYPE);
    return output;
  }

  async exportPlantUml(uri?: vscode.Uri, destination?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const input = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!input) return;
    const document = await vscode.workspace.openTextDocument(input);
    let target = destination ?? await vscode.window.showSaveDialog({ defaultUri: this.defaultDestination(document, '.puml'), saveLabel: 'Export PlantUML', filters: { PlantUML: ['puml', 'plantuml', 'pu', 'iuml'] } });
    if (!target) return;
    if (!/\.(?:puml|plantuml|pu|iuml)$/i.test(target.path)) target = target.with({ path: target.path + '.puml' });
    const output = target;
    await this.enqueueEdit(document, async () => {
      const source = this.documentSnapshot(document).source;
      if (output.toString() === input.toString()) { if (!await document.save()) throw new Error('VS Code could not save the PlantUML file.'); }
      else await this.writeDestination(output, source);
    });
    return output;
  }

  private defaultDestination(document: vscode.TextDocument, extension: string): vscode.Uri | undefined {
    const name = (basename(document.uri.path).replace(/\.[^./]+$/, '') || 'diagram') + extension;
    if (document.uri.scheme !== 'untitled') return vscode.Uri.joinPath(document.uri, '..', name);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    return folder ? vscode.Uri.joinPath(folder, name) : undefined;
  }

  private async writeDestination(uri: vscode.Uri, text: string): Promise<void> {
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    if (open?.isDirty) throw new Error('The destination has unsaved changes. Save or close that file before replacing it.');
    if (open) {
      await this.replaceText(open, open.getText(), text, open.version);
      if (!await open.save()) throw new Error('VS Code could not save the destination file.');
    } else await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  }

  private async handleMessage(session: EditorSession, message: WebviewMessage): Promise<void> {
    if (session.disposed) return;
    switch (message.type) {
      case 'ready':
        session.ready = true;
        this.sendDocument(session);
        if (session.showSourceOnReady) { session.showSourceOnReady = false; await this.post(session, { type: 'showSource' }); }
        break;
      case 'edit':
        await this.enqueueEdit(session.document, async () => {
          const snapshot = this.documentSnapshot(session.document);
          requireDocumentVersion(snapshot.version, message.version);
          const before = session.document.getText();
          const source = applyDiagramEdit(snapshot.source, message.diagramId, message.edit);
          const after = writeEditorSource(before, session.document.fileName, source);
          await this.replaceText(session.document, before, after, session.document.version);
          // Changed text already broadcasts once through onDidChangeTextDocument.
          // A duplicate snapshot can arrive after a new-node placement and reset
          // it to the older layout, so acknowledge only no-op edits explicitly.
          if (before === after) this.sendDocument(session);
        });
        break;
      case 'layout': {
        await this.enqueueEdit(session.document, async () => {
          const snapshot = this.documentSnapshot(session.document);
          if (message.version !== undefined) requireDocumentVersion(snapshot.version, message.version);
          if (!parseDocument(snapshot.source).diagrams.some(item => item.id === message.diagramId)) return;
          const layout = mergeLayoutPositions(this.editorLayouts(session.document, snapshot)[message.diagramId] ?? { positions: {} }, message.layout, message.basePositions);
          if (snapshot.format === 'aliot') {
            const uri = session.document.uri.toString();
            let viewports = this.portableViewports.get(uri);
            if (!viewports) { viewports = new Map(); this.portableViewports.set(uri, viewports); }
            viewports.set(message.diagramId, layout.viewport);
            const previous = snapshot.layouts[message.diagramId]?.positions ?? {};
            // Opening a file and fitting its viewport must not dirty it. A
            // deliberate placement persists its viewport together with geometry.
            if (!samePositions(previous, layout.positions)) {
              const before = session.document.getText();
              const after = writeEditorLayout(before, session.document.fileName, message.diagramId, layout);
              await this.replaceText(session.document, before, after, session.document.version);
              if (before !== after) return; // The native document event broadcasts to both panels.
            }
          } else {
            const key = this.layoutKey(session.document.uri);
            const layouts = this.layouts(session.document.uri);
            layouts[message.diagramId] = layout;
            this.layoutCache.set(key, layouts);
            const previous = this.layoutTimers.get(key);
            if (previous) clearTimeout(previous);
            this.layoutTimers.set(key, setTimeout(() => {
              this.layoutTimers.delete(key);
              void this.context.workspaceState.update(key, this.layoutCache.get(key));
            }, 350));
          }
          for (const peer of this.sessions) if (peer !== session && peer.document.uri.toString() === session.document.uri.toString()) this.sendDocument(peer);
        });
        break;
      }
      case 'create': {
        const template = nativeTemplates.find(item => item.kind === message.kind);
        if (!template) throw new Error('That diagram template is not available.');
        if (!this.documentSnapshot(session.document).source.trim()) {
          await this.enqueueEdit(session.document, async () => {
            const before = session.document.getText();
            if (this.documentSnapshot(session.document).source.trim()) { await this.newDiagram(template.kind); return; }
            await this.replaceText(session.document, before, writeEditorSource(before, session.document.fileName, template.source), session.document.version);
          });
        } else await this.newDiagram(template.kind);
        break;
      }
      case 'openSource': await this.openSource(session.document.uri, message.line); break;
      case 'saveAliot': await this.saveAliotDocument(session.document.uri); break;
      case 'openAliot': await this.openAliotDocument(); break;
      case 'exportPlantUml': await this.exportPlantUml(session.document.uri); break;
      case 'undo':
      case 'redo':
        // Custom text editors use VS Code's native undo stack, including edits from the source tab.
        if (session.panel.active) await vscode.commands.executeCommand(message.type);
        break;
    }
  }

  private async enqueueEdit(document: vscode.TextDocument, operation: () => Promise<void>): Promise<void> {
    const key = document.uri.toString();
    const previous = this.editQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.editQueues.set(key, next);
    try { await next; }
    finally { if (this.editQueues.get(key) === next) this.editQueues.delete(key); }
  }

  private async replaceText(document: vscode.TextDocument, before: string, after: string, expectedVersion: number): Promise<void> {
    requireDocumentVersion(document.version, expectedVersion);
    const change = minimalTextChange(before, after);
    if (!change) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply this edit. Check that the file is writable.');
  }

  private layoutKey(uri: vscode.Uri): string { return `aliotUml.layouts.${uri.toString()}`; }

  private layouts(uri: vscode.Uri): Layouts {
    const key = this.layoutKey(uri);
    if (!this.layoutCache.has(key)) this.layoutCache.set(key, this.context.workspaceState.get<Layouts>(key, {}));
    return this.layoutCache.get(key)!;
  }

  private documentSnapshot(document: vscode.TextDocument): DocumentSnapshot {
    const previous = this.documentSnapshots.get(document);
    if (previous?.documentVersion === document.version) return previous;
    const decoded = readEditorDocument(document.getText(), document.fileName);
    const snapshot: DocumentSnapshot = { ...decoded, documentVersion: document.version, version: decoded.format === 'aliot' && previous?.format === 'aliot' && previous.source === decoded.source ? previous.version : document.version };
    if (previous?.format === 'aliot' && decoded.format === 'aliot') {
      // Explicit changes/undo to stored presentation override ephemeral views;
      // source-only changes keep the viewport the user is currently looking at.
      const viewports = this.portableViewports.get(document.uri.toString());
      if (viewports) for (const id of viewports.keys()) if (!sameLayout(previous.layouts[id], decoded.layouts[id])) viewports.delete(id);
    }
    this.documentSnapshots.set(document, snapshot);
    return snapshot;
  }

  private editorLayouts(document: vscode.TextDocument, snapshot = this.documentSnapshot(document)): Layouts {
    if (snapshot.format === 'plantuml') return this.layouts(document.uri);
    const layouts = Object.assign(Object.create(null), snapshot.layouts) as Layouts;
    for (const [id, viewport] of this.portableViewports.get(document.uri.toString()) ?? []) {
      const layout = { ...(layouts[id] ?? { positions: Object.create(null) }) };
      if (viewport) layout.viewport = viewport; else delete layout.viewport;
      layouts[id] = layout;
    }
    return layouts;
  }

  private sendDocument(session: EditorSession): void {
    try {
      const snapshot = this.documentSnapshot(session.document);
      void this.post(session, {
        type: 'document', source: snapshot.source, version: snapshot.version, format: snapshot.format,
        fileName: basename(session.document.uri.path) || 'Untitled PlantUML',
        layouts: this.editorLayouts(session.document, snapshot), trusted: vscode.workspace.isTrusted,
      });
    } catch (error) { void this.post(session, { type: 'error', message: errorMessage(error) }); }
  }

  private post(session: EditorSession, message: HostMessage): Thenable<boolean> {
    return session.disposed ? Promise.resolve(false) : session.panel.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src 'none';"><link rel="stylesheet" href="${stylesheet}"><title>Aliot UML Editor</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function samePositions(left: DiagramLayout['positions'], right: DiagramLayout['positions']): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && (['x', 'y', 'width', 'height'] as const).every(field => left[key][field] === right[key][field]));
}

function sameLayout(left: DiagramLayout | undefined, right: DiagramLayout | undefined): boolean {
  if (!left || !right) return left === right;
  return samePositions(left.positions, right.positions) && left.viewport?.x === right.viewport?.x && left.viewport?.y === right.viewport?.y && left.viewport?.zoom === right.viewport?.zoom;
}
