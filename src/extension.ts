import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { parseDocument } from './core/parser';
import { applyDiagramEdit } from './core/edits';
import { nativeTemplates } from './core/templates';
import { isPlantUmlFile, layoutFileName, parseLayoutFile, serializeLayoutFile, validateSource } from './core/layout-file';
import type { DiagramKind, DiagramLayout, HostMessage, Layouts, WebviewMessage } from './shared/protocol';
import { mergeLayoutPositions, minimalTextChange, requireDocumentVersion, validWebviewMessage } from './host/messages';

export const EDITOR_VIEW_TYPE = 'aliot.umlEditor';
const MAX_LAYOUT_HISTORY = 500;

interface EditorSession {
  document: vscode.TextDocument;
  panel: vscode.WebviewPanel;
  disposed: boolean;
  ready: boolean;
  showSourceOnReady?: boolean;
}

type Positions = DiagramLayout['positions'];
type Viewport = DiagramLayout['viewport'];

/** One placement change. It is undone only while the source still reads as it did when the change was made. */
interface LayoutStep { diagramId: string; before?: Positions; after?: Positions; sourceText: string }

interface LayoutState {
  /** The companion layout file; undefined for untitled documents, whose placement stays in memory. */
  file?: vscode.Uri;
  positions: Layouts;
  viewports: Record<string, Viewport>;
  undo: LayoutStep[];
  redo: LayoutStep[];
  /** Source text after the latest observed change, used to follow native undo outside this editor. */
  text: string;
  /** Layout file content this editor last read or wrote; null when the file does not exist. */
  written: string | null;
  /** Non-zero while this editor runs a native undo/redo, so the change is not treated as external. */
  nativeHistory: number;
  error?: string;
  loaded: Promise<void>;
  watcher?: vscode.Disposable;
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
  );
}

/** The layout file that belongs to a PlantUML document, if it can have one. */
export function layoutFileUri(uri: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme === 'untitled' || !isPlantUmlFile(uri.path)) return undefined;
  return uri.with({ path: layoutFileName(uri.path) });
}

