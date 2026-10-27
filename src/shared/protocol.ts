export type DiagramKind = 'class' | 'object' | 'sequence' | 'usecase' | 'component' | 'deployment' | 'state' | 'activity' | 'entity' | 'mindmap' | 'wbs' | 'json' | 'yaml' | 'gantt' | 'timing' | 'network' | 'wireframe' | 'ditaa' | 'c4' | 'archimate' | 'salt' | 'ebnf' | 'regex' | 'math' | 'board' | 'git' | 'chen' | 'dot' | 'latex' | 'jcckit' | 'chronology' | 'chart' | 'files' | 'sdl' | 'unknown';

export interface Point { x: number; y: number }
export interface ElementPlacement extends Point { width?: number; height?: number }
export type LineType = 'straight' | 'ortho' | 'polyline' | 'spline';
export interface SourceRange { startLine: number; endLine: number }
export interface DiagramElement extends SourceRange {
  id: string;
  name: string;
  kind: string;
  members: string[];
  parentId?: string;
  implicit?: boolean;
  /** Family-specific semantic data and native drawing geometry, never executable content. */
  meta?: Record<string, unknown>;
}
export interface DiagramRelation extends SourceRange {
  id: string;
  source: string;
  target: string;
  label: string;
  arrow: string;
  sourceMultiplicity?: string;
  targetMultiplicity?: string;
  meta?: Record<string, unknown>;
}
export interface DiagramBlock extends SourceRange {
  id: string;
  title: string;
  kind: DiagramKind;
  source: string;
  elements: DiagramElement[];
  relations: DiagramRelation[];
  /** False if syntax cannot be faithfully represented by editable nodes. */
  graphical: boolean;
  warnings: string[];
  meta?: Record<string, unknown>;
}
export interface ParsedDocument { diagrams: DiagramBlock[]; warnings: string[] }
export interface DiagramTemplate { kind: DiagramKind; label: string; description: string; source: string; palette: string[] }
export type DiagramEdit =
  | { type: 'move'; elementId: string; position: Point }
  | { type: 'rename'; elementId: string; name: string }
  | { type: 'members'; elementId: string; members: string[] }
  | { type: 'addElement'; kind: string; name: string; parentId?: string }
  | { type: 'addRelation'; source: string; target: string; arrow: string; label: string; sequenceRow?: number }
  | { type: 'moveSequenceEvent'; eventId: string; row: number }
  | { type: 'editRelation'; relationId: string; label: string; arrow: string }
  | { type: 'deleteElement'; elementId: string }
  | { type: 'deleteRelation'; relationId: string }
  | { type: 'replaceSource'; source: string }
  | { type: 'insertSnippet'; source: string };

export interface DiagramLayout { positions: Record<string, ElementPlacement>; viewport?: { x: number; y: number; zoom: number } }
export type Layouts = Record<string, DiagramLayout>;
export type HostMessage =
  | { type: 'document'; source: string; version: number; fileName: string; layouts: Layouts; trusted: boolean; format?: 'plantuml' | 'aliot'; aliotDocument?: string; revision?: number }
  | { type: 'showSource' }
  | { type: 'error'; message: string };
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; version: number; diagramId: string; edit: DiagramEdit }
  | { type: 'layout'; diagramId: string; layout: DiagramLayout; version?: number; basePositions?: Record<string, Point> }
  | { type: 'create'; kind: DiagramKind }
  | { type: 'openSource'; line?: number }
  | { type: 'saveAliot' }
  | { type: 'openAliot' }
  | { type: 'exportPlantUml' }
  | { type: 'undo' }
  | { type: 'redo' };
