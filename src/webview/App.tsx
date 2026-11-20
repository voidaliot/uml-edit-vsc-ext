import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReactFlow, Background, BackgroundVariant, MiniMap, applyNodeChanges, applyEdgeChanges, ConnectionMode, SelectionMode, useReactFlow, useNodesInitialized, type NodeTypes, type EdgeTypes, type Connection, type Viewport, type NodeChange } from '@xyflow/react';
import type { FinalConnectionState } from '@xyflow/react';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceAround, AlignStartHorizontal, AlignStartVertical, AlignVerticalSpaceAround, ArrowLeftRight, Check, Code2, Download, FilePlus2, FolderOpen, Hand, Map as MapIcon, ListTree, Maximize, Minus, MousePointer2, Plus, Redo2, RefreshCw, Shapes, SquareArrowOutUpRight, Trash2, Undo2, X } from 'lucide-react';
import { parseDocument, umlFamilies } from '../core/parser';
import { applyDiagramEdit } from '../core/edits';
import { layoutDiagram } from '../core/layout';
import { nativeTemplates, unsupportedTemplates, getTemplate, supportsBlank, unnamedKinds } from '../core/templates';
import type { DiagramBlock, DiagramEdit, DiagramElement, DiagramKind, DiagramRelation, ElementPlacement, HostMessage, LineType, Point } from '../shared/protocol';
import { send, subscribe, isStandalone, isFilePreview, openLocalFile, downloadSource, loadViewState, saveViewState } from './bridge';
import { UmlNodeView, type UmlNode } from './nodes';
import { EdgeMarkers, UmlEdgeView, type UmlEdge } from './edges';
import { prepareGraphPorts, relationHandles } from './connections';
import { alignBoxes, clearOfPinned, containerBounds, freeformKinds, freeSpot, type Alignment, type Box } from './arrange';
import { QuickConnect, connectableKinds, connectionDrop, type QuickAdd } from './QuickConnect';
import { canReconnect } from './connections';
import { reconnectRadius } from './edges';

