import type { HostMessage, WebviewMessage, Layouts } from '../shared/protocol';
import { applyDiagramEdit } from '../core/edits';
import { getNativeTemplate } from '../core/templates';
import { mergeLayoutPositions } from '../host/messages';
import { ALIOT_EXTENSION, ALIOT_MAX_DOCUMENT_BYTES, ALIOT_MAX_SOURCE_BYTES, isAliotFile, readEditorDocument, serializeAliotDocument, writeEditorLayout, writeEditorSource } from '../core/aliot-document';

declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage(message: WebviewMessage): void; getState(): unknown; setState(state: unknown): void };
    __ALIOT_INITIAL_SOURCE__?: string;
    __ALIOT_FILE_NAME__?: string;
    __ALIOT_PREVIEW_MODEL__?: boolean;
    __ALIOT_PREVIEW_TOKEN__?: string;
  }
}

const vscode = window.acquireVsCodeApi?.();
export const isStandalone = !vscode;
export let isFilePreview = !vscode && window.__ALIOT_PREVIEW_MODEL__ === true;
export type BridgeMessage = HostMessage | { type: 'connection'; connected: boolean } | { type: 'documentOpened' };
const listeners = new Set<(message: BridgeMessage) => void>();
const emit = (message: BridgeMessage) => listeners.forEach(listener => listener(message));
let eventStream: EventSource | undefined;
let lastPreviewVersion = -1;
let lastPreviewRevision = -1;
let connectionEpoch = 0;
let previewQueue: Promise<void> = Promise.resolve();
let fileName = window.__ALIOT_FILE_NAME__ ?? 'order-management.puml';
let format: 'plantuml' | 'aliot' = isAliotFile(fileName) ? 'aliot' : 'plantuml';
let aliotEnvelope: string | undefined;
const pendingLayouts = new Set<Extract<WebviewMessage, { type: 'layout' }>>();
const acceptPreviewMessage = (message: HostMessage) => {
  if (message.type === 'document') {
    if (message.version < lastPreviewVersion) return;
    if (message.revision !== undefined && message.revision < lastPreviewRevision) return;
    lastPreviewVersion = message.version;
    if (message.revision !== undefined) lastPreviewRevision = message.revision;
    source = message.source; version = message.version; fileName = message.fileName; format = message.format ?? (isAliotFile(fileName) ? 'aliot' : 'plantuml');
    aliotEnvelope = format === 'aliot' ? message.aliotDocument : undefined;
    layouts = { ...message.layouts };
    for (const pending of pendingLayouts) if (pending.version === undefined || pending.version === message.version) {
      layouts[pending.diagramId] = mergeLayoutPositions(layouts[pending.diagramId] ?? { positions: {} }, pending.layout, pending.basePositions);
    }
    emit({ ...message, format, layouts });
    return;
  }
  emit(message);
};
let source = window.__ALIOT_INITIAL_SOURCE__ ?? '@startuml\ntitle Order management\nclass "Order" as Order {\n  + id: UUID\n  + status: OrderStatus\n  + submit()\n}\nclass "Line item" as LineItem {\n  + quantity: int\n  + unitPrice: Money\n}\nclass "Customer" as Customer {\n  + name: String\n  + email: String\n}\nOrder *-- LineItem : contains\nCustomer --> Order : places\n@enduml\n';
let version = 1;
let layouts: Layouts = {};
interface HistorySnapshot { source: string; layouts: Layouts; fileName: string; format: 'plantuml' | 'aliot'; aliotEnvelope?: string; kind: 'source' | 'document' | 'layout' }
const undo: HistorySnapshot[] = [];
const redo: HistorySnapshot[] = [];
const documentMessage = (): HostMessage => ({ type: 'document', source, version, layouts, trusted: true, fileName, format });
const historySnapshot = (kind: HistorySnapshot['kind'] = 'source'): HistorySnapshot => ({ source, layouts: structuredClone(layouts), fileName, format, aliotEnvelope, kind });
function restoreHistory(snapshot: HistorySnapshot) {
  if (snapshot.kind !== 'layout' || source !== snapshot.source) version++;
  source = snapshot.source; layouts = snapshot.layouts; fileName = snapshot.fileName; format = snapshot.format; aliotEnvelope = snapshot.aliotEnvelope;
  if (snapshot.kind === 'document') emit({ type: 'documentOpened' });
  emit(documentMessage());
}

function portableDocument(): string {
  if (aliotEnvelope === undefined) return serializeAliotDocument(source, layouts);
  let document = writeEditorSource(aliotEnvelope, fileName, source);
  for (const [id, layout] of Object.entries(layouts)) document = writeEditorLayout(document, fileName, id, layout);
  return document;
}

