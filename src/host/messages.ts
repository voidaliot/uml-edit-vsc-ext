import type { DiagramEdit, DiagramLayout, WebviewMessage } from '../shared/protocol';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 10000): value is string => typeof value === 'string' && value.length <= max;
const id = (value: unknown): value is string => text(value, 1000) && !!value.length;
const version = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const safeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;
const badKey = (value: string) => value === '__proto__' || value === 'constructor' || value === 'prototype';

export function validEdit(value: unknown): value is DiagramEdit {
  if (!object(value)) return false;
  switch (value.type) {
    case 'move': return id(value.elementId) && object(value.position) && safeNumber(value.position.x) && safeNumber(value.position.y);
    case 'rename': return id(value.elementId) && text(value.name);
    case 'members': return id(value.elementId) && Array.isArray(value.members) && value.members.length <= 2000 && value.members.every(member => text(member));
    case 'addElement': return id(value.kind) && text(value.name) && (value.parentId === undefined || id(value.parentId));
    case 'addRelation': return id(value.source) && id(value.target) && text(value.arrow, 100) && text(value.label) && (value.sequenceRow === undefined || version(value.sequenceRow) && value.sequenceRow <= 20000);
    case 'moveSequenceEvent': return id(value.eventId) && version(value.row) && value.row <= 20000;
    case 'editRelation': return id(value.relationId) && text(value.arrow, 100) && text(value.label);
    case 'deleteElement': return id(value.elementId);
    case 'deleteRelation': return id(value.relationId);
    case 'deleteElements': return [value.elementIds, value.relationIds].every(list => Array.isArray(list) && list.length <= 20000 && list.every(item => id(item)));
    case 'replaceSource':
    case 'insertSnippet': return text(value.source, 2 * 1024 * 1024);
    case 'paste': return text(value.kind, 100) && !!value.kind && text(value.source, 2 * 1024 * 1024);
    case 'properties': return id(value.elementId) && text(value.stereotype, 200) && text(value.color, 100);
    case 'moveToContainer': return id(value.elementId) && (value.parentId === undefined || id(value.parentId));
    case 'addConnectedElement': return id(value.source) && id(value.kind) && text(value.name) && text(value.arrow, 100) && text(value.label) && (value.sequenceRow === undefined || version(value.sequenceRow) && value.sequenceRow <= 20000);
    case 'reconnectRelation': return id(value.relationId) && (value.end === 'source' || value.end === 'target') && id(value.elementId);
    default: return false;
  }
}

export function validLayout(value: unknown): value is DiagramLayout {
  if (!object(value) || !object(value.positions) || Object.keys(value.positions).length > 20000) return false;
  // PlantUML aliases may be names such as constructor or __proto__. Validate
  // their own data entries without reading aliases through an object's prototype.
  if (!Object.entries(value.positions).every(([key, point]) => id(key) && object(point) && Object.hasOwn(point, 'x') && Object.hasOwn(point, 'y') && safeNumber(point.x) && safeNumber(point.y) && ['width', 'height'].every(field => point[field] === undefined || safeNumber(point[field]) && Number(point[field]) > 0))) return false;
  return value.viewport === undefined || (object(value.viewport) && safeNumber(value.viewport.x) && safeNumber(value.viewport.y) && typeof value.viewport.zoom === 'number' && value.viewport.zoom >= 0.05 && value.viewport.zoom <= 10);
}

export function validWebviewMessage(value: unknown): value is WebviewMessage {
  if (!object(value)) return false;
  switch (value.type) {
    case 'ready':
    case 'undo':
    case 'redo': return true;
    case 'openSource': return value.line === undefined || (version(value.line) && value.line <= 1e7);
    case 'edit': return version(value.version) && id(value.diagramId) && validEdit(value.edit) && (value.kind === undefined || text(value.kind, 100));
    case 'layout': return id(value.diagramId) && !badKey(value.diagramId) && validLayout(value.layout) && (value.version === undefined || version(value.version)) && (value.basePositions === undefined || validLayout({ positions: value.basePositions }));
    case 'create': return text(value.kind, 100) && (value.blank === undefined || typeof value.blank === 'boolean');
    case 'export': return validExport(value);
    default: return false;
  }
}

/** Exported images travel as one message; the webview refuses larger ones with a clear message first. */
export const MAX_EXPORT_CHARS = 64 * 1024 * 1024;

/** A plain file name for the save dialog's default: no folders, no characters a file system rejects. */
export const validExportName = (name: unknown, format: string): name is string =>
  text(name, 200) && /^[^\\/:*?"<>|\u0000-\u001f.][^\\/:*?"<>|\u0000-\u001f]*$/.test(name) && name.toLowerCase().endsWith(`.${format}`);

function validExport(value: Record<string, unknown>): boolean {
  if ((value.format !== 'svg' && value.format !== 'png') || !validExportName(value.name, value.format) || typeof value.data !== 'string' || !value.data.length || value.data.length > MAX_EXPORT_CHARS) return false;
  return value.format === 'svg' ? value.data.startsWith('<svg') : value.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data);
}

/** Rebase deliberate placements on the latest view so another panel's moves survive. */
export function mergeLayoutPositions(latest: DiagramLayout, proposed: DiagramLayout, base?: DiagramLayout['positions']): DiagramLayout {
  if (!base) return proposed;
  const positions = Object.assign(Object.create(null), latest.positions) as DiagramLayout['positions'];
  const keys = new Set([...Object.keys(base), ...Object.keys(proposed.positions)]);
  for (const key of keys) {
    const before = Object.hasOwn(base, key) ? base[key] : undefined;
    const next = Object.hasOwn(proposed.positions, key) ? proposed.positions[key] : undefined;
    if (before?.x === next?.x && before?.y === next?.y && before?.width === next?.width && before?.height === next?.height) continue;
    if (next) positions[key] = next; else delete positions[key];
  }
  return { ...proposed, positions };
}

/** Compute one narrow edit, retaining untouched text and avoiding whole-document rewrites. */
export function minimalTextChange(before: string, after: string): { start: number; end: number; text: string } | undefined {
  if (before === after) return undefined;
  let start = 0;
  const common = Math.min(before.length, after.length);
  while (start < common && before[start] === after[start]) start++;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd--; afterEnd--; }
  // VS Code normalizes CRLF positions; keep replacement ranges outside newline pairs.
  if (start > 0 && before[start - 1] === '\r' && before[start] === '\n') start--;
  if (beforeEnd > 0 && before[beforeEnd - 1] === '\r' && before[beforeEnd] === '\n') { beforeEnd++; afterEnd++; }
  return { start, end: beforeEnd, text: after.slice(start, afterEnd) };
}

export function requireDocumentVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new Error('The file changed before this edit could be applied. Your draft is preserved; review the latest diagram and apply it again.');
}
