import type { DiagramBlock, DiagramElement, DiagramKind } from '../shared/protocol';
import { parseDocument } from './parser';
import { codeLines, parseDeclaration, parseMemberStatement, parseRelation, quote, reference, type TokenSpan } from './syntax';
import { familyFor } from './families/registry';
import { getTemplate } from './templates';

/** Source-derived copy of a selection, held by the editor and pasted back as text. */
export interface ClipFragment {
  kind: DiagramKind;
  /** Declarations, bodies and relationships, dedented, one statement per line as in the original. */
  source: string;
  /** Snippet line → id of the copied element declared on it, so copies can be placed beside their originals. */
  origins: Record<number, string>;
}

/** The families whose statements are self-contained declarations and relationships. */
const copyableKinds = new Set<DiagramKind>(['class', 'object', 'usecase', 'component', 'deployment', 'state', 'entity']);
const pseudoKinds = new Set(['start', 'end']);
const notePattern = /^(\s*[hr]?note\s+(?:left|right|top|bottom)\s+(?:of\s+)?)([^:]+?)(\s*(?::.*)?)$/i;
const noteAlias = /^(\s*[hr]?note\s+as\s+)(\S+)/i;
const label = (kind: DiagramKind) => (getTemplate(kind)?.label ?? kind).toLowerCase();

/** Why `action` is not available in this diagram, or undefined when it is. */
export function declarationBlocker(block: DiagramBlock, action: string): string | undefined {
  if (!block.graphical) return 'This diagram has syntax the canvas cannot edit. Use the source editor.';
  if (block.kind === 'sequence') return `${action} is not available in sequence diagrams, where messages depend on their order. Use the source editor.`;
  if (['activity', 'sdl', 'mindmap', 'wbs'].includes(block.kind) || block.meta?.legacy) return `${action} is not available here: this diagram is defined by the order of its source. Use the source editor.`;
  if (familyFor(block.kind) || !copyableKinds.has(block.kind)) return `${action} is not available in ${label(block.kind)} diagrams. Use the source editor.`;
  if (block.elements.some(element => element.meta?.procedure)) return `${action} is not available in a diagram that uses local procedures. Use the source editor.`;
}

/** Why this diagram cannot copy or paste elements, or undefined when it can. */
export const clipboardBlocker = (block: DiagramBlock) => declarationBlocker(block, 'Copy and paste');

const indentOf = (line: string) => line.match(/^\s*/)![0];

/**
 * Copy the selected elements, everything inside selected containers, and the relationships whose two
 * ends are both copied. Comments inside the copied statements travel with them.
 */
export function copyFragment(source: string, block: DiagramBlock, ids: readonly string[]): ClipFragment {
  const blocker = clipboardBlocker(block);
  if (blocker) throw new Error(blocker);
  const raw = source.split(/\r?\n/), code = codeLines(source);
  const byId = new Map(block.elements.map(element => [element.id, element]));
  const copied = new Set<string>();
  const include = (element: DiagramElement) => {
    if (copied.has(element.id)) return;
    copied.add(element.id);
    for (const child of block.elements) if (child.parentId === element.id) include(child);
  };
  for (const id of ids) { const element = byId.get(id); if (element && (element.meta?.editable !== false || pseudoKinds.has(element.kind))) include(element); }
  const tops = block.elements.filter(element => copied.has(element.id) && !pseudoKinds.has(element.kind) && !(element.parentId && copied.has(element.parentId)));
  if (!tops.length) throw new Error('Select one or more elements to copy.');
  const spans = tops.filter(element => !element.implicit).map(element => [element.startLine, element.endLine] as const);
  const inSpan = (line: number) => spans.some(([start, end]) => line >= start && line <= end);
  const bodies = new Set<number>();
  for (const element of block.elements) if (!element.meta?.container && element.endLine > element.startLine && !element.implicit) for (let line = element.startLine + 1; line <= element.endLine; line++) bodies.add(line);
  const relationLines = new Map(block.relations.map(relation => [relation.startLine, relation]));
  const both = (line: number) => { const relation = relationLines.get(line)!; return copied.has(relation.source) && copied.has(relation.target); };
  const owned = (line: number) => { if (bodies.has(line) || relationLines.has(line) || parseDeclaration(code[line])) return undefined; return parseMemberStatement(code[line])?.owner; };
  // Each chunk keeps its own lines, dedented to its first line, in source order.
  const chunks: { order: number; lines: { text: string; code: string; origin?: string }[] }[] = [];
  const starts = new Map(block.elements.filter(item => copied.has(item.id) && !item.implicit).map(item => [item.startLine, item.id]));
  for (const element of tops) {
    if (element.implicit) {
      chunks.push({ order: element.startLine - .5, lines: [{ text: `${element.kind} ${quote(element.name)} as ${reference(element.id)}`, code: '', origin: element.id }] });
      continue;
    }
    const lines = [];
    for (let line = element.startLine; line <= element.endLine; line++) {
      if (!bodies.has(line) && relationLines.has(line) && !both(line)) continue;
      const owner = owned(line);
      if (owner && !copied.has(owner)) continue;
      lines.push({ text: raw[line], code: code[line], origin: starts.get(line) });
    }
    chunks.push({ order: element.startLine, lines });
  }
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    if (inSpan(line) || bodies.has(line)) continue;
    const owner = owned(line);
    if (relationLines.has(line) ? both(line) : owner && copied.has(owner)) chunks.push({ order: line, lines: [{ text: raw[line], code: code[line] }] });
  }
  chunks.sort((a, b) => a.order - b.order);
  const lines: string[] = [], expected: string[] = [], origins: Record<number, string> = {};
  for (const chunk of chunks) {
    const indent = indentOf(chunk.lines[0].text);
    for (const line of chunk.lines) {
      const strip = (text: string) => text.startsWith(indent) ? text.slice(indent.length) : text.trimStart();
      if (line.origin) origins[lines.length] = line.origin;
      lines.push(strip(line.text)); expected.push(line.code ? strip(line.code) : line.text);
    }
  }
  // A block comment that opens or closes outside the copied lines would swallow the pasted source.
  if (codeLines(`${lines.join('\n')}\nx`).some((text, index) => text.trimEnd() !== (expected[index] ?? 'x').trimEnd())) throw new Error('This selection starts or ends inside a block comment. Copy it in the source editor.');
  return { kind: block.kind, source: lines.join('\n'), origins };
}