function downloadDocument(content: string, extension: string, type: string) {
  const stem = fileName.replace(/^.*[\\/]/, '').replace(/\.(?:aliotuml|puml|plantuml|pu|iuml)$/i, '') || 'diagram';
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = stem + extension; link.style.display = 'none';
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openBrowserDocument() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = `${ALIOT_EXTENSION},.puml,.plantuml,.pu,.iuml`;
  input.setAttribute('aria-label', 'Open Aliot or PlantUML file'); input.style.display = 'none';
  input.addEventListener('cancel', () => input.remove(), { once: true });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) { input.remove(); return; }
    void (async () => {
      try {
        const limit = isAliotFile(file.name) ? ALIOT_MAX_DOCUMENT_BYTES : ALIOT_MAX_SOURCE_BYTES;
        if (file.size > limit) throw new Error(`This file exceeds the ${limit / 1024 / 1024} MiB editor limit.`);
        const text = await file.text(), opened = readEditorDocument(text, file.name);
        // A chosen local file becomes an independent document. Late responses from
        // the former live connection must never replace it or resume disk writes.
        connectionEpoch++; eventStream?.close(); eventStream = undefined; isFilePreview = false;
        pendingLayouts.clear(); lastPreviewVersion = -1; lastPreviewRevision = -1; previewQueue = Promise.resolve();
        source = opened.source; layouts = opened.layouts; format = opened.format; fileName = file.name; aliotEnvelope = opened.format === 'aliot' ? text : undefined; version++;
        undo.length = 0; redo.length = 0;
        emit({ type: 'documentOpened' }); emit(documentMessage());
      } catch (error) { emit({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
      finally { input.remove(); }
    })();
  }, { once: true });
  document.body.append(input); input.click();
}

window.addEventListener('message', event => {
  if (event.data && typeof event.data.type === 'string') emit(event.data as HostMessage);
});

export function subscribe(listener: (message: BridgeMessage) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function send(message: WebviewMessage): void {
  if (vscode) { vscode.postMessage(message); return; }
  if (message.type === 'openAliot') { openBrowserDocument(); return; }
  if (message.type === 'saveAliot' || message.type === 'exportPlantUml') {
    const epoch = connectionEpoch;
    void previewQueue.then(() => {
      if (epoch !== connectionEpoch) return;
      try {
        if (message.type === 'saveAliot') downloadDocument(portableDocument(), ALIOT_EXTENSION, 'application/json');
        else downloadDocument(source, '.puml', 'text/plain;charset=utf-8');
      } catch (error) { emit({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
    });
    return;
  }
  if (isFilePreview) {
    const epoch = connectionEpoch;
    if (message.type === 'layout') {
      layouts = { ...layouts, [message.diagramId]: mergeLayoutPositions(layouts[message.diagramId] ?? { positions: {} }, message.layout, message.basePositions) };
      pendingLayouts.add(message);
    }
    if (message.type === 'ready' && !eventStream) {
      eventStream = new EventSource('/api/events');
      eventStream.onmessage = event => {
        if (epoch !== connectionEpoch) return;
        try { const update = JSON.parse(event.data) as HostMessage; if (update && typeof update.type === 'string') acceptPreviewMessage(update); }
        catch { emit({ type: 'error', message: 'Received an invalid update from the local file preview.' }); }
      };
      eventStream.onopen = () => { if (epoch === connectionEpoch) emit({ type: 'connection', connected: true }); };
      eventStream.onerror = () => { if (epoch === connectionEpoch) emit({ type: 'connection', connected: false }); };
    }
    const ready = message.type === 'ready';
    previewQueue = previewQueue.then(async () => {
      if (epoch !== connectionEpoch) return;
      try {
        const response = await fetch(ready ? '/api/document' : '/api/message', ready ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Aliot-Preview-Token': window.__ALIOT_PREVIEW_TOKEN__ ?? '' }, body: JSON.stringify(message) });
        const result = response.status === 204 ? undefined : await response.json();
        if (epoch !== connectionEpoch) return;
        if (message.type === 'layout') pendingLayouts.delete(message);
        if (!response.ok) throw new Error(result?.error ?? result?.message ?? 'The source file could not be updated.');
        if (result && typeof result.type === 'string') acceptPreviewMessage(result as HostMessage);
      } catch (error) {
        if (epoch === connectionEpoch) {
          if (message.type === 'layout') pendingLayouts.delete(message);
          emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      }
    });
    return;
  }
  // The browser preview runs exactly the same edits as the extension host.
  queueMicrotask(() => {
    try {
      switch (message.type) {
        case 'ready': emit(documentMessage()); break;
        case 'edit': {
          if (message.version !== version) throw new Error('The document changed while you were editing. Your draft is still available; review it against the current source before applying again.');
          const next = applyDiagramEdit(source, message.diagramId, message.edit);
          if (next !== source) { undo.push(historySnapshot()); redo.length = 0; source = next; version++; }
          emit(documentMessage()); break;
        }
        case 'layout': {
          if (message.version !== undefined && message.version !== version) throw new Error('The document changed before the layout could be saved.');
          const next = mergeLayoutPositions(layouts[message.diagramId] ?? { positions: {} }, message.layout, message.basePositions);
          if (JSON.stringify(layouts[message.diagramId]?.positions ?? {}) !== JSON.stringify(next.positions)) { undo.push(historySnapshot('layout')); redo.length = 0; }
          layouts = { ...layouts, [message.diagramId]: next }; break;
        }
        case 'create': {
          const template = getNativeTemplate(message.kind);
          if (!template) throw new Error('This diagram type does not have a native editor yet.');
          undo.push(historySnapshot('document')); redo.length = 0;
          source = template.source; version++; layouts = {}; aliotEnvelope = undefined; fileName = `${template.kind}${format === 'aliot' ? ALIOT_EXTENSION : '.puml'}`;
          emit(documentMessage()); break;
        }
        case 'undo': if (undo.length) { const snapshot = undo.pop()!; redo.push(historySnapshot(snapshot.kind)); restoreHistory(snapshot); } break;
        case 'redo': if (redo.length) { const snapshot = redo.pop()!; undo.push(historySnapshot(snapshot.kind)); restoreHistory(snapshot); } break;
        case 'openSource': break;
      }
    } catch (error) { emit({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  });
}
