import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BaseEdge, EdgeLabelRenderer, useReactFlow, useStore, type Edge, type EdgeProps } from '@xyflow/react';
import type { DiagramRelation, LineType } from '../shared/protocol';
import { RichText } from './RichText';
import { connectorStroke, routeConnector, type ActivityRoute } from './routing';

export type UmlEdge = Edge<{
  relation: DiagramRelation;
  lineType?: LineType;
  sequenceIndex?: number;
  version?: number;
  diagramId?: string;
  onMoveSequence?: (relation: DiagramRelation, row: number, version: number, diagramId: string) => Promise<boolean>;
  onEdit: (relation: DiagramRelation) => void;
}, 'uml'>;

function marker(arrow: string, side: 'start' | 'end'): string | undefined {
  const part = side === 'start' ? arrow.split(/[-.]/)[0] : arrow.split(/[-.]/).at(-1)!;
  if (/[{}]/.test(part)) return part.includes('o') ? 'url(#uml-many-optional)' : 'url(#uml-many)';
  if (part.includes('|') && /[<>]/.test(part)) return 'url(#uml-inheritance)';
  if (part.includes('|')) return 'url(#uml-one)';
  if (part.includes('*')) return 'url(#uml-composition)';
  if (part.includes('o')) return 'url(#uml-aggregation)';
  if (part.includes('<') || part.includes('>')) return 'url(#uml-arrow)';
  return undefined;
}

