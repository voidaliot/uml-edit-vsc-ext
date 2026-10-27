import { useEffect, useRef, useState } from 'react';
import { Handle, NodeResizeControl, Position, useStore, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/react';
import type { DiagramElement, ElementPlacement } from '../shared/protocol';
import { TimeContent } from './TimeContent';
import { DataContent } from './DataContent';
import { ArchitectureContent } from './ArchitectureContent';
import { RichText } from './RichText';
import { graphPortPosition, type GraphPort } from './connections';
import './activity.css';

export type UmlNode = Node<{
  element: DiagramElement;
  diagramId: string;
  version: number;
  editRequest?: number;
  sequenceHeight?: number;
  onResizeDivider?: (id: string, placement: ElementPlacement, finished: boolean, version: number, diagramId: string) => void;
  onRename: (id: string, name: string, version: number, diagramId: string) => Promise<boolean>;
  onMembers: (id: string, members: string[], version: number, diagramId: string) => Promise<boolean>;
}, 'uml'>;

const compartmentKinds = new Set(['class', 'abstract', 'interface', 'enum', 'enumeration', 'object', 'entity', 'annotation']);

function Actor() {
  return <svg className="actor-symbol" width="42" height="58" viewBox="0 0 42 58" aria-hidden="true"><circle cx="21" cy="9" r="7" /><path d="M21 16V37M5 25H37M21 37L7 55M21 37L35 55" /></svg>;
}

function ParticipantSymbol({ kind }: { kind: string }) {
  return <svg className="participant-symbol" width="42" height="38" viewBox="0 0 42 38" aria-hidden="true"><circle cx="21" cy="17" r="12" />{kind === 'boundary' && <path d="M1 3V32M1 17H9" />}{kind === 'control' && <path d="M21 5L15 1M21 5L15 10" />}{kind === 'entity' && <path d="M6 33H36" />}</svg>;
}

function ActivityShape({ kind, width, height }: { kind: string; width: number; height: number }) {
  const w = width - 1, h = height - 1, mid = height / 2;
  const inset = Math.min(16, width / 5);
  const points = kind === 'merge' ? `0.5,${mid} ${width / 2},0.5 ${w},${mid} ${width / 2},${h}`
    : kind === 'sdl-input' ? `0.5,0.5 ${w},0.5 ${w - inset},${mid} ${w},${h} 0.5,${h}`
    : kind === 'sdl-output' ? `0.5,0.5 ${w - inset},0.5 ${w},${mid} ${w - inset},${h} 0.5,${h}`
    : kind === 'sdl-save' ? `${inset},0.5 ${w},0.5 ${w - inset},${h} 0.5,${h}`
    : kind === 'sdl-load' ? `0.5,0.5 ${w - inset},0.5 ${w},${h} ${inset},${h}`
    : kind === 'decision' || kind === 'sdl-continuous' ? `0.5,${mid} ${inset},0.5 ${w - inset},0.5 ${w},${mid} ${w - inset},${h} ${inset},${h}`
    : `0.5,0.5 ${w},0.5 ${w},${h} 0.5,${h}`;
  return <svg className="activity-control-shape" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true"><polygon points={points} />{kind === 'sdl-procedure' && <path d={`M5 0V${height} M${width - 5} 0V${height}`} />}</svg>;
}

export function UmlNodeView({ data, selected }: NodeProps<UmlNode>) {
  const { element, sequenceHeight } = data;
  const interactive = useStore(state => state.nodesDraggable);
  const updateNodeInternals = useUpdateNodeInternals();
  const graphPorts = element.meta?.graphPorts as GraphPort[] | undefined;
  const sequencePorts = element.meta?.sequencePorts as { id: string; offset: number }[] | undefined;
  const portSignature = `${element.meta?.width}:${element.meta?.height}:${sequenceHeight}:${JSON.stringify(graphPorts)}:${JSON.stringify(sequencePorts)}`;
  useEffect(() => { if (graphPorts?.length || sequencePorts?.length) updateNodeInternals(element.id); }, [element.id, portSignature, updateNodeInternals]);
  const resizeContext = useRef({ version: data.version, diagramId: data.diagramId });
  const [editing, setEditing] = useState(false);
  const [membersEditing, setMembersEditing] = useState(false);
  const [draft, setDraft] = useState(element.name);
  const [memberDraft, setMemberDraft] = useState(element.members.join('\n'));
  const [editVersion, setEditVersion] = useState(data.version);
  const [editDiagram, setEditDiagram] = useState(data.diagramId);
  const [editOriginalName, setEditOriginalName] = useState(element.name);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const seenEditRequest = useRef(data.editRequest);
  const beginEdit = () => { if (element.meta?.editable === false) return; const editableName = typeof element.meta?.renameValue === 'string' ? element.meta.renameValue : element.name; setDraft(editableName); setEditOriginalName(editableName); setEditVersion(data.version); setEditDiagram(data.diagramId); setEditing(true); };
  useEffect(() => {
    if (data.editRequest !== undefined && data.editRequest !== seenEditRequest.current) beginEdit();
    seenEditRequest.current = data.editRequest;
  }, [data.editRequest]);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  useEffect(() => { if (membersEditing) textarea.current?.focus(); }, [membersEditing]);
  const saveName = async () => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    const applied = draft.trim() === editOriginalName || await data.onRename(element.id, draft.trim(), editVersion, editDiagram);
    setSaving(false);
    if (applied) setEditing(false);
  };
  const familyContent = /^(?:timing-|gantt-|chronology-|data-|salt-|grammar-|math-|chart-|files-|c4-|archimate-|network-|chen-|dot-|ditaa-|board-|git-)/.test(element.kind);
  const kind = String(familyContent ? element.kind : element.meta?.shape ?? element.kind).toLowerCase().replace(/^abstract class$/, 'abstract').replace(/\s+/g, '-');
  const symbolNotation = element.meta?.symbolNotation === true;
  const compartments = compartmentKinds.has(kind) && !element.meta?.container && !symbolNotation;
  const editableMembers = compartments || element.meta?.editMembers === true;
  const procedure = element.meta?.procedure === true;
  const isCircle = ['start', 'end', 'initial', 'final', 'fork', 'join'].includes(kind);
  const isActor = kind === 'actor' || kind === 'person';
  const participantSymbol = ['boundary', 'control', 'entity'].includes(kind) && (sequenceHeight || symbolNotation);
  const kindLabel = kind === 'abstract' ? 'abstract class' : kind;
  const activity = element.meta?.activityLayout === true;
  const controlShape = activity && (kind === 'decision' || kind === 'merge' || kind.startsWith('sdl-'));
  const members = element.members;
  const fieldsOnly = kind === 'object' || kind === 'entity';
  const methods = fieldsOnly ? [] : members.filter(line => /\(|\{method\}/.test(line));
  const fields = fieldsOnly ? members : members.filter(line => !/\(|\{method\}/.test(line));
  const name = editing && editDiagram === data.diagramId ? <input ref={input} className="node-name-editor nodrag nopan nowheel" aria-label="Element name" value={draft} onChange={event => setDraft(event.target.value)} onBlur={saveName} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') saveName(); if (event.key === 'Escape') setEditing(false); }} /> : <span className="node-name" onDoubleClick={event => { event.stopPropagation(); beginEdit(); }}><RichText text={element.name} />{typeof element.meta?.generic === 'string' && <small>{element.meta.generic}</small>}</span>;
  const header = <div className={`node-title ${kind === 'abstract' || kind === 'interface' ? 'node-title-italic' : ''}`} onDoubleClick={event => { event.stopPropagation(); beginEdit(); }}>
    {isActor && <Actor />}
    {participantSymbol && <ParticipantSymbol kind={kind} />}
    {symbolNotation && kind === 'interface' && <svg className="interface-symbol" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="8" /></svg>}
    {kind === 'component' && <svg className="component-symbol" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3H21V21H7Z" /><path d="M3 7H11V11H3ZM3 14H11V18H3Z" /></svg>}
    {!element.meta?.symbolNotation && ['interface', 'enum', 'enumeration', 'entity', 'annotation'].includes(kind) && <span className="node-stereotype">«{kindLabel}»</span>}
    {typeof element.meta?.stereotype === 'string' && !(activity && kind.startsWith('sdl-')) && <span className="node-stereotype">«{element.meta.stereotype}»</span>}
    {typeof element.meta?.frameType === 'string' && <span className="node-stereotype">{element.meta.frameType}</span>}
    {name}
  </div>;
  const showMembers = () => { setMemberDraft(element.members.join('\n')); setEditVersion(data.version); setEditDiagram(data.diagramId); setMembersEditing(true); };
  const saveMembers = async () => { if (saving) return; setSaving(true); const applied = await data.onMembers(element.id, memberDraft.split('\n').map(line => line.trimEnd()).filter(Boolean), editVersion, editDiagram); setSaving(false); if (applied) setMembersEditing(false); };

  return <div className={`uml-node kind-${kind} ${selected ? 'is-selected' : ''} ${sequenceHeight ? 'sequence-node' : ''} ${familyContent ? 'family-node' : ''} ${activity ? 'activity-node' : ''} ${controlShape ? 'activity-control' : ''} ${element.meta?.symbolNotation ? 'symbol-notation' : ''} ${element.meta?.container ? 'container-node' : ''} ${element.meta?.standaloneTitle ? 'standalone-title' : ''} ${element.meta?.editable === false ? 'decoration-node' : ''}`} style={{ width: typeof element.meta?.width === 'number' ? element.meta.width : undefined, height: sequenceHeight ?? (typeof element.meta?.height === 'number' ? element.meta.height : undefined), backgroundColor: !controlShape && typeof element.meta?.color === 'string' ? element.meta.color : undefined }} data-element-id={element.id} data-element-kind={kind}>
    {kind === 'sequence-divider' && selected && interactive && (['left', 'right'] as const).map(side => <NodeResizeControl key={side} position={side} resizeDirection="horizontal" minWidth={100} minHeight={28} maxHeight={28} className={`sequence-divider-resize ${side} nodrag nopan`} onResizeStart={() => { resizeContext.current = { version: data.version, diagramId: data.diagramId }; }} onResize={(_, size) => data.onResizeDivider?.(element.id, { x: size.x, y: size.y, width: size.width, height: 28 }, false, resizeContext.current.version, resizeContext.current.diagramId)} onResizeEnd={(_, size) => data.onResizeDivider?.(element.id, { x: size.x, y: size.y, width: size.width, height: 28 }, true, resizeContext.current.version, resizeContext.current.diagramId)} />)}
    {controlShape && <ActivityShape kind={kind} width={Number(element.meta?.width ?? 120)} height={Number(element.meta?.height ?? 36)} />}
    {kind === 'cloud' && !sequenceHeight && <svg className="cloud-shape" viewBox="0 0 192 90" preserveAspectRatio="none" aria-hidden="true"><path d="M24 67C-5 67 0 34 22 30C18 10 43 1 60 14C75-3 107 0 117 13C139 1 164 12 162 28C195 26 202 65 174 70C177 89 148 95 132 80C113 94 91 94 76 81C54 96 28 88 24 67Z" /></svg>}
    {!sequenceHeight && !kind.startsWith('sequence-') && <><Handle type="source" position={Position.Top} id="top" className="uml-handle" /><Handle type="source" position={Position.Left} id="left" className="uml-handle" /></>}
    {sequenceHeight && sequencePorts?.map(port => <Handle key={port.id} type="source" position={Position.Right} id={port.id} className="uml-handle sequence-handle" title={port.id === 'sequence-new' ? 'Add a message after the last row' : 'Connect a message at this row'} aria-label={`${element.name} ${port.id}`} style={{ left: '50%', right: 'auto', top: port.offset, transform: 'translate(-50%, -50%)' }} />)}
    {graphPorts?.map(port => {
      const point = graphPortPosition(element, port);
      return <Handle key={port.id} type="source" position={port.side as Position} id={port.id} className="uml-handle" style={{ left: point.x, top: point.y, right: 'auto', bottom: 'auto', transform: 'translate(-50%, -50%)' }} />;
    })}
    {Array.isArray(element.meta?.tablePorts) && (element.meta.tablePorts as { id: string; offset: number }[]).map(port => <Handle key={port.id} type="source" position={Position.Right} id={port.id} className="uml-handle" style={{ top: port.offset }} />)}
    {activity && Array.isArray(element.meta?.activityPorts) && (element.meta.activityPorts as { id: string; side: 'top' | 'bottom'; offset: number }[]).map(port => <Handle key={port.id} type="source" position={port.side === 'top' ? Position.Top : Position.Bottom} id={port.id} className="uml-handle" style={{ left: port.offset }} />)}
    {sequenceHeight ? <><div className="sequence-head">{header}</div><div className="lifeline" />{Array.isArray(element.meta?.activations) && (element.meta.activations as { start: number; end: number }[]).map((bar, index) => <div key={index} className="activation-bar" style={{ top: 78 + bar.start * 52, height: Math.max(22, (bar.end - bar.start) * 52) }} />)}<div className="sequence-foot">{isActor && <Actor />}{participantSymbol && <ParticipantSymbol kind={kind} />}<span><RichText text={element.name} /></span></div></> : <>
      {!isCircle && (editing || element.meta?.hideHeader !== true && !kind.endsWith('-axis')) && header}
      {familyContent && <div className="family-content" onDoubleClick={event => { event.stopPropagation(); if (editableMembers) showMembers(); else beginEdit(); }}><TimeContent element={element} /><DataContent element={element} /><ArchitectureContent element={element} /></div>}
      {editableMembers && (membersEditing && editDiagram === data.diagramId ? <div className="member-editor nodrag nopan nowheel"><textarea ref={textarea} value={memberDraft} aria-label="Element members" onChange={event => setMemberDraft(event.target.value)} onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') saveMembers(); if (event.key === 'Escape') setMembersEditing(false); }} rows={Math.max(3, memberDraft.split('\n').length + 1)} /><div className="inline-actions"><button onClick={() => setMembersEditing(false)}>Cancel</button><button className="primary" onClick={saveMembers}>Apply</button></div></div> : procedure ? selected && <button className="procedure-values nodrag nopan" onClick={showMembers}>Edit values</button> : !familyContent && !element.meta?.hiddenMembers && <div className="node-members" onDoubleClick={event => { event.stopPropagation(); showMembers(); }} title="Double-click to edit attributes and operations">
        {!element.meta?.hiddenFields && <div className="member-compartment">{fields.length ? fields.map((line, index) => <div key={index}><RichText text={line.replace(/\{field\}\s*/, '')} /></div>) : <span className="member-placeholder">attributes</span>}</div>}
        {kind !== 'object' && kind !== 'entity' && !element.meta?.hiddenMethods && <div className="member-compartment">{methods.length ? methods.map((line, index) => <div key={index}><RichText text={line.replace(/\{method\}\s*/, '')} /></div>) : <span className="member-placeholder">operations</span>}</div>}
      </div>)}
      {!familyContent && !compartments && !editableMembers && members.length > 0 && !isActor && <div className="node-detail"><RichText text={members.join('\n')} /></div>}
    </>}
    {!sequenceHeight && !kind.startsWith('sequence-') && <><Handle type="source" position={Position.Right} id="right" className="uml-handle" style={typeof element.meta?.connectionWidth === 'number' ? { left: element.meta.connectionWidth, right: 'auto' } : undefined} /><Handle type="source" position={Position.Bottom} id="bottom" className="uml-handle" /></>}
  </div>;
}

