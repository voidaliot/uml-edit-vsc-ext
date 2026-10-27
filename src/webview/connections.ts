import type { DiagramBlock, DiagramElement, DiagramRelation, Point } from '../shared/protocol';
import type { ActivityRoute } from './routing';
import type { Side } from './routing';

export interface GraphPort { id: string; side: Side; fraction: number }

function center(element: DiagramElement | undefined, point: Point): Point {
  const widths: Record<string, number> = { start: 24, initial: 24, end: 28, final: 28, merge: 24, decision: 68, actor: 125, person: 125 };
  const width = Number(element?.meta?.connectionWidth ?? element?.meta?.width ?? widths[element?.kind ?? ''] ?? 192);
  const height = Number(element?.meta?.height ?? (['start', 'initial', 'end', 'final', 'merge', 'decision'].includes(element?.kind ?? '') ? width : 80));
  return { x: point.x + width / 2, y: point.y + height / 2 };
}

/** Side selection uses visible shape centers, so different node sizes cannot skew a trunk. */
function baseHandles(relation: DiagramRelation, diagram: DiagramBlock, points: Record<string, Point>) {
  if (diagram.kind === 'sequence') {
    const row = Number(relation.meta?.row ?? 0);
    return { sourceHandle: `sequence-${row}`, targetHandle: relation.source === relation.target ? `sequence-return-${row}` : `sequence-${row}` };
  }
  if (relation.source === relation.target) return { sourceHandle: 'right', targetHandle: 'top' };
  if (relation.meta?.treeLayout === 'wbs') return { sourceHandle: String(relation.meta.sourceHandle), targetHandle: String(relation.meta.targetHandle) };
  const sourceElement = diagram.elements.find(element => element.id === relation.source);
  const targetElement = diagram.elements.find(element => element.id === relation.target);
  if (sourceElement?.kind === 'network-bus') return { sourceHandle: `bus-${relation.target}`, targetHandle: (points[relation.target]?.y ?? 0) >= (points[relation.source]?.y ?? 0) ? 'top' : 'bottom' };
  const sourcePoint = Object.hasOwn(points, relation.source) ? points[relation.source] : undefined;
  const targetPoint = Object.hasOwn(points, relation.target) ? points[relation.target] : undefined;
  if (!sourcePoint || !targetPoint) return { sourceHandle: 'right', targetHandle: 'left' };
  const source = center(sourceElement, sourcePoint), target = center(targetElement, targetPoint);
  const dx = target.x - source.x, dy = target.y - source.y;
  if (relation.meta?.treeLayout === 'mindmap') return dx >= 0 ? { sourceHandle: 'right', targetHandle: 'left' } : { sourceHandle: 'left', targetHandle: 'right' };
  const route = relation.meta?.activityRoute as ActivityRoute | undefined;
  if (route) {
    const ports = { sourceHandle: String(relation.meta?.sourceHandle ?? route.sourceHandle ?? 'bottom'), targetHandle: String(relation.meta?.targetHandle ?? route.targetHandle ?? 'top') };
    if (route.kind === 'branch' && sourceElement?.kind === 'decision') return { ...ports, sourceHandle: Math.abs(dx) < 2 ? 'bottom' : dx < 0 ? 'left' : 'right', targetHandle: 'top' };
    if (route.kind === 'merge' && targetElement?.kind === 'merge') return { ...ports, sourceHandle: 'bottom', targetHandle: Math.abs(dx) < 2 ? 'top' : dx > 0 ? 'left' : 'right' };
    return ports;
  }
  if (relation.meta?.sourceHandle && relation.meta?.targetHandle) return { sourceHandle: String(relation.meta.sourceHandle), targetHandle: String(relation.meta.targetHandle) };
  const hint = relation.arrow.replace(/\[[^\]]*\]/g, '').match(/[-.=](left|right|up|down|le|ri|do|l|r|u|d)(?=[-.=<>|o*{])/i)?.[1];
  if (hint && /^[ud]/i.test(hint)) return dy >= 0 ? { sourceHandle: 'bottom', targetHandle: 'top' } : { sourceHandle: 'top', targetHandle: 'bottom' };
  if (hint && /^[lr]/i.test(hint)) return dx >= 0 ? { sourceHandle: 'right', targetHandle: 'left' } : { sourceHandle: 'left', targetHandle: 'right' };
  const width = Number(sourceElement?.meta?.width ?? 192), height = Number(sourceElement?.meta?.height ?? 80);
  if (Math.abs(dx) / width > Math.abs(dy) / height) return dx >= 0 ? { sourceHandle: 'right', targetHandle: 'left' } : { sourceHandle: 'left', targetHandle: 'right' };
  return dy >= 0 ? { sourceHandle: 'bottom', targetHandle: 'top' } : { sourceHandle: 'top', targetHandle: 'bottom' };
}

export function relationHandles(relation: DiagramRelation, diagram: DiagramBlock, points: Record<string, Point>) {
  if (relation.meta?.graphSourceHandle && relation.meta?.graphTargetHandle) return { sourceHandle: String(relation.meta.graphSourceHandle), targetHandle: String(relation.meta.graphTargetHandle) };
  return baseHandles(relation, diagram, points);
}

