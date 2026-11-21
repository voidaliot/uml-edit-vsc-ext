import { useEffect } from 'react';
import { ArrowRight, Plus, X } from 'lucide-react';
import type { FinalConnectionState } from '@xyflow/react';
import { applyDiagramEdit } from '../core/edits';
import type { DiagramBlock, DiagramKind, Point } from '../shared/protocol';

/** A connection dropped on empty canvas: where, from what, and the element the user is naming. */
export interface QuickAdd {
  /** Canvas-relative place of the chooser. */
  x: number; y: number;
  /** Where the new element goes, in flow coordinates. */
  point: Point;
  source: string;
  arrow: string;
  sequenceRow?: number;
  kinds: string[];
  kind?: string;
  name: string;
  version: number;
  diagramId: string;
}

/** Containers, annotations and symbols that only exist as one end of a transition are no relationship target. */
const notEndpoints = new Set(['note', 'package', 'rectangle', 'attribute', 'initial', 'final', 'start', 'stop', 'alt', 'loop', 'opt', 'divider']);

/** The palette kinds that can be added and connected in one step from this element, tried on the real source. */
export function connectableKinds(source: string, diagram: DiagramBlock, palette: string[], from: string, arrow: string, sequenceRow: number | undefined, kind: DiagramKind | undefined): string[] {
  return palette.filter(candidate => {
    if (notEndpoints.has(candidate)) return false;
    try { return applyDiagramEdit(source, diagram.id, { type: 'addConnectedElement', source: from, kind: candidate, name: 'Element', arrow, label: '', sequenceRow }, { kind }) !== source; } catch { return false; }
  });
}

/**
 * Where a connection that found no handle was released: on the empty canvas, or on an element's body.
 * Nothing when React Flow already connected it to a handle, or it ended outside the canvas.
 */
export function connectionDrop(event: MouseEvent | TouchEvent, state: FinalConnectionState): { point: Point; nodeId?: string } | undefined {
  if (state.isValid || state.toHandle || !state.fromNode) return;
  const pointer = 'changedTouches' in event ? event.changedTouches[0] : event;
  if (!pointer) return;
  const hit = document.elementFromPoint(pointer.clientX, pointer.clientY);
  if (!hit?.closest('.react-flow__pane') || hit.closest('.nowheel')) return;
  const node = hit.closest<HTMLElement>('.react-flow__node');
  return { point: { x: pointer.clientX, y: pointer.clientY }, nodeId: node ? node.dataset.id ?? '' : undefined };
}

export function QuickConnect({ draft, sourceName, onChange, onSubmit, onCancel }: { draft: QuickAdd; sourceName: string; onChange: (draft: QuickAdd) => void; onSubmit: () => void; onCancel: () => void }) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onCancel]);
  if (!draft.kind) return <div className="context-menu quick-connect nowheel" role="menu" aria-label="Add connected element" style={{ left: Math.max(8, draft.x), top: Math.max(8, draft.y) }}>
    <div className="context-heading">CONNECT {sourceName.toUpperCase()} TO A NEW…</div>
    {draft.kinds.map((kind, index) => <button role="menuitem" key={kind} autoFocus={index === 0} onClick={() => onChange({ ...draft, kind })}><Plus size={13} /> {kind.replace(/^sdl-/, '')}</button>)}
    <div className="menu-divider" />
    <button role="menuitem" onClick={onCancel}>Cancel <kbd>Esc</kbd></button>
  </div>;
  return <div className="floating-form nowheel" role="dialog" aria-label="Add connected element">
    <div className="form-heading"><span>Add {draft.kind}</span><button className="tool-button" title="Cancel adding element" aria-label="Cancel adding element" onClick={onCancel}><X size={15} /></button></div>
    <form onSubmit={event => { event.preventDefault(); onSubmit(); }}>
      <div className="connection-summary"><span>{sourceName}</span><ArrowRight size={14} /><span>{draft.name.trim() || `new ${draft.kind}`}</span></div>
      <label>Name<input autoFocus aria-label="New element name" placeholder={`Name this ${draft.kind}`} value={draft.name} onChange={event => onChange({ ...draft, name: event.target.value })} /></label>
      <div className="form-actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit" disabled={!draft.name.trim()}><Plus size={14} /> Add and connect</button></div>
    </form>
  </div>;
}
