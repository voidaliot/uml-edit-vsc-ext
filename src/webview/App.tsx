import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReactFlow, Background, BackgroundVariant, MiniMap, applyNodeChanges, applyEdgeChanges, ConnectionMode, SelectionMode, useReactFlow, useNodesInitialized, type NodeTypes, type EdgeTypes, type Connection, type Viewport, type NodeChange } from '@xyflow/react';
import { ArrowLeftRight, Check, Code2, Download, FilePlus2, FolderOpen, Hand, Map as MapIcon, ListTree, Maximize, Minus, MousePointer2, Plus, Redo2, RefreshCw, Save, Shapes, SquareArrowOutUpRight, Trash2, Undo2, X } from 'lucide-react';
import { parseDocument } from '../core/parser';
import { applyDiagramEdit } from '../core/edits';
import { layoutDiagram } from '../core/layout';
import { nativeTemplates, unsupportedTemplates, getTemplate } from '../core/templates';
import type { DiagramBlock, DiagramEdit, DiagramElement, DiagramRelation, ElementPlacement, HostMessage, LineType, Point } from '../shared/protocol';
import { send, subscribe, isStandalone, isFilePreview } from './bridge';
import { UmlNodeView, type UmlNode } from './nodes';
import { EdgeMarkers, UmlEdgeView, type UmlEdge } from './edges';
import { prepareGraphPorts, relationHandles } from './connections';

type FlowNode = UmlNode;
type DocumentState = Extract<HostMessage, { type: 'document' }>;
type ContextMenu = { x: number; y: number; point: Point; element?: DiagramElement; relation?: DiagramRelation };
type ElementDraft = { kind: string; name: string; point: Point; version: number; diagramId: string; parentId?: string };
type RelationDraft = { source: string; target: string; arrow: string; label: string; relationId?: string; version: number; diagramId: string; sequenceRow?: number };
const nodeTypes = { uml: UmlNodeView } satisfies NodeTypes;
const edgeTypes = { uml: UmlEdgeView } satisfies EdgeTypes;
const arrowTypes = [ ['-->', 'Directed association'], ['--', 'Association'], ['..>', 'Dependency'], ['<|--', 'Inheritance'], ['<|..', 'Realization'], ['*--', 'Composition'], ['o--', 'Aggregation'] ];

