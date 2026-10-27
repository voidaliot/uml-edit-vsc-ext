import type { DiagramBlock, DiagramElement, DiagramRelation, Point } from '../shared/protocol';
import { codeLines } from './syntax';

type Side = 'top' | 'right' | 'bottom' | 'left';
interface Size { width: number; height: number }
interface Fragment { points: Map<string, Point>; left: number; right: number; height: number; entry?: string; exits: string[] }
interface Route { kind: 'branch' | 'merge' | 'loop' | 'flow'; sourceHandle: Side; targetHandle: Side; laneX?: number; side?: 'left' | 'right'; clearance?: number }
const ROW_GAP = 26, BRANCH_GAP = 52, GROUP_X = 18, GROUP_TOP = 34, GROUP_BOTTOM = 18;

/** Font-independent, conservative measurement for the renderer's 12px labels. */
function textSize(text: string, minimum: number, maximum: number, inset: number): Size {
  const lines = text.replace(/<[^>]*>/g, '').replace(/\\n/g, '\n').split('\n');
  const length = (value: string) => [...value].reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 12 : /[MW@#%]/.test(char) ? 9 : /[il.,'!:;| ]/.test(char) ? 3.8 : 6.7), 0);
  const natural = Math.max(0, ...lines.map(length));
  const width = Math.ceil(Math.max(minimum, Math.min(maximum, natural + inset)) / 2) * 2;
  const rows = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(length(line) / Math.max(32, width - inset))), 0);
  return { width, height: Math.max(36, rows * 18 + 16) };
}

function measure(element: DiagramElement): Size {
  if (element.kind === 'start') return { width: 18, height: 18 };
  if (element.kind === 'end') return { width: 22, height: 22 };
  if (element.kind === 'merge' && !element.name) return { width: 20, height: 20 };
  if (element.kind === 'fork' || element.kind === 'join') return { width: 96, height: 6 };
  if (element.kind === 'decision') return textSize(element.name, 120, 240, 48);
  if (element.kind === 'note') return textSize(element.name, 140, 240, 28);
  return textSize(element.name, 120, 220, 28);
}

/** Matching syntax boundaries remain useful when a branch ends instead of reaching a join. */
function structuredJoins(block: DiagramBlock, nodes: Map<string, DiagramElement>): Map<string, string> {
  const result = new Map<string, string>(), lines = codeLines(block.source);
  const atLine = new Map<number, DiagramElement[]>();
  for (const node of nodes.values()) atLine.set(node.startLine, [...atLine.get(node.startLine) ?? [], node]);
  const stack: { type: string; heads: string[] }[] = [];
  for (let offset = 1; offset < lines.length - 1; offset++) {
    const line = block.startLine + offset, text = lines[offset].trim(), elements = atLine.get(line) ?? [];
    const condition = elements.find(element => element.kind === 'decision');
    if (condition && /^elseif\b/i.test(text)) { stack.at(-1)?.heads.push(condition.id); continue; }
    const control = String(condition?.meta?.control ?? (condition?.meta?.legacyData as { control?: string } | undefined)?.control ?? '');
    if (condition && ['if', 'switch', 'while'].includes(control)) { stack.push({ type: control, heads: [condition.id] }); continue; }
    if (/^(?:fork|split)\s*$/i.test(text)) {
      const head = elements.find(element => element.kind === 'fork' || element.kind === 'merge');
      if (head) stack.push({ type: text.toLowerCase(), heads: [head.id] });
      continue;
    }
    if (/^repeat(?:\s*:.*;)?\s*$/i.test(text)) { stack.push({ type: 'repeat', heads: [] }); continue; }
    const closing = /^(?:endif|endswitch|endwhile|end\s*(?:fork|split|merge)|repeat\s+while)\b/i.exec(text);
    if (!closing) continue;
    const frame = stack.pop();
    const join = elements.find(element => element.kind === 'merge' || element.kind === 'join');
    if (frame && join) for (const head of frame.heads) result.set(head, join.id);
  }
  return result;
}

/**
 * Lay out control-flow regions rather than assigning every node a uniform grid cell.
 * A fragment has a vertical trunk and a measured envelope. Sibling branches reserve
 * separate envelopes, then continue from one shared join below their deepest path.
 */
