import { useEffect, useRef } from 'react';
import { Panel, ViewportPortal, useInternalNode, type NodeChange } from '@xyflow/react';
import type { DiagramBlock, Point } from '../shared/protocol';
import { containerTargets } from '../core/containment';
import { applyDiagramEdit } from '../core/edits';
import { dropContainer, freeSpot, snapBox, type Box, type Guide } from './arrange';
import type { UmlNode } from './nodes';

/** The containers this element can really be written into: the edit itself decides, so a preview never promises a move that is then refused. */
function movableInto(source: string, diagram: DiagramBlock, elementId: string) {
  return containerTargets(source, diagram, elementId)?.filter(target => {
    try { applyDiagramEdit(source, diagram.id, { type: 'moveToContainer', elementId, parentId: target.id }); return true; } catch { return false; }
  });
}

/** Snap distance in screen pixels, so snapping feels the same at every zoom. */
const snapDistance = 6;
/** How far past its container, in screen pixels, an element is dragged before the container lets go of it. */
const leaveDistance = 48;

/** The box a node is fitted and snapped with: its fitted size when it has one, else what was rendered. */
export const nodeBox = (node: UmlNode): Box => ({ ...node.position, width: Number(node.data.element.meta?.width ?? node.measured?.width ?? 192), height: Number(node.data.element.meta?.height ?? node.measured?.height ?? 80) });

const parentOf = (nodes: ReadonlyMap<string, UmlNode>, id: string) => nodes.get(id)?.data.element.parentId;
const subtree = (nodes: readonly UmlNode[], id: string): Set<string> => {
  const ids = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const node of nodes) if (node.data.element.parentId && ids.has(node.data.element.parentId) && !ids.has(node.id)) { ids.add(node.id); grew = true; } }
  return ids;
};

