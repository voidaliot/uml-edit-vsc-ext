import type { HostMessage, WebviewMessage, Layouts } from '../shared/protocol';
import { applyDiagramEdit } from '../core/edits';
import { getNativeTemplate } from '../core/templates';
import { mergeLayoutPositions } from '../host/messages';
import { MAX_SOURCE_BYTES, validateSource } from '../core/layout-file';

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
const pendingLayouts = new Set<Extract<WebviewMessage, { type: 'layout' }>>();
const acceptPreviewMessage = (message: HostMessage) => {
  if (message.type === 'document') {
    if (message.version < lastPreviewVersion) return;
    if (message.revision !== undefined && message.revision < lastPreviewRevision) return;
    lastPreviewVersion = message.version;
    if (message.revision !== undefined) lastPreviewRevision = message.revision;
    source = message.source; version = message.version; fileName = message.fileName;
    layouts = { ...message.layouts };
    for (const pending of pendingLayouts) if (pending.version === undefined || pending.version === message.version) {
      layouts[pending.diagramId] = mergeLayoutPositions(layouts[pending.diagramId] ?? { positions: {} }, pending.layout, pending.basePositions);
    }
    emit({ ...message, layouts });
    return;
  }
  emit(message);
};
let source = window.__ALIOT_INITIAL_SOURCE__ ?? '@startuml\ntitle Order management\nclass "Order" as Order {\n  + id: UUID\n  + status: OrderStatus\n  + submit()\n}\nclass "Line item" as LineItem {\n  + quantity: int\n  + unitPrice: Money\n}\nclass "Customer" as Customer {\n  + name: String\n  + email: String\n}\nOrder *-- LineItem : contains\nCustomer --> Order : places\n@enduml\n';
let version = 1;
let layouts: Layouts = {};
interface HistorySnapshot { source: string; layouts: Layouts; fileName: string; kind: 'source' | 'document' | 'layout' }
const undo: HistorySnapshot[] = [];
const redo: HistorySnapshot[] = [];
const documentMessage = (): HostMessage => ({ type: 'document', source, version, layouts, trusted: true, fileName });
const historySnapshot = (kind: HistorySnapshot['kind'] = 'source'): HistorySnapshot => ({ source, layouts: structuredClone(layouts), fileName, kind });
function restoreHistory(snapshot: HistorySnapshot) {
  if (snapshot.kind !== 'layout' || source !== snapshot.source) version++;
  source = snapshot.source; layouts = snapshot.layouts; fileName = snapshot.fileName;
  if (snapshot.kind === 'document') emit({ type: 'documentOpened' });
  emit(documentMessage());
}

/** Browser preview only: VS Code saves the document natively. */
export function downloadSource(): void {
  const epoch = connectionEpoch;
  void previewQueue.then(() => { if (epoch === connectionEpoch) downloadText(source); });
}

function downloadText(content: string) {
  const name = fileName.replace(/^.*[\\/]/, '') || 'diagram.puml';
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = /\.(?:puml|plantuml|pu|iuml)$/i.test(name) ? name : `${name}.puml`; link.style.display = 'none';
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Browser preview only: open a local PlantUML file as an independent document. */
export function openLocalFile(): void {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.puml,.plantuml,.pu,.iuml';
  input.setAttribute('aria-label', 'Open PlantUML file'); input.style.display = 'none';
  input.addEventListener('cancel', () => input.remove(), { once: true });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) { input.remove(); return; }
    void (async () => {
      try {
        if (file.size > MAX_SOURCE_BYTES) throw new Error(`This file exceeds the ${MAX_SOURCE_BYTES / 1024 / 1024} MiB editor limit.`);
        const text = await file.text();
        validateSource(text);
        // A chosen local file becomes an independent document. Late responses from
        // the former live connection must never replace it or resume disk writes.
        connectionEpoch++; eventStream?.close(); eventStream = undefined; isFilePreview = false;
        pendingLayouts.clear(); lastPreviewVersion = -1; lastPreviewRevision = -1; previewQueue = Promise.resolve();
        source = text; layouts = {}; fileName = file.name; version++;
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
          source = template.source; version++; layouts = {}; fileName = `${template.kind}.puml`;
          emit(documentMessage()); break;
        }
        case 'undo': if (undo.length) { const snapshot = undo.pop()!; redo.push(historySnapshot(snapshot.kind)); restoreHistory(snapshot); } break;
        case 'redo': if (redo.length) { const snapshot = redo.pop()!; undo.push(historySnapshot(snapshot.kind)); restoreHistory(snapshot); } break;
        case 'openSource': break;
      }
    } catch (error) { emit({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  });
}