function ToolButton({ title, label, children, onClick, active, disabled, className = '' }: { title: string; label?: string; children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean; className?: string }) {
  return <button className={`tool-button ${active ? 'active' : ''} ${className}`} title={title} aria-label={label ?? title} aria-pressed={active} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function App() {
  const [documentState, setDocumentState] = useState<DocumentState>();
  const [activeId, setActiveId] = useState('diagram-1');
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<UmlEdge[]>([]);
  const [tool, setTool] = useState<'select' | 'hand'>('select');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [showOutline, setShowOutline] = useState(true);
  const [showMinimap, setShowMinimap] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [gallerySearch, setGallerySearch] = useState('');
  const [menu, setMenu] = useState<ContextMenu>();
  const [elementDraft, setElementDraft] = useState<ElementDraft>();
  const [relationDraft, setRelationDraft] = useState<RelationDraft>();
  const [selectedId, setSelectedId] = useState<string>();
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceRequested, setSourceRequested] = useState(false);
  const [sourceDraft, setSourceDraft] = useState('');
  const [sourceBase, setSourceBase] = useState('');
  const [sourceVersion, setSourceVersion] = useState(0);
  const [sourceDiagram, setSourceDiagram] = useState('');
  const [error, setError] = useState('');
  const [applyingEdit, setApplyingEdit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const canvas = useRef<HTMLDivElement>(null);
  const relayoutFit = useRef<DiagramBlock | undefined>(undefined);
  const docRef = useRef(documentState);
  docRef.current = documentState;
  const positions = useRef<Record<string, Record<string, ElementPlacement>>>({});
  const dragStart = useRef<{ diagramId: string; version: number; positions: Record<string, Point> } | undefined>(undefined);
  const pendingPlacement = useRef<{ diagramId: string; knownIds: Set<string>; point: Point } | undefined>(undefined);
  const pendingEdit = useRef<{ expectedSource: string; version: number; resolve: (applied: boolean) => void; timer: number } | undefined>(undefined);
  const lastScene = useRef('');
  const flow = useReactFlow<FlowNode, UmlEdge>();
  const nodesInitialized = useNodesInitialized();
  const parsed = useMemo(() => parseDocument(documentState?.source ?? ''), [documentState?.source]);
  const diagram = parsed.diagrams.find(block => block.id === activeId) ?? parsed.diagrams[0];
  const native = Boolean(diagram?.graphical);
  const derivedRelations = Boolean(diagram && (diagram.meta?.derivedRelations ?? (['activity', 'sdl', 'mindmap', 'wbs'].includes(diagram.kind) && !diagram.meta?.legacy)));
  const hand = tool === 'hand' || spaceHeld;
  const palette = diagram ? getTemplate(diagram.kind)?.palette ?? [] : [];

  useEffect(() => {
    const unsubscribe = subscribe(message => {
      if (message.type === 'document') {
        positions.current = Object.fromEntries(Object.entries(message.layouts).map(([id, layout]) => [id, Object.assign(Object.create(null), layout.positions)]));
        docRef.current = message;
        setDocumentState(message); setBusy(null);
        const pending = pendingEdit.current;
        if (pending && message.version > pending.version) {
          const applied = message.source === pending.expectedSource;
          if (!applied) setError('The document changed before this edit was applied. Your draft is preserved.');
          window.clearTimeout(pending.timer); pending.resolve(applied); pendingEdit.current = undefined;
        }
      }
      else if (message.type === 'documentOpened') {
        relayoutFit.current = undefined;
        if (pendingEdit.current) { window.clearTimeout(pendingEdit.current.timer); pendingEdit.current.resolve(false); pendingEdit.current = undefined; }
        lastScene.current = ''; pendingPlacement.current = undefined; dragStart.current = undefined;
        setNodes([]); setEdges([]); setActiveId('diagram-1'); setSelectedId(undefined); setMenu(undefined);
        setElementDraft(undefined); setRelationDraft(undefined); setSourceOpen(false); setSourceRequested(false); setSourceDraft(''); setSourceBase(''); setSourceDiagram('');
        setShowGallery(false); setError(''); setBusy(null); setApplyingEdit(false);
      }
      else if (message.type === 'showSource') setSourceRequested(true);
      else if (message.type === 'error') { setError(message.message); setBusy(null); if (pendingEdit.current) { window.clearTimeout(pendingEdit.current.timer); pendingEdit.current.resolve(false); pendingEdit.current = undefined; } }
      else if (message.type === 'connection') setBusy(message.connected ? null : 'Reconnecting to source file…');
    });
    send({ type: 'ready' });
    return unsubscribe;
  }, []);

  const commit = useCallback(async (edit: DiagramEdit, version?: number, diagramId?: string): Promise<boolean> => {
    const current = docRef.current;
    if (!current || !(diagramId ?? diagram?.id)) return false;
    if (pendingEdit.current) { setError('Another edit is still applying. Your draft is preserved; try again when it finishes.'); return false; }
    if (version !== undefined && version !== current.version) { setError('The document changed while you were editing. Your draft is preserved. Cancel and reopen the editor to review the current value.'); return false; }
    try {
      const expectedSource = applyDiagramEdit(current.source, diagramId ?? diagram!.id, edit);
      if (expectedSource === current.source) return true;
      setError(''); setApplyingEdit(true);
      const applied = await new Promise<boolean>(resolve => {
        const timer = window.setTimeout(() => { pendingEdit.current = undefined; setError('The editor has not confirmed this change. Your draft is preserved.'); resolve(false); }, 15000);
        pendingEdit.current = { expectedSource, version: current.version, resolve, timer };
        send({ type: 'edit', version: version ?? current.version, diagramId: diagramId ?? diagram!.id, edit });
      });
      setApplyingEdit(false);
      if (applied && edit.type === 'rename') {
        const id = diagramId ?? diagram!.id;
        const before = parseDocument(current.source).diagrams.find(block => block.id === id);
        const after = parseDocument(expectedSource).diagrams.find(block => block.id === id);
        const original = before?.elements.find(element => element.id === edit.elementId);
        const replacement = after?.elements.find(element => element.startLine === original?.startLine && element.kind === original.kind && element.name === edit.name);
        if (original && replacement && original.id !== replacement.id) {
          const previousPoints = Object.assign(Object.create(null), positions.current[id] ?? current.layouts[id]?.positions ?? {}) as Record<string, Point>;
          const point = Object.hasOwn(previousPoints, original.id) ? previousPoints[original.id] : undefined;
          if (point && !replacement.meta?.positionLocked && !replacement.meta?.moveEdit) {
            const basePositions = { ...previousPoints };
            previousPoints[replacement.id] = point;
            positions.current[id] = previousPoints;
            setNodes(previous => previous.map(node => node.type === 'uml' && node.data.diagramId === id && node.id === replacement.id ? { ...node, position: point } : node));
            send({ type: 'layout', version: docRef.current?.version, basePositions, diagramId: id, layout: { ...current.layouts[id], positions: previousPoints } });
          }
        }
      }
      return applied;
    } catch (error) { setApplyingEdit(false); setError(error instanceof Error ? error.message : String(error)); return false; }
  }, [diagram?.id]);

  const editRelation = useCallback((relation: DiagramRelation) => {
    if (!diagram || !documentState) return;
    if (derivedRelations) {
      setSourceDraft(diagram.source); setSourceBase(diagram.source); setSourceVersion(documentState.version); setSourceDiagram(diagram.id); setSourceOpen(true); setMenu(undefined); return;
    }
    setRelationDraft({ ...relation, relationId: relation.id, version: documentState.version, diagramId: diagram.id });
    setMenu(undefined);
  }, [diagram?.id, documentState?.version, derivedRelations]);

  const moveMessage = useCallback((relation: DiagramRelation, row: number, version: number, diagramId: string) => commit({ type: 'moveSequenceEvent', eventId: relation.id, row }, version, diagramId), [commit]);

  const resizeDivider = useCallback((id: string, placement: ElementPlacement, finished: boolean, version: number, diagramId: string) => {
    const current = docRef.current;
    if (!current || current.version !== version || diagram?.id !== diagramId) { setError('The diagram changed during the resize. Try again on the current divider.'); return; }
    setNodes(previous => previous.map(node => node.id === id ? { ...node, position: { x: placement.x, y: placement.y }, data: { ...node.data, element: { ...node.data.element, meta: { ...node.data.element.meta, width: placement.width, height: placement.height ?? 28 } } } } : node));
    if (!finished) return;
    const basePositions = { ...positions.current[diagramId] ?? {} };
    const next = { ...basePositions, [id]: placement };
    positions.current[diagramId] = next;
    send({ type: 'layout', version, basePositions, diagramId, layout: { ...current.layouts[diagramId], positions: next, viewport: flow.getViewport() } });
  }, [diagram?.id, flow]);

  useEffect(() => {
    if (!diagram || !documentState) { setNodes([]); setEdges([]); return; }
    if (!native) { setNodes([]); setEdges([]); return; }
    const automatic = layoutDiagram(diagram);
    const saved: Record<string, ElementPlacement> = Object.assign(Object.create(null), positions.current[diagram.id] ?? documentState.layouts[diagram.id]?.positions ?? {});
    const pending = pendingPlacement.current;
    if (pending?.diagramId === diagram.id) {
      const added = diagram.elements.find(element => !pending.knownIds.has(element.id));
      if (added) {
        const basePositions = { ...saved };
        if (!added.meta?.positionLocked && !added.meta?.moveEdit) saved[added.id] = pending.point;
        pendingPlacement.current = undefined;
        send({ type: 'layout', version: docRef.current?.version, basePositions, diagramId: diagram.id, layout: { ...documentState.layouts[diagram.id], positions: saved } });
      }
    }
    positions.current[diagram.id] = saved;
    prepareGraphPorts(diagram, { ...automatic, ...saved });
    setNodes(previous => diagram.elements.map(element => {
      const old = previous.find(node => node.id === element.id);
      const remembered = !element.meta?.positionLocked && !element.meta?.moveEdit && Object.hasOwn(saved, element.id) ? saved[element.id] : undefined;
      if (element.kind === 'sequence-divider' && remembered?.width) element.meta = { ...element.meta, width: remembered.width, height: remembered.height ?? 28 };
      let point = remembered ?? (Object.hasOwn(automatic, element.id) ? automatic[element.id] : undefined) ?? { x: 0, y: 0 };
      if (element.meta?.tableRow && element.parentId && automatic[element.id] && automatic[element.parentId]) {
        const parent = Object.hasOwn(saved, element.parentId) ? saved[element.parentId] : automatic[element.parentId];
        point = { x: automatic[element.id].x + parent.x - automatic[element.parentId].x, y: automatic[element.id].y + parent.y - automatic[element.parentId].y };
      }
      if (element.meta?.lockX && automatic[element.id]) point.x = automatic[element.id].x;
      return {
        id: element.id, type: 'uml', position: diagram.kind === 'sequence' ? { ...point, y: automatic[element.id]?.y ?? 0 } : point, selected: old?.selected,
        zIndex: element.meta?.container ? 0 : 1, draggable: element.meta?.editable !== false && element.meta?.fixedPosition !== true && element.meta?.positionLocked !== true, connectable: element.meta?.editable !== false && !element.meta?.container && !element.kind.startsWith('sequence-'),
        selectable: element.kind !== 'timing-messages', style: element.kind === 'timing-messages' ? { pointerEvents: 'none' } : undefined,
        data: { element, diagramId: diagram.id, version: documentState.version, editRequest: old?.type === 'uml' ? old.data.editRequest : undefined,
          sequenceHeight: diagram.kind === 'sequence' && !element.kind.startsWith('sequence-') ? Number(diagram.meta?.sequenceHeight ?? 150 + Number(diagram.meta?.sequenceRows ?? diagram.relations.length) * 52) : undefined,
          onResizeDivider: resizeDivider,
          onRename: (id: string, name: string, version: number, diagramId: string) => commit({ type: 'rename', elementId: id, name }, version, diagramId),
          onMembers: (id: string, members: string[], version: number, diagramId: string) => commit({ type: 'members', elementId: id, members }, version, diagramId)
        }
      } satisfies UmlNode;
    }));
    setEdges(diagram.relations.filter(relation => !/hidden/i.test(relation.arrow) && !relation.meta?.tableInternal).map((relation, index) => ({ id: relation.id, type: 'uml', source: relation.source, target: relation.target, ...relationHandles(relation, diagram, { ...automatic, ...saved }), data: { relation, lineType: diagram.meta?.lineType as LineType, sequenceIndex: diagram.kind === 'sequence' ? Number(relation.meta?.row ?? index) : undefined, onEdit: editRelation, onMoveSequence: diagram.kind === 'sequence' ? moveMessage : undefined, version: documentState.version, diagramId: diagram.id } })));
  }, [diagram, native, documentState, commit, editRelation, moveMessage, resizeDivider]);

  useLayoutEffect(() => {
    if (!diagram || nodes.length === 0 || !nodesInitialized || nodes.some(node => node.data.diagramId !== diagram.id)) return;
    const scene = diagram.id;
    if (lastScene.current === scene) return;
    const stored = documentState?.layouts[diagram.id]?.viewport;
    // Fit as soon as React Flow has measured this scene. A delayed fit can move
    // a label between the two clicks that start an inline edit.
    lastScene.current = scene;
    if (stored && native) void flow.setViewport(stored);
    else void flow.fitView({ padding: 0.2, maxZoom: 1 });
  }, [nodesInitialized, nodes, diagram?.id, native]);

  useEffect(() => {
    const request = relayoutFit.current;
    if (!request) return;
    if (request !== diagram) { relayoutFit.current = undefined; return; }
    if (!nodesInitialized || !nodes.length || nodes.some(node => node.data.diagramId !== request.id)) return;
    // Fit the freshly applied, measured scene; no timer survives a diagram change.
    relayoutFit.current = undefined;
    void flow.fitView({ padding: 0.2, maxZoom: 1.2, duration: 220 });
  }, [nodesInitialized, nodes, diagram, flow]);

  const persistLayout = useCallback((viewport?: Viewport, movedIds: readonly string[] = []) => {
    if (!diagram || !native) return;
    const currentNodes = flow.getNodes().filter(node => node.type === 'uml');
    const nextPositions: Record<string, ElementPlacement> = Object.assign(Object.create(null), positions.current[diagram.id] ?? docRef.current?.layouts[diagram.id]?.positions ?? {});
    const basePositions = { ...nextPositions };
    // Pan, zoom, and fit only save the viewport. Automatic coordinates must
    // remain free to reflow when source structure or layout rules change.
    for (const id of movedIds) {
      const node = currentNodes.find(node => node.id === id);
      if (node && !node.data.element.meta?.positionLocked && !node.data.element.meta?.moveEdit) nextPositions[id] = { ...nextPositions[id], ...node.position };
    }
    positions.current[diagram.id] = nextPositions;
    const displayedPositions = Object.fromEntries(currentNodes.map(node => [node.id, node.position]));
    prepareGraphPorts(diagram, displayedPositions);
    setNodes(previous => previous.map(node => ({ ...node, data: { ...node.data } })));
    setEdges(previous => previous.map(edge => ({ ...edge, ...relationHandles(edge.data!.relation, diagram, displayedPositions) })));
    send({ type: 'layout', version: docRef.current?.version, basePositions, diagramId: diagram.id, layout: { positions: nextPositions, viewport: viewport ?? flow.getViewport() } });
  }, [diagram, native, flow]);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, .nowheel, .react-flow__minimap')) return;
      relayoutFit.current = undefined;
      if (diagram) lastScene.current = diagram.id;
      event.preventDefault(); event.stopPropagation();
      const current = flow.getViewport();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.clientHeight : 1;
      let next: Viewport;
      if (hand || event.ctrlKey || event.metaKey) {
        const z = Math.max(0.2, Math.min(3, current.zoom * Math.exp(-event.deltaY * scale * 0.002)));
        const rect = target.getBoundingClientRect();
        const x = event.clientX - rect.left, y = event.clientY - rect.top;
        next = { zoom: z, x: x - (x - current.x) * z / current.zoom, y: y - (y - current.y) * z / current.zoom };
      } else next = { ...current, x: current.x - (event.shiftKey ? event.deltaY : event.deltaX) * scale, y: current.y - (event.shiftKey ? 0 : event.deltaY) * scale };
      void flow.setViewport(next); setZoom(next.zoom);
    };
    target.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => target.removeEventListener('wheel', onWheel, true);
  }, [hand, flow, diagram?.id]);

  const requestRename = useCallback((id: string) => {
    setNodes(previous => previous.map(node => node.id === id && node.type === 'uml' ? { ...node, data: { ...node.data, editRequest: Date.now() } } : node));
    setMenu(undefined);
  }, []);

  const deleteSelection = useCallback(() => {
    if (!diagram || !selectedId || !native) return;
    if (diagram.elements.some(element => element.id === selectedId)) commit({ type: 'deleteElement', elementId: selectedId });
    else if (diagram.relations.some(relation => relation.id === selectedId)) {
      if (derivedRelations) { setError('These connections follow the diagram structure. Edit the PlantUML source to change them.'); return; }
      void commit({ type: 'deleteRelation', relationId: selectedId });
    }
    setSelectedId(undefined); setMenu(undefined);
  }, [diagram, selectedId, native, derivedRelations, commit]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Space') { event.preventDefault(); setSpaceHeld(true); }
      if (event.key === 'Escape') { setMenu(undefined); setElementDraft(undefined); setRelationDraft(undefined); setShowGallery(false); }
      if (event.key === 'F2' && selectedId && native) { event.preventDefault(); const relation = diagram?.relations.find(item => item.id === selectedId); if (relation) editRelation(relation); else requestRename(selectedId); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelection(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); send({ type: event.shiftKey ? 'redo' : 'undo' }); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); send({ type: 'redo' }); }
      if (!(event.ctrlKey || event.metaKey || event.altKey)) {
        if (event.key.toLowerCase() === 'v') setTool('select');
        if (event.key.toLowerCase() === 'h') setTool('hand');
        if (event.key.toLowerCase() === 'f') void flow.fitView({ padding: 0.2, maxZoom: 1.2, duration: 180 });
      }
    };
    const keyup = (event: KeyboardEvent) => { if (event.code === 'Space') setSpaceHeld(false); };
    const blur = () => setSpaceHeld(false);
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); };
  }, [selectedId, native, deleteSelection, requestRename, diagram, editRelation, flow]);

  const openSource = () => {
    if (!documentState) return;
    const id = diagram?.id ?? 'document', content = diagram?.source ?? documentState.source;
    if (sourceDiagram !== id || (!sourceOpen && sourceDraft === sourceBase)) { setSourceDraft(content); setSourceBase(content); setSourceVersion(documentState.version); setSourceDiagram(id); }
    setSourceOpen(true); setMenu(undefined);
  };
  useEffect(() => {
    if (sourceRequested && documentState) { openSource(); setSourceRequested(false); }
  }, [sourceRequested, documentState]);

  const reloadSource = () => {
    if (!documentState) return;
    const sourceBlock = parsed.diagrams.find(block => block.id === sourceDiagram);
    const content = sourceDiagram === 'document' ? documentState.source : sourceBlock?.source ?? diagram?.source ?? documentState.source;
    setSourceDraft(content); setSourceBase(content); setSourceVersion(documentState.version); setSourceDiagram(sourceDiagram === 'document' ? 'document' : sourceBlock?.id ?? diagram?.id ?? 'document');
  };

  useEffect(() => {
    if (!sourceOpen || !documentState) return;
    let content = sourceDiagram === 'document' ? documentState.source : parsed.diagrams.find(block => block.id === sourceDiagram)?.source;
    if (content === undefined && sourceDraft === sourceBase) { content = documentState.source; setSourceDiagram('document'); }
    if (content === undefined) return;
    if (content === sourceDraft || sourceDraft === sourceBase) {
      setSourceDraft(content); setSourceBase(content); setSourceVersion(documentState.version);
    }
  }, [documentState?.source, documentState?.version, sourceOpen, sourceDiagram]);

  useEffect(() => {
    if (!sourceOpen || !documentState || sourceDraft !== sourceBase) return;
    const targetId = diagram?.id ?? 'document';
    if (targetId === sourceDiagram) return;
    const content = diagram?.source ?? documentState.source;
    setSourceDraft(content); setSourceBase(content); setSourceVersion(documentState.version); setSourceDiagram(targetId);
  }, [activeId]);

  const openContext = (event: { preventDefault(): void; clientX: number; clientY: number }, element?: DiagramElement, relation?: DiagramRelation) => {
    event.preventDefault();
    const rect = canvas.current!.getBoundingClientRect();
    setMenu({ x: Math.min(event.clientX - rect.left, rect.width - 240), y: Math.min(event.clientY - rect.top, rect.height - 370), point: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), element, relation });
    if (element) setSelectedId(element.id);
    if (relation) setSelectedId(relation.id);
  };

  const beginElement = (kind: string, point?: Point, parentId?: string) => {
    if (!diagram || !documentState) return;
    const rect = canvas.current!.getBoundingClientRect();
    setElementDraft({ kind, name: '', parentId, point: point ?? flow.screenToFlowPosition({ x: rect.left + rect.width / 2 - 90, y: rect.top + rect.height / 2 - 40 }), version: documentState.version, diagramId: diagram.id });
    setMenu(undefined);
  };

  const addElement = async () => {
    if (!elementDraft || !diagram || !elementDraft.name.trim()) return;
    pendingPlacement.current = { diagramId: diagram.id, knownIds: new Set(diagram.elements.map(element => element.id)), point: elementDraft.point };
    const applied = await commit({ type: 'addElement', kind: elementDraft.kind, name: elementDraft.name.trim(), parentId: elementDraft.parentId }, elementDraft.version, elementDraft.diagramId);
    if (applied) setElementDraft(undefined);
    else pendingPlacement.current = undefined;
  };

  const connect = (connection: Connection) => {
    if (!diagram || !documentState || !connection.source || !connection.target) return;
    const match = connection.sourceHandle?.match(/^sequence-(\d+)$/);
    const sequenceRow = diagram.kind === 'sequence' ? match ? Number(match[1]) : Number(diagram.meta?.sequenceRows ?? diagram.relations.length) : undefined;
    setRelationDraft({ source: connection.source, target: connection.target, arrow: diagram.kind === 'sequence' ? '->' : '-->', label: '', version: documentState.version, diagramId: diagram.id, sequenceRow });
  };

  const saveRelation = async () => {
    if (!relationDraft) return;
    const applied = await commit(relationDraft.relationId ? { type: 'editRelation', relationId: relationDraft.relationId, label: relationDraft.label, arrow: relationDraft.arrow } : { type: 'addRelation', source: relationDraft.source, target: relationDraft.target, arrow: relationDraft.arrow, label: relationDraft.label, sequenceRow: relationDraft.sequenceRow }, relationDraft.version, relationDraft.diagramId);
    if (applied) setRelationDraft(undefined);
  };

  const autoLayout = () => {
    if (!diagram) return;
    relayoutFit.current = diagram;
    lastScene.current = diagram.id;
    const fresh = layoutDiagram(diagram);
    prepareGraphPorts(diagram, fresh);
    const basePositions = { ...positions.current[diagram.id] ?? docRef.current?.layouts[diagram.id]?.positions ?? {} };
    positions.current[diagram.id] = Object.create(null);
    setNodes(previous => previous.map(node => ({ ...node, position: fresh[node.id] ?? node.position, data: { ...node.data } })));
    setEdges(previous => previous.map(edge => ({ ...edge, ...relationHandles(edge.data!.relation, diagram, fresh) })));
    send({ type: 'layout', version: docRef.current?.version, basePositions, diagramId: diagram.id, layout: { positions: {} } });
  };

  const selectElement = (element: DiagramElement) => {
    setSelectedId(element.id);
    setNodes(previous => previous.map(node => ({ ...node, selected: node.id === element.id })));
    if (native) void flow.fitView({ nodes: [{ id: element.id }], padding: 1, maxZoom: 1, duration: 220 });
  };

  const sourceTarget = sourceDiagram === 'document' ? documentState?.source : parsed.diagrams.find(block => block.id === sourceDiagram)?.source;
  const changeNodes = (changes: NodeChange<FlowNode>[]) => setNodes(previous => {
    const adjusted = changes.map(change => {
      if (change.type !== 'position' || !change.position) return change;
      const node = previous.find(node => node.id === change.id);
      return { ...change, position: { x: node?.data.element.meta?.lockX ? node.position.x : change.position.x, y: diagram?.kind === 'sequence' && node?.data.element.kind !== 'sequence-divider' ? node?.position.y ?? change.position.y : change.position.y } };
    });
    let next = applyNodeChanges(adjusted, previous);
    for (const change of adjusted) {
      if (change.type !== 'position' || !change.position) continue;
      const parent = previous.find(node => node.id === change.id);
      if (!parent?.data.element.meta?.container || parent.data.element.kind.startsWith('sequence-')) continue;
      const descendants = new Set([parent.id]);
      const children = new Map<string, string[]>();
      for (const child of previous) if (child.data.element.parentId) children.set(child.data.element.parentId, [...children.get(child.data.element.parentId) ?? [], child.id]);
      const queue = [parent.id];
      while (queue.length) for (const id of children.get(queue.shift()!) ?? []) if (!descendants.has(id)) { descendants.add(id); queue.push(id); }
      next = next.map(node => node.id !== parent.id && descendants.has(node.id) ? { ...node, position: { x: node.position.x + change.position!.x - parent.position.x, y: node.position.y + change.position!.y - parent.position.y } } : node);
    }
    return next;
  });
  const sourceTargetLabel = sourceDiagram === 'document' ? 'Document' : parsed.diagrams.find(block => block.id === sourceDiagram)?.title ?? sourceDiagram;
  const sourceChanged = documentState && sourceVersion !== documentState.version && sourceDraft !== sourceTarget;
  return <div className="app-shell">
    <header className="editor-toolbar nowheel" role="toolbar" aria-label="Diagram tools">
      <div className="toolbar-group">
        <ToolButton title="Toggle outline" onClick={() => setShowOutline(!showOutline)} active={showOutline}><ListTree size={16} /></ToolButton>
        <label className="diagram-selector"><select aria-label="Current diagram" title="Current diagram" value={diagram?.id ?? ''} disabled={!parsed.diagrams.length} onChange={event => { setActiveId(event.target.value); setSelectedId(undefined); setMenu(undefined); }}>{parsed.diagrams.length ? parsed.diagrams.map((block, index) => <option key={block.id} value={block.id}>{`${index + 1}. ${getTemplate(block.kind)?.label ?? block.kind}${block.title && block.title.toLowerCase() !== `${block.kind} diagram` ? ` — ${block.title}` : ''}`}</option>) : <option value="">Choose a diagram</option>}</select></label>
        <ToolButton title="New diagram" onClick={() => { setShowGallery(true); setGallerySearch(''); }}><FilePlus2 size={16} /></ToolButton>
        <ToolButton title="Open Aliot diagram" onClick={() => send({ type: 'openAliot' })}><FolderOpen size={16} /></ToolButton>
        <ToolButton title="Save Aliot diagram" onClick={() => send({ type: 'saveAliot' })} disabled={!documentState || applyingEdit}><Save size={16} /></ToolButton>
        <ToolButton title="Export PlantUML" onClick={() => send({ type: 'exportPlantUml' })} disabled={!documentState || applyingEdit}><Download size={16} /></ToolButton>
      </div>
      <span className="toolbar-divider" />
      <div className="toolbar-group">
        <ToolButton title="Select tool (V): wheel pans, Ctrl+wheel zooms" onClick={() => setTool('select')} active={!hand}><MousePointer2 size={16} /></ToolButton>
        <ToolButton title="Hand tool (H): drag to pan, wheel zooms. Hold Space temporarily." onClick={() => setTool('hand')} active={hand}><Hand size={16} /></ToolButton>
        <ToolButton title="Re-layout diagram after changes; reset manual placements" label="Re-layout diagram" onClick={autoLayout} disabled={!native || applyingEdit}><RefreshCw size={16} /></ToolButton>
      </div>
      <span className="toolbar-divider" />
      <div className="toolbar-group">
        <ToolButton title="Undo (Ctrl+Z)" onClick={() => send({ type: 'undo' })}><Undo2 size={16} /></ToolButton>
        <ToolButton title="Redo (Ctrl+Shift+Z)" onClick={() => send({ type: 'redo' })}><Redo2 size={16} /></ToolButton>
      </div>
      <span className="toolbar-divider" />
      <div className="toolbar-group">
        <ToolButton title="Toggle minimap" onClick={() => setShowMinimap(!showMinimap)} active={showMinimap}><MapIcon size={16} /></ToolButton>
      </div>
      <span className="toolbar-divider" />
      <div className="toolbar-group">
        <ToolButton title="Zoom out" onClick={() => void flow.zoomOut({ duration: 120 })}><Minus size={16} /></ToolButton>
        <button className="zoom-value" onClick={() => void flow.zoomTo(1, { duration: 180 })} title="Reset zoom to 100%" aria-label="Reset zoom to 100%">{Math.round(zoom * 100)}%</button>
        <ToolButton title="Zoom in" onClick={() => void flow.zoomIn({ duration: 120 })}><Plus size={16} /></ToolButton>
        <ToolButton title="Fit diagram (F)" onClick={() => void flow.fitView({ padding: 0.2, maxZoom: 1.2, duration: 180 })}><Maximize size={16} /></ToolButton>
      </div>
      <span className="toolbar-divider" />
      <div className="toolbar-group">
        <ToolButton title="Edit PlantUML source in canvas" onClick={openSource} disabled={!documentState} active={sourceOpen}><Code2 size={16} /></ToolButton>
        {documentState?.format !== 'aliot' && <ToolButton title="Source file" disabled={!documentState || isStandalone && !isFilePreview} onClick={() => isFilePreview ? openSource() : send({ type: 'openSource', line: diagram?.startLine })}><SquareArrowOutUpRight size={16} /></ToolButton>}
      </div>
    </header>
    <div className="workspace">
      {showOutline && <aside className="outline" aria-label="Diagram outline">
        <div className="outline-list">{native && diagram?.elements.map(element => <button key={element.id} className={`outline-item ${selectedId === element.id ? 'selected' : ''}`} onClick={() => selectElement(element)} onDoubleClick={() => requestRename(element.id)}><span className={`element-glyph glyph-${element.kind}`}>{element.kind === 'actor' ? '♙' : element.kind === 'interface' ? 'I' : element.kind === 'enum' ? 'E' : element.kind.slice(0, 1).toUpperCase()}</span><span>{element.name || element.kind.replace(/(^|-|\s)(\w)/g, (_, separator: string, letter: string) => `${separator ? ' ' : ''}${letter.toUpperCase()}`)}</span><small>{element.kind}</small></button>)}
          {(!native || !diagram?.elements.length) && <p className="outline-empty">{diagram ? native ? 'Right-click the canvas to add an element.' : 'Native support for this syntax is not implemented. The source remains available.' : 'Create a diagram to begin.'}</p>}
        </div>
        <div className="outline-bottom"><span className="small-label">{native ? 'ADD ELEMENT' : 'AUTHORING'}</span>{native && palette.length > 0 ? <div className="palette-list">{palette.map(kind => <button key={kind} onClick={() => beginElement(kind)}><Plus size={12} /><span>{kind}</span></button>)}</div> : <button className="text-button" onClick={openSource} disabled={!documentState}><Code2 size={14} /> Edit diagram source</button>}</div>
      </aside>}
      <main ref={canvas} className={`canvas-shell ${hand ? 'hand-tool' : 'select-tool'}`} aria-label="Diagram canvas" onPointerDownCapture={() => { relayoutFit.current = undefined; if (diagram) lastScene.current = diagram.id; }}>
        <ReactFlow<FlowNode, UmlEdge> nodes={native ? nodes : []} edges={native ? edges : []} nodeTypes={nodeTypes} edgeTypes={edgeTypes} proOptions={{ hideAttribution: true }}
          onNodesChange={changeNodes}
          onEdgesChange={changes => setEdges(previous => applyEdgeChanges(changes, previous))}
          onNodeClick={(_, node) => { setSelectedId(node.id); setMenu(undefined); }}
          onEdgeClick={(_, edge) => { setSelectedId(edge.id); setMenu(undefined); }}
          onNodeDoubleClick={(_, node) => native && requestRename(node.id)}
          onEdgeDoubleClick={(_, edge) => edge.data && editRelation(edge.data.relation)}
          onNodeContextMenu={(event, node) => openContext(event, node.type === 'uml' ? node.data.element : undefined)}
          onEdgeContextMenu={(event, edge) => openContext(event, undefined, edge.data?.relation)}
          onPaneContextMenu={event => openContext(event)}
          onPaneClick={() => { setMenu(undefined); setSelectedId(undefined); }}
          onNodeDragStart={() => {
            if (diagram && documentState) dragStart.current = { diagramId: diagram.id, version: documentState.version, positions: Object.fromEntries(flow.getNodes().map(node => [node.id, { ...node.position }])) };
          }}
          onNodeDragStop={async (_, node) => {
            const started = dragStart.current;
            dragStart.current = undefined;
            if (node.data.element.kind === 'sequence-divider' && started && diagram?.id === started.diagramId) {
              const applied = await commit({ type: 'moveSequenceEvent', eventId: node.id, row: Math.max(0, Math.round((node.position.y - 137) / 52)) }, started.version, started.diagramId);
              const latest = parseDocument(docRef.current?.source ?? '').diagrams.find(block => block.id === started.diagramId);
              if (!latest) return;
              const automatic = layoutDiagram(latest)[node.id];
              if (automatic) setNodes(previous => previous.map(item => item.id === node.id ? { ...item, position: { x: applied ? node.position.x : started.positions[node.id].x, y: automatic.y } } : item));
              if (applied && automatic && Math.abs(node.position.x - started.positions[node.id].x) > .01) resizeDivider(node.id, { x: node.position.x, y: automatic.y, width: Number(node.data.element.meta?.width), height: 28 }, true, docRef.current!.version, started.diagramId);
            } else if (node.data.element.meta?.moveEdit) {
              const applied = await commit({ type: 'move', elementId: node.id, position: node.position }, started?.version, started?.diagramId);
              if (!applied && diagram) setNodes(previous => previous.map(item => item.id === node.id ? { ...item, position: layoutDiagram(diagram)[item.id] ?? item.position } : item));
            } else if (started && diagram && started.diagramId === diagram.id && started.version === docRef.current?.version) {
              const movedIds = flow.getNodes().filter(item => {
                const before = started.positions[item.id];
                return before && (Math.abs(item.position.x - before.x) > 0.01 || Math.abs(item.position.y - before.y) > 0.01);
              }).map(item => item.id);
              persistLayout(undefined, movedIds);
            }
          }}
          onMove={(_, viewport) => setZoom(viewport.zoom)}
          onMoveEnd={(_, viewport) => persistLayout(viewport)}
          onConnect={connect} connectionMode={ConnectionMode.Loose} connectionRadius={28}
          nodesDraggable={native && !hand} nodesConnectable={native && !hand && !derivedRelations} elementsSelectable={native && !hand}
          selectNodesOnDrag={!hand} selectionOnDrag={native && !hand} selectionMode={SelectionMode.Partial} elevateNodesOnSelect={false}
          panOnDrag={hand ? [0, 1] : [1]} panOnScroll={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panActivationKeyCode={null} zoomActivationKeyCode={null}
          deleteKeyCode={null} minZoom={0.2} maxZoom={3} onlyRenderVisibleElements={false} preventScrolling fitViewOptions={{ maxZoom: 1, padding: 0.2 }}>
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--grid)" />
          {showMinimap && <MiniMap pannable zoomable nodeColor="var(--minimap-node)" maskColor="var(--minimap-mask)" style={{ background: 'var(--panel)' }} />}
          <EdgeMarkers />
        </ReactFlow>
        {!diagram && documentState && <div className="empty-state"><div className="empty-symbol"><Shapes size={34} strokeWidth={1} /></div><h1>{documentState.source.trim() ? 'Open the source to continue.' : 'Make your ideas clear.'}</h1><p>{documentState.source.trim() ? 'This file has no complete diagram block. You can edit its PlantUML source right here.' : 'Choose a native diagram type to start drawing.'}</p>{documentState.source.trim() ? <button className="primary" onClick={openSource}><Code2 size={15} /> Edit PlantUML source</button> : <button className="primary" onClick={() => setShowGallery(true)}><Plus size={15} /> Create a diagram</button>}<span>Class · Sequence · Activity · State · and more</span></div>}
        {native && diagram && nodes.length === 0 && <div className="empty-state"><h2>Your canvas is ready</h2><p>Right-click to place your first element.</p>{palette[0] && <button className="primary" onClick={() => beginElement(palette[0])}><Plus size={15} /> Add {palette[0]}</button>}</div>}
        {diagram && !native && <section className="unsupported-notice" role="status" aria-label="Native diagram not supported"><div className="empty-symbol"><Shapes size={28} strokeWidth={1.3} /></div><h2>Native support is not implemented for this syntax.</h2><p>{getTemplate(diagram.kind)?.label ?? diagram.kind} diagrams with these constructs cannot currently be drawn as editable native elements.</p><ul>{(diagram.warnings.length ? diagram.warnings : ['This diagram type does not have a native React Flow implementation yet.']).map((warning, index) => <li key={index}>{warning}</li>)}</ul><button className="primary" onClick={openSource}><Code2 size={14} /> Edit PlantUML source</button></section>}
        {native && diagram && diagram.warnings.length > 0 && <details className="native-notes nowheel"><summary>{diagram.warnings.length} notation {diagram.warnings.length === 1 ? 'note' : 'notes'}</summary><ul>{diagram.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
        {menu && <div className="context-menu nowheel" role="menu" style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }} onKeyDown={event => { if (event.key === 'Escape') setMenu(undefined); }}>
          <div className="context-heading">{menu.element?.name ?? (menu.relation ? 'Relationship' : 'ADD TO DIAGRAM')}</div>
          {menu.element && native && <><button role="menuitem" onClick={() => requestRename(menu.element!.id)}>Rename <kbd>F2</kbd></button><button role="menuitem" onClick={() => { commit({ type: 'deleteElement', elementId: menu.element!.id }); setMenu(undefined); }}><Trash2 size={13} /> Delete element</button><div className="menu-divider" /></>}
          {menu.relation && <><button role="menuitem" onClick={() => editRelation(menu.relation!)}>Edit relationship</button><button role="menuitem" onClick={() => { commit({ type: 'deleteRelation', relationId: menu.relation!.id }); setMenu(undefined); }}><Trash2 size={13} /> Delete relationship</button><div className="menu-divider" /></>}
          {!menu.element && !menu.relation && native && palette.map(kind => <button role="menuitem" key={kind} onClick={() => beginElement(kind, menu.point)}><Plus size={13} /> {kind}</button>)}
          {Boolean(menu.element && (menu.element.meta?.container || ['mindmap', 'wbs', 'files'].includes(diagram?.kind ?? '') || ['object', 'array'].includes(String(menu.element.meta?.dataType)))) && native && palette.map(kind => <button role="menuitem" key={kind} onClick={() => beginElement(kind, menu.point, menu.element!.id)}><Plus size={13} /> Add {kind} inside</button>)}
          <button role="menuitem" onClick={openSource}><Code2 size={13} /> Edit PlantUML source</button>
          <button role="menuitem" onClick={() => { setMenu(undefined); setShowGallery(true); }}><FilePlus2 size={13} /> New diagram…</button>
        </div>}
        {elementDraft && <div className="floating-form nowheel" role="dialog" aria-label="Add element"><div className="form-heading"><span>Add {elementDraft.kind}</span><ToolButton title="Cancel adding element" onClick={() => setElementDraft(undefined)}><X size={15} /></ToolButton></div><form onSubmit={event => { event.preventDefault(); addElement(); }}><label>Name<input autoFocus aria-label="New element name" placeholder={`Name this ${elementDraft.kind}`} value={elementDraft.name} onChange={event => setElementDraft({ ...elementDraft, name: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') setElementDraft(undefined); }} /></label><div className="form-actions"><button type="button" onClick={() => setElementDraft(undefined)}>Cancel</button><button className="primary" type="submit" disabled={!elementDraft.name.trim()}><Plus size={14} /> Add element</button></div></form></div>}
        {relationDraft && <div className="floating-form relation-form nowheel" role="dialog" aria-label="Edit relationship"><div className="form-heading"><span>{relationDraft.relationId ? 'Edit relationship' : 'Connect elements'}</span><ToolButton title="Cancel relationship" onClick={() => setRelationDraft(undefined)}><X size={15} /></ToolButton></div><form onSubmit={event => { event.preventDefault(); saveRelation(); }}><div className="connection-summary"><span>{diagram?.elements.find(element => element.id === relationDraft.source)?.name ?? relationDraft.source}</span><ArrowLeftRight size={14} /><span>{diagram?.elements.find(element => element.id === relationDraft.target)?.name ?? relationDraft.target}</span></div><label>Relationship<select aria-label="Relationship type" value={relationDraft.arrow} onChange={event => setRelationDraft({ ...relationDraft, arrow: event.target.value })}>{!arrowTypes.some(([arrow]) => arrow === relationDraft.arrow) && <option value={relationDraft.arrow}>{relationDraft.arrow}</option>}{arrowTypes.map(([arrow, name]) => <option key={arrow} value={arrow}>{name} ({arrow})</option>)}</select></label><label>Label<input aria-label="Relationship label" autoFocus placeholder="Optional label" value={relationDraft.label} onChange={event => setRelationDraft({ ...relationDraft, label: event.target.value })} /></label><div className="form-actions"><button type="button" onClick={() => setRelationDraft(undefined)}>Cancel</button><button className="primary" type="submit"><Check size={14} /> Apply</button></div></form></div>}
        {sourceOpen && <section className="source-panel nowheel" aria-label="PlantUML source editor"><div className="form-heading"><div><Code2 size={15} /><span>PlantUML source</span><small title={sourceTargetLabel}>{sourceTargetLabel} · {sourceDraft !== sourceBase ? 'Unsaved draft' : 'In sync'}</small></div><ToolButton title="Close source editor" onClick={() => setSourceOpen(false)}><X size={15} /></ToolButton></div>{sourceChanged && <div className="draft-notice">The document changed. Your draft is preserved. Reload the current source before making further changes.<button onClick={reloadSource}>Reload source</button></div>}<textarea aria-label="PlantUML source" spellCheck={false} value={sourceDraft} onChange={event => setSourceDraft(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); commit({ type: 'replaceSource', source: sourceDraft }, sourceVersion, sourceDiagram); } if (event.key === 'Tab') { event.preventDefault(); const target = event.currentTarget, start = target.selectionStart, end = target.selectionEnd; setSourceDraft(sourceDraft.slice(0, start) + '  ' + sourceDraft.slice(end)); requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 2; }); } }} /><div className="source-footer"><span>Ctrl+Enter to apply · Escape leaves your draft</span><button className="primary" onClick={() => commit({ type: 'replaceSource', source: sourceDraft }, sourceVersion, sourceDiagram)} disabled={sourceDraft === sourceBase || Boolean(sourceChanged)}><Check size={13} /> Apply changes</button></div></section>}
        {error && <div className="error-toast" role="alert"><span>{error}</span><ToolButton title="Dismiss error" onClick={() => setError('')}><X size={14} /></ToolButton></div>}
        {busy && !error && <div className="connection-notice" role="status">{busy}</div>}
      </main>
    </div>
    {(showGallery || !diagram && documentState && !documentState.source.trim()) && <div className="gallery-backdrop nowheel" role="presentation" onClick={event => { if (event.target === event.currentTarget && diagram) setShowGallery(false); }}>
      <section className="gallery" role="dialog" aria-modal="true" aria-label="Create a new diagram">
        <div className="gallery-heading"><div><span className="eyebrow">ALIOT UML EDITOR</span><h1>Start with a diagram.</h1><p>Choose a diagram type with editable React Flow elements.</p></div>{diagram && <ToolButton title="Close diagram gallery" onClick={() => setShowGallery(false)}><X size={18} /></ToolButton>}</div>
        <input className="gallery-search" autoFocus aria-label="Search diagram types" placeholder="Find a diagram type…" value={gallerySearch} onChange={event => setGallerySearch(event.target.value)} />
        <div className="gallery-content"><div className="template-grid">{nativeTemplates.filter(template => `${template.label} ${template.description}`.toLowerCase().includes(gallerySearch.toLowerCase())).map(template => <button key={template.kind} className="template-card" onClick={() => { send({ type: 'create', kind: template.kind }); setActiveId(isFilePreview ? `diagram-${parsed.diagrams.length + 1}` : 'diagram-1'); setShowGallery(false); setSourceOpen(false); lastScene.current = ''; }}><span className="template-icon"><Shapes size={20} strokeWidth={1.25} /></span><strong>{template.label}</strong><span>{template.description}</span><small>Native React Flow</small></button>)}</div>
          {unsupportedTemplates.length > 0 && <details className="unsupported-types"><summary>Not implemented ({unsupportedTemplates.length} diagram types)</summary><p>These formats are recognized in source, but do not have a native diagram editor yet.</p><div>{unsupportedTemplates.filter(template => `${template.label} ${template.description}`.toLowerCase().includes(gallerySearch.toLowerCase())).map(template => <button key={template.kind} disabled title="Native editor not implemented">{template.label}<small>Not implemented</small></button>)}</div></details>}
        </div><div className="gallery-footer"><span>{nativeTemplates.length} native diagram types</span><span>{isFilePreview ? 'Adds a diagram to this file' : diagram ? 'Creates a new document' : 'Your diagram stays as readable PlantUML'}</span></div>
      </section>
    </div>}
  </div>;
}