/** Separate fan-in/out ports follow the order of the visible opposite endpoints. */
export function prepareGraphPorts(diagram: DiagramBlock, points: Record<string, Point>): void {
  if (!['class', 'object', 'component', 'deployment', 'usecase', 'state', 'entity', 'c4', 'archimate', 'dot'].includes(diagram.kind)) return;
  const elements = new Map(diagram.elements.map(element => [element.id, element]));
  const ports = new Map<string, GraphPort[]>(diagram.elements.map(element => [element.id, []]));
  type Endpoint = { relation: DiagramRelation; end: 'source' | 'target'; other: number; port: GraphPort };
  const bundles = new Map<string, Endpoint[]>();
  for (const relation of diagram.relations) {
    if (relation.meta) { delete relation.meta.graphSourceHandle; delete relation.meta.graphTargetHandle; }
    if (/hidden/i.test(relation.arrow) || relation.source === relation.target || relation.meta?.sourceHandle || relation.meta?.targetHandle) continue;
    const source = elements.get(relation.source), target = elements.get(relation.target);
    if (!source || !target || !Object.hasOwn(points, source.id) || !Object.hasOwn(points, target.id)) continue;
    const handles = baseHandles(relation, diagram, points);
    for (const end of ['source', 'target'] as const) {
      const element = end === 'source' ? source : target, opposite = end === 'source' ? target : source;
      const side = handles[end === 'source' ? 'sourceHandle' : 'targetHandle'] as Side;
      if (!['top', 'right', 'bottom', 'left'].includes(side)) continue;
      const other = center(opposite, points[opposite.id]), own = center(element, points[element.id]);
      const horizontal = side === 'top' || side === 'bottom';
      const width = Number(element.meta?.width ?? 192), height = Number(element.meta?.height ?? 80);
      const dx = other.x - own.x, dy = other.y - own.y;
      // Project the direct center-to-center ray onto the visible side. Uniform
      // fan spacing can turn an otherwise clear line into a node crossing.
      const scale = horizontal ? height / 2 / (Math.abs(dy) || 1) : width / 2 / (Math.abs(dx) || 1);
      const fraction = .5 + (horizontal ? dx * scale / width : dy * scale / height);
      const port: GraphPort = { id: `graph-${end}-${relation.id}`, side, fraction: Math.max(.08, Math.min(.92, fraction)) };
      const key = `${element.id}\0${side}`;
      const endpoint = { relation, end, other: port.fraction, port };
      bundles.set(key, [...bundles.get(key) ?? [], endpoint]); ports.get(element.id)!.push(port);
      relation.meta = { ...relation.meta, [end === 'source' ? 'graphSourceHandle' : 'graphTargetHandle']: port.id };
    }
  }
  for (const bundle of bundles.values()) {
    bundle.sort((a, b) => a.other - b.other || a.relation.startLine - b.relation.startLine || a.relation.id.localeCompare(b.relation.id));
    const first = bundle[0], element = elements.get(first.end === 'source' ? first.relation.source : first.relation.target)!;
    const size = Number(first.port.side === 'top' || first.port.side === 'bottom' ? element.meta?.width ?? 192 : element.meta?.height ?? 80);
    const spacing = Math.min(12 / size, .84 / Math.max(1, bundle.length - 1));
    for (let index = 1; index < bundle.length; index++) bundle[index].port.fraction = Math.max(bundle[index].port.fraction, bundle[index - 1].port.fraction + spacing);
    bundle.at(-1)!.port.fraction = Math.min(.92, bundle.at(-1)!.port.fraction);
    for (let index = bundle.length - 2; index >= 0; index--) bundle[index].port.fraction = Math.min(bundle[index].port.fraction, bundle[index + 1].port.fraction - spacing);
  }
  for (const element of diagram.elements) element.meta = { ...element.meta, graphPorts: ports.get(element.id) };
}

/** Ports sit on the visible outline, including ellipses and the small UML symbols. */
export function graphPortPosition(element: DiagramElement, port: GraphPort): Point {
  const width = Number(element.meta?.width ?? 192), height = Number(element.meta?.height ?? 80);
  const horizontal = port.side === 'top' || port.side === 'bottom';
  let x = horizontal ? width * port.fraction : port.side === 'left' ? 0 : width;
  let y = horizontal ? port.side === 'top' ? 0 : height : height * port.fraction;
  if (element.meta?.symbolNotation) {
    const radius = element.kind === 'interface' ? 8 : 12, cy = element.kind === 'interface' ? 14 : 17;
    const offset = (port.fraction * 2 - 1) * radius, outer = Math.sqrt(radius * radius - offset * offset);
    x = width / 2 + (horizontal ? offset : port.side === 'left' ? -outer : outer);
    y = cy + (horizontal ? port.side === 'top' ? -outer : outer : offset);
  } else if (element.kind === 'usecase') {
    const t = port.fraction * 2 - 1, arc = Math.sqrt(Math.max(0, 1 - t * t));
    if (horizontal) y = height / 2 + (port.side === 'top' ? -1 : 1) * height / 2 * arc;
    else x = width / 2 + (port.side === 'left' ? -1 : 1) * width / 2 * arc;
  } else if (element.kind === 'cloud') {
    if (horizontal) y = port.side === 'top' ? height * .08 : height * .91;
    else x = port.side === 'left' ? width * .04 : width * .96;
  } else if (element.kind === 'database' && horizontal) {
    const arc = Math.sqrt(Math.max(0, 1 - Math.pow(port.fraction * 2 - 1, 2)));
    y = port.side === 'top' ? 12 - 12 * arc : height - 12 + 12 * arc;
  }
  return { x, y };
}
