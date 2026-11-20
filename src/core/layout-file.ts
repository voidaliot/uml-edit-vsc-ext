import type { DiagramLayout, DiagramRelation, ElementPlacement, Layouts, Point } from '../shared/protocol';

/** Manual placements live next to the PlantUML file: `order.puml` → `order.puml.layout.json`. */
export const LAYOUT_FILE_SUFFIX = '.layout.json';
export const LAYOUT_FILE_VERSION = 1;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_LAYOUT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DIAGRAMS = 10_000, MAX_POSITIONS = 20_000, MAX_COORDINATE = 10_000_000, MAX_BENDS = 20_000, MAX_BEND_POINTS = 200, MAX_DIAGRAM_BEND_POINTS = 200_000;

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

/**
 * A relationship's bend identity: its two endpoints in direction order, and how many earlier
 * relationships join the same endpoints in that direction. Relation ids are line numbers and change
 * with every edit above them; this key survives everything except changing the relationship's own ends.
 */
export function bendKey(source: string, target: string, occurrence: number): string {
  return JSON.stringify([source, target, occurrence]);
}

export function bendKeyParts(key: string): { source: string; target: string; occurrence: number } | undefined {
  let parts: unknown;
  try { parts = JSON.parse(key); } catch { return undefined; }
  if (!Array.isArray(parts) || parts.length !== 3) return undefined;
  const [source, target, occurrence] = parts;
  if (typeof source !== 'string' || typeof target !== 'string' || !identifier(source) || !identifier(target) || !Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence > MAX_BENDS) return undefined;
  // Only the one spelling `bendKey` writes: two spellings of one relationship would be saved as a repeated entry.
  if (bendKey(source, target, occurrence) !== key) return undefined;
  return { source, target, occurrence };
}

/** Relation id → bend key, for every relationship of a diagram in source order. */
export function relationBendKeys(relations: readonly DiagramRelation[]): Map<string, string> {
  const seen = new Map<string, number>(), keys = new Map<string, string>();
  for (const relation of relations) {
    const pair = JSON.stringify([relation.source, relation.target]), occurrence = seen.get(pair) ?? 0;
    seen.set(pair, occurrence + 1);
    keys.set(relation.id, bendKey(relation.source, relation.target, occurrence));
  }
  return keys;
}

/** Validates bend points keyed by `bendKey`. */
export function validateBends(bends: unknown, path: string): asserts bends is Record<string, Point[]> {
  if (!record(bends)) throw new Error(`${path} must be an object of relationship bends.`);
  const entries = Object.entries(bends);
  if (entries.length > MAX_BENDS) throw new Error(`${path} exceeds the 20,000 relationship limit.`);
  let total = 0;
  for (const [key, points] of entries) {
    if (!bendKeyParts(key)) throw new Error(`${path} contains an invalid relationship identity.`);
    if (!Array.isArray(points) || !points.length || points.length > MAX_BEND_POINTS) throw new Error(`${path} needs 1–200 bend points per relationship.`);
    // Keeps what the editor writes well inside the size it accepts when reading the file back.
    if ((total += points.length) > MAX_DIAGRAM_BEND_POINTS) throw new Error(`${path} exceeds the 200,000 bend point limit of a diagram.`);
    for (const point of points) if (!record(point) || !coordinate(point.x) || !coordinate(point.y)) throw new Error(`${path} needs finite bend coordinates between -10000000 and 10000000.`);
  }
}

/** Reads the file's bend list into bends keyed by `bendKey`. */
function readBends(list: unknown, path: string): Record<string, Point[]> {
  if (!Array.isArray(list)) throw new Error(`${path} must be a list of relationship bends.`);
  if (list.length > MAX_BENDS) throw new Error(`${path} exceeds the 20,000 relationship limit.`);
  const bends: Record<string, unknown> = Object.create(null);
  list.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (!record(entry) || typeof entry.source !== 'string' || typeof entry.target !== 'string' || typeof entry.occurrence !== 'number' || !bendKeyParts(bendKey(entry.source, entry.target, entry.occurrence))) throw new Error(`${at} needs "source" and "target" element identities and a non-negative integer "occurrence".`);
    const key = bendKey(entry.source, entry.target, entry.occurrence);
    if (Object.hasOwn(bends, key)) throw new Error(`${at} repeats a relationship that already has bends.`);
    // Copy only the coordinates: unknown fields are not kept.
    bends[key] = Array.isArray(entry.points) ? entry.points.map(point => record(point) ? { x: point.x, y: point.y } : point) : entry.points;
  });
  validateBends(bends, path);
  return bends;
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
    const bends = diagram.bends === undefined ? {} : readBends(diagram.bends, `diagrams[${JSON.stringify(id)}].bends`);
    if (Object.keys(positions).length || Object.keys(bends).length) layouts[id] = Object.keys(bends).length ? { positions, bends } : { positions };
  }
  return layouts;
}

