import type { DiagramBlock, DiagramElement, DiagramRelation, Point } from '../shared/protocol';
import { codeLines } from './syntax';
import { measureLabel } from './label-metrics';
import { clearCompoundSightlines } from './compound-layout';

interface Size { width: number; height: number }
/** A bend sequence for one relationship, contributed by one nesting level. */
interface RouteFragment { relation: DiagramRelation; side: 'source' | 'common' | 'target'; depth: number; points: Point[] }
interface Layout extends Size { points: Record<string, Point>; routes: RouteFragment[] }
interface Link {
  source: string; target: string; axis: 'x' | 'y'; clearance?: number; sourceOffset?: number; targetOffset?: number;
  /** The relationship this link ranks; absent for invisible ordering constraints. */
  relation?: DiagramRelation;
  /** True when a direction hint or generalization swapped the ranked endpoints. */
  flipped?: boolean;
  side?: RouteFragment['side'];
}
const laneWidth = 18;
const phantomPrefix = '\u0000outside:';
const gap = 70;
const siblingGap = 32;

/** The canvas uses these dimensions too, so ranking measures the visible boxes. */
export function graphElementSize(element: DiagramElement): Size {
  if (element.meta?.procedure || element.meta?.standaloneTitle) return { width: Number(element.meta.width) || 192, height: Number(element.meta.height) || 90 };
  const kind = String(element.meta?.shape ?? element.kind).replace(/^abstract class$/, 'abstract');
  const control: Record<string, Size> = {
    start: { width: 24, height: 24 }, initial: { width: 24, height: 24 },
    end: { width: 28, height: 28 }, final: { width: 28, height: 28 },
    merge: { width: 24, height: 24 }, decision: { width: 68, height: 68 },
    fork: { width: 140, height: 8 }, join: { width: 140, height: 8 },
  };
  if (control[kind]) return control[kind];
  if (element.meta?.symbolNotation) {
    const width = Math.ceil(Math.max(kind === 'interface' ? 80 : 94, Math.min(150, measureLabel(element.name, Infinity).width + 24)));
    const label = measureLabel(element.name, width - 20);
    return { width, height: Math.ceil(label.height + (kind === 'interface' ? 38 : 62)) };
  }
  if (/^(?:c4|archimate|dot)-/.test(element.kind)) return { width: Number(element.meta?.width) || 220, height: Number(element.meta?.height) || 90 };
  let width = ['actor', 'person'].includes(kind) ? 125 : 192;
  if (['stack', 'card', 'queue', 'cloud', 'database'].includes(kind)) {
    const inset = kind === 'stack' ? 32 : 40;
    width = Math.ceil(Math.max(kind === 'stack' ? 110 : 128, Math.min(320, measureLabel(element.name, Infinity).width + inset)));
  }
  const label = measureLabel(element.name, width - (kind === 'usecase' ? 40 : 24));
  const titleHeight = 24 + label.height + (element.meta?.stereotype || ['interface', 'enum', 'entity', 'annotation'].includes(kind) ? 17 : 0);
  const fieldsOnly = kind === 'object' || kind === 'entity';
  const compartment = ['class', 'abstract', 'interface', 'enum', 'enumeration', 'object', 'entity', 'annotation'].includes(kind);
  const wrapped = (lines: string[]) => lines.reduce((count, line) => count + Math.max(1, Math.ceil(line.replace(/\{(?:field|method)\}/g, '').length / 26)), 0);
  let height = titleHeight;
  if (compartment && !element.meta?.hiddenMembers) {
    const fields = fieldsOnly ? element.members : element.members.filter(line => !/\(|\{method\}/.test(line));
    const methods = fieldsOnly ? [] : element.members.filter(line => /\(|\{method\}/.test(line));
    if (!element.meta?.hiddenFields) height += Math.max(32, 14 + wrapped(fields) * 19);
    if (!fieldsOnly && !element.meta?.hiddenMethods) height += Math.max(32, 14 + wrapped(methods) * 19);
  } else if (element.members.length) height += 17 + wrapped(element.members) * 16;
  if (['actor', 'person'].includes(kind)) height += 65;
  if (kind === 'database') height = Math.max(100, height + 30);
  if (kind === 'cloud') height = Math.max(90, height + 20);
  if (kind === 'usecase') height = Math.max(74, height + 4);
  if (kind === 'artifact') height += 18;
  height = Math.ceil(height + 3);
  if (kind === 'usecase') width = Math.min(320, Math.max(width, Math.ceil(height * 1.25)));
  return { width, height };
}

function layoutDirectives(block: DiagramBlock): string[] {
  const result: string[] = [];
  let inProcedure = false;
  for (const [index, line] of codeLines(block.source).entries()) {
    if (/^\s*!(?:procedure|function)\b/i.test(line)) { inProcedure = true; continue; }
    if (inProcedure) { if (/^\s*!end(?:procedure|function)\b/i.test(line)) inProcedure = false; continue; }
    const absolute = index + block.startLine;
    if (block.elements.some(element => !element.meta?.container && absolute > element.startLine && absolute <= element.endLine)) continue;
    result.push(line);
  }
  return result;
}

function horizontal(block: DiagramBlock): boolean {
  let value = block.meta?.direction === 'LR' || block.meta?.direction === 'RL';
  for (const line of layoutDirectives(block)) {
    if (/^\s*(?:left to right direction|LAYOUT_LEFT_RIGHT\s*\()/i.test(line)) value = true;
    if (/^\s*(?:top to bottom direction|LAYOUT_TOP_DOWN\s*\()/i.test(line)) value = false;
  }
  return value;
}

function direction(block: DiagramBlock, relation: DiagramRelation, across: boolean): Link {
  const arrow = relation.arrow.replace(/\[[^\]]*\]/g, '');
  const span = (block.meta?.relationSpans as Record<string, { macro?: string }> | undefined)?.[relation.id];
  const hint = arrow.match(/(?:[-.=])(left|right|up|down|le|ri|do|l|r|u|d)(?=[-.=<>|o*{])/i)?.[1]?.toLowerCase()
    ?? span?.macro?.match(/_(Left|Right|Up|Down|L|R|U|D)$/i)?.[1]?.toLowerCase();
  let source = relation.source, target = relation.target;
  let axis: 'x' | 'y';
  let flipped = false;
  if (block.kind === 'c4' && /_Neighbor$/i.test(span?.macro ?? '')) {
    axis = across ? 'y' : 'x';
  } else if (hint) {
    axis = /^[lr]/.test(hint) ? 'x' : 'y';
    if (/^[lu]/.test(hint)) { [source, target] = [target, source]; flipped = true; }
  } else {
    // PlantUML's short graph links occupy one rank (the state gallery uses ->).
    const short = block.kind !== 'dot' && (arrow.match(/[-.=]/g)?.length ?? 0) === 1;
    axis = across !== short ? 'x' : 'y';
    // A generalization points to its parent, which belongs above its descendants.
    if (/[.=-]+\|>$/.test(arrow)) { [source, target] = [target, source]; flipped = true; }
  }
  const clearance = axis === 'x' && relation.label ? Math.max(90, measureLabel(relation.label, 240, 10).width + 40) : gap;
  return { source, target, axis, clearance, relation, flipped, side: 'common' };
}

/** Stable union and ranking; feedback edges do not pull an entire cycle into one row. */
function ranks(ids: string[], links: Link[], main: 'x' | 'y'): Map<string, number> {
  const parent = new Map(ids.map(id => [id, id]));
  const find = (id: string): string => { const next = parent.get(id)!; if (next !== id) parent.set(id, find(next)); return parent.get(id)!; };
  for (const edge of links) if (edge.axis !== main) parent.set(find(edge.target), find(edge.source));
  const groups = [...new Set(ids.map(find))];
  const outgoing = new Map(groups.map(id => [id, [] as string[]]));
  for (const edge of links) if (edge.axis === main) {
    const source = find(edge.source), target = find(edge.target);
    if (source !== target && !outgoing.get(source)!.includes(target)) outgoing.get(source)!.push(target);
  }
  const state = new Map<string, number>(), order: string[] = [], forward = new Map<string, string[]>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const target of outgoing.get(id)!) {
      if (state.get(target) === 1) continue;
      forward.set(id, [...forward.get(id) ?? [], target]);
      if (!state.has(target)) visit(target);
    }
    state.set(id, 2); order.push(id);
  };
  // Start at the natural roots, so a cycle is cut at its feedback edge instead
  // of wherever the first declared element happens to sit.
  const targeted = new Set([...outgoing.values()].flat());
  for (const id of groups) if (!targeted.has(id) && !state.has(id)) visit(id);
  groups.forEach(id => { if (!state.has(id)) visit(id); });
  const levels = new Map(groups.map(id => [id, 0]));
  const topological = order.reverse();
  for (const id of topological) for (const target of forward.get(id) ?? []) levels.set(target, Math.max(levels.get(target)!, levels.get(id)! + 1));
  // Longest-path ranking strands roots at the top. Sink each one toward its
  // successors while that shortens more links than it stretches.
  const inbound = new Map(groups.map(id => [id, 0]));
  for (const targets of forward.values()) for (const target of targets) inbound.set(target, inbound.get(target)! + 1);
  for (const id of [...topological].reverse()) {
    const targets = forward.get(id) ?? [];
    if (!targets.length || targets.length <= inbound.get(id)!) continue;
    const limit = Math.min(...targets.map(target => levels.get(target)!)) - 1;
    if (limit > levels.get(id)!) levels.set(id, limit);
  }
  return new Map(ids.map(id => [id, levels.get(find(id))!]));
}

function connected(ids: string[], links: Link[]): string[][] {
  const neighbors = new Map(ids.map(id => [id, [] as string[]]));
  for (const edge of links) { neighbors.get(edge.source)!.push(edge.target); neighbors.get(edge.target)!.push(edge.source); }
  const seen = new Set<string>(), result: string[][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const queue = [id], group: string[] = []; seen.add(id);
    while (queue.length) { const current = queue.shift()!; group.push(current); for (const neighbor of neighbors.get(current)!) if (!seen.has(neighbor)) { seen.add(neighbor); queue.push(neighbor); } }
    result.push(group);
  }
  return result;
}

interface Chain {
  ids: string[];
  offsets: Map<string, number>;
  width: number;
  start: number;
  order: number;
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** Least-squares compaction with minimum spacing; repeated neighbors remain balanced. */
function compactChains(chains: Chain[], preferred: number[], weights: number[], fixed?: Chain): number[] {
  const minimum: number[] = [];
  chains.forEach((chain, index) => minimum.push(index ? minimum[index - 1] + chains[index - 1].width + siblingGap : 0));
  const values = preferred.map((value, index) => value - minimum[index]);
  const project = (from: number, to: number, bound?: { value: number; minimum: boolean }) => {
    const pools: { from: number; to: number; value: number; weight: number }[] = [];
    for (let index = from; index < to; index++) {
      const value = !bound ? values[index] : bound.minimum ? Math.max(bound.value, values[index]) : Math.min(bound.value, values[index]);
      pools.push({ from: index, to: index + 1, value, weight: weights[index] });
      while (pools.length > 1 && pools.at(-2)!.value > pools.at(-1)!.value) {
        const after = pools.pop()!, before = pools.pop()!, weight = before.weight + after.weight;
        pools.push({ from: before.from, to: after.to, value: (before.value * before.weight + after.value * after.weight) / weight, weight });
      }
    }
    for (const pool of pools) for (let index = pool.from; index < pool.to; index++) values[index] = pool.value;
  };
  const fixedIndex = fixed ? chains.indexOf(fixed) : -1;
  if (fixedIndex < 0) project(0, chains.length);
  else {
    const value = fixed!.start - minimum[fixedIndex];
    project(0, fixedIndex, { value, minimum: false });
    values[fixedIndex] = value;
    project(fixedIndex + 1, chains.length, { value, minimum: true });
  }
  return values.map((value, index) => value + minimum[index]);
}

function arrangeComponent(ids: string[], links: Link[], sizes: Map<string, Size>, across: boolean, depth: number): Layout {
  const main = across ? 'x' : 'y', cross = across ? 'y' : 'x';
  const levels = ranks(ids, links, main);
  // Outside neighbours sit beyond every rank of this scope, so a relationship that
  // leaves the container gets a lane through each rank between its end and the border.
  const inside = ids.filter(id => !id.startsWith(phantomPrefix)).map(id => levels.get(id)!);
  if (inside.length !== ids.length && inside.length) {
    const first = Math.min(...inside), last = Math.max(...inside);
    for (const id of ids) if (id.startsWith(phantomPrefix)) levels.set(id, id.startsWith(`${phantomPrefix}from:`) ? first - 1 : last + 1);
  }
  // Perpendicular fan links are alignment preferences, not equalities: unioning them
  // destroys the explicit ordering of an entire horizontal or vertical pipeline.
  const crossLinks = links.filter(edge => edge.axis === cross);
  // A link that skips ranks gets a narrow lane in every rank it passes, so it is
  // routed between the boxes there instead of straight through them.
  const lanes = new Set<string>(), mainLinks: Link[] = [], routed: { link: Link; lanes: string[] }[] = [];
  const all = [...ids];
  for (const link of links.filter(edge => edge.axis === main)) {
    const from = levels.get(link.source)!, to = levels.get(link.target)!;
    if (Math.abs(to - from) <= 1) { mainLinks.push(link); continue; }
    const step = to > from ? 1 : -1, chain: string[] = [];
    let previous = link.source;
    for (let rank = from + step; rank !== to; rank += step) {
      const id = `\u0000lane:${routed.length}:${rank}`;
      lanes.add(id); all.push(id); levels.set(id, rank); chain.push(id);
      mainLinks.push({ source: previous, target: id, axis: main, sourceOffset: previous === link.source ? link.sourceOffset : 0 });
      previous = id;
    }
    mainLinks.push({ source: previous, target: link.target, axis: main, targetOffset: link.targetOffset, clearance: link.clearance });
    routed.push({ link, lanes: chain });
  }
  const size = (id: string): Size => lanes.has(id) ? { width: across ? 0 : laneWidth, height: across ? laneWidth : 0 } : sizes.get(id)!;
  const crossRanks = ranks(ids, crossLinks, cross);
  const layers = new Map<number, string[]>();
  for (const id of all) { const rank = levels.get(id)!; layers.set(rank, [...layers.get(rank) ?? [], id]); }
  const mainSize = (id: string) => across ? size(id).width : size(id).height;
  const crossSize = (id: string) => across ? size(id).height : size(id).width;
  const ordered = [...layers.entries()].sort(([a], [b]) => a - b).map(([rank, layer]) => {
    const constraints = crossLinks.filter(edge => layer.includes(edge.source) && layer.includes(edge.target));
    return { rank, chains: connected(layer, constraints).map((members, order): Chain => {
      const chainIds = members.sort((a, b) => (crossRanks.get(a) ?? 0) - (crossRanks.get(b) ?? 0) || all.indexOf(a) - all.indexOf(b));
      const offsets = new Map<string, number>(); let width = 0;
      chainIds.forEach((id, index) => {
        offsets.set(id, width); width += crossSize(id);
        const next = chainIds[index + 1];
        if (next) width += Math.max(gap, ...constraints.filter(edge => edge.source === id && edge.target === next || edge.source === next && edge.target === id).map(edge => edge.clearance ?? gap));
      });
      return { ids: chainIds, offsets, width, start: 0, order };
    }) };
  });
  const points: Record<string, Point> = Object.create(null);
  const bands = new Map<number, { start: number; depth: number }>();
  const broadest = Math.max(0, ...ordered.map(({ chains }) => chains.reduce((sum, chain) => sum + chain.width, 0) + (chains.length - 1) * siblingGap));
  let offset = 0;
  for (const { rank, chains } of ordered) {
    const layer = chains.flatMap(chain => chain.ids), bandDepth = Math.max(...layer.map(mainSize));
    const extent = chains.reduce((sum, chain) => sum + chain.width, 0) + (chains.length - 1) * siblingGap;
    let cursor = (broadest - extent) / 2;
    for (const chain of chains) {
      chain.start = cursor;
      for (const id of chain.ids) points[id] = { [main]: offset + (bandDepth - mainSize(id)) / 2, [cross]: cursor + chain.offsets.get(id)! } as unknown as Point;
      cursor += chain.width + siblingGap;
    }
    bands.set(rank, { start: offset, depth: bandDepth });
    const leaving = mainLinks.filter(edge => { const from = levels.get(edge.source)!, to = levels.get(edge.target)!; return Math.min(from, to) === rank && Math.max(from, to) === rank + 1; });
    // A label needs room between two rows as well as between two columns.
    const rankClearance = main === 'x' ? Math.max(gap, ...leaving.map(edge => edge.clearance ?? gap)) : leaving.some(edge => edge.relation?.label) ? gap + 26 : gap;
    offset += bandDepth + rankClearance;
  }
  const center = (id: string) => points[id][cross] + crossSize(id) / 2;
  const attachments = (chain: Chain) => mainLinks.flatMap(edge => {
    const source = chain.offsets.has(edge.source), target = chain.offsets.has(edge.target);
    if (source === target) return [];
    const local = source ? edge.source : edge.target, neighbor = source ? edge.target : edge.source;
    const localOffset = (source ? edge.sourceOffset : edge.targetOffset) ?? 0;
    const neighborOffset = (source ? edge.targetOffset : edge.sourceOffset) ?? 0;
    return [center(neighbor) + neighborOffset - chain.offsets.get(local)! - crossSize(local) / 2 - localOffset];
  });
  // Keep the strongest directed chain rigid while balancing its surrounding rows.
  // A fan may move a row toward the chain, but cannot pull one end away from it.
  const real = (chain: Chain) => chain.ids.some(id => !lanes.has(id) && !id.startsWith(phantomPrefix));
  const strength = (chain: Chain) => [real(chain) ? 1 : 0, crossLinks.filter(edge => chain.offsets.has(edge.source) && chain.offsets.has(edge.target)).length, attachments(chain).length, chain.width];
  const anchor = ordered.flatMap(layer => layer.chains).reduce<Chain | undefined>((best, chain) => {
    if (!best) return chain;
    const previous = strength(best), next = strength(chain);
    for (let index = 0; index < next.length; index++) { if (next[index] > previous[index]) return chain; if (next[index] < previous[index]) return best; }
    return best;
  }, undefined);
  for (let pass = 0; pass < 8; pass++) {
    for (const { chains } of pass % 2 ? [...ordered].reverse() : ordered) {
      const preferences = new Map(chains.map(chain => { const neighbors = attachments(chain); return [chain, { start: chain === anchor || !neighbors.length ? chain.start : median(neighbors), weight: Math.max(1, Math.min(5, neighbors.length)) }]; }));
      chains.sort((a, b) => preferences.get(a)!.start + a.width / 2 - preferences.get(b)!.start - b.width / 2 || a.order - b.order);
      const starts = compactChains(chains, chains.map(chain => preferences.get(chain)!.start), chains.map(chain => preferences.get(chain)!.weight), chains.includes(anchor!) ? anchor : undefined);
      chains.forEach((chain, index) => {
        chain.start = starts[index];
        for (const id of chain.ids) points[id][cross] = chain.start + chain.offsets.get(id)!;
      });
    }
  }
  const routes: RouteFragment[] = routed.filter(({ link }) => link.relation).map(({ link, lanes: chain }) => {
    const bends = chain.flatMap(id => {
      const band = bands.get(levels.get(id)!)!, at = center(id);
      const enter = { [main]: band.start, [cross]: at } as unknown as Point, leave = { [main]: band.start + band.depth, [cross]: at } as unknown as Point;
      const pair = levels.get(link.target)! > levels.get(link.source)! ? [enter, leave] : [leave, enter];
      return band.depth < 1 ? [pair[0]] : pair;
    });
    return { relation: link.relation!, side: link.side ?? 'common', depth, points: link.flipped ? bends.reverse() : bends };
  });
  // Outside neighbours only steer this scope; they are not part of its extent.
  const kept = all.filter(id => !id.startsWith(phantomPrefix));
  for (const id of all) if (id.startsWith(phantomPrefix)) delete points[id];
  const minX = Math.min(...kept.map(id => points[id].x)), minY = Math.min(...kept.map(id => points[id].y));
  for (const id of kept) { points[id].x -= minX; points[id].y -= minY; }
  for (const route of routes) for (const point of route.points) { point.x -= minX; point.y -= minY; }
  const layout = { points, routes, width: Math.max(...kept.map(id => points[id].x + size(id).width)), height: Math.max(...kept.map(id => points[id].y + size(id).height)) };
  for (const id of lanes) delete points[id];
  return layout;
}

/** Flow independent groups into rows (or columns for left-to-right diagrams). */
function pack(components: Layout[], across: boolean, single: boolean): { offsets: Point[]; width: number; height: number } {
  const length = (layout: Layout) => across ? layout.height : layout.width, breadth = (layout: Layout) => across ? layout.width : layout.height;
  const area = components.reduce((sum, layout) => sum + (layout.width + gap) * (layout.height + gap), 0);
  const limit = single ? Infinity : Math.max(...components.map(length), Math.sqrt(area) * 1.5);
  const offsets: Point[] = [];
  let cursor = 0, line = 0, lineBreadth = 0, extent = 0;
  for (const component of components) {
    if (cursor > 0 && cursor + length(component) > limit) { cursor = 0; line += lineBreadth + gap; lineBreadth = 0; }
    offsets.push(across ? { x: line, y: cursor } : { x: cursor, y: line });
    extent = Math.max(extent, cursor + length(component));
    cursor += length(component) + gap; lineBreadth = Math.max(lineBreadth, breadth(component));
  }
  return across ? { offsets, width: line + lineBreadth, height: extent } : { offsets, width: extent, height: line + lineBreadth };
}

/** Native layered graph layout, including topology inside and between nested containers. */
export function layoutGraph(block: DiagramBlock): Record<string, Point> {
  const across = horizontal(block), elements = new Map(block.elements.map(element => [element.id, element]));
  const sizes = new Map<string, Size>(), nested = new Map<string, Layout>();
  for (const relation of block.relations) if (relation.meta) { delete relation.meta.route; delete relation.meta.routeAnchor; }
  const allLinks = block.relations.filter(edge => elements.has(edge.source) && elements.has(edge.target)).map(edge => direction(block, edge, across));
  // C4's Lay_* macros are invisible ordering constraints, not visible relationships.
  for (const line of layoutDirectives(block)) {
    const match = line.match(/^\s*Lay_(L|R|U|D)\s*\(\s*([\w.]+)\s*,\s*([\w.]+)\s*\)/i);
    if (match) { const reverse = /[LU]/i.test(match[1]); allLinks.push({ source: match[reverse ? 3 : 2], target: match[reverse ? 2 : 3], axis: /[LR]/i.test(match[1]) ? 'x' : 'y' }); }
  }
  const ancestor = (id: string, roots: Set<string>): string | undefined => {
    const seen = new Set<string>();
    while (!roots.has(id)) { if (seen.has(id)) return; seen.add(id); const parent = elements.get(id)?.parentId; if (!parent) return; id = parent; }
    return id;
  };
  const main = across ? 'x' : 'y';
  const groups = new Map<string | undefined, DiagramElement[]>();
  for (const element of block.elements) { const parent = element.parentId && elements.has(element.parentId) ? element.parentId : undefined; groups.set(parent, [...groups.get(parent) ?? [], element]); }
  const siblings = new Map([...groups].map(([parent, group]) => [parent, new Set(group.map(element => element.id))]));
  // Ranks depend on topology alone, so every scope's order is known before any box is sized.
  const scopeRank = new Map<string, number>();
  for (const roots of siblings.values()) {
    const inner = allLinks.flatMap(edge => { const source = ancestor(edge.source, roots), target = ancestor(edge.target, roots); return source && target && source !== target ? [{ ...edge, source, target }] : []; });
    for (const [id, level] of ranks([...roots], inner, main)) scopeRank.set(id, level);
  }
  /** Whether an outside element ends up before (-1) or after (1) this container along the flow. */
  const sideOf = (container: string, outside: string): number => {
    const seen = new Set<string>();
    for (let current: string | undefined = container; current && !seen.has(current);) {
      seen.add(current);
      const parent: string | undefined = elements.get(current)?.parentId && elements.has(elements.get(current)!.parentId!) ? elements.get(current)!.parentId : undefined;
      const other = ancestor(outside, siblings.get(parent)!);
      if (other && other !== current) return Math.sign(scopeRank.get(other)! - scopeRank.get(current)!);
      current = parent;
    }
    return 0;
  };
  const scope = (parentId?: string, depth = 0): Layout => {
    const group = groups.get(parentId) ?? [];
    if (!group.length) return { points: Object.create(null), routes: [], width: 0, height: 0 };
    for (const element of group) {
      if (element.meta?.container) {
        const children = scope(element.id, depth + 1); nested.set(element.id, children);
        const size = { width: Math.max(260, children.width + 60), height: Math.max(150, children.height + 100) };
        sizes.set(element.id, size); element.meta = { ...element.meta, ...size };
      } else {
        const size = graphElementSize(element); sizes.set(element.id, size); element.meta = { ...element.meta, ...size };
      }
    }
    const roots = new Set(group.map(element => element.id));
    // Align to the actual descendant connected by a relationship, rather than
    // the center of a boundary that may also contain an unrelated side column.
    const attachmentOffset = (id: string, root: string) => {
      if (id === root) return 0;
      const point = nested.get(root)?.points[id], size = sizes.get(id), rootSize = sizes.get(root);
      if (!point || !size || !rootSize) return 0;
      return across ? point.y + 70 + size.height / 2 - rootSize.height / 2 : point.x + 30 + size.width / 2 - rootSize.width / 2;
    };
    const links = allLinks.flatMap((edge): Link[] => {
      const source = ancestor(edge.source, roots), target = ancestor(edge.target, roots);
      if (source && target) return source !== target ? [{ ...edge, source, target, sourceOffset: attachmentOffset(edge.source, source), targetOffset: attachmentOffset(edge.target, target) }] : [];
      // A relationship leaving this container still decides which of its children
      // sit on the near side, so the far endpoint takes part as a sizeless neighbour.
      if (!parentId || edge.axis !== main || !source && !target) return [];
      // Where the far end really sits decides the side: a feedback link enters from below
      // although it points at this container, so the arrow's direction alone would mislead.
      const inner = (source ?? target)!, far = source ? edge.target : edge.source, where = sideOf(parentId, far);
      if (!where) return [];
      const outside = `${phantomPrefix}${where < 0 ? 'from' : 'to'}:${far}`, offset = attachmentOffset(source ? edge.source : edge.target, inner);
      sizes.set(outside, { width: 0, height: 0 });
      // The ranked source is the relationship's target when a hint flipped it.
      const startsInside = Boolean(source) !== Boolean(edge.flipped);
      // Bends are produced along the flow; the relationship may run against it.
      const flipped = startsInside ? where < 0 : where > 0, side = startsInside ? 'source' : 'target';
      return [where > 0 ? { ...edge, source: inner, target: outside, side, flipped, sourceOffset: offset, targetOffset: 0 } : { ...edge, source: outside, target: inner, side, flipped, sourceOffset: 0, targetOffset: offset }];
    });
    const phantoms = [...new Set(links.flatMap(edge => [edge.source, edge.target]).filter(id => id.startsWith(phantomPrefix)))];
    const parts = connected([...roots, ...phantoms], links);
    const isolated = parts.filter(ids => ids.length === 1), linked = parts.filter(ids => ids.length > 1);
    const components = linked.map(ids => arrangeComponent(ids, links.filter(edge => ids.includes(edge.source) && ids.includes(edge.target)), sizes, across, depth));
    if (isolated.length) {
      // PlantUML packs isolated symbols as a compact gallery; independent boundaries form a row.
      const singles = isolated.map(([id]) => ({ id, ...sizes.get(id)! }));
      const columns = singles.every(item => elements.get(item.id)?.meta?.container) ? singles.length : Math.ceil(Math.sqrt(singles.length));
      const columnWidths = Array.from({ length: columns }, (_, column) => Math.max(...singles.filter((_, index) => index % columns === column).map(item => item.width)));
      const gallery: Layout = { points: Object.create(null), routes: [], width: 0, height: 0 };
      let x = 0, y = 0, rowHeight = 0;
      singles.forEach((item, index) => {
        if (index && index % columns === 0) { x = 0; y += rowHeight + gap; rowHeight = 0; }
        gallery.points[item.id] = { x, y };
        gallery.width = Math.max(gallery.width, x + item.width); x += columnWidths[index % columns] + gap; rowHeight = Math.max(rowHeight, item.height);
      });
      gallery.height = y + rowHeight;
      components.push(gallery);
    }
    const packed = pack(components, across, components.length === 1);
    const points: Record<string, Point> = Object.create(null), routes: RouteFragment[] = [];
    components.forEach((component, index) => {
      const origin = packed.offsets[index];
      for (const route of component.routes) { for (const point of route.points) { point.x += origin.x; point.y += origin.y; } routes.push(route); }
      for (const [id, point] of Object.entries(component.points)) {
        points[id] = { x: origin.x + point.x, y: origin.y + point.y };
        const inner = nested.get(id);
        if (!inner) continue;
        for (const [child, childPoint] of Object.entries(inner.points)) points[child] = { x: points[id].x + 30 + childPoint.x, y: points[id].y + 70 + childPoint.y };
        for (const route of inner.routes) { for (const point of route.points) { point.x += points[id].x + 30; point.y += points[id].y + 70; } routes.push(route); }
      }
    });
    return { points, routes, width: packed.width, height: packed.height };
  };
  const { points: result, routes } = scope();
  const compound = block.kind === 'c4' && (!block.meta?.lineType || ['straight', 'polyline'].includes(String(block.meta.lineType)));
  if (compound) clearCompoundSightlines(block, result, across, allLinks);
  for (const point of Object.values(result)) { point.x += 80; point.y += 70; }
  // The sightline pass moves whole subtrees afterwards, which invalidates lanes.
  if (!compound) {
    const order = (fragment: RouteFragment) => fragment.side === 'source' ? -fragment.depth - 1 : fragment.side === 'common' ? 0 : fragment.depth + 1;
    const byRelation = new Map<DiagramRelation, RouteFragment[]>();
    for (const fragment of routes) byRelation.set(fragment.relation, [...byRelation.get(fragment.relation) ?? [], fragment]);
    for (const [relation, fragments] of byRelation) {
      if (!result[relation.source] || !result[relation.target]) continue;
      const bends = fragments.sort((a, b) => order(a) - order(b)).flatMap(fragment => fragment.points.map(point => ({ x: Math.round(point.x + 80), y: Math.round(point.y + 70) })));
      relation.meta = { ...relation.meta, route: bends, routeAnchor: { source: { ...result[relation.source] }, target: { ...result[relation.target] } } };
    }
  }
  return result;
}
