import { getBezierPath, getSmoothStepPath, type Position } from '@xyflow/react';
import type { LineType, Point } from '../shared/protocol';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export interface ActivityRoute {
  kind: 'flow' | 'branch' | 'merge' | 'loop';
  sourceHandle?: Side;
  targetHandle?: Side;
  laneX?: number;
  side?: 'left' | 'right';
  clearance?: number;
}
export interface EdgeGeometry {
  sourceX: number; sourceY: number; targetX: number; targetY: number;
  sourcePosition: Side; targetPosition: Side;
}

/** A short orthogonal route with optional rounded corners; no invisible handle offsets. */
export function orthogonalPath(points: Point[], radius = 0): string {
  const compact = points.filter((point, index) => !index || Math.abs(point.x - points[index - 1].x) > .01 || Math.abs(point.y - points[index - 1].y) > .01);
  for (let index = compact.length - 2; index > 0; index--) {
    const before = compact[index - 1], point = compact[index], after = compact[index + 1];
    if (before.x === point.x && point.x === after.x || before.y === point.y && point.y === after.y) compact.splice(index, 1);
  }
  if (!compact.length) return '';
  if (radius <= 0) return compact.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  let path = `M ${compact[0].x} ${compact[0].y}`;
  for (let index = 1; index < compact.length - 1; index++) {
    const before = compact[index - 1], point = compact[index], after = compact[index + 1];
    const incoming = Math.hypot(point.x - before.x, point.y - before.y), outgoing = Math.hypot(after.x - point.x, after.y - point.y);
    const r = Math.min(radius, incoming / 2, outgoing / 2);
    const a = { x: point.x + (before.x - point.x) * r / incoming, y: point.y + (before.y - point.y) * r / incoming };
    const b = { x: point.x + (after.x - point.x) * r / outgoing, y: point.y + (after.y - point.y) * r / outgoing };
    path += ` L ${a.x} ${a.y} Q ${point.x} ${point.y} ${b.x} ${b.y}`;
  }
  const end = compact.at(-1)!;
  return `${path} L ${end.x} ${end.y}`;
}

export function routeActivityEdge(geometry: EdgeGeometry, route: ActivityRoute, radius = 0) {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, sourcePosition: sp, targetPosition: tp } = geometry;
  const points: Point[] = [{ x: sx, y: sy }];
  let labelX = (sx + tx) / 2, labelY = (sy + ty) / 2;
  const horizontalSource = sp === 'left' || sp === 'right', horizontalTarget = tp === 'left' || tp === 'right';
  if (route.kind === 'loop') {
    const left = route.side ? route.side === 'left' : sp === 'left';
    const clearance = route.clearance ?? 28;
    const lane = left ? Math.min(route.laneX ?? Infinity, sx - clearance, tx - clearance) : Math.max(route.laneX ?? -Infinity, sx + clearance, tx + clearance);
    const lead = Math.min(clearance, 12);
    const sourceY = horizontalSource ? sy : sy + (sp === 'bottom' ? lead : -lead);
    const targetY = horizontalTarget ? ty : ty + (tp === 'top' ? -lead : lead);
    if (!horizontalSource) points.push({ x: sx, y: sourceY });
    points.push({ x: lane, y: sourceY }, { x: lane, y: targetY });
    if (!horizontalTarget) points.push({ x: tx, y: targetY });
    labelX = lane + (left ? -12 : 12); labelY = (sourceY + targetY) / 2;
  } else if (horizontalSource && !horizontalTarget) {
    // Decision arms run sideways once, then straight into each branch's top.
    points.push({ x: tx, y: sy });
    labelX = (sx + tx) / 2; labelY = sy - 12;
  } else if (!horizontalSource && horizontalTarget) {
    // Branches meet the sides of a merge rather than zigzagging around it.
    points.push({ x: sx, y: ty });
    labelX = (sx + tx) / 2; labelY = ty - 12;
  } else if (horizontalSource && horizontalTarget) {
    const midX = (sx + tx) / 2;
    points.push({ x: midX, y: sy }, { x: midX, y: ty });
    labelX = midX; labelY -= 12;
  } else {
    const midY = (sy + ty) / 2;
    points.push({ x: sx, y: midY }, { x: tx, y: midY });
    if (Math.abs(sx - tx) < 2) labelX += 14;
    else labelY = midY - 12;
  }
  points.push({ x: tx, y: ty });
  return { path: orthogonalPath(points, radius), labelX, labelY, points };
}

/** Structured flow keeps its branches and loop tracks; other links are straight by default. */
export function routeConnector(geometry: EdgeGeometry, lineType: LineType = 'straight', activity?: ActivityRoute, self = false) {
  if (activity) return routeActivityEdge(geometry, activity, lineType === 'spline' ? 12 : 0);
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = geometry;
  if (self) {
    const outsideX = Math.max(sx, tx) + 48, outsideY = Math.min(sy, ty) - 40;
    const points = [{ x: sx, y: sy }, { x: outsideX, y: sy }, { x: outsideX, y: outsideY }, { x: tx, y: outsideY }, { x: tx, y: ty }];
    return { path: orthogonalPath(points, lineType === 'spline' ? 16 : 0), labelX: outsideX + 10, labelY: (sy + outsideY) / 2 };
  }
  if (lineType === 'straight' || lineType === 'polyline') return { path: `M ${sx} ${sy} L ${tx} ${ty}`, labelX: (sx + tx) / 2, labelY: (sy + ty) / 2 };
  const options = { ...geometry, sourcePosition: geometry.sourcePosition as Position, targetPosition: geometry.targetPosition as Position };
  let [path, labelX, labelY] = lineType === 'spline' ? getBezierPath(options) : getSmoothStepPath({ ...options, borderRadius: 0, offset: 16 });
  // React Flow emits zero-radius Q commands even when its corner radius is zero.
  if (lineType === 'ortho') path = path.replace(/Q\s*([-\d.e+]+),([-\d.e+]+)\s+([-\d.e+]+),([-\d.e+]+)/g, (_match, _cx, _cy, x, y) => `L ${x} ${y}`);
  return { path, labelX, labelY };
}

export function connectorStroke(arrow: string, sequence = false) {
  const options = [...arrow.matchAll(/\[([^\]]*)\]/g)].flatMap(match => match[1].toLowerCase().split(',').map(value => value.trim()));
  const bare = arrow.replace(/\[[^\]]*\]/g, '');
  const strokeDasharray = options.includes('plain') ? undefined : options.includes('dotted') ? '1 4'
    : options.includes('dashed') || bare.includes('.') || sequence && bare.includes('--') ? '5 4' : undefined;
  return { strokeDasharray, bold: options.includes('bold') };
}