/**
 * Serializes manual placements, one element per line so diffs stay readable.
 * Returns undefined when nothing is placed manually: the file should not exist.
 */
export function serializeLayoutFile(layouts: Layouts): string | undefined {
  const diagrams = Object.entries(layouts).filter(([, layout]) => Object.keys(layout.positions).length || Object.keys(layout.bends ?? {}).length);
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
    const positions = lines.length ? `{\n${lines.join(',\n')}\n      }` : '{}';
    const bends = Object.entries(layout.bends ?? {});
    if (!bends.length) return `    ${JSON.stringify(id)}: {\n      "positions": ${positions}\n    }`;
    validateBends(layout.bends, `diagrams[${JSON.stringify(id)}].bends`);
    const routes = bends.map(([key, points]) => {
      const { source, target, occurrence } = bendKeyParts(key)!;
      return `        { "source": ${JSON.stringify(source)}, "target": ${JSON.stringify(target)}, "occurrence": ${occurrence}, "points": [${points.map(point => `{ "x": ${point.x}, "y": ${point.y} }`).join(', ')}] }`;
    });
    return `    ${JSON.stringify(id)}: {\n      "positions": ${positions},\n      "bends": [\n${routes.join(',\n')}\n      ]\n    }`;
  });
  return `{\n  "version": ${LAYOUT_FILE_VERSION},\n  "diagrams": {\n${blocks.join(',\n')}\n  }\n}\n`;
}

/** Positions and bends only; the viewport is per-user view state and never written to the layout file. */
export function positionsOf(layouts: Layouts): Layouts {
  const result: Layouts = Object.create(null);
  for (const [id, layout] of Object.entries(layouts)) {
    const bends = layout.bends && Object.keys(layout.bends).length ? { bends: layout.bends } : {};
    if (Object.keys(layout.positions).length || bends.bends) result[id] = { positions: layout.positions, ...bends };
  }
  return result;
}

/**
 * Bend keys that no longer name the relationship they were shaped for. A key counts relationships
 * between two elements in source order, so deleting, re-attaching or renaming one of them would
 * hand its bends to a neighbour. Any pair whose relationships changed loses its bends instead.
 */
export function staleBendKeys(keys: readonly string[], before: { source: string; relations: readonly DiagramRelation[] }, after: { source: string; relations: readonly DiagramRelation[] } | undefined): string[] {
  const lines = (state: { source: string; relations: readonly DiagramRelation[] } | undefined, source: string, target: string) => {
    const text = state?.source.split(/\r?\n/) ?? [];
    return JSON.stringify((state?.relations ?? []).filter(relation => relation.source === source && relation.target === target).map(relation => text[relation.startLine]?.trim()));
  };
  return keys.filter(key => { const parts = bendKeyParts(key); return !parts || lines(before, parts.source, parts.target) !== lines(after, parts.source, parts.target); });
}

/** Bends of relationships whose two ends were moved by the same amount, moved along with them. */
export function shiftBends(bends: Readonly<Record<string, Point[]>>, moved: Readonly<Record<string, Point>>): Record<string, Point[]> | undefined {
  let changed = false;
  const next: Record<string, Point[]> = Object.create(null);
  for (const [key, points] of Object.entries(bends)) {
    const parts = bendKeyParts(key), from = parts && Object.hasOwn(moved, parts.source) ? moved[parts.source] : undefined, to = parts && Object.hasOwn(moved, parts.target) ? moved[parts.target] : undefined;
    const together = from && to && Math.abs(from.x - to.x) < .01 && Math.abs(from.y - to.y) < .01 && (Math.abs(from.x) > .01 || Math.abs(from.y) > .01);
    next[key] = together ? points.map(point => ({ x: point.x + from.x, y: point.y + from.y })) : points;
    changed ||= Boolean(together);
  }
  return changed ? next : undefined;
}
