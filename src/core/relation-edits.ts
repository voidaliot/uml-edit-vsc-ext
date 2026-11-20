import type { DiagramBlock, DiagramEdit, DiagramElement } from '../shared/protocol';
import { parseDocument } from './parser';
import { codeLines, parseDeclaration, parseRelation, reference, unquote } from './syntax';
import { familyFor } from './families/registry';
import type { EditOptions } from './edits';

type Apply = (source: string, diagramId: string, edit: DiagramEdit, options: EditOptions) => string;
type ConnectedElement = Extract<DiagramEdit, { type: 'addConnectedElement' }>;
type Reconnect = Extract<DiagramEdit, { type: 'reconnectRelation' }>;

const structureKinds = new Set(['activity', 'sdl', 'mindmap', 'wbs']);
const pseudoKinds = new Set(['start', 'end']);

function parsedBlock(source: string, diagramId: string, options: EditOptions): DiagramBlock | undefined {
  return parseDocument(source, { kinds: options.kind ? { [diagramId]: options.kind } : undefined }).diagrams.find(candidate => candidate.id === diagramId);
}

/**
 * A new element and the relationship that leads to it, as one source change. Both halves run through
 * the ordinary element and relationship edits, so every family keeps its own syntax and rules.
 */
export function addConnectedElement(source: string, block: DiagramBlock, edit: ConnectedElement, options: EditOptions, apply: Apply): string {
  const from = block.elements.find(element => element.id === edit.source);
  if (!from) throw new Error('This element no longer exists. Try the edit again on the current diagram.');
  if (from.kind === 'end') throw new Error('A final state cannot start a transition.');
  const withElement = apply(source, block.id, { type: 'addElement', kind: edit.kind, name: edit.name }, options);
  const next = parsedBlock(withElement, block.id, options);
  const known = new Set(block.elements.map(element => element.id));
  const added = next?.elements.filter(element => !known.has(element.id)) ?? [];
  // The relationship needs exactly one new endpoint, and the source must keep its identity.
  if (added.length !== 1 || added[0].meta?.container || added[0].kind.startsWith('sequence-') || !next!.elements.some(element => element.id === edit.source)) throw new Error('This element cannot be added and connected in one step. Add it first, then connect it.');
  return apply(withElement, block.id, { type: 'addRelation', source: edit.source, target: added[0].id, arrow: edit.arrow, label: edit.label, sequenceRow: edit.sequenceRow }, options);
}

/** The text that names an element where it is already referenced, so shorthand forms stay shorthand. */
function referenceText(block: DiagramBlock, code: string[], element: DiagramElement): string {
  if (pseudoKinds.has(element.kind)) return '[*]';
  const declaration = element.implicit ? undefined : parseDeclaration(code[element.startLine]);
  if (declaration?.id === element.id) return declaration.aliasSpan ? reference(element.id) : declaration.nameSpan.text;
  for (const relation of block.relations) {
    const syntax = parseRelation(code[relation.startLine]);
    const span = [syntax?.sourceSpan, syntax?.targetSpan].find(candidate => candidate && candidate.text !== '[*]' && unquote(candidate.text) === element.id);
    if (span) return span.text;
  }
  return reference(element.id);
}

/** Re-attach one end of a relationship by rewriting only that endpoint token on its line. */
export function reconnectRelation(source: string, block: DiagramBlock, edit: Reconnect, options: EditOptions): string {
  if (structureKinds.has(block.kind) || block.meta?.derivedRelations || block.meta?.legacy || familyFor(block.kind)) throw new Error('These connections follow the diagram structure. Edit the PlantUML source to change them.');
  if (edit.end !== 'source' && edit.end !== 'target') throw new Error('Choose which end of the relationship to move.');
  const relation = block.relations.find(candidate => candidate.id === edit.relationId);
  if (!relation) throw new Error('This relationship no longer exists.');
  const element = block.elements.find(candidate => candidate.id === edit.elementId);
  if (!element) throw new Error('This element no longer exists. Try the edit again on the current diagram.');
  if ((edit.end === 'source' ? relation.source : relation.target) === element.id) return source;
  if (element.meta?.editable === false || element.kind.startsWith('sequence-')) throw new Error('A relationship cannot end on this element.');
  // A note without an alias is identified by its line number, which no relationship can name durably.
  if (element.kind === 'note' && element.id === `note-${element.startLine}`) throw new Error('Give this note an alias (note "…" as N1) before attaching a relationship to it.');
  if (pseudoKinds.has(element.kind) && element.kind !== (edit.end === 'source' ? 'start' : 'end')) throw new Error('An initial state can only start a transition, and a final state can only end one.');
  const code = codeLines(source);
  const syntax = parseRelation(code[relation.startLine]);
  if (!syntax || relation.startLine !== relation.endLine || block.relations.filter(candidate => candidate.startLine === relation.startLine).length !== 1) throw new Error('This relationship must be edited in the source panel.');
  const span = edit.end === 'source' ? syntax.sourceSpan : syntax.targetSpan;
  const lines = source.split(/\r?\n/);
  const line = lines[relation.startLine];
  lines[relation.startLine] = line.slice(0, span.start) + referenceText(block, code, element) + line.slice(span.end);
  const result = lines.join(source.includes('\r\n') ? '\r\n' : '\n');
  // The rewritten token must name exactly the chosen element, in this line's scope, without
  // creating an element or silently dropping one that only this relationship declared.
  const next = parsedBlock(result, block.id, options);
  const moved = next?.relations.filter(candidate => candidate.startLine === relation.startLine);
  const expected = edit.end === 'source' ? { source: element.id, target: relation.target } : { source: relation.source, target: element.id };
  if (!next || moved?.length !== 1 || moved[0].source !== expected.source || moved[0].target !== expected.target || next.elements.some(candidate => !block.elements.some(old => old.id === candidate.id))) throw new Error('This end cannot be re-attached unambiguously. Edit the relationship in the source panel.');
  // An element named only in relationships lives where it is first mentioned; re-attaching must not
  // pull it out of (or into) a container as a side effect.
  const rehomed = next.elements.find(candidate => block.elements.find(old => old.id === candidate.id)?.parentId !== candidate.parentId);
  if (rehomed) throw new Error(`Re-attaching here would move "${rehomed.name}" to another container, because it is only named in relationships. Declare it first, or edit the source.`);
  const lost = block.elements.find(old => !pseudoKinds.has(old.kind) && !next.elements.some(candidate => candidate.id === old.id));
  if (lost) throw new Error(`"${lost.name}" exists only through this relationship. Declare it first, or edit the source.`);
  return result;
}