type FlowNode = UmlNode;
type DocumentState = Extract<HostMessage, { type: 'document' }>;
type ContextMenu = { x: number; y: number; point: Point; element?: DiagramElement; relation?: DiagramRelation };
type ElementDraft = { kind: string; name: string; point?: Point; version: number; diagramId: string; parentId?: string };
type RelationDraft = { source: string; target: string; arrow: string; label: string; relationId?: string; version: number; diagramId: string; sequenceRow?: number };
const nodeTypes = { uml: UmlNodeView } satisfies NodeTypes;
const edgeTypes = { uml: UmlEdgeView } satisfies EdgeTypes;
const structuralArrows = [['-->', 'Directed association'], ['--', 'Association'], ['..>', 'Dependency'], ['<|--', 'Inheritance'], ['<|..', 'Realization'], ['*--', 'Composition'], ['o--', 'Aggregation']];
/** Each family offers the connectors that mean something in its notation. */
const arrowTypes: Partial<Record<DiagramKind, string[][]>> = {
  sequence: [['->', 'Message'], ['-->', 'Reply'], ['->>', 'Asynchronous message'], ['-->>', 'Asynchronous reply']],
  state: [['-->', 'Transition'], ['->', 'Transition, same row']],
  usecase: [['-->', 'Association'], ['--', 'Association, undirected'], ['..>', 'Include / extend'], ['<|--', 'Generalization']],
  component: [['-->', 'Uses'], ['--', 'Connection'], ['..>', 'Dependency']],
  deployment: [['-->', 'Connection'], ['--', 'Link'], ['..>', 'Dependency']],
  object: [['-->', 'Link'], ['--', 'Association'], ['*--', 'Composition'], ['o--', 'Aggregation']],
  entity: [['||--o{', 'One to many'], ['}o--||', 'Many to one'], ['||--||', 'One to one'], ['}o--o{', 'Many to many'], ['--', 'Plain link']],
};
const defaultArrow = (kind: DiagramKind | undefined) => (kind && arrowTypes[kind] || structuralArrows)[0][0];
const title = (kind: string) => kind.replace(/^sdl-/, '').replace(/(^|[-_\s])(\w)/g, (_, separator: string, letter: string) => `${separator ? ' ' : ''}${letter.toUpperCase()}`);

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
  const [quickAdd, setQuickAdd] = useState<QuickAdd>();
  const [selectedId, setSelectedId] = useState<string>();
  const [kinds, setKinds] = useState<Record<string, DiagramKind>>(() => loadViewState().kinds ?? {});
  const [blankStart, setBlankStart] = useState(false);
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
  const keyboardPlacement = useRef<{ diagramId: string; version: number; positions: Record<string, Point> } | undefined>(undefined);
  const pendingPlacement = useRef<{ diagramId: string; knownIds: Set<string>; point?: Point } | undefined>(undefined);
  const reveal = useRef<string | undefined>(undefined);
  const reconnecting = useRef<{ id: string; end: 'source' | 'target' } | undefined>(undefined);
  const kindsRef = useRef(kinds);
  kindsRef.current = kinds;
  const pendingEdit = useRef<{ expectedSource: string; version: number; resolve: (applied: boolean) => void; timer: number } | undefined>(undefined);
  const lastScene = useRef('');
  const flow = useReactFlow<FlowNode, UmlEdge>();
  const nodesInitialized = useNodesInitialized();
  const parsed = useMemo(() => parseDocument(documentState?.source ?? '', { kinds }), [documentState?.source, kinds]);
  const chooseKind = useCallback((diagramId: string, kind: DiagramKind) => setKinds(previous => { const next = { ...previous, [diagramId]: kind }; saveViewState({ kinds: next }); return next; }), []);
  const diagram = parsed.diagrams.find(block => block.id === activeId) ?? parsed.diagrams[0];
  const native = Boolean(diagram?.graphical);
  const derivedRelations = Boolean(diagram && (diagram.meta?.derivedRelations ?? (['activity', 'sdl', 'mindmap', 'wbs'].includes(diagram.kind) && !diagram.meta?.legacy)));
  const hand = tool === 'hand' || spaceHeld;
  const palette = diagram ? [...getTemplate(diagram.kind)?.palette ?? [], ...(diagram.kind === 'state' ? ['initial', 'final'] : [])] : [];
  // An empty UML block does not say what it is going to be; ask instead of assuming a class diagram.
  const undecided = Boolean(diagram && native && diagram.meta?.openKind && !diagram.elements.length && !kinds[diagram.id]);
  const freeform = Boolean(diagram && freeformKinds.has(diagram.kind));
  const selectedNodes = useMemo(() => nodes.filter(node => node.selected).map(node => node.id), [nodes]);
  const selectedEdges = useMemo(() => edges.filter(edge => edge.selected).map(edge => edge.id), [edges]);
  const selectionCount = selectedNodes.length + selectedEdges.length || (selectedId ? 1 : 0);

  useEffect(() => {
    const unsubscribe = subscribe(message => {
      if (message.type === 'document') {
        positions.current = Object.fromEntries(Object.entries(message.layouts).map(([id, layout]) => [id, Object.assign(Object.create(null), layout.positions)]));
        docRef.current = message;
        if (message.kinds) setKinds(previous => { const next = { ...message.kinds, ...previous }; saveViewState({ kinds: next }); return next; });
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
        lastScene.current = ''; pendingPlacement.current = undefined; dragStart.current = undefined; keyboardPlacement.current = undefined; reveal.current = undefined;
        setKinds({}); saveViewState({ kinds: {} });
        setNodes([]); setEdges([]); setActiveId('diagram-1'); setSelectedId(undefined); setMenu(undefined);
        setElementDraft(undefined); setRelationDraft(undefined); setSourceOpen(false); setSourceRequested(false); setSourceDraft(''); setSourceBase(''); setSourceDiagram('');
        setShowGallery(false); setError(''); setBusy(null); setApplyingEdit(false);
        setQuickAdd(undefined); reconnecting.current = undefined;
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
      const kind = kindsRef.current[diagramId ?? diagram!.id];
      const expectedSource = applyDiagramEdit(current.source, diagramId ?? diagram!.id, edit, { kind });
      if (expectedSource === current.source) return true;
      setError(''); setApplyingEdit(true);
      const applied = await new Promise<boolean>(resolve => {
        const timer = window.setTimeout(() => { pendingEdit.current = undefined; setError('The editor has not confirmed this change. Your draft is preserved.'); resolve(false); }, 15000);
        pendingEdit.current = { expectedSource, version: current.version, resolve, timer };
        send({ type: 'edit', version: version ?? current.version, diagramId: diagramId ?? diagram!.id, edit, kind });
      });
      setApplyingEdit(false);
      if (applied && edit.type === 'rename') {
        const id = diagramId ?? diagram!.id;
        const before = parseDocument(current.source, { kinds: kindsRef.current }).diagrams.find(block => block.id === id);
        const after = parseDocument(expectedSource, { kinds: kindsRef.current }).diagrams.find(block => block.id === id);
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
      setSourceRequested(true); setMenu(undefined); return;
    }
    setRelationDraft({ ...relation, relationId: relation.id, version: documentState.version, diagramId: diagram.id });
    setMenu(undefined);
  }, [diagram?.id, documentState?.version, derivedRelations]);

  const selectEdge = useCallback((id: string, extend: boolean) => {
    setEdges(previous => previous.map(edge => edge.id === id ? { ...edge, selected: extend ? !edge.selected : true } : extend ? edge : { ...edge, selected: false }));
    if (!extend) setNodes(previous => previous.map(node => node.selected ? { ...node, selected: false } : node));
  }, []);

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
    const leaves = diagram.elements.filter(element => !element.meta?.container && element.meta?.editable !== false);
    const pinned = (element: DiagramElement) => !element.meta?.positionLocked && !element.meta?.moveEdit && Object.hasOwn(saved, element.id);
    // In a diagram that is mostly placed by hand, a new element takes a clear spot beside the
    // arrangement; the automatic layout would rank it into positions the others no longer hold.
    const arranged = freeformKinds.has(diagram.kind) && leaves.filter(pinned).length * 2 > leaves.length;
    const sized = (element: DiagramElement, point: Point): Box => ({ ...point, width: Number(element.meta?.width ?? 192), height: Number(element.meta?.height ?? 80) });
    const pending = pendingPlacement.current;
    const added = pending?.diagramId === diagram.id ? diagram.elements.find(element => !pending.knownIds.has(element.id)) : undefined;
    const spot = (element: DiagramElement, taken: Record<string, Point>) => {
      const placed = diagram.elements.filter(other => other.id !== element.id && !other.meta?.container && taken[other.id]).map(other => sized(other, taken[other.id]));
      const siblings = element.parentId ? diagram.elements.filter(other => other.id !== element.id && other.parentId === element.parentId && !other.meta?.container && taken[other.id]).map(other => sized(other, taken[other.id])) : [];
      if (element.parentId && !siblings.length) { const parent = taken[element.parentId]; if (parent) return { x: parent.x + 30, y: parent.y + 70 }; }
      return freeSpot(placed, siblings);
    };
    if (pending && added) {
      const basePositions = { ...saved };
      const movable = !added.meta?.positionLocked && !added.meta?.moveEdit;
      // A right-click names the place. From the palette an arranged diagram gets a clear spot;
      // an automatic one simply ranks the new element with the rest.
      const point = pending.point ?? (arranged && !added.meta?.container ? spot(added, { ...automatic, ...saved }) : undefined);
      if (movable && point) saved[added.id] = point;
      pendingPlacement.current = undefined; reveal.current = added.id;
      if (movable && point) send({ type: 'layout', version: docRef.current?.version, basePositions, diagramId: diagram.id, layout: { ...documentState.layouts[diagram.id], positions: saved } });
    }
    positions.current[diagram.id] = saved;
    const display: Record<string, Point> = Object.create(null);
    for (const element of diagram.elements) {
      const remembered = pinned(element) ? saved[element.id] : undefined;
      if (element.kind === 'sequence-divider' && remembered?.width) element.meta = { ...element.meta, width: remembered.width, height: remembered.height ?? 28 };
      // Copy: saved and automatic points are shared with stored layouts and must not be adjusted in place.
      let point = { ...(remembered ?? (Object.hasOwn(automatic, element.id) ? automatic[element.id] : undefined) ?? { x: 0, y: 0 }) };
      if (element.meta?.tableRow && element.parentId && automatic[element.id] && automatic[element.parentId]) {
        const parent = Object.hasOwn(saved, element.parentId) ? saved[element.parentId] : automatic[element.parentId];
        point = { x: automatic[element.id].x + parent.x - automatic[element.parentId].x, y: automatic[element.id].y + parent.y - automatic[element.parentId].y };
      }
      if (element.meta?.lockX && automatic[element.id]) point.x = automatic[element.id].x;
      if (diagram.kind === 'sequence') point.y = automatic[element.id]?.y ?? 0;
      display[element.id] = point;
    }
    // Elements that arrived without a place (typed in the source, say) must not land on the arrangement.
    if (arranged) {
      const taken: Record<string, Point> = Object.fromEntries(diagram.elements.filter(element => pinned(element) || element.meta?.container).map(element => [element.id, display[element.id]]));
      for (const element of leaves) if (!pinned(element)) taken[element.id] = display[element.id] = spot(element, taken);
    } else if (freeformKinds.has(diagram.kind)) {
      // A re-ranked element must never land on one that was placed by hand.
      const ranked = new Map(leaves.filter(element => !pinned(element)).map(element => [element.id, sized(element, display[element.id])]));
      for (const [id, point] of clearOfPinned(ranked, leaves.filter(pinned).map(element => sized(element, display[element.id])))) display[id] = point;
    }
    if (freeformKinds.has(diagram.kind)) {
      const holdsPinned = (id: string): boolean => diagram.elements.some(child => child.parentId === id && (child.meta?.container ? holdsPinned(child.id) : pinned(child) || arranged));
      for (const [id, bounds] of containerBounds(diagram.elements, id => { const element = diagram.elements.find(item => item.id === id); return element && display[id] ? sized(element, display[id]) : undefined; })) {
        if (!holdsPinned(id)) continue;
        const element = diagram.elements.find(item => item.id === id)!;
        element.meta = { ...element.meta, width: bounds.width, height: bounds.height };
        display[id] = { x: bounds.x, y: bounds.y };
      }
    }
    prepareGraphPorts(diagram, display);
    setNodes(previous => diagram.elements.map(element => {
      const old = previous.find(node => node.id === element.id);
      return {
        id: element.id, type: 'uml', position: display[element.id], selected: reveal.current ? element.id === reveal.current : old?.selected,
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
    // Links between the same two elements would stack their labels at one midpoint.
    const parallel = new Map<string, string[]>();
    for (const relation of diagram.relations) { const key = [relation.source, relation.target].sort().join('\0'); parallel.set(key, [...parallel.get(key) ?? [], relation.id]); }
    const labelSide = (relation: DiagramRelation): -1 | 0 | 1 => { const group = parallel.get([relation.source, relation.target].sort().join('\0'))!, index = group.indexOf(relation.id); return group.length < 2 || diagram.kind === 'sequence' ? 0 : index === 0 ? -1 : index === group.length - 1 ? 1 : 0; };
    setEdges(previous => diagram.relations.filter(relation => !/hidden/i.test(relation.arrow) && !relation.meta?.tableInternal).map((relation, index) => ({ id: relation.id, type: 'uml', source: relation.source, target: relation.target, selected: reveal.current ? false : previous.find(edge => edge.id === relation.id)?.selected, ...relationHandles(relation, diagram, display), data: { relation, lineType: diagram.meta?.lineType as LineType, labelSide: labelSide(relation), sequenceIndex: diagram.kind === 'sequence' ? Number(relation.meta?.row ?? index) : undefined, onEdit: editRelation, onSelect: selectEdge, onMoveSequence: diagram.kind === 'sequence' ? moveMessage : undefined, version: documentState.version, diagramId: diagram.id } }) satisfies UmlEdge));
  }, [diagram, native, documentState, commit, editRelation, moveMessage, resizeDivider, selectEdge]);

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

  useEffect(() => {
    const id = reveal.current;
    if (!id || !nodesInitialized || !canvas.current) return;
    const node = flow.getNode(id);
    // Deleted again before it was shown: nothing is left to reveal.
    if (!node) { if (!nodes.some(item => item.id === id)) reveal.current = undefined; return; }
    reveal.current = undefined; setSelectedId(id);
    // Bring a new element into view only when it landed outside the window.
    const rect = canvas.current.getBoundingClientRect(), view = flow.getViewport();
    const left = node.position.x * view.zoom + view.x, top = node.position.y * view.zoom + view.y;
    const right = left + (node.measured?.width ?? 192) * view.zoom, bottom = top + (node.measured?.height ?? 80) * view.zoom;
    if (left < 0 || top < 0 || right > rect.width || bottom > rect.height) void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 220 });
  }, [nodesInitialized, nodes, flow]);

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

  const select = useCallback((ids: readonly string[]) => {
    setNodes(previous => previous.map(node => node.selected === ids.includes(node.id) ? node : { ...node, selected: ids.includes(node.id) }));
    setEdges(previous => previous.map(edge => edge.selected === ids.includes(edge.id) ? edge : { ...edge, selected: ids.includes(edge.id) }));
    setSelectedId(ids.length === 1 ? ids[0] : undefined);
  }, []);

  /** Everything selected goes in one edit, so one undo brings it all back. */
  const deleteSelection = useCallback(() => {
    if (!diagram || !native) return;
    const picked = new Set([...selectedNodes, ...selectedEdges, ...(selectedId ? [selectedId] : [])]);
    const elementIds = diagram.elements.filter(element => picked.has(element.id) && element.meta?.editable !== false).map(element => element.id);
    const relationIds = derivedRelations ? [] : diagram.relations.filter(relation => picked.has(relation.id)).map(relation => relation.id);
    setMenu(undefined);
    if (!elementIds.length && !relationIds.length) {
      if (derivedRelations && diagram.relations.some(relation => picked.has(relation.id))) setError('These connections follow the diagram structure. Delete the elements they join, or edit the PlantUML source.');
      return;
    }
    void commit(elementIds.length === 1 && !relationIds.length ? { type: 'deleteElement', elementId: elementIds[0] } : !elementIds.length && relationIds.length === 1 ? { type: 'deleteRelation', relationId: relationIds[0] } : { type: 'deleteElements', elementIds, relationIds });
    select([]);
  }, [diagram, selectedId, selectedNodes, selectedEdges, native, derivedRelations, commit, select]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Space') { event.preventDefault(); setSpaceHeld(true); }
      if (event.key === 'Escape') { setMenu(undefined); setElementDraft(undefined); setRelationDraft(undefined); setShowGallery(false); select([]); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && native) { event.preventDefault(); select([...nodes.filter(node => node.selectable !== false).map(node => node.id), ...edges.map(edge => edge.id)]); return; }
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
  }, [selectedId, native, deleteSelection, requestRename, diagram, editRelation, flow, select, nodes, edges]);

  const openSource = () => {
    if (!documentState) return;
    const id = diagram?.id ?? 'document', content = diagram?.source ?? documentState.source;
    if (sourceDraft === sourceBase && (sourceDiagram !== id || !sourceOpen)) { setSourceDraft(content); setSourceBase(content); setSourceVersion(documentState.version); setSourceDiagram(id); }
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
    // A right-click inside a selection acts on all of it; anywhere else it picks that one item.
    const id = element?.id ?? relation?.id;
    if (id && !selectedNodes.includes(id) && !selectedEdges.includes(id)) select([id]);
  };

  const beginElement = (kind: string, point?: Point, parentId?: string) => {
    if (!diagram || !documentState) return;
    setMenu(undefined);
    if (diagram.kind === 'state' && (kind === 'initial' || kind === 'final')) {
      // The initial and final symbols only exist as one end of a transition.
      const state = diagram.elements.find(element => element.id === (parentId ?? selectedId) && element.kind === 'state');
      if (!state) { setError(`Select a state first, then add its ${kind} marker.`); return; }
      void commit({ type: 'addRelation', source: kind === 'initial' ? '[*]' : state.id, target: kind === 'initial' ? state.id : '[*]', arrow: '-->', label: '' });
      return;
    }
    if (unnamedKinds.has(kind)) {
      pendingPlacement.current = { diagramId: diagram.id, knownIds: new Set(diagram.elements.map(element => element.id)) };
      void commit({ type: 'addElement', kind, name: kind }).then(applied => { if (!applied) pendingPlacement.current = undefined; });
      return;
    }
    setElementDraft({ kind, name: '', parentId, point, version: documentState.version, diagramId: diagram.id });
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
    setRelationDraft({ source: connection.source, target: connection.target, arrow: defaultArrow(diagram.kind), label: '', version: documentState.version, diagramId: diagram.id, sequenceRow });
  };

  const saveRelation = async () => {
    if (!relationDraft) return;
    const applied = await commit(relationDraft.relationId ? { type: 'editRelation', relationId: relationDraft.relationId, label: relationDraft.label, arrow: relationDraft.arrow } : { type: 'addRelation', source: relationDraft.source, target: relationDraft.target, arrow: relationDraft.arrow, label: relationDraft.label, sequenceRow: relationDraft.sequenceRow }, relationDraft.version, relationDraft.diagramId);
    if (applied) setRelationDraft(undefined);
  };

  /**
   * A connection released on an element's body links to that element, as on one of its handles.
   * Released on empty canvas, it offers a new element there, linked from where the drag began.
   */
  const connectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (!diagram || !documentState || !native || hand || !state.fromNode) return;
    const drop = connectionDrop(event, state), moving = reconnecting.current;
    if (!drop || drop.nodeId !== undefined && flow.getNode(drop.nodeId)?.connectable === false) return;
    if (moving) {
      const edge = edges.find(item => item.id === moving.id);
      if (edge && drop.nodeId) reconnect(edge, { source: moving.end === 'source' ? drop.nodeId : edge.source, target: moving.end === 'target' ? drop.nodeId : edge.target, sourceHandle: null, targetHandle: null });
      return;
    }
    if (derivedRelations) return;
    if (drop.nodeId !== undefined) {
      if (drop.nodeId && drop.nodeId !== state.fromNode.id) connect({ source: state.fromNode.id, target: drop.nodeId, sourceHandle: state.fromHandle?.id ?? null, targetHandle: null });
      return;
    }
    const match = state.fromHandle?.id?.match(/^sequence-(\d+)$/);
    const sequenceRow = diagram.kind === 'sequence' ? match ? Number(match[1]) : Number(diagram.meta?.sequenceRows ?? diagram.relations.length) : undefined;
    const arrow = defaultArrow(diagram.kind), source = state.fromNode.id;
    const choices = connectableKinds(documentState.source, diagram, palette, source, arrow, sequenceRow, kinds[diagram.id]);
    if (!choices.length) { setError('No element can be added and connected here in one step. Add the element first, then connect it.'); return; }
    const rect = canvas.current!.getBoundingClientRect(), at = flow.screenToFlowPosition(drop.point);
    setMenu(undefined);
    setQuickAdd({ x: Math.min(drop.point.x - rect.left, rect.width - 240), y: Math.min(drop.point.y - rect.top, rect.height - 60 - 32 * choices.length), point: { x: at.x - 96, y: at.y - 40 }, source, arrow, sequenceRow, kinds: choices, kind: choices.length === 1 ? choices[0] : undefined, name: '', version: documentState.version, diagramId: diagram.id });
  };
  const addConnected = async () => {
    const draft = quickAdd;
    if (!draft?.kind || !draft.name.trim() || !diagram) return;
    pendingPlacement.current = { diagramId: draft.diagramId, knownIds: new Set(diagram.elements.map(element => element.id)), point: draft.point };
    const applied = await commit({ type: 'addConnectedElement', source: draft.source, kind: draft.kind, name: draft.name.trim(), arrow: draft.arrow, label: '', sequenceRow: draft.sequenceRow }, draft.version, draft.diagramId);
    if (applied) setQuickAdd(undefined);
    else pendingPlacement.current = undefined;
  };
  const cancelQuickAdd = useCallback(() => setQuickAdd(undefined), []);
  // Only a selected relationship shows its end grips, so a drag near an unselected end still starts a new connection.
  const relinkable = Boolean(diagram && native && !hand && !derivedRelations && canReconnect(diagram));
  const linkedEdges = useMemo(() => relinkable ? edges.map(edge => edge.selected && edge.data ? { ...edge, reconnectable: true, data: { ...edge.data, reconnectable: true } } : edge) : edges, [edges, relinkable]);
  const reconnect = (edge: UmlEdge, connection: Connection) => {
    const moving = reconnecting.current;
    if (!moving || moving.id !== edge.id || !edge.data) return;
    const elementId = moving.end === 'source' ? connection.source : connection.target;
    if (!elementId || elementId === edge[moving.end]) return;
    void commit({ type: 'reconnectRelation', relationId: edge.id, end: moving.end, elementId }, edge.data.version, edge.data.diagramId);
  };

  const autoLayout = () => {
    if (!diagram) return;
    relayoutFit.current = diagram;
    lastScene.current = diagram.id;
    const fresh = layoutDiagram(diagram);
    prepareGraphPorts(diagram, fresh);
    const basePositions = { ...positions.current[diagram.id] ?? docRef.current?.layouts[diagram.id]?.positions ?? {} };
    positions.current[diagram.id] = Object.create(null);
    // Containers that were fitted around dragged contents return to their laid-out size.
    setNodes(previous => previous.map(node => ({ ...node, position: fresh[node.id] ?? node.position, data: { ...node.data, element: diagram.elements.find(element => element.id === node.id) ?? node.data.element } })));
    setEdges(previous => previous.map(edge => ({ ...edge, ...relationHandles(edge.data!.relation, diagram, fresh) })));
    send({ type: 'layout', version: docRef.current?.version, basePositions, diagramId: diagram.id, layout: { positions: {} } });
  };

  const selectElement = (element: DiagramElement) => {
    select([element.id]);
    if (native) void flow.fitView({ nodes: [{ id: element.id }], padding: 1, maxZoom: 1, duration: 220 });
  };

  const beginDrag = () => {
    if (diagram && documentState) dragStart.current = { diagramId: diagram.id, version: documentState.version, positions: Object.fromEntries(flow.getNodes().map(node => [node.id, { ...node.position }])) };
  };
  /** One element, or a whole selection when React Flow drags its bounding box. */
  const endDrag = async (node?: FlowNode) => {
    const started = dragStart.current;
    dragStart.current = undefined;
    if (node?.data.element.kind === 'sequence-divider' && started && diagram?.id === started.diagramId) {
      const applied = await commit({ type: 'moveSequenceEvent', eventId: node.id, row: Math.max(0, Math.round((node.position.y - 137) / 52)) }, started.version, started.diagramId);
      const latest = parseDocument(docRef.current?.source ?? '', { kinds: kindsRef.current }).diagrams.find(block => block.id === started.diagramId);
      if (!latest) return;
      const automatic = layoutDiagram(latest)[node.id];
      if (automatic) setNodes(previous => previous.map(item => item.id === node.id ? { ...item, position: { x: applied ? node.position.x : started.positions[node.id].x, y: automatic.y } } : item));
      if (applied && automatic && Math.abs(node.position.x - started.positions[node.id].x) > .01) resizeDivider(node.id, { x: node.position.x, y: automatic.y, width: Number(node.data.element.meta?.width), height: 28 }, true, docRef.current!.version, started.diagramId);
    } else if (node?.data.element.meta?.moveEdit) {
      const applied = await commit({ type: 'move', elementId: node.id, position: node.position }, started?.version, started?.diagramId);
      if (!applied && diagram) setNodes(previous => previous.map(item => item.id === node.id ? { ...item, position: layoutDiagram(diagram)[item.id] ?? item.position } : item));
    } else if (started && diagram && started.diagramId === diagram.id && started.version === docRef.current?.version) {
      const movedIds = flow.getNodes().filter(item => {
        const before = started.positions[item.id];
        return before && (Math.abs(item.position.x - before.x) > 0.01 || Math.abs(item.position.y - before.y) > 0.01);
      }).map(item => item.id);
      if (movedIds.length) persistLayout(undefined, movedIds);
    }
  };
  const sourceTarget = sourceDiagram === 'document' ? documentState?.source : parsed.diagrams.find(block => block.id === sourceDiagram)?.source;
  /** Keep every container drawn around its contents while they are moved. */
  const fitContainers = (next: FlowNode[], moved: ReadonlySet<string>): FlowNode[] => {
    if (!moved.size || !diagram || !freeformKinds.has(diagram.kind)) return next;
    const byId = new Map(next.map(node => [node.id, node]));
    const size = (node: FlowNode): Box => ({ ...node.position, width: Number(node.data.element.meta?.width ?? node.measured?.width ?? 192), height: Number(node.data.element.meta?.height ?? node.measured?.height ?? 80) });
    const bounds = containerBounds(next.map(node => node.data.element), id => byId.has(id) ? size(byId.get(id)!) : undefined);
    const affected = (id: string): boolean => next.some(node => node.data.element.parentId === id && (moved.has(node.id) || affected(node.id)));
    return next.map(node => {
      const fitted = bounds.get(node.id);
      if (!fitted || !affected(node.id)) return node;
      const current = size(node);
      if (Math.abs(current.x - fitted.x) < .01 && Math.abs(current.y - fitted.y) < .01 && current.width === fitted.width && current.height === fitted.height) return node;
      return { ...node, position: { x: fitted.x, y: fitted.y }, data: { ...node.data, element: { ...node.data.element, meta: { ...node.data.element.meta, width: fitted.width, height: fitted.height } } } };
    });
  };
  const align = (how: Alignment) => {
    if (!diagram || !documentState || !freeform) return;
    const chosen = nodes.filter(node => node.selected && node.draggable !== false && !node.data.element.meta?.container);
    const moved = alignBoxes(new Map(chosen.map(node => [node.id, { ...node.position, width: node.measured?.width ?? Number(node.data.element.meta?.width ?? 192), height: node.measured?.height ?? Number(node.data.element.meta?.height ?? 80) }])), how);
    if (!moved.size) return;
    // Saved like a keyboard nudge: one placement step, once the nodes have rendered.
    keyboardPlacement.current = { diagramId: diagram.id, version: documentState.version, positions: Object.fromEntries(nodes.map(node => [node.id, { ...node.position }])) };
    setNodes(previous => fitContainers(previous.map(node => moved.has(node.id) ? { ...node, position: moved.get(node.id)! } : node), new Set(moved.keys())));
  };
  const changeNodes = (changes: NodeChange<FlowNode>[]) => {
    // Keyboard nudges finish without a drag-stop event. Capture their baseline
    // before React Flow's changes are applied, then persist after the render.
    if (!dragStart.current && diagram && documentState && changes.some(change => change.type === 'position' && change.position && change.dragging === false)) {
      keyboardPlacement.current = { diagramId: diagram.id, version: documentState.version, positions: Object.fromEntries(nodes.map(node => [node.id, { ...node.position }])) };
    }
    setNodes(previous => {
      const adjusted = changes.map(change => {
        if (change.type !== 'position' || !change.position) return change;
        const node = previous.find(node => node.id === change.id);
        return { ...change, position: { x: node?.data.element.meta?.lockX ? node.position.x : change.position.x, y: diagram?.kind === 'sequence' && node?.data.element.kind !== 'sequence-divider' ? node?.position.y ?? change.position.y : change.position.y } };
      });
      const originals = new Map(previous.map(node => [node.id, node]));
      const moved = new Map(adjusted.flatMap(change => change.type === 'position' && change.position ? [[change.id, change.position] as const] : []));
      const next = applyNodeChanges(adjusted, previous).map(node => {
        // React Flow already moves every selected node. Only inherit a movement
        // for unselected descendants, from their nearest explicitly moved parent.
        if (moved.has(node.id)) return node;
        const visited = new Set([node.id]);
        let parentId = node.data.element.parentId;
        while (parentId && !visited.has(parentId)) {
          visited.add(parentId);
          const parent = originals.get(parentId), point = moved.get(parentId);
          if (!parent) break;
          if (point && parent.data.element.meta?.container && !parent.data.element.kind.startsWith('sequence-')) {
            return { ...node, position: { x: node.position.x + point.x - parent.position.x, y: node.position.y + point.y - parent.position.y } };
          }
          parentId = parent.data.element.parentId;
        }
        return node;
      });
      return fitContainers(next, new Set(moved.keys()));
    });
  };
  useEffect(() => {
    const started = keyboardPlacement.current;
    if (!started) return;
    keyboardPlacement.current = undefined;
    if (started.diagramId !== diagram?.id || started.version !== docRef.current?.version) return;
    const movedIds = nodes.filter(node => {
      const before = started.positions[node.id];
      return before && (Math.abs(node.position.x - before.x) > .01 || Math.abs(node.position.y - before.y) > .01);
    }).map(node => node.id);
    if (movedIds.length) persistLayout(undefined, movedIds);
  }, [nodes, diagram?.id, persistLayout]);
  const sourceTargetLabel = sourceDiagram === 'document' ? 'Document' : parsed.diagrams.find(block => block.id === sourceDiagram)?.title ?? sourceDiagram;
  const sourceChanged = documentState && sourceVersion !== documentState.version && sourceDraft !== sourceTarget;
  return <div className="app-shell">
    <header className="editor-toolbar nowheel" role="toolbar" aria-label="Diagram tools">
      <div className="toolbar-group">
        <ToolButton title="Toggle outline" onClick={() => setShowOutline(!showOutline)} active={showOutline}><ListTree size={16} /></ToolButton>
        <label className="diagram-selector"><select aria-label="Current diagram" title="Current diagram" value={diagram?.id ?? ''} disabled={!parsed.diagrams.length} onChange={event => { setActiveId(event.target.value); select([]); setMenu(undefined); }}>{parsed.diagrams.length ? parsed.diagrams.map((block, index) => <option key={block.id} value={block.id}>{`${index + 1}. ${block.meta?.openKind && !block.elements.length && !kinds[block.id] ? 'New diagram' : getTemplate(block.kind)?.label ?? block.kind}${block.title && block.title.toLowerCase() !== `${block.kind} diagram` ? ` — ${block.title}` : ''}`}</option>) : <option value="">Choose a diagram</option>}</select></label>
        <ToolButton title="New diagram" onClick={() => { setShowGallery(true); setGallerySearch(''); }}><FilePlus2 size={16} /></ToolButton>
        {isStandalone && <>
          <ToolButton title="Open PlantUML file" onClick={openLocalFile}><FolderOpen size={16} /></ToolButton>
          <ToolButton title="Download PlantUML" onClick={downloadSource} disabled={!documentState || applyingEdit}><Download size={16} /></ToolButton>
        </>}
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
        <ToolButton title={selectionCount > 1 ? `Delete ${selectionCount} selected items (Delete)` : 'Delete selection (Delete)'} label="Delete selection" onClick={deleteSelection} disabled={!native || !selectionCount || applyingEdit}><Trash2 size={16} /></ToolButton>
      </div>
      {freeform && selectedNodes.length > 1 && <><span className="toolbar-divider" /><div className="toolbar-group" role="group" aria-label="Arrange selection">
        <ToolButton title="Align left edges" onClick={() => align('left')}><AlignStartVertical size={16} /></ToolButton>
        <ToolButton title="Align centers horizontally" onClick={() => align('center')}><AlignCenterVertical size={16} /></ToolButton>
        <ToolButton title="Align right edges" onClick={() => align('right')}><AlignEndVertical size={16} /></ToolButton>
        <ToolButton title="Align top edges" onClick={() => align('top')}><AlignStartHorizontal size={16} /></ToolButton>
        <ToolButton title="Align centers vertically" onClick={() => align('middle')}><AlignCenterHorizontal size={16} /></ToolButton>
        <ToolButton title="Align bottom edges" onClick={() => align('bottom')}><AlignEndHorizontal size={16} /></ToolButton>
        <ToolButton title="Distribute horizontally" onClick={() => align('distribute-x')} disabled={selectedNodes.length < 3}><AlignHorizontalSpaceAround size={16} /></ToolButton>
        <ToolButton title="Distribute vertically" onClick={() => align('distribute-y')} disabled={selectedNodes.length < 3}><AlignVerticalSpaceAround size={16} /></ToolButton>
      </div></>}
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
        <ToolButton title="Source file" disabled={!documentState || isStandalone && !isFilePreview} onClick={() => isFilePreview ? openSource() : send({ type: 'openSource', line: diagram?.startLine })}><SquareArrowOutUpRight size={16} /></ToolButton>
      </div>
    </header>
    <div className="workspace">
      {showOutline && <aside className="outline" aria-label="Diagram outline">
        <div className="outline-list">{native && diagram?.elements.map(element => <button key={element.id} className={`outline-item ${selectedId === element.id || selectedNodes.includes(element.id) ? 'selected' : ''}`} onClick={() => selectElement(element)} onDoubleClick={() => requestRename(element.id)}><span className={`element-glyph glyph-${element.kind}`}>{element.kind === 'actor' ? '♙' : element.kind === 'interface' ? 'I' : element.kind === 'enum' ? 'E' : element.kind.slice(0, 1).toUpperCase()}</span><span>{element.name || element.kind.replace(/(^|-|\s)(\w)/g, (_, separator: string, letter: string) => `${separator ? ' ' : ''}${letter.toUpperCase()}`)}</span><small>{element.kind}</small></button>)}
          {(!native || !diagram?.elements.length) && <p className="outline-empty">{diagram ? native ? undecided ? 'Choose a diagram type to begin.' : 'Right-click the canvas to add an element.' : 'Native support for this syntax is not implemented. The source remains available.' : 'Create a diagram to begin.'}</p>}
        </div>
        <div className="outline-bottom"><span className="small-label">{native ? 'ADD ELEMENT' : 'AUTHORING'}</span>{native && diagram?.meta?.openKind === true && <label className="kind-select">Diagram type<select aria-label="Diagram type" value={undecided ? '' : diagram.kind} onChange={event => chooseKind(diagram.id, event.target.value as DiagramKind)}>{undecided && <option value="">Choose…</option>}{umlFamilies.map(kind => <option key={kind} value={kind}>{getTemplate(kind)?.label ?? kind}</option>)}</select></label>}{native && undecided ? null : native && palette.length > 0 ? <div className="palette-list">{palette.map(kind => <button key={kind} title={`Add ${title(kind).toLowerCase()}`} onClick={() => beginElement(kind)}><Plus size={12} /><span>{kind}</span></button>)}</div> : <button className="text-button" onClick={openSource} disabled={!documentState}><Code2 size={14} /> Edit diagram source</button>}</div>
      </aside>}
      <main ref={canvas} className={`canvas-shell ${hand ? 'hand-tool' : 'select-tool'}`} aria-label="Diagram canvas" onPointerDownCapture={() => { relayoutFit.current = undefined; if (diagram) lastScene.current = diagram.id; }}>
        <ReactFlow<FlowNode, UmlEdge> nodes={native ? nodes : []} edges={native ? linkedEdges : []} nodeTypes={nodeTypes} edgeTypes={edgeTypes} proOptions={{ hideAttribution: true }}
          onNodesChange={changeNodes}
          onEdgesChange={changes => setEdges(previous => applyEdgeChanges(changes, previous))}
          onNodeClick={(_, node) => { setSelectedId(node.id); setMenu(undefined); }}
          onEdgeClick={(_, edge) => { setSelectedId(edge.id); setMenu(undefined); }}
          onSelectionChange={({ nodes: chosen, edges: links }) => { if (chosen.length + links.length !== 1) setSelectedId(undefined); else setSelectedId(chosen[0]?.id ?? links[0].id); }}
          onNodeDoubleClick={(_, node) => native && requestRename(node.id)}
          onEdgeDoubleClick={(_, edge) => edge.data && editRelation(edge.data.relation)}
          onNodeContextMenu={(event, node) => openContext(event, node.type === 'uml' ? node.data.element : undefined)}
          onEdgeContextMenu={(event, edge) => openContext(event, undefined, edge.data?.relation)}
          onPaneContextMenu={event => openContext(event)}
          onPaneClick={() => { setMenu(undefined); select([]); }}
          onNodeDragStart={beginDrag} onNodeDragStop={(_, node) => void endDrag(node)}
          onSelectionDragStart={beginDrag} onSelectionDragStop={() => void endDrag()}
          onSelectionContextMenu={event => openContext(event)}
          onMove={(_, viewport) => setZoom(viewport.zoom)}
          onMoveEnd={(_, viewport) => persistLayout(viewport)}
          onConnect={connect} connectionMode={ConnectionMode.Loose} connectionRadius={28}
          onConnectEnd={connectEnd} onReconnect={reconnect} edgesReconnectable={false} reconnectRadius={reconnectRadius}
          onReconnectStart={(_, edge, handleType) => { reconnecting.current = { id: edge.id, end: handleType === 'target' ? 'source' : 'target' }; }} onReconnectEnd={() => { reconnecting.current = undefined; }}
          nodesDraggable={native && !hand} nodesConnectable={native && !hand && !derivedRelations} elementsSelectable={native && !hand}
          selectNodesOnDrag={!hand} selectionOnDrag={native && !hand} selectionMode={SelectionMode.Partial} elevateNodesOnSelect={false} multiSelectionKeyCode={['Meta', 'Control', 'Shift']} selectionKeyCode={null}
          panOnDrag={hand ? [0, 1] : [1]} panOnScroll={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panActivationKeyCode={null} zoomActivationKeyCode={null}
          deleteKeyCode={null} minZoom={0.2} maxZoom={3} onlyRenderVisibleElements={false} preventScrolling fitViewOptions={{ maxZoom: 1, padding: 0.2 }}>
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--grid)" />
          {showMinimap && <MiniMap pannable zoomable nodeColor="var(--minimap-node)" maskColor="var(--minimap-mask)" style={{ background: 'var(--panel)' }} />}
          <EdgeMarkers />
        </ReactFlow>
        {!diagram && documentState && <div className="empty-state"><div className="empty-symbol"><Shapes size={34} strokeWidth={1} /></div><h1>{documentState.source.trim() ? 'Open the source to continue.' : 'Make your ideas clear.'}</h1><p>{documentState.source.trim() ? 'This file has no complete diagram block. You can edit its PlantUML source right here.' : 'Choose a native diagram type to start drawing.'}</p>{documentState.source.trim() ? <button className="primary" onClick={openSource}><Code2 size={15} /> Edit PlantUML source</button> : <button className="primary" onClick={() => setShowGallery(true)}><Plus size={15} /> Create a diagram</button>}<span>Class · Sequence · Activity · State · and more</span></div>}
        {native && diagram && nodes.length === 0 && (undecided
          ? <div className="empty-state kind-chooser" role="group" aria-label="Choose a diagram type"><h2>What are you drawing?</h2><p>This diagram is empty. Pick its type to get the matching elements.</p><div className="kind-grid">{umlFamilies.map(kind => <button key={kind} onClick={() => chooseKind(diagram.id, kind)}><strong>{getTemplate(kind)?.label ?? kind}</strong><span>{getTemplate(kind)?.description}</span></button>)}</div></div>
          : <div className="empty-state"><h2>Your canvas is ready</h2><p>Right-click to place your first element, or add one here.</p><div className="starter-list">{palette.filter(kind => !['initial', 'final', 'stop'].includes(kind)).slice(0, 4).map((kind, index) => <button key={kind} className={index ? '' : 'primary'} onClick={() => beginElement(kind)}><Plus size={15} /> Add {title(kind).toLowerCase()}</button>)}</div></div>)}
        {diagram && !native && <section className="unsupported-notice" role="status" aria-label="Native diagram not supported"><div className="empty-symbol"><Shapes size={28} strokeWidth={1.3} /></div><h2>Native support is not implemented for this syntax.</h2><p>{getTemplate(diagram.kind)?.label ?? diagram.kind} diagrams with these constructs cannot currently be drawn as editable native elements.</p><ul>{(diagram.warnings.length ? diagram.warnings : ['This diagram type does not have a native React Flow implementation yet.']).map((warning, index) => <li key={index}>{warning}</li>)}</ul><button className="primary" onClick={openSource}><Code2 size={14} /> Edit PlantUML source</button></section>}
        {native && diagram && diagram.warnings.length > 0 && <details className="native-notes nowheel"><summary>{diagram.warnings.length} notation {diagram.warnings.length === 1 ? 'note' : 'notes'}</summary><ul>{diagram.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
        {menu && <div className="context-menu nowheel" role="menu" style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }} onKeyDown={event => { if (event.key === 'Escape') setMenu(undefined); }}>
          <div className="context-heading">{selectionCount > 1 ? `${selectionCount} selected` : menu.element?.name ?? (menu.relation ? 'Relationship' : 'ADD TO DIAGRAM')}</div>
          {menu.element && native && selectionCount <= 1 && menu.element.meta?.editable !== false && <button role="menuitem" onClick={() => requestRename(menu.element!.id)}>Rename <kbd>F2</kbd></button>}
          {menu.relation && selectionCount <= 1 && <button role="menuitem" onClick={() => editRelation(menu.relation!)}>Edit relationship</button>}
          {menu.element && native && selectionCount <= 1 && diagram?.kind === 'state' && menu.element.kind === 'state' && <><button role="menuitem" onClick={() => beginElement('initial', undefined, menu.element!.id)}>Mark as initial state</button><button role="menuitem" onClick={() => beginElement('final', undefined, menu.element!.id)}>Add final transition</button></>}
          {native && selectionCount > 0 && <><button role="menuitem" onClick={deleteSelection}><Trash2 size={13} /> {selectionCount > 1 ? `Delete ${selectionCount} items` : menu.relation ? 'Delete relationship' : 'Delete element'} <kbd>Del</kbd></button><div className="menu-divider" /></>}
          {!menu.element && !menu.relation && native && !undecided && palette.filter(kind => !['initial', 'final'].includes(kind)).map(kind => <button role="menuitem" key={kind} onClick={() => beginElement(kind, menu.point)}><Plus size={13} /> {kind}</button>)}
          {Boolean(selectionCount <= 1 && menu.element && (menu.element.meta?.container || ['mindmap', 'wbs', 'files'].includes(diagram?.kind ?? '') || ['object', 'array'].includes(String(menu.element.meta?.dataType)))) && native && palette.filter(kind => !unnamedKinds.has(kind) && !['initial', 'final'].includes(kind)).map(kind => <button role="menuitem" key={kind} onClick={() => beginElement(kind, undefined, menu.element!.id)}><Plus size={13} /> Add {kind} inside</button>)}
          {native && !menu.element && !menu.relation && nodes.length > 0 && <button role="menuitem" onClick={() => { select([...nodes.filter(node => node.selectable !== false).map(node => node.id), ...edges.map(edge => edge.id)]); setMenu(undefined); }}>Select all <kbd>Ctrl+A</kbd></button>}
          <button role="menuitem" onClick={openSource}><Code2 size={13} /> Edit PlantUML source</button>
          <button role="menuitem" onClick={() => { setMenu(undefined); setShowGallery(true); }}><FilePlus2 size={13} /> New diagram…</button>
        </div>}
        {elementDraft && <div className="floating-form nowheel" role="dialog" aria-label="Add element"><div className="form-heading"><span>Add {elementDraft.kind}</span><ToolButton title="Cancel adding element" onClick={() => setElementDraft(undefined)}><X size={15} /></ToolButton></div><form onSubmit={event => { event.preventDefault(); addElement(); }}><label>Name<input autoFocus aria-label="New element name" placeholder={`Name this ${elementDraft.kind}`} value={elementDraft.name} onChange={event => setElementDraft({ ...elementDraft, name: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') setElementDraft(undefined); }} /></label><div className="form-actions"><button type="button" onClick={() => setElementDraft(undefined)}>Cancel</button><button className="primary" type="submit" disabled={!elementDraft.name.trim()}><Plus size={14} /> Add element</button></div></form></div>}
        {relationDraft && <div className="floating-form relation-form nowheel" role="dialog" aria-label="Edit relationship"><div className="form-heading"><span>{relationDraft.relationId ? 'Edit relationship' : 'Connect elements'}</span><ToolButton title="Cancel relationship" onClick={() => setRelationDraft(undefined)}><X size={15} /></ToolButton></div><form onSubmit={event => { event.preventDefault(); saveRelation(); }}><div className="connection-summary"><span>{diagram?.elements.find(element => element.id === relationDraft.source)?.name ?? relationDraft.source}</span><ArrowLeftRight size={14} /><span>{diagram?.elements.find(element => element.id === relationDraft.target)?.name ?? relationDraft.target}</span></div><label>Relationship<select aria-label="Relationship type" value={relationDraft.arrow} onChange={event => setRelationDraft({ ...relationDraft, arrow: event.target.value })}>{!(diagram && arrowTypes[diagram.kind] || structuralArrows).some(([arrow]) => arrow === relationDraft.arrow) && <option value={relationDraft.arrow}>{relationDraft.arrow}</option>}{(diagram && arrowTypes[diagram.kind] || structuralArrows).map(([arrow, name]) => <option key={arrow} value={arrow}>{name} ({arrow})</option>)}</select></label><label>Label<input aria-label="Relationship label" autoFocus placeholder="Optional label" value={relationDraft.label} onChange={event => setRelationDraft({ ...relationDraft, label: event.target.value })} /></label><div className="form-actions"><button type="button" onClick={() => setRelationDraft(undefined)}>Cancel</button><button className="primary" type="submit"><Check size={14} /> Apply</button></div></form></div>}
        {quickAdd && <QuickConnect draft={quickAdd} sourceName={diagram?.elements.find(element => element.id === quickAdd.source)?.name || quickAdd.source} onChange={setQuickAdd} onSubmit={addConnected} onCancel={cancelQuickAdd} />}
        {sourceOpen && <section className="source-panel nowheel" aria-label="PlantUML source editor"><div className="form-heading"><div><Code2 size={15} /><span>PlantUML source</span><small title={sourceTargetLabel}>{sourceTargetLabel} · {sourceDraft !== sourceBase ? 'Unsaved draft' : 'In sync'}</small></div><ToolButton title="Close source editor" onClick={() => setSourceOpen(false)}><X size={15} /></ToolButton></div>{sourceChanged && <div className="draft-notice">The document changed. Your draft is preserved. Reload the current source before making further changes.<button onClick={reloadSource}>Reload source</button></div>}<textarea aria-label="PlantUML source" spellCheck={false} value={sourceDraft} onChange={event => setSourceDraft(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); commit({ type: 'replaceSource', source: sourceDraft }, sourceVersion, sourceDiagram); } if (event.key === 'Tab') { event.preventDefault(); const target = event.currentTarget, start = target.selectionStart, end = target.selectionEnd; setSourceDraft(sourceDraft.slice(0, start) + '  ' + sourceDraft.slice(end)); requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 2; }); } }} /><div className="source-footer"><span>Ctrl+Enter to apply · Escape leaves your draft</span><button className="primary" onClick={() => commit({ type: 'replaceSource', source: sourceDraft }, sourceVersion, sourceDiagram)} disabled={sourceDraft === sourceBase || Boolean(sourceChanged)}><Check size={13} /> Apply changes</button></div></section>}
        {error && <div className="error-toast" role="alert"><span>{error}</span><ToolButton title="Dismiss error" onClick={() => setError('')}><X size={14} /></ToolButton></div>}
        {busy && !error && <div className="connection-notice" role="status">{busy}</div>}
      </main>
    </div>
    {(showGallery || !diagram && documentState && !documentState.source.trim()) && <div className="gallery-backdrop nowheel" role="presentation" onClick={event => { if (event.target === event.currentTarget && diagram) setShowGallery(false); }}>
      <section className="gallery" role="dialog" aria-modal="true" aria-label="Create a new diagram">
        <div className="gallery-heading"><div><span className="eyebrow">ALIOT UML EDITOR</span><h1>Start with a diagram.</h1><p>Choose a diagram type with editable React Flow elements.</p></div>{diagram && <ToolButton title="Close diagram gallery" onClick={() => setShowGallery(false)}><X size={18} /></ToolButton>}</div>
        <div className="gallery-controls"><input className="gallery-search" autoFocus aria-label="Search diagram types" placeholder="Find a diagram type…" value={gallerySearch} onChange={event => setGallerySearch(event.target.value)} /><div className="start-mode" role="radiogroup" aria-label="Start with"><button role="radio" aria-checked={!blankStart} className={blankStart ? '' : 'active'} onClick={() => setBlankStart(false)}>Example</button><button role="radio" aria-checked={blankStart} className={blankStart ? 'active' : ''} onClick={() => setBlankStart(true)}>Blank</button></div></div>
        <div className="gallery-content"><div className="template-grid">{nativeTemplates.filter(template => `${template.label} ${template.description}`.toLowerCase().includes(gallerySearch.toLowerCase())).map(template => <button key={template.kind} className="template-card" onClick={() => {
            const blank = blankStart && supportsBlank(template.kind), id = isFilePreview ? `diagram-${parsed.diagrams.length + 1}` : 'diagram-1';
            send({ type: 'create', kind: template.kind, blank });
            // The extension opens a new editor for a second diagram and tells that editor the family itself.
            if (isStandalone || !documentState?.source.trim()) { const next = { ...(isFilePreview ? kinds : {}), ...(blank ? { [id]: template.kind } : {}) }; setKinds(next); saveViewState({ kinds: next }); }
            setActiveId(id); select([]); setShowGallery(false); setSourceOpen(false); lastScene.current = '';
          }}><span className="template-icon"><Shapes size={20} strokeWidth={1.25} /></span><strong>{template.label}</strong><span>{template.description}</span><small>{blankStart ? supportsBlank(template.kind) ? 'Starts empty' : 'Starts from its example' : 'Starts with an example'}</small></button>)}</div>
          {unsupportedTemplates.length > 0 && <details className="unsupported-types"><summary>Not implemented ({unsupportedTemplates.length} diagram types)</summary><p>These formats are recognized in source, but do not have a native diagram editor yet.</p><div>{unsupportedTemplates.filter(template => `${template.label} ${template.description}`.toLowerCase().includes(gallerySearch.toLowerCase())).map(template => <button key={template.kind} disabled title="Native editor not implemented">{template.label}<small>Not implemented</small></button>)}</div></details>}
        </div><div className="gallery-footer"><span>{nativeTemplates.length} native diagram types</span><span>{isFilePreview ? 'Adds a diagram to this file' : diagram ? 'Creates a new document' : 'Your diagram stays as readable PlantUML'}</span></div>
      </section>
    </div>}
  </div>;
}