export function UmlEdgeView({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps<UmlEdge>) {
  const relation = data!.relation;
  const flow = useReactFlow();
  const interactive = useStore(state => state.nodesDraggable);
  const [dragOffset, setDragOffset] = useState(0);
  const cancelDrag = useRef<(() => void) | undefined>(undefined);
  const dragged = useRef(false);
  useEffect(() => () => cancelDrag.current?.(), []);
  useEffect(() => { cancelDrag.current?.(); setDragOffset(0); }, [sourceY, data?.sequenceIndex]);
  const startDrag = (event: ReactPointerEvent) => {
    if (!data?.onMoveSequence || data.sequenceIndex === undefined || !interactive || event.button !== 0) return;
    event.stopPropagation();
    cancelDrag.current?.();
    const startY = event.clientY, zoom = flow.getZoom(), row = data.sequenceIndex;
    const version = data.version!, diagramId = data.diagramId!;
    let delta = 0;
    const move = (next: PointerEvent) => {
      delta = (next.clientY - startY) / zoom;
      if (Math.abs(delta) >= 4) { next.preventDefault(); setDragOffset(delta); }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      cancelDrag.current = undefined;
    };
    const cancel = () => { cleanup(); setDragOffset(0); };
    const finish = () => {
      cleanup(); setDragOffset(0);
      if (Math.abs(delta) < 4) return;
      dragged.current = true;
      const target = Math.max(0, Math.min(20000, Math.round(row + delta / 52)));
      void data.onMoveSequence!(relation, target, version, diagramId);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    cancelDrag.current = cancel;
  };
  const arrow = relation.arrow.replace(/\[[^\]]*\]/g, '');
  const activity = relation.meta?.activityRoute as ActivityRoute | undefined;
  const schedule = relation.meta?.ganttDependency === true;
  const lineType = schedule && data?.lineType === 'straight' ? 'ortho' : data?.lineType;
  const structuredRoute = (relation.meta?.treeLayout === 'wbs' || schedule) && lineType !== 'polyline' && lineType !== 'spline' ? { kind: 'flow' as const } : undefined;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (data?.sequenceIndex !== undefined) {
    const y = sourceY + dragOffset;
    labelX = (sourceX + targetX) / 2;
    labelY = y - 13;
    if (source === target) { path = `M ${sourceX} ${y} h 60 v ${targetY - sourceY} h -60`; labelX = sourceX + 65; labelY = y + 15; }
    else path = `M ${sourceX} ${y} L ${targetX} ${y}`;
  } else ({ path, labelX, labelY } = routeConnector({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }, lineType, activity ?? structuredRoute, source === target));
  const stroke = connectorStroke(relation.arrow, data?.sequenceIndex !== undefined);
  const sourceCardinality = { x: sourceX + (sourcePosition === 'left' ? -24 : 9), y: sourceY + (sourcePosition === 'bottom' ? 9 : -20) };
  const targetCardinality = { x: targetX + (targetPosition === 'left' ? -24 : 9), y: targetY + (targetPosition === 'bottom' ? 9 : -20) };
  return <>
    <g className={data?.onMoveSequence ? 'sequence-message-drag nodrag nopan' : undefined} onPointerDown={startDrag}><BaseEdge id={id} path={path} markerStart={marker(arrow, 'start')} markerEnd={schedule ? 'url(#uml-schedule-arrow)' : activity ? 'url(#uml-flow-arrow)' : marker(arrow, 'end')} style={{ stroke: selected ? 'var(--accent)' : 'var(--diagram-line)', strokeWidth: stroke.bold ? 3 : selected ? 2 : activity || schedule ? 1.2 : 1.5, strokeDasharray: stroke.strokeDasharray }} interactionWidth={18} /></g>
    <EdgeLabelRenderer><button className={`edge-label nodrag nopan ${data?.onMoveSequence ? 'sequence-message-label' : ''} ${activity ? 'activity-edge-label' : ''} ${selected ? 'selected' : ''} ${!relation.label ? 'empty-label' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }} onPointerDown={startDrag} onKeyDown={event => { if (data?.onMoveSequence && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); void data.onMoveSequence(relation, Math.max(0, data.sequenceIndex! + (event.key === 'ArrowUp' ? -1 : 1)), data.version!, data.diagramId!); } }} onDoubleClick={event => { event.stopPropagation(); data?.onEdit(relation); }} onClick={event => { if (dragged.current) { dragged.current = false; return; } if (event.detail === 1 && !relation.label) data?.onEdit(relation); }} aria-label={`Edit relationship${relation.label ? ` ${relation.label}` : ` from ${source} to ${target}`}`} title={data?.onMoveSequence ? 'Drag up or down to reorder; double-click to edit message' : 'Double-click to edit relationship'}>{relation.meta?.number !== undefined && <b>{String(relation.meta.number)}. </b>}<RichText text={relation.label || (selected ? '+ label' : '')} /></button></EdgeLabelRenderer>
    {(relation.sourceMultiplicity || relation.targetMultiplicity) && <EdgeLabelRenderer>{relation.sourceMultiplicity && <span className="multiplicity" style={{ transform: `translate(${sourceCardinality.x}px,${sourceCardinality.y}px)` }}>{relation.sourceMultiplicity}</span>}{relation.targetMultiplicity && <span className="multiplicity" style={{ transform: `translate(${targetCardinality.x}px,${targetCardinality.y}px)` }}>{relation.targetMultiplicity}</span>}</EdgeLabelRenderer>}
  </>;
}

export function EdgeMarkers() {
  return <svg className="marker-definitions" aria-hidden="true"><defs>
    <marker id="uml-schedule-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L6 3 L0 6 Z" fill="var(--diagram-line)" /></marker>
    <marker id="uml-flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 L2 4 Z" fill="var(--diagram-line)" /></marker>
    <marker id="uml-arrow" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M1 1 L11 6 L1 11" fill="none" stroke="var(--diagram-line)" strokeWidth="1.5" /></marker>
    <marker id="uml-inheritance" viewBox="0 0 14 12" refX="13" refY="6" markerWidth="14" markerHeight="12" orient="auto-start-reverse"><path d="M1 1 L13 6 L1 11 Z" fill="var(--canvas)" stroke="var(--diagram-line)" strokeWidth="1.2" /></marker>
    <marker id="uml-composition" viewBox="0 0 18 12" refX="17" refY="6" markerWidth="18" markerHeight="12" orient="auto-start-reverse"><path d="M1 6 L9 1 L17 6 L9 11 Z" fill="var(--diagram-line)" stroke="var(--diagram-line)" /></marker>
    <marker id="uml-aggregation" viewBox="0 0 18 12" refX="17" refY="6" markerWidth="18" markerHeight="12" orient="auto-start-reverse"><path d="M1 6 L9 1 L17 6 L9 11 Z" fill="var(--canvas)" stroke="var(--diagram-line)" strokeWidth="1.2" /></marker>
    <marker id="uml-one" viewBox="0 0 18 14" refX="17" refY="7" markerWidth="18" markerHeight="14" orient="auto-start-reverse"><path d="M9 2V12 M14 2V12" fill="none" stroke="var(--diagram-line)" strokeWidth="1.3" /></marker>
    <marker id="uml-many" viewBox="0 0 20 14" refX="19" refY="7" markerWidth="20" markerHeight="14" orient="auto-start-reverse"><path d="M5 7L19 1 M5 7L19 13 M5 7H19" fill="none" stroke="var(--diagram-line)" strokeWidth="1.3" /></marker>
    <marker id="uml-many-optional" viewBox="0 0 25 14" refX="24" refY="7" markerWidth="25" markerHeight="14" orient="auto-start-reverse"><circle cx="5" cy="7" r="3.5" fill="var(--canvas)" stroke="var(--diagram-line)" strokeWidth="1.2" /><path d="M12 7L24 1 M12 7L24 13 M12 7H24" fill="none" stroke="var(--diagram-line)" strokeWidth="1.3" /></marker>
  </defs></svg>;
}