/** Where the pointer is and whether Alt is held, read before React Flow handles the same move. */
export function usePointer() {
  const pointer = useRef({ x: 0, y: 0, alt: false });
  useEffect(() => {
    const track = (event: PointerEvent) => { pointer.current = { x: event.clientX, y: event.clientY, alt: event.altKey }; };
    const key = (event: KeyboardEvent) => { pointer.current = { ...pointer.current, alt: event.altKey }; };
    window.addEventListener('pointermove', track, true); window.addEventListener('pointerdown', track, true);
    window.addEventListener('keydown', key, true); window.addEventListener('keyup', key, true);
    return () => { window.removeEventListener('pointermove', track, true); window.removeEventListener('pointerdown', track, true); window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', key, true); };
  }, []);
  return pointer;
}

/** Shift the dragged nodes so their edges or centres meet those of the nodes standing still. */
export function snapDrag(changes: NodeChange<UmlNode>[], nodes: readonly UmlNode[], zoom: number, alsoMoving: ReadonlySet<string> = new Set()): { changes: NodeChange<UmlNode>[]; guides: Guide[] } {
  const dragged = changes.flatMap(change => change.type === 'position' && change.position ? [{ id: change.id, position: change.position }] : []);
  if (!dragged.length) return { changes, guides: [] };
  const byId = new Map(nodes.map(node => [node.id, node])), moving = new Set(dragged.map(change => change.id));
  // Contents follow a dragged container and containers are fitted around it: neither stands still.
  const still = (node: UmlNode) => {
    if (moving.has(node.id) || alsoMoving.has(node.id) || node.hidden || node.selectable === false) return false;
    for (let at = node.data.element.parentId, steps = 0; at && steps < 64; at = parentOf(byId, at), steps++) if (moving.has(at)) return false;
    return !dragged.some(change => { for (let at = parentOf(byId, change.id), steps = 0; at && steps < 64; at = parentOf(byId, at), steps++) if (at === node.id) return true; return false; });
  };
  const boxes = dragged.flatMap(change => byId.has(change.id) ? [{ ...nodeBox(byId.get(change.id)!), ...change.position }] : []);
  if (!boxes.length) return { changes, guides: [] };
  const left = Math.min(...boxes.map(box => box.x)), top = Math.min(...boxes.map(box => box.y));
  const union = { x: left, y: top, width: Math.max(...boxes.map(box => box.x + box.width)) - left, height: Math.max(...boxes.map(box => box.y + box.height)) - top };
  const { dx, dy, guides } = snapBox(union, nodes.filter(still).map(nodeBox), snapDistance / zoom, { x: !dragged.some(change => byId.get(change.id)?.data.element.meta?.lockX), y: true });
  if (!dx && !dy) return { changes, guides };
  return { changes: changes.map(change => change.type === 'position' && change.position && moving.has(change.id) ? { ...change, position: { x: change.position.x + dx, y: change.position.y + dy }, ...(change.positionAbsolute ? { positionAbsolute: { x: change.positionAbsolute.x + dx, y: change.positionAbsolute.y + dy } } : {}) } : change), guides };
}

/** One element dragged on its own, which may change container when it is dropped. */
export interface DragSession {
  id: string; original?: string; current?: string; blocked?: string;
  allowed: Set<string>; containers: Map<string, Box>; parents: Map<string, string | undefined>;
  /** Containers the element was shown in during this drag; each is refitted until it ends. */
  touched: Set<string>;
}

export function startSession(source: string, diagram: DiagramBlock, nodes: readonly UmlNode[], id: string): DragSession | undefined {
  const targets = movableInto(source, diagram, id), node = nodes.find(item => item.id === id);
  if (!targets || !node) return undefined;
  const own = subtree(nodes, id);
  const containers = new Map(nodes.filter(item => item.data.element.meta?.container && !own.has(item.id)).map(item => [item.id, nodeBox(item)]));
  const session: DragSession = { id, original: node.data.element.parentId, current: node.data.element.parentId, allowed: new Set(targets.map(target => target.id)), containers, parents: new Map(nodes.map(item => [item.id, item.data.element.parentId])), touched: new Set() };
  touch(session);
  return session;
}

function touch(session: DragSession) {
  for (let at = session.current; at !== undefined && !session.touched.has(at); at = session.parents.get(at)) session.touched.add(at);
}

/** Follow the pointer to the container the element would be dropped into now. */
export function followDrag(session: DragSession, pointer: Point, box: Box, zoom: number): void {
  const { parentId, blocked } = dropContainer({ pointer, box, original: session.original, current: session.current, containers: session.containers, parents: session.parents, allowed: session.allowed, margin: leaveDistance / zoom });
  session.current = parentId; session.blocked = blocked;
  touch(session);
}

/** What a session's drop would do, in words, and which container to highlight. */
export function dropFeedback(session: DragSession, nodes: readonly UmlNode[]): { target?: string; hint?: string; blocked?: boolean } {
  // A concurrent region has no name of its own; it is part of its state.
  const name = (id: string | undefined): string => { const element = nodes.find(node => node.id === id)?.data.element; return !element ? '' : element.kind === 'state-region' ? name(element.parentId) : `“${element.name || element.kind}”`; };
  if (session.blocked) return { target: session.blocked, blocked: true, hint: `${name(session.blocked)} cannot hold ${name(session.id)} in the source. Release to keep it in ${session.original ? name(session.original) : 'the top level'}.` };
  if (session.current === session.original) return {};
  if (session.current) return { target: session.current, hint: `Release to move ${name(session.id)} into ${name(session.current)} · drag back to keep it where it was` };
  return { hint: `Release to take ${name(session.id)} out of ${name(session.original)} to the top level · drag back onto it to keep it inside` };
}

/**
 * Where an element moved from the menu lands: under the target's contents, or beside the whole
 * arrangement when it leaves its container. Its own contents travel with it.
 */
export function menuPlacement(nodes: readonly UmlNode[], id: string, parentId: string | undefined): Record<string, Point> {
  const own = subtree(nodes, id), node = nodes.find(item => item.id === id);
  if (!node) return {};
  const others = nodes.filter(item => !own.has(item.id));
  const target = parentId ? others.find(item => item.id === parentId) : undefined;
  const siblings = others.filter(item => item.data.element.parentId === parentId && parentId !== undefined).map(nodeBox);
  const spot = target && !siblings.length ? { x: target.position.x + 30, y: target.position.y + 70 } : freeSpot(others.filter(item => !item.data.element.parentId).map(nodeBox), siblings);
  const dx = spot.x - node.position.x, dy = spot.y - node.position.y;
  return Object.fromEntries(nodes.filter(item => own.has(item.id)).map(item => [item.id, { x: item.position.x + dx, y: item.position.y + dy }]));
}

/**
 * The contents of the containers an element leaves and joins, where they are shown now. A changed
 * group is ranked afresh by the automatic layout; saving them keeps the scene the user arranged.
 */
export function groupPlacements(nodes: readonly UmlNode[], containers: readonly (string | undefined)[], pinned: (id: string) => boolean): Record<string, Point> {
  const inside = new Set<string>();
  for (const id of containers) if (id !== undefined) for (const member of subtree(nodes, id)) if (member !== id) inside.add(member);
  return Object.fromEntries(nodes.filter(node => inside.has(node.id) && !pinned(node.id)).map(node => [node.id, { ...node.position }]));
}

export interface DragFeedback { guides: Guide[]; target?: string; hint?: string; blocked?: boolean }

function TargetOutline({ id, blocked }: { id: string; blocked?: boolean }) {
  const node = useInternalNode<UmlNode>(id);
  if (!node) return null;
  const { x, y } = node.internals.positionAbsolute;
  return <rect className={`drop-target ${blocked ? 'blocked' : ''}`} x={x - 4} y={y - 4} width={(node.measured.width ?? 0) + 8} height={(node.measured.height ?? 0) + 8} rx={6} vectorEffect="non-scaling-stroke" />;
}

/** Snap guides and the highlighted drop target, drawn over the diagram while something is dragged. */
export function DragOverlay({ feedback }: { feedback?: DragFeedback }) {
  if (!feedback || !feedback.guides.length && !feedback.target && !feedback.hint) return null;
  return <>
    <ViewportPortal>
      <svg className="drag-overlay" aria-hidden="true">
        {feedback.target && <TargetOutline id={feedback.target} blocked={feedback.blocked} />}
        {feedback.guides.map(guide => guide.axis === 'x'
          ? <line key={`x${guide.at}`} className="snap-guide" x1={guide.at} x2={guide.at} y1={guide.from - 12} y2={guide.to + 12} vectorEffect="non-scaling-stroke" />
          : <line key={`y${guide.at}`} className="snap-guide" y1={guide.at} y2={guide.at} x1={guide.from - 12} x2={guide.to + 12} vectorEffect="non-scaling-stroke" />)}
      </svg>
    </ViewportPortal>
    {feedback.hint && <Panel position="bottom-center" className={`drop-hint ${feedback.blocked ? 'blocked' : ''}`}><span role="status">{feedback.hint}</span></Panel>}
  </>;
}

/** "Move to…" in an element's context menu: the same membership change as a drag, without the gesture. */
export function MoveToMenu({ source, diagram, elementId, onMove }: { source: string; diagram: DiagramBlock; elementId: string; onMove: (parentId: string | undefined) => void }) {
  const element = diagram.elements.find(item => item.id === elementId);
  const targets = movableInto(source, diagram, elementId)?.filter(target => target.id !== element?.parentId);
  if (!element || !targets || !targets.length && !element.parentId) return null;
  return <>
    <div className="context-subheading">Move to…</div>
    {element.parentId && <button role="menuitem" onClick={() => onMove(undefined)}>Top level</button>}
    {targets.map(target => <button role="menuitem" key={target.id} onClick={() => onMove(target.id)}>{target.name || target.id} <small>{target.kind}</small></button>)}
  </>;
}