/** The line a paste inserts at: snippet line i becomes document line insertion + i. */
export const pasteInsertionLine = (block: DiagramBlock) => block.endLine;

/**
 * The fragment's lines with every copied identity renamed to one that is free in the target diagram.
 * `fresh` picks the alias for an id, given the ids already taken.
 */
export function pasteLines(block: DiagramBlock, fragment: Pick<ClipFragment, 'kind' | 'source'>, fresh: (id: string, taken: ReadonlySet<string>) => string): string[] {
  const blocker = clipboardBlocker(block);
  if (blocker) throw new Error(blocker);
  if (fragment.kind !== block.kind) throw new Error(`These elements were copied from a ${label(fragment.kind)} diagram and cannot be pasted into a ${label(block.kind)} diagram.`);
  if (typeof fragment.source !== 'string' || !fragment.source.trim()) throw new Error('There is nothing to paste.');
  // A block marker anywhere, even behind a comment, could end the diagram early; a stray CR would mix line endings.
  if (/@(?:start|end)[a-z]/i.test(fragment.source) || fragment.source.includes('\r')) throw new Error('The copied text cannot be pasted into a diagram. Paste it in the source editor.');
  // Alone, a few elements may read as another of the families that share this syntax (a lone
  // `[Web]` as a component diagram); the family is settled by the diagram they are pasted into.
  const snippet = parseDocument(`@startuml\n${fragment.source}\n@enduml`, { kinds: { 'diagram-1': block.kind } }).diagrams[0];
  if (!snippet?.graphical || !copyableKinds.has(snippet.kind)) throw new Error(`The copied text is not a ${label(block.kind)} diagram the canvas can edit.`);
  const raw = fragment.source.split('\n'), code = codeLines(fragment.source);
  // Snippet document line n is fragment line n - 1.
  const skip = new Set<number>();
  for (const element of snippet.elements) if (!element.meta?.container && !element.implicit) for (let line = element.startLine + 1; line <= element.endLine; line++) skip.add(line - 1);
  const taken = new Set(block.elements.map(element => element.id)), renames = new Map<string, string>();
  for (const element of snippet.elements) {
    if (pseudoKinds.has(element.kind) || element.kind === 'state-region' || element.kind === 'note' && element.id === `note-${element.startLine}`) continue;
    const alias = fresh(element.id, taken);
    taken.add(alias);
    if (alias !== element.id) renames.set(element.id, alias);
  }
  const implicit = new Set(snippet.elements.filter(element => element.implicit).map(element => element.id));
  const replace = (line: string, span: TokenSpan, text: string) => line.slice(0, span.start) + text + line.slice(span.end);
  const token = (span: TokenSpan) => {
    const id = renames.get(span.text.startsWith('"') || /^[\[(:]/.test(span.text) ? span.text.slice(1, -1).replace(/\\(["\\])/g, '$1') : span.text);
    if (!id) return undefined;
    // An undeclared shorthand keeps its shape: `[Api]` stays a component, now `[Api2]`.
    return /^[\[(:]/.test(span.text) && implicit.has(span.text.slice(1, -1)) ? span.text[0] + id + span.text.at(-1) : reference(id);
  };
  return raw.map((line, index) => {
    if (skip.has(index)) return line;
    const text = code[index];
    const note = text.match(notePattern), alias = text.match(noteAlias);
    if (note) {
      const target = note[2].trim(), renamed = renames.get(target.replace(/^"|"$/g, ''));
      return renamed ? line.slice(0, note[1].length) + reference(renamed) + line.slice(note[1].length + note[2].length) : line;
    }
    if (alias) { const renamed = renames.get(alias[2]); return renamed ? line.slice(0, alias[1].length) + reference(renamed) + line.slice(alias[0].length) : line; }
    const declaration = parseDeclaration(text);
    if (declaration) {
      const renamed = renames.get(declaration.id);
      if (!renamed) return line;
      if (declaration.aliasSpan) return replace(line, declaration.aliasSpan, reference(renamed));
      if (/^\s*[\[(:]/.test(text)) return line.slice(0, declaration.nameSpan.end) + ` as ${reference(renamed)}` + line.slice(declaration.nameSpan.end);
      return replace(line, declaration.nameSpan, `${quote(declaration.name)} as ${reference(renamed)}`);
    }
    const relation = parseRelation(text);
    if (relation) {
      // Patch the later span first so the earlier one keeps its columns.
      const target = token(relation.targetSpan), updated = target ? replace(line, relation.targetSpan, target) : line;
      const source = token(relation.sourceSpan);
      return source ? replace(updated, relation.sourceSpan, source) : updated;
    }
    const member = parseMemberStatement(text);
    const owner = member && renames.get(member.owner);
    return member && owner ? replace(line, member.ownerSpan, reference(owner)) : line;
  });
}