export function layoutActivity(block: DiagramBlock): Record<string, Point> {
  const result: Record<string, Point> = Object.create(null);
  const containers = new Map(block.elements.filter(element => element.meta?.container || element.kind === 'partition' || element.kind === 'swimlane').map(element => [element.id, element]));
  const notes = block.elements.filter(element => element.kind === 'note');
  const nodes = new Map(block.elements.filter(element => !containers.has(element.id) && element.kind !== 'note').map(element => [element.id, element]));
  const order = new Map([...nodes.keys()].map((id, index) => [id, index]));
  const sizes = new Map<string, Size>();
  for (const element of [...nodes.values(), ...notes]) {
    const size = measure(element); sizes.set(element.id, size);
    element.meta = { ...element.meta, ...size, activityLayout: true };
    delete element.meta.activityPorts;
  }
  const ancestry = new Map<string, string[]>();
  const parents = (id: string): string[] => {
    const cached = ancestry.get(id); if (cached) return cached;
    const path: string[] = [], seen = new Set<string>();
    let parent = nodes.get(id)?.parentId ?? containers.get(id)?.parentId ?? notes.find(note => note.id === id)?.parentId;
    while (parent && containers.has(parent) && !seen.has(parent)) { seen.add(parent); path.unshift(parent); parent = containers.get(parent)?.parentId; }
    ancestry.set(id, path); return path;
  };
  const gap = (from: string, to: string): number => {
    const a = parents(from), b = parents(to); let shared = 0;
    while (shared < a.length && a[shared] === b[shared]) shared++;
    return ROW_GAP + (a.length - shared) * GROUP_BOTTOM + (b.length - shared) * GROUP_TOP;
  };
  const edges = block.relations.filter(edge => nodes.has(edge.source) && nodes.has(edge.target));
  const outgoing = new Map<string, DiagramRelation[]>(), incoming = new Map<string, DiagramRelation[]>();
  const priority = (edge: DiagramRelation) => /^(?:yes|true|ok|accepted)$/i.test(edge.label) ? 0 : /^(?:no|false|else|otherwise)$/i.test(edge.label) ? 2 : 1;
  for (const edge of edges) { outgoing.set(edge.source, [...outgoing.get(edge.source) ?? [], edge]); incoming.set(edge.target, [...incoming.get(edge.target) ?? [], edge]); }
  for (const list of outgoing.values()) list.sort((a, b) => priority(a) - priority(b) || order.get(a.target)! - order.get(b.target)!);
  const roots = [...nodes.keys()].filter(id => !incoming.has(id) || nodes.get(id)!.kind === 'start');
  // DFS identifies actual cycle closures, including legacy aliases whose source-line
  // order cannot distinguish a loop from a forward reference.
  const back = new Set<string>(), state = new Map<string, number>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const edge of outgoing.get(id) ?? []) {
      if (state.get(edge.target) === 1) back.add(edge.id);
      else if (!state.has(edge.target)) visit(edge.target);
    }
    state.set(id, 2);
  };
  for (const id of [...roots, ...nodes.keys()]) if (!state.has(id)) visit(id);
  const forward = new Map([...nodes.keys()].map(id => [id, (outgoing.get(id) ?? []).filter(edge => !back.has(edge.id))]));
  const paired = structuredJoins(block, nodes), placed = new Set<string>();
  const distanceCache = new Map<string, Map<string, number>>();
  const distances = (start: string, stop?: string) => {
    const key = JSON.stringify([start, stop]), cached = distanceCache.get(key); if (cached) return cached;
    const found = new Map<string, number>([[start, 0]]), queue = [start];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]; if (id === stop) continue;
      for (const edge of forward.get(id) ?? []) if (!found.has(edge.target)) { found.set(edge.target, found.get(id)! + 1); queue.push(edge.target); }
    }
    distanceCache.set(key, found); return found;
  };
  const convergence = (head: string, branches: DiagramRelation[], stop?: string): string | undefined => {
    const explicit = paired.get(head); if (explicit && !placed.has(explicit)) return explicit;
    const paths = branches.map(edge => distances(edge.target, stop));
    return [...paths[0].keys()].filter(id => id !== head && !placed.has(id) && paths.every(path => path.has(id)))
      .sort((a, b) => Math.max(...paths.map(path => path.get(a)!)) - Math.max(...paths.map(path => path.get(b)!)) || order.get(a)! - order.get(b)!)[0];
  };
  const blank = (): Fragment => ({ points: new Map(), left: -30, right: 30, height: 0, exits: [] });
  const include = (fragment: Fragment, id: string, point: Point) => {
    const size = sizes.get(id)!, reserve = parents(id).length * GROUP_X;
    fragment.points.set(id, point);
    fragment.left = Math.min(fragment.left, point.x - reserve); fragment.right = Math.max(fragment.right, point.x + size.width + reserve);
    fragment.height = Math.max(fragment.height, point.y + size.height);
  };
  const append = (fragment: Fragment, child: Fragment, x: number, y: number) => {
    for (const [id, point] of child.points) fragment.points.set(id, { x: point.x + x, y: point.y + y });
    fragment.left = Math.min(fragment.left, child.left + x); fragment.right = Math.max(fragment.right, child.right + x);
    fragment.height = Math.max(fragment.height, child.height + y);
  };
  const resizeBar = (id: string, width: number) => {
    if (!['fork', 'join'].includes(nodes.get(id)?.kind ?? '')) return;
    const size = { width: Math.max(96, Math.ceil(width)), height: 6 }; sizes.set(id, size); Object.assign(nodes.get(id)!.meta!, size);
  };
  const build = (entry: string, stop?: string): Fragment => {
    if (entry === stop || placed.has(entry)) return blank();
    const fragment: Fragment = { points: new Map(), left: 0, right: 0, height: 0, entry, exits: [] };
    let current: string | undefined = entry, y = 0;
    while (current && current !== stop && !placed.has(current)) {
      const id: string = current, node = nodes.get(id)!, size = sizes.get(id)!;
      placed.add(id); include(fragment, id, { x: -size.width / 2, y }); fragment.exits = [id];
      const branches = (forward.get(id) ?? []).filter(edge => !placed.has(edge.target));
      if (!branches.length) break;
      if (branches.length === 1) {
        const next = branches[0].target; if (next === stop) break;
        y += size.height + gap(id, next); current = next; continue;
      }
      const join = convergence(id, branches, stop);
      const isWhile = node.meta?.control === 'while' && join !== undefined;
      if (isWhile) {
        const bodyEdges = branches.filter(edge => edge.target !== join);
        const children = bodyEdges.map(edge => build(edge.target, join));
        let bottom = y + size.height;
        for (const child of children) {
          const childY = y + size.height + gap(id, child.entry ?? join!);
          append(fragment, child, 0, childY);
          bottom = Math.max(bottom, childY + child.height + Math.max(ROW_GAP, ...child.exits.map(exit => gap(exit, join!))));
        }
        fragment.left -= 28; fragment.right += 28;
        if (join === stop || placed.has(join!)) { fragment.exits = children.flatMap(child => child.exits); break; }
        current = join; y = Math.max(bottom, y + size.height + gap(id, join!)); continue;
      }
      const children = branches.map(edge => build(edge.target, join ?? stop));
      const centers: number[] = [];
      for (let index = 0; index < children.length; index++) centers[index] = index ? centers[index - 1] + children[index - 1].right + BRANCH_GAP - children[index].left : -children[index].left;
      const midpoint = (centers[0] + centers.at(-1)!) / 2;
      const childY = y + size.height + Math.max(...branches.map(edge => gap(id, edge.target)));
      let bottom = childY;
      for (let index = 0; index < children.length; index++) {
        const child = children[index]; append(fragment, child, centers[index] - midpoint, childY);
        bottom = Math.max(bottom, childY + child.height + (join ? Math.max(ROW_GAP, ...child.exits.map(exit => gap(exit, join))) : 0));
      }
      if (node.kind === 'fork') {
        const width = centers.at(-1)! - centers[0] + 36; resizeBar(id, width); include(fragment, id, { x: -sizes.get(id)!.width / 2, y });
        if (join) resizeBar(join, width);
      }
      if (!join || join === stop || placed.has(join)) { fragment.exits = children.flatMap(child => child.exits); break; }
      current = join; y = bottom;
    }
    return fragment;
  };

  let componentX = 0;
  const compareRoot = (a: string, b: string) => (parents(a)[0] ?? '').localeCompare(parents(b)[0] ?? '') || order.get(a)! - order.get(b)!;
  const orderedRoots = [...new Set([...roots.sort(compareRoot), ...nodes.keys()])];
  for (const id of orderedRoots) {
    if (placed.has(id)) continue;
    const fragment = build(id), padding = parents(id).length * GROUP_TOP;
    for (const [nodeId, point] of fragment.points) result[nodeId] = { x: point.x + componentX - fragment.left, y: point.y + padding };
    componentX += fragment.right - fragment.left + 70;
  }

  const lanes = [...containers.values()].filter(element => element.kind === 'swimlane');
  if (lanes.length) {
    const laneNames = lanes.map(lane => lane.name);
    const unassigned = [...nodes.values()].some(node => !laneNames.includes(String(node.meta?.lane ?? '')));
    const names = unassigned ? ['', ...laneNames] : laneNames;
    let x = 0;
    for (const name of names) {
      const members = [...nodes.values()].filter(node => String(node.meta?.lane ?? '') === name);
      const left = members.length ? Math.min(...members.map(node => result[node.id].x - parents(node.id).length * GROUP_X)) : 0;
      const right = Math.max(left + 140, ...members.map(node => result[node.id].x + sizes.get(node.id)!.width + parents(node.id).length * GROUP_X));
      const width = Math.max(180, right - left + 40);
      for (const member of members) { result[member.id].x += x + 20 - left; result[member.id].y += 42; }
      const lane = lanes.find(item => item.name === name);
      if (lane) { result[lane.id] = { x, y: 0 }; lane.meta = { ...lane.meta, activityLayout: true, width }; }
      x += width;
    }
    const height = Math.max(100, ...[...nodes.keys()].map(id => result[id].y + sizes.get(id)!.height)) + 24;
    for (const lane of lanes) lane.meta!.height = height;
  }

  const collides = (point: Point, size: Size, skip?: string) => [...nodes.keys(), ...notes.map(note => note.id)].some(id => {
    if (id === skip || !result[id]) return false;
    const other = result[id], dimensions = sizes.get(id)!;
    return point.x < other.x + dimensions.width + 12 && point.x + size.width + 12 > other.x && point.y < other.y + dimensions.height + 12 && point.y + size.height + 12 > other.y;
  });
  for (const note of notes) {
    const anchor = String(note.meta?.attachTo ?? ''), anchorPoint = result[anchor], size = sizes.get(note.id)!;
    const point = anchorPoint ? { x: anchorPoint.x + sizes.get(anchor)!.width + 28, y: anchorPoint.y } : { x: componentX, y: 0 };
    if (collides(point, size, note.id)) point.x = Math.max(componentX, ...[...nodes.keys()].map(id => result[id].x + sizes.get(id)!.width)) + 28;
    while (collides(point, size, note.id)) point.y += size.height + 20;
    result[note.id] = point;
  }

  // Partitions wrap already laid-out flow; they never replace it with a second grid.
  const partitions = [...containers.values()].filter(element => element.kind !== 'swimlane').sort((a, b) => parents(b.id).length - parents(a.id).length);
  for (const partition of partitions) {
    const members = block.elements.filter(element => element.parentId === partition.id && result[element.id]);
    if (!members.length) {
      result[partition.id] = { x: componentX, y: 0 }; partition.meta = { ...partition.meta, activityLayout: true, width: 170, height: 80 }; componentX += 210; continue;
    }
    const left = Math.min(...members.map(node => result[node.id].x)) - GROUP_X;
    const top = Math.min(...members.map(node => result[node.id].y)) - GROUP_TOP;
    const right = Math.max(...members.map(node => result[node.id].x + Number(node.meta?.width ?? 120))) + GROUP_X;
    const bottom = Math.max(...members.map(node => result[node.id].y + Number(node.meta?.height ?? 36))) + GROUP_BOTTOM;
    result[partition.id] = { x: left, y: top }; partition.meta = { ...partition.meta, activityLayout: true, width: Math.max(150, right - left), height: bottom - top };
  }

  const center = (id: string) => result[id].x + sizes.get(id)!.width / 2;
  const nodeBounds = [...nodes.keys()].map(id => ({ id, x: result[id].x, y: result[id].y, ...sizes.get(id)! }));
  const diagramCenter = nodeBounds.length ? (Math.min(...nodeBounds.map(item => item.x)) + Math.max(...nodeBounds.map(item => item.x + item.width))) / 2 : 0;
  const loopTracks = new Map<string, number>();
  for (const edge of edges) {
    const source = nodes.get(edge.source)!, target = nodes.get(edge.target)!, a = result[source.id], b = result[target.id];
    const dx = center(target.id) - center(source.id);
    let route: Route = { kind: 'flow', sourceHandle: 'bottom', targetHandle: 'top' };
    if (back.has(edge.id) || b.y <= a.y) {
      const reachable = distances(target.id), low = Math.min(a.y, b.y), high = Math.max(a.y + sizes.get(source.id)!.height, b.y + sizes.get(target.id)!.height);
      const region = nodeBounds.filter(item => reachable.has(item.id) && item.y >= low && item.y <= high);
      const left = Math.min(a.x, b.x, ...region.map(item => item.x)), right = Math.max(a.x + sizes.get(source.id)!.width, b.x + sizes.get(target.id)!.width, ...region.map(item => item.x + item.width));
      const side = (left + right) / 2 < diagramCenter - 1 ? 'left' : 'right';
      const trackKey = `${side}:${Math.round(side === 'left' ? left : right)}`;
      const track = loopTracks.get(trackKey) ?? 0; loopTracks.set(trackKey, track + 1);
      const clearance = 24 + track * 16, laneX = side === 'left' ? left - clearance : right + clearance;
      route = { kind: 'loop', sourceHandle: source.kind === 'merge' || source.id === target.id ? 'bottom' : side, targetHandle: side, side, clearance, laneX };
    } else if (source.kind === 'decision' && source.meta?.control === 'while' && paired.get(source.id) === target.id) {
      const body = nodeBounds.filter(item => item.y > a.y && item.y < b.y && distances(source.id).has(item.id));
      const laneX = Math.min(a.x, b.x, ...body.map(item => item.x)) - 28;
      route = { kind: 'loop', sourceHandle: 'left', targetHandle: 'left', side: 'left', clearance: 28, laneX };
    } else if ((forward.get(source.id)?.length ?? 0) > 1 && !['fork', 'join'].includes(source.kind)) {
      route = { kind: 'branch', sourceHandle: dx < -1 ? 'left' : dx > 1 ? 'right' : 'bottom', targetHandle: target.kind === 'merge' && Math.abs(dx) < 1 ? 'right' : 'top' };
      if (paired.get(source.id) === target.id && Math.abs(dx) < 1) {
        const body = nodeBounds.filter(item => item.y > a.y && item.y < b.y);
        const side = body.reduce((sum, item) => sum + item.x + item.width / 2 - center(source.id), 0) <= 0 ? 'right' : 'left';
        route = { kind: 'loop', sourceHandle: side, targetHandle: side, side, clearance: 24, laneX: side === 'left' ? Math.min(a.x, b.x, ...body.map(item => item.x)) - 24 : Math.max(a.x + sizes.get(source.id)!.width, b.x + sizes.get(target.id)!.width, ...body.map(item => item.x + item.width)) + 24 };
      }
    } else if (target.kind === 'merge' && (incoming.get(target.id)?.length ?? 0) > 1 && Math.abs(dx) > 1) route = { kind: 'merge', sourceHandle: 'bottom', targetHandle: dx > 0 ? 'left' : 'right' };
    edge.meta = { ...edge.meta, sourceHandle: route.sourceHandle, targetHandle: route.targetHandle, activityRoute: route };
  }

  // A bar exposes a real port above/below each branch center instead of fanning out
  // from one center handle. The renderer keeps these offsets relative while dragging.
  for (const bar of nodes.values()) {
    if (bar.kind !== 'fork' && bar.kind !== 'join') continue;
    const parallel = bar.kind === 'fork' ? (forward.get(bar.id) ?? []) : (incoming.get(bar.id) ?? []).filter(edge => !back.has(edge.id));
    const ports: { id: string; side: 'top' | 'bottom'; offset: number }[] = [];
    for (const [index, edge] of parallel.entries()) {
      const source = bar.kind === 'fork', other = source ? edge.target : edge.source, side = source ? 'bottom' : 'top';
      const id = `activity-${source ? 'out' : 'in'}-${index}`;
      ports.push({ id, side, offset: Math.max(5, Math.min(sizes.get(bar.id)!.width - 5, center(other) - result[bar.id].x)) });
      edge.meta = { ...edge.meta, [source ? 'sourceHandle' : 'targetHandle']: id, activityRoute: { kind: 'flow', sourceHandle: 'bottom', targetHandle: 'top' } };
    }
    bar.meta = { ...bar.meta, activityPorts: ports };
  }

  const loopXs = edges.map(edge => (edge.meta?.activityRoute as Route | undefined)?.laneX).filter((x): x is number => x !== undefined);
  const offsetX = 50 - Math.min(0, ...Object.values(result).map(point => point.x), ...loopXs), offsetY = 44 - Math.min(0, ...Object.values(result).map(point => point.y));
  for (const point of Object.values(result)) { point.x += offsetX; point.y += offsetY; }
  for (const edge of edges) { const route = edge.meta?.activityRoute as Route; if (route.laneX !== undefined) route.laneX += offsetX; }
  block.meta = { ...block.meta, activityLayout: true };
  return result;
}
