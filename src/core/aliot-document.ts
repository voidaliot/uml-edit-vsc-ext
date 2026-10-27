import { applyEdits, modify, visit } from 'jsonc-parser';
import type { DiagramLayout, Layouts } from '../shared/protocol';

export const ALIOT_EXTENSION = '.aliotuml';
export const ALIOT_FORMAT = 'aliot-uml';
export const ALIOT_VERSION = 1;
export const ALIOT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const ALIOT_MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_LAYOUTS = 10_000, MAX_POSITIONS = 20_000, MAX_COORDINATE = 10_000_000;

export interface EditorDocument {
  format: 'plantuml' | 'aliot';
  source: string;
  layouts: Layouts;
}

interface AliotDocument extends Record<string, unknown> {
  format: typeof ALIOT_FORMAT;
  version: typeof ALIOT_VERSION;
  source: string;
  layouts: Layouts;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: Record<string, unknown>, property: string) => Object.hasOwn(value, property);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const identifier = (value: string) => value.length > 0 && value.length <= 1000;
const diagramKey = (value: string) => identifier(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const coordinate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;

function validateSource(source: unknown): asserts source is string {
  if (typeof source !== 'string') throw new Error('Aliot UML source must be a string containing PlantUML text.');
  if (source.length > ALIOT_MAX_SOURCE_BYTES || bytes(source) > ALIOT_MAX_SOURCE_BYTES) throw new Error('PlantUML source exceeds the 2 MiB UTF-8 size limit.');
}

function validateLayout(layout: unknown, path: string): asserts layout is DiagramLayout {
  if (!record(layout) || !own(layout, 'positions') || !record(layout.positions)) throw new Error(`${path}.positions must be an object of element positions.`);
  const positions = Object.entries(layout.positions);
  if (positions.length > MAX_POSITIONS) throw new Error(`${path}.positions exceeds the 20,000 element limit.`);
  for (const [id, point] of positions) {
    if (!identifier(id)) throw new Error(`${path} contains an invalid element identity (use 1–1000 characters).`);
    if (!record(point) || !own(point, 'x') || !own(point, 'y') || !coordinate(point.x) || !coordinate(point.y)) throw new Error(`${path}.positions[${JSON.stringify(id)}] needs finite x and y coordinates between -10000000 and 10000000.`);
    for (const dimension of ['width', 'height']) if (point[dimension] !== undefined && (!coordinate(point[dimension]) || Number(point[dimension]) <= 0)) throw new Error(`${path}.positions[${JSON.stringify(id)}].${dimension} must be positive and at most 10000000.`);
  }
  if (own(layout, 'viewport') && layout.viewport !== undefined) {
    const viewport = layout.viewport;
    if (!record(viewport) || !own(viewport, 'x') || !own(viewport, 'y') || !own(viewport, 'zoom') || !coordinate(viewport.x) || !coordinate(viewport.y) || typeof viewport.zoom !== 'number' || !Number.isFinite(viewport.zoom) || viewport.zoom < .05 || viewport.zoom > 10) throw new Error(`${path}.viewport needs finite x/y coordinates and zoom between 0.05 and 10.`);
  }
}

function validateLayouts(layouts: unknown): asserts layouts is Layouts {
  if (!record(layouts)) throw new Error('Aliot UML layouts must be an object keyed by diagram identity.');
  const entries = Object.entries(layouts);
  if (entries.length > MAX_LAYOUTS) throw new Error('Aliot UML layouts exceeds the 10,000 diagram limit.');
  for (const [id, layout] of entries) {
    if (!diagramKey(id)) throw new Error(`Invalid or reserved diagram identity ${JSON.stringify(id)}.`);
    validateLayout(layout, `layouts[${JSON.stringify(id)}]`);
  }
}

/** Strict JSON: duplicate keys are rejected so a targeted edit cannot select the wrong value. */
function parseAliot(text: string): AliotDocument {
  if (typeof text !== 'string' || text.length > ALIOT_MAX_DOCUMENT_BYTES || bytes(text) > ALIOT_MAX_DOCUMENT_BYTES) throw new Error('Aliot UML document exceeds the 32 MiB UTF-8 size limit.');
  const stack: (Set<string> | undefined)[] = [];
  const enter = (object: boolean) => {
    if (stack.length >= 128) throw new Error('Aliot UML JSON nesting exceeds the supported 128 levels.');
    stack.push(object ? new Set() : undefined);
  };
  let syntaxError = false;
  visit(text, {
    onObjectBegin: () => { enter(true); },
    onArrayBegin: () => { enter(false); },
    onObjectEnd: () => { stack.pop(); },
    onArrayEnd: () => { stack.pop(); },
    onObjectProperty: name => {
      const properties = stack.at(-1);
      if (!properties) { syntaxError = true; return; }
      if (properties.has(name)) throw new Error(`Aliot UML JSON contains duplicate property ${JSON.stringify(name)}. Remove the duplicate before editing.`);
      properties.add(name);
    },
    onError: () => { syntaxError = true; },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  let document: unknown;
  try { document = JSON.parse(text); } catch { throw new Error('Invalid Aliot UML JSON. Use strict JSON without comments or trailing commas.'); }
  if (syntaxError) throw new Error('Invalid Aliot UML JSON. Use strict JSON without comments or trailing commas.');
  if (!record(document)) throw new Error('Aliot UML document must be a JSON object.');
  if (!own(document, 'format') || document.format !== ALIOT_FORMAT) throw new Error('Aliot UML document must declare "format": "aliot-uml".');
  if (!own(document, 'version') || document.version !== ALIOT_VERSION) throw new Error(`Unsupported Aliot UML document version ${JSON.stringify(document.version) ?? '(missing)'}. This editor supports version 1; the file has not been changed.`);
  if (!own(document, 'source')) throw new Error('Aliot UML document is missing its PlantUML source.');
  validateSource(document.source);
  if (!own(document, 'layouts')) throw new Error('Aliot UML document is missing its layouts object.');
  validateLayouts(document.layouts);
  return document as AliotDocument;
}

/** Dictionary aliases are data, including legal PlantUML names such as __proto__. */
function safeLayouts(layouts: Layouts): Layouts {
  const result: Layouts = Object.create(null);
  for (const [id, layout] of Object.entries(layouts)) {
    const positions: DiagramLayout['positions'] = Object.create(null);
    for (const [alias, point] of Object.entries(layout.positions)) positions[alias] = Object.assign(Object.create(null), point);
    result[id] = { ...layout, positions, ...(layout.viewport ? { viewport: { ...layout.viewport } } : {}) };
  }
  return result;
}

export function isAliotFile(fileName: string): boolean {
  return typeof fileName === 'string' && fileName.toLowerCase().endsWith(ALIOT_EXTENSION);
}

export function readEditorDocument(text: string, fileName: string): EditorDocument {
  if (!isAliotFile(fileName)) { validateSource(text); return { format: 'plantuml', source: text, layouts: Object.create(null) }; }
  const document = parseAliot(text);
  return { format: 'aliot', source: document.source, layouts: safeLayouts(document.layouts) };
}

function setPath(text: string, path: string[], value: unknown): string {
  // Without formattingOptions the edit affects only this JSON token/property.
  // Unrelated escape spelling, whitespace, metadata, and envelope line endings survive.
  return applyEdits(text, modify(text, path, value, {}));
}

export function writeEditorSource(text: string, fileName: string, source: string): string {
  validateSource(source);
  if (!isAliotFile(fileName)) return source;
  const document = parseAliot(text);
  if (document.source === source) return text;
  const updated = setPath(text, ['source'], source);
  if (updated.length > ALIOT_MAX_DOCUMENT_BYTES || bytes(updated) > ALIOT_MAX_DOCUMENT_BYTES) throw new Error('Aliot UML document exceeds the 32 MiB UTF-8 size limit.');
  return updated;
}

/** Replace known layout geometry, retaining extension metadata on surviving entries. */
export function writeEditorLayout(text: string, fileName: string, diagramId: string, layout: DiagramLayout): string {
  if (!isAliotFile(fileName)) throw new Error('Portable layouts require an .aliotuml document. Save as Aliot UML first.');
  const document = parseAliot(text);
  if (!diagramKey(diagramId)) throw new Error(`Invalid or reserved diagram identity ${JSON.stringify(diagramId)}.`);
  validateLayout(layout, `layouts[${JSON.stringify(diagramId)}]`);
  const path = ['layouts', diagramId];
  const previous = Object.hasOwn(document.layouts, diagramId) ? document.layouts[diagramId] : undefined;
  if (!previous) {
    if (Object.keys(document.layouts).length >= MAX_LAYOUTS) throw new Error('Aliot UML layouts exceeds the 10,000 diagram limit.');
    const updated = setPath(text, path, layout); parseAliot(updated); return updated;
  }
  let updated = text;
  for (const alias of Object.keys(previous.positions)) if (!Object.hasOwn(layout.positions, alias)) updated = setPath(updated, [...path, 'positions', alias], undefined);
  for (const [alias, point] of Object.entries(layout.positions)) {
    if (!Object.hasOwn(previous.positions, alias)) updated = setPath(updated, [...path, 'positions', alias], point);
    else for (const axis of ['x', 'y', 'width', 'height'] as const) if (point[axis] !== previous.positions[alias][axis]) updated = setPath(updated, [...path, 'positions', alias, axis], point[axis]);
  }
  if (layout.viewport === undefined) {
    if (previous.viewport !== undefined) updated = setPath(updated, [...path, 'viewport'], undefined);
  } else if (previous.viewport === undefined) updated = setPath(updated, [...path, 'viewport'], layout.viewport);
  else for (const field of ['x', 'y', 'zoom'] as const) if (layout.viewport[field] !== previous.viewport[field]) updated = setPath(updated, [...path, 'viewport', field], layout.viewport[field]);
  if (updated !== text) parseAliot(updated);
  return updated;
}

export function serializeAliotDocument(source: string, layouts: Layouts = Object.create(null)): string {
  validateSource(source); validateLayouts(layouts);
  let text: string;
  try { text = JSON.stringify({ format: ALIOT_FORMAT, version: ALIOT_VERSION, source, layouts }, null, 2) + '\n'; }
  catch { throw new Error('Aliot UML metadata must contain JSON values without circular references.'); }
  // Validate the serialized representation as well, so every new document reopens.
  parseAliot(text);
  return text;
}
