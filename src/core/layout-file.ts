import type { DiagramLayout, ElementPlacement, Layouts } from '../shared/protocol';

/** Manual placements live next to the PlantUML file: `order.puml` → `order.puml.layout.json`. */
export const LAYOUT_FILE_SUFFIX = '.layout.json';
export const LAYOUT_FILE_VERSION = 1;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_LAYOUT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DIAGRAMS = 10_000, MAX_POSITIONS = 20_000, MAX_COORDINATE = 10_000_000;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const identifier = (value: string) => value.length > 0 && value.length <= 1000;
const diagramKey = (value: string) => identifier(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const coordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;

export function isPlantUmlFile(fileName: string): boolean {
  return /\.(?:puml|plantuml|pu|iuml)$/i.test(fileName);
}

export function layoutFileName(sourceFileName: string): string {
  return sourceFileName + LAYOUT_FILE_SUFFIX;
}

export function validateSource(source: unknown): asserts source is string {
  if (typeof source !== 'string') throw new Error('PlantUML source must be text.');
  if (source.length > MAX_SOURCE_BYTES || bytes(source) > MAX_SOURCE_BYTES) throw new Error('PlantUML source exceeds the 2 MiB UTF-8 size limit.');
}

function validatePositions(positions: unknown, path: string): asserts positions is Record<string, ElementPlacement> {
  if (!record(positions)) throw new Error(`${path} must be an object of element positions.`);
  const entries = Object.entries(positions);
  if (entries.length > MAX_POSITIONS) throw new Error(`${path} exceeds the 20,000 element limit.`);
  for (const [id, point] of entries) {
    if (!identifier(id)) throw new Error(`${path} contains an invalid element identity (use 1–1000 characters).`);
    if (!record(point) || !Object.hasOwn(point, 'x') || !Object.hasOwn(point, 'y') || !coordinate(point.x) || !coordinate(point.y)) throw new Error(`${path}[${JSON.stringify(id)}] needs finite x and y coordinates between -10000000 and 10000000.`);
    for (const dimension of ['width', 'height']) if (point[dimension] !== undefined && (!coordinate(point[dimension]) || Number(point[dimension]) <= 0)) throw new Error(`${path}[${JSON.stringify(id)}].${dimension} must be positive and at most 10000000.`);
  }
}

/** Dictionary aliases are data, including legal PlantUML names such as __proto__. */
function placement(point: ElementPlacement): ElementPlacement {
  const result: ElementPlacement = Object.assign(Object.create(null), { x: point.x, y: point.y });
  if (point.width !== undefined) result.width = point.width;
  if (point.height !== undefined) result.height = point.height;
  return result;
}

/** Reads a layout file. Unknown fields are ignored; geometry is validated strictly. */
export function parseLayoutFile(text: string): Layouts {
  if (typeof text !== 'string' || text.length > MAX_LAYOUT_FILE_BYTES || bytes(text) > MAX_LAYOUT_FILE_BYTES) throw new Error('The layout file exceeds the 32 MiB size limit.');
  let document: unknown;
  try { document = JSON.parse(text); } catch { throw new Error('The layout file is not valid JSON.'); }
  if (!record(document)) throw new Error('The layout file must contain a JSON object.');
  if (document.version !== LAYOUT_FILE_VERSION) throw new Error(`Unsupported layout file version ${JSON.stringify(document.version) ?? '(missing)'}. This editor reads version 1.`);
  const diagrams = document.diagrams;
  if (!record(diagrams)) throw new Error('The layout file needs a "diagrams" object keyed by diagram identity.');
  const entries = Object.entries(diagrams);
  if (entries.length > MAX_DIAGRAMS) throw new Error('The layout file exceeds the 10,000 diagram limit.');
  const layouts: Layouts = Object.create(null);
  for (const [id, diagram] of entries) {
    if (!diagramKey(id)) throw new Error(`Invalid or reserved diagram identity ${JSON.stringify(id)}.`);
    if (!record(diagram)) throw new Error(`diagrams[${JSON.stringify(id)}] must be an object.`);
    validatePositions(diagram.positions, `diagrams[${JSON.stringify(id)}].positions`);
    const positions: DiagramLayout['positions'] = Object.create(null);
    for (const [alias, point] of Object.entries(diagram.positions)) positions[alias] = placement(point);
    if (Object.keys(positions).length) layouts[id] = { positions };
  }
  return layouts;
}

/**
 * Serializes manual placements, one element per line so diffs stay readable.
 * Returns undefined when nothing is placed manually: the file should not exist.
 */
export function serializeLayoutFile(layouts: Layouts): string | undefined {
  const diagrams = Object.entries(layouts).filter(([, layout]) => Object.keys(layout.positions).length);
  if (!diagrams.length) return undefined;
  if (diagrams.length > MAX_DIAGRAMS) throw new Error('The layout exceeds the 10,000 diagram limit.');
  const blocks = diagrams.map(([id, layout]) => {
    if (!diagramKey(id)) throw new Error(`Invalid or reserved diagram identity ${JSON.stringify(id)}.`);
    validatePositions(layout.positions, `diagrams[${JSON.stringify(id)}].positions`);
    const lines = Object.entries(layout.positions).map(([alias, point]) => {
      const fields = [`"x": ${point.x}`, `"y": ${point.y}`];
      if (point.width !== undefined) fields.push(`"width": ${point.width}`);
      if (point.height !== undefined) fields.push(`"height": ${point.height}`);
      return `        ${JSON.stringify(alias)}: { ${fields.join(', ')} }`;
    });
    return `    ${JSON.stringify(id)}: {\n      "positions": {\n${lines.join(',\n')}\n      }\n    }`;
  });
  return `{\n  "version": ${LAYOUT_FILE_VERSION},\n  "diagrams": {\n${blocks.join(',\n')}\n  }\n}\n`;
}

/** Positions only; the viewport is per-user view state and never written to the layout file. */
export function positionsOf(layouts: Layouts): Layouts {
  const result: Layouts = Object.create(null);
  for (const [id, layout] of Object.entries(layouts)) if (Object.keys(layout.positions).length) result[id] = { positions: layout.positions };
  return result;
}