export class UmlEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private readonly sessions = new Set<EditorSession>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly editQueues = new Map<string, Promise<void>>();
  private readonly states = new Map<string, LayoutState>();
  private readonly viewportTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeSession?: EditorSession;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!event.contentChanges.length) return;
        const key = event.document.uri.toString();
        const state = this.states.get(key);
        if (state) {
          const next = event.document.getText();
          if (event.reason === undefined) state.redo.length = 0;
          else if (!state.nativeHistory) {
            // Undo/redo from a text editor or the Edit menu: placement steps recorded on the
            // replaced text move with it, so they stay reachable from the diagram's history.
            for (const stack of [state.undo, state.redo]) for (let index = stack.length - 1; index >= 0 && stack[index].sourceText === state.text; index--) stack[index].sourceText = next;
          }
          state.text = next;
        }
        for (const session of this.sessions) if (session.document.uri.toString() === key) this.sendDocument(session);
      }),
      // Keep the layout file beside its diagram when the diagram is renamed, moved or deleted in VS Code.
      vscode.workspace.onWillRenameFiles(event => event.waitUntil(this.moveLayoutFiles(event.files.map(file => [file.oldUri, file.newUri])))),
      vscode.workspace.onDidDeleteFiles(event => { void this.moveLayoutFiles(event.files.map(file => [file, undefined])); }),
    );
  }

  get activeUri(): vscode.Uri | undefined { return this.activeSession?.document.uri; }

  dispose(): void {
    for (const session of this.sessions) session.disposed = true;
    for (const key of [...this.viewportTimers.keys()]) this.flushViewports(key);
    for (const state of this.states.values()) state.watcher?.dispose();
    this.states.clear();
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
      const key = document.uri.toString();
      if (![...this.sessions].some(item => item.document.uri.toString() === key)) this.releaseState(key);
      if (this.activeSession === session) this.activeSession = [...this.sessions].find(item => item.panel.active);
      for (const disposable of localSubscriptions) disposable.dispose();
    });
    await this.state(document).loaded;
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
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
    if (line !== undefined) {
      const position = new vscode.Position(Math.max(0, Math.min(line, document.lineCount - 1)), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  private async handleMessage(session: EditorSession, message: WebviewMessage): Promise<void> {
    if (session.disposed) return;
    const document = session.document;
    switch (message.type) {
      case 'ready': {
        session.ready = true;
        this.sendDocument(session);
        const error = this.state(document).error;
        if (error) await this.post(session, { type: 'error', message: error });
        if (session.showSourceOnReady) { session.showSourceOnReady = false; await this.post(session, { type: 'showSource' }); }
        break;
      }
      case 'edit':
        await this.enqueueEdit(document, async () => {
          requireDocumentVersion(document.version, message.version);
          const before = document.getText();
          const after = applyDiagramEdit(before, message.diagramId, message.edit);
          validateSource(after);
          await this.replaceText(document, before, after, document.version);
          // Changed text already broadcasts once through onDidChangeTextDocument.
          // A duplicate snapshot can arrive after a new-node placement and reset
          // it to the older layout, so acknowledge only no-op edits explicitly.
          if (before === after) this.sendDocument(session);
        });
        break;
      case 'layout':
        await this.enqueueEdit(document, async () => {
          if (message.version !== undefined) requireDocumentVersion(document.version, message.version);
          if (!parseDocument(document.getText()).diagrams.some(item => item.id === message.diagramId)) return;
          const state = this.state(document), id = message.diagramId;
          const current = state.positions[id]?.positions ?? Object.create(null) as Positions;
          const layout = mergeLayoutPositions({ positions: current }, message.layout, message.basePositions);
          if (layout.viewport) state.viewports[id] = { ...layout.viewport }; else delete state.viewports[id];
          this.scheduleViewports(document.uri, state);
          if (!samePositions(current, layout.positions)) {
            const step: LayoutStep = { diagramId: id, before: state.positions[id]?.positions, after: copyPositions(layout.positions), sourceText: document.getText() };
            state.undo.push(step);
            if (state.undo.length > MAX_LAYOUT_HISTORY) state.undo.shift();
            state.redo.length = 0;
            setPositions(state, id, step.after);
            await this.writeLayoutFile(state);
          }
          // The dragging panel already shows this placement.
          for (const peer of this.sessions) if (peer !== session && peer.document.uri.toString() === document.uri.toString()) this.sendDocument(peer);
        });
        break;
      case 'create': {
        const template = nativeTemplates.find(item => item.kind === message.kind);
        if (!template) throw new Error('That diagram template is not available.');
        if (!document.getText().trim()) {
          await this.enqueueEdit(document, async () => {
            const before = document.getText();
            if (before.trim()) { await this.newDiagram(template.kind); return; }
            await this.replaceText(document, before, template.source, document.version);
          });
        } else await this.newDiagram(template.kind);
        break;
      }
      case 'openSource': await this.openSource(document.uri, message.line); break;
      case 'undo':
      case 'redo': await this.history(session, message.type); break;
    }
  }

  /**
   * Source and placement share one history. Placement steps live here; source steps are VS Code's
   * native undo stack, so edits from a text editor beside the diagram stay part of the same history.
   * A placement step is next exactly when the source still reads as it did when the step was recorded.
   */
  private async history(session: EditorSession, direction: 'undo' | 'redo'): Promise<void> {
    const document = session.document, state = this.state(document);
    await this.enqueueEdit(document, async () => {
      const stack = direction === 'undo' ? state.undo : state.redo;
      const step = stack.at(-1);
      if (step && step.sourceText === document.getText()) { await this.applyStep(document, state, direction); return; }
      if (!session.panel.active) return;
      const version = document.version;
      state.nativeHistory++;
      try {
        await vscode.commands.executeCommand(direction);
        const deadline = Date.now() + 250;
        while (document.version === version && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      } finally { state.nativeHistory--; }
      // The native stack had nothing left: the placement step is the next one after all.
      if (document.version === version && step) await this.applyStep(document, state, direction);
    });
  }

  private async applyStep(document: vscode.TextDocument, state: LayoutState, direction: 'undo' | 'redo'): Promise<void> {
    const step = (direction === 'undo' ? state.undo : state.redo).pop()!;
    (direction === 'undo' ? state.redo : state.undo).push(step);
    setPositions(state, step.diagramId, direction === 'undo' ? step.before : step.after);
    await this.writeLayoutFile(state);
    this.broadcast(document.uri);
  }

  private state(document: vscode.TextDocument): LayoutState {
    const key = document.uri.toString();
    let state = this.states.get(key);
    if (state) return state;
    const file = layoutFileUri(document.uri);
    const viewports = document.uri.scheme === 'untitled' ? {} : this.context.workspaceState.get<Record<string, Viewport>>(this.viewportKey(key), {});
    state = { file, positions: Object.create(null), viewports: Object.assign(Object.create(null), viewports), undo: [], redo: [], text: document.getText(), written: null, nativeHistory: 0, loaded: Promise.resolve() };
    this.states.set(key, state);
    if (file) {
      const current = state;
      current.loaded = this.readLayoutFile(current).catch(error => { current.error = errorMessage(error); });
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(file, '..'), basename(file.path)));
      const reload = () => { void this.enqueueEdit(document, () => this.reloadLayoutFile(document, current)); };
      watcher.onDidChange(reload); watcher.onDidCreate(reload); watcher.onDidDelete(reload);
      current.watcher = watcher;
    }
    return state;
  }

  private releaseState(key: string): void {
    this.flushViewports(key);
    this.states.get(key)?.watcher?.dispose();
    this.states.delete(key);
  }

  private async readFile(uri: vscode.Uri): Promise<string | null> {
    try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); }
    catch (error) { if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return null; throw error; }
  }

  private async readLayoutFile(state: LayoutState): Promise<void> {
    const text = await this.readFile(state.file!);
    state.written = text;
    state.error = undefined;
    state.positions = Object.create(null);
    if (text === null) return;
    try { state.positions = parseLayoutFile(text); }
    catch (error) { state.error = `${basename(state.file!.path)}: ${errorMessage(error)} Manual placements are ignored until the file is fixed; moving an element replaces it.`; }
  }

  /** External changes (a checkout, a hand edit) replace placement and start a new placement history. */
  private async reloadLayoutFile(document: vscode.TextDocument, state: LayoutState): Promise<void> {
    if (this.states.get(document.uri.toString()) !== state) return;
    const text = await this.readFile(state.file!);
    if (text === state.written) return;
    await this.readLayoutFile(state);
    state.undo.length = 0; state.redo.length = 0;
    this.broadcast(document.uri);
    if (state.error) for (const session of this.sessions) if (session.document.uri.toString() === document.uri.toString()) void this.post(session, { type: 'error', message: state.error });
  }

  private async writeLayoutFile(state: LayoutState): Promise<void> {
    if (!state.file) return;
    const text = serializeLayoutFile(state.positions) ?? null;
    if (text === state.written) return;
    state.written = text;
    state.error = undefined;
    if (text === null) {
      try { await vscode.workspace.fs.delete(state.file, { useTrash: false }); }
      catch (error) { if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) throw error; }
    } else await vscode.workspace.fs.writeFile(state.file, new TextEncoder().encode(text));
  }

  private async moveLayoutFiles(files: [vscode.Uri, vscode.Uri | undefined][]): Promise<void> {
    const involved = new Set(files.map(([uri]) => uri.toString()));
    await Promise.all(files.map(async ([from, to]) => {
      const source = layoutFileUri(from);
      if (!source || involved.has(source.toString()) || await this.readFile(source).catch(() => null) === null) return;
      try {
        if (!to) await vscode.workspace.fs.delete(source, { useTrash: true });
        else {
          const target = layoutFileUri(to);
          if (target) await vscode.workspace.fs.rename(source, target, { overwrite: false });
        }
      } catch { /* A layout file that cannot follow its diagram is left in place, never overwritten. */ }
    }));
  }

  private viewportKey(uri: string): string { return `aliotUml.viewports.${uri}`; }

  /** Viewports are personal view state: kept in the workspace, never in the shared layout file. */
  private scheduleViewports(uri: vscode.Uri, state: LayoutState): void {
    if (!state.file) return;
    const key = uri.toString();
    const previous = this.viewportTimers.get(key);
    if (previous) clearTimeout(previous);
    this.viewportTimers.set(key, setTimeout(() => this.flushViewports(key), 350));
  }

  private flushViewports(key: string): void {
    const timer = this.viewportTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.viewportTimers.delete(key);
    const state = this.states.get(key);
    if (state) void this.context.workspaceState.update(this.viewportKey(key), { ...state.viewports });
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

  private editorLayouts(state: LayoutState): Layouts {
    const layouts: Layouts = Object.create(null);
    for (const [id, layout] of Object.entries(state.positions)) layouts[id] = { positions: layout.positions };
    for (const [id, viewport] of Object.entries(state.viewports)) if (viewport) layouts[id] = { positions: layouts[id]?.positions ?? Object.create(null), viewport };
    return layouts;
  }

  private broadcast(uri: vscode.Uri): void {
    for (const session of this.sessions) if (session.document.uri.toString() === uri.toString()) this.sendDocument(session);
  }

  private sendDocument(session: EditorSession): void {
    try {
      const source = session.document.getText();
      validateSource(source);
      void this.post(session, {
        type: 'document', source, version: session.document.version,
        fileName: basename(session.document.uri.path) || 'Untitled PlantUML',
        layouts: this.editorLayouts(this.state(session.document)), trusted: vscode.workspace.isTrusted,
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

function copyPositions(positions: Positions): Positions {
  const result: Positions = Object.create(null);
  for (const [id, point] of Object.entries(positions)) result[id] = { ...point };
  return result;
}

function setPositions(state: LayoutState, diagramId: string, positions: Positions | undefined): void {
  if (positions && Object.keys(positions).length) state.positions[diagramId] = { positions };
  else delete state.positions[diagramId];
}

function samePositions(left: Positions, right: Positions): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && (['x', 'y', 'width', 'height'] as const).every(field => left[key][field] === right[key][field]));
}
