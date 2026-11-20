import type { DiagramBlock, DiagramEdit, DiagramElement, DiagramKind } from '../shared/protocol';
import { parseDocument } from './parser';
import { codeLines, isIdentifier, parseDeclaration, parseRelation, parseMemberStatement, quote, reference } from './syntax';
import { getNativeTemplate } from './templates';
import { familyFor } from './families/registry';
import { editProcedure } from './procedures';
import { editLegacyActivity } from './legacy-activity';
import { moveSequenceEvent, sequenceInsertionLine } from './sequence';
import { pasteInsertionLine, pasteLines } from './clipboard';
import { setProperties } from './properties';
import { moveToContainer } from './containment';
import { addConnectedElement, reconnectRelation } from './relation-edits';

const memberKinds = new Set(['class', 'abstract class', 'interface', 'enum', 'annotation', 'object', 'entity']);
const relationArrows = new Set(['-->', '->', '<--', '<-', '--', '..', '..>', '<..', '<|--', '--|>', '<|..', '..|>', '*--', '--*', 'o--', '--o', '||--o{', '}o--||', '||--||', '}o--o{', '-->>', '->>', '<->', '<-->']);

function nameValue(name: string): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Enter a non-empty name.');
  if (/[\r\n\u0000]/.test(name)) throw new Error('Names must fit on one line. Use the source editor for multiline labels.');
  if (name.length > 2000) throw new Error('This label is too long for an inline edit.');
  return name.trim();
}

function newId(block: DiagramBlock, kind: string, taken: ReadonlySet<string> = new Set()): string {
  const stem = kind.replace(/[^a-zA-Z0-9_]/g, '_') || 'element';
  let index = 1;
  while (taken.has(`${stem}_${index}`) || block.elements.some(element => element.id === `${stem}_${index}`)) index++;
  return `${stem}_${index}`;
}

function findElement(block: DiagramBlock, id: string): DiagramElement {
  const element = block.elements.find(candidate => candidate.id === id);
  if (!element) throw new Error('This element no longer exists. Try the edit again on the current diagram.');
  return element;
}

function assertComplete(block: DiagramBlock): void {
  if (!/^\s*@end\w+\b/im.test(block.source)) throw new Error('Complete the @start / @end block in the source editor first.');
}


const reservedAliases = new Set(['as', 'class', 'interface', 'enum', 'abstract', 'annotation', 'object', 'entity', 'actor', 'participant', 'boundary', 'control', 'collections', 'queue', 'database', 'component', 'node', 'artifact', 'cloud', 'package', 'namespace', 'frame', 'folder', 'rectangle', 'card', 'file', 'storage', 'stack', 'agent', 'person', 'process', 'label', 'hexagon', 'circle', 'usecase', 'state', 'action', 'note', 'start', 'stop', 'end', 'if', 'else', 'endif', 'while', 'repeat', 'fork', 'split', 'alt', 'opt', 'loop', 'par', 'break', 'critical', 'group', 'ref', 'activate', 'deactivate', 'destroy', 'return', 'title', 'legend', 'header', 'footer', 'hide', 'show', 'skinparam', 'left', 'right', 'top', 'bottom', 'together', 'of', 'on', 'over', 'is']);

/** A readable alias taken from the name: "Line item" becomes LineItem. */
function aliasFor(block: DiagramBlock, kind: string, name: string, taken: ReadonlySet<string> = new Set()): string {
  const words = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9_]+/).filter(Boolean);
  const stem = words.length === 1 ? words[0] : words.map(word => word[0].toUpperCase() + word.slice(1)).join('');
  if (!stem || !/^[A-Za-z_]/.test(stem) || stem.length > 40 || reservedAliases.has(stem.toLowerCase())) return newId(block, kind, taken);
  let alias = stem, index = 2;
  while (taken.has(alias) || block.elements.some(element => element.id === alias)) alias = `${stem}${index++}`;
  return alias;
}

const activityOpen = /^(?:(?:if|while|switch)\s*\(|repeat(?:\s*:.*;)?$|(?:fork|split)$)/i;
const activityClose = /^(?:endif|endswitch|endwhile|repeat\s+while\b|end\s*(?:fork|split)\b|end\s+merge$)/i;

/** The first and last line of the control structure a decision, merge, fork or join belongs to. */
function activityStructure(block: DiagramBlock, code: string[], line: number): [number, number] | undefined {
  const text = (index: number) => code[index].trim();
  const scan = (from: number, step: 1 | -1): number | undefined => {
    let depth = 0;
    for (let index = from; index > block.startLine && index < block.endLine; index += step) {
      const opens = activityOpen.test(text(index)), closes = activityClose.test(text(index));
      if (step > 0 ? opens : closes) depth++;
      else if (step > 0 ? closes : opens) { if (--depth === 0) return index; }
    }
  };
  if (activityOpen.test(text(line))) { const end = scan(line, 1); return end === undefined ? undefined : [line, end]; }
  if (activityClose.test(text(line))) { const start = scan(line, -1); return start === undefined ? undefined : [start, line]; }
  if (/^elseif\b/i.test(text(line))) {
    // One alternative of a chain: up to the next alternative at the same depth.
    let depth = 0;
    for (let index = line + 1; index < block.endLine; index++) {
      if (activityOpen.test(text(index))) depth++;
      else if (activityClose.test(text(index))) { if (depth-- === 0) return [line, index - 1]; }
      else if (depth === 0 && /^(?:elseif|else)\b/i.test(text(index))) return [line, index - 1];
    }
  }
}

/** Every source line that goes when this element is deleted. */
function removalLines(block: DiagramBlock, code: string[], element: DiagramElement): Set<number> {
  if (!block.graphical) throw new Error('This diagram contains advanced syntax. Delete in the source panel to review all references.');
  const remove = new Set<number>();
  const span = (from: number, to: number) => { for (let line = from; line <= to; line++) remove.add(line); };
  if (block.kind === 'activity' || block.kind === 'sdl') {
    if (['decision', 'merge', 'fork', 'join'].includes(element.kind)) {
      const structure = activityStructure(block, code, element.startLine);
      if (!structure) throw new Error('Delete this control structure in the source editor.');
      span(...structure);
    } else span(element.startLine, element.endLine);
  } else if (block.kind === 'mindmap' || block.kind === 'wbs') {
    const ids = new Set([element.id]);
    for (const candidate of block.elements) if (candidate.parentId && ids.has(candidate.parentId)) ids.add(candidate.id);
    for (const candidate of block.elements) if (ids.has(candidate.id)) remove.add(candidate.startLine);
  } else if (element.kind === 'sequence-fragment') {
    // Dissolve the frame; its messages stay in the conversation.
    remove.add(element.startLine); remove.add(element.endLine);
    for (const divider of block.elements) if (divider.kind === 'sequence-divider' && divider.meta?.fragment === element.id) remove.add(divider.startLine);
  } else {
    const descendants = new Set([element.id]);
    const children = new Map<string, string[]>();
    for (const candidate of block.elements) if (candidate.parentId) children.set(candidate.parentId, [...children.get(candidate.parentId) ?? [], candidate.id]);
    const queue = [element.id];
    while (queue.length) for (const id of children.get(queue.shift()!) ?? []) if (!descendants.has(id)) { descendants.add(id); queue.push(id); }
    if (!element.implicit) span(element.startLine, element.endLine);
    for (const relation of block.relations) if (descendants.has(relation.source) || descendants.has(relation.target)) remove.add(relation.startLine);
    for (let line = block.startLine + 1; line < block.endLine; line++) {
      const owner = parseMemberStatement(code[line])?.owner;
      if (owner && descendants.has(owner)) remove.add(line);
    }
  }
  return remove;
}

function relationLine(block: DiagramBlock, relationId: string): number {
  if (['activity', 'sdl', 'mindmap', 'wbs'].includes(block.kind)) throw new Error('This connection is derived from the diagram structure. Edit the structure in the source panel.');
  const relation = block.relations.find(candidate => candidate.id === relationId);
  if (!relation) throw new Error('This relationship no longer exists.');
  return relation.startLine;
}

/** Remove a whole selection as one edit. Items that cannot be removed are skipped while others can. */
function deleteSelection(source: string, diagramId: string, elementIds: string[], relationIds: string[], options: EditOptions): string {
  const block = parseDocument(source, { kinds: options.kind ? { [diagramId]: options.kind } : undefined }).diagrams.find(candidate => candidate.id === diagramId)!;
  const native = !block.meta?.legacy && !familyFor(block.kind) && !block.elements.some(element => element.meta?.procedure);
  let failure: unknown, removed = 0;
  if (native) {
    const code = codeLines(source), remove = new Set<number>();
    for (const id of new Set(elementIds)) {
      const element = block.elements.find(candidate => candidate.id === id);
      if (!element) continue;
      try { for (const line of removalLines(block, code, element)) remove.add(line); removed++; } catch (error) { failure ??= error; }
    }
    for (const id of new Set(relationIds)) {
      try { remove.add(relationLine(block, id)); removed++; } catch (error) { failure ??= error; }
    }
    if (!removed && failure) throw failure;
    return source.split(/\r?\n/).filter((_, index) => !remove.has(index)).join(source.includes('\r\n') ? '\r\n' : '\n');
  }
  // Family adapters patch one item at a time. Work from the end of the source so
  // earlier items keep their line-derived identities while later ones go.
  const order = (id: string, relation: boolean) => (relation ? block.relations : block.elements).find(item => item.id === id)?.startLine ?? -1;
  const items = [...[...new Set(elementIds)].map(id => ({ id, relation: false })), ...[...new Set(relationIds)].map(id => ({ id, relation: true }))].sort((a, b) => order(b.id, b.relation) - order(a.id, a.relation));
  let current = source;
  for (const item of items) {
    const latest = parseDocument(current, { kinds: options.kind ? { [diagramId]: options.kind } : undefined }).diagrams.find(candidate => candidate.id === diagramId);
    if (!latest || !(item.relation ? latest.relations : latest.elements).some(candidate => candidate.id === item.id)) continue;
    try { current = applyDiagramEdit(current, diagramId, item.relation ? { type: 'deleteRelation', relationId: item.id } : { type: 'deleteElement', elementId: item.id }, options); removed++; } catch (error) { failure ??= error; }
  }
  if (!removed && failure) throw failure;
  return current;
}

export interface EditOptions {
  /** The family the editor shows for a block whose source does not settle it yet. */
  kind?: DiagramKind;
}

/** Apply a narrowly scoped source patch; never serialize the parsed graph back over the document. */
export function applyDiagramEdit(source: string, diagramId: string, edit: DiagramEdit, options: EditOptions = {}): string {
  if (diagramId === 'document') {
    if (edit.type !== 'replaceSource' || typeof edit.source !== 'string') throw new Error('Only explicit source replacement can edit the whole document.');
    return edit.source;
  }
  const block = parseDocument(source, { kinds: options.kind ? { [diagramId]: options.kind } : undefined }).diagrams.find(candidate => candidate.id === diagramId);
  if (!block) throw new Error('This diagram no longer exists. Reopen it and try again.');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const code = codeLines(source);
  if (edit.type === 'replaceSource') {
    if (typeof edit.source !== 'string') throw new Error('Source must be text.');
    const replacement = edit.source.split(/\r?\n/);
    // The editor displays one block without a trailing newline; tolerate a pasted one.
    if (replacement.at(-1) === '') replacement.pop();
    lines.splice(block.startLine, block.endLine - block.startLine + 1, ...replacement);
    return lines.join(eol);
  }
  assertComplete(block);
  // Edits that rewrite a declaration line are checked on their result: a comment or brace caught in
  // the rewritten text must not take the diagram, or the blocks after it, off the canvas.
  const stillEditable = (result: string, action: string): string => {
    if (result === source) return result;
    const parse = (text: string) => parseDocument(text, { kinds: options.kind ? { [diagramId]: options.kind } : undefined }).diagrams;
    const after = parse(result), same = after.find(candidate => candidate.id === diagramId);
    if (after.length !== parse(source).length || !same?.graphical || same.kind !== block.kind) throw new Error(`${action} would leave syntax the canvas cannot edit. Make this change in the source editor.`);
    return result;
  };
  if (edit.type === 'deleteElements') {
    if (!Array.isArray(edit.elementIds) || !Array.isArray(edit.relationIds) || !edit.elementIds.length && !edit.relationIds.length) throw new Error('Select something to delete.');
    return deleteSelection(source, diagramId, edit.elementIds, edit.relationIds, options);
  }

  // Connection gestures: composed from the element and relationship edits, or one endpoint token.
  if (edit.type === 'addConnectedElement') return addConnectedElement(source, block, edit, options, applyDiagramEdit);
  if (edit.type === 'reconnectRelation') return reconnectRelation(source, block, edit, options);

  if (edit.type === 'moveSequenceEvent') return moveSequenceEvent(source, block, edit.eventId, edit.row);

  // Clipboard and properties work on declaration lines; both refuse other families themselves.
  if (edit.type === 'paste') {
    // A copy keeps its alias where it is free; beside its original, Order becomes Order2.
    const fresh = (id: string, taken: ReadonlySet<string>) => {
      if (isIdentifier(id) && !taken.has(id) && !reservedAliases.has(id.toLowerCase())) return id;
      const stem = id.replace(/(?<=\D)\d+$/, '');
      return aliasFor(block, 'element', stem, stem === id ? taken : new Set([...taken, stem]));
    };
    lines.splice(pasteInsertionLine(block), 0, ...pasteLines(block, edit, fresh));
    const result = lines.join(eol);
    const pasted = parseDocument(result, { kinds: options.kind ? { [diagramId]: options.kind } : undefined }).diagrams.find(candidate => candidate.id === diagramId);
    if (!pasted?.graphical || pasted.kind !== block.kind) throw new Error('Pasting here would leave syntax the canvas cannot edit. Paste in the source editor instead.');
    return result;
  }
  if (edit.type === 'properties') return stillEditable(setProperties(source, block, edit.elementId, edit), 'Changing these properties');
  // Membership is where a declaration is written; the move refuses every family where it is not.
  if (edit.type === 'moveToContainer') return stillEditable(moveToContainer(source, block, edit.elementId, edit.parentId), 'Moving this element');

  if (block.meta?.legacy) {
    const result = editLegacyActivity(source, block, edit);
    if (result !== undefined) return result;
    throw new Error('Edit this legacy control structure through its source to preserve its branches.');
  }
  const procedureEdit = editProcedure(source, block, edit);
  if (procedureEdit !== undefined) return procedureEdit;
  const family = familyFor(block.kind);
  if (family && edit.type !== 'insertSnippet') {
    const updated = family.edit(source, block, edit);
    if (updated === undefined) throw new Error('This operation is not available for this element. Edit its properties or source instead.');
    return updated;
  }
  const insertAt = (line: number, text: string[]) => lines.splice(line, 0, ...text);
  const removeLines = (indexes: Set<number>) => lines.filter((_, index) => !indexes.has(index)).join(eol);
  const rewriteReferences = (element: DiagramElement, alias: string) => {
    for (const relation of block.relations) {
      const syntax = parseRelation(code[relation.startLine]);
      if (!syntax) continue;
      let updated = lines[relation.startLine];
      if (relation.target === element.id) updated = updated.slice(0, syntax.targetSpan.start) + reference(alias) + updated.slice(syntax.targetSpan.end);
      if (relation.source === element.id) updated = updated.slice(0, syntax.sourceSpan.start) + reference(alias) + updated.slice(syntax.sourceSpan.end);
      lines[relation.startLine] = updated;
    }
    if (alias !== element.id) {
      for (let index = block.startLine + 1; index < block.endLine; index++) {
        const member = parseMemberStatement(code[index]);
        if (member?.owner === element.id) lines[index] = lines[index].slice(0, member.ownerSpan.start) + reference(alias) + lines[index].slice(member.ownerSpan.end);
      }
    }
  };

  if (edit.type === 'insertSnippet') {
    if (typeof edit.source !== 'string' || /^\s*@(?:start|end)/im.test(edit.source)) throw new Error('A snippet must be inside the current diagram block.');
    insertAt(block.endLine, edit.source.split(/\r?\n/));
    return lines.join(eol);
  }
  if (edit.type === 'addElement') {
    const name = nameValue(edit.name);
    if (!getNativeTemplate(block.kind)?.palette.includes(edit.kind)) throw new Error('This element type is not available for native editing in this diagram. Use the source editor for unsupported syntax.');
    if (block.kind === 'mindmap' || block.kind === 'wbs') {
      const parent = edit.parentId ? findElement(block, edit.parentId) : block.elements[0];
      const parentMarker = parent ? code[parent.startLine].trim().match(/^[*+-]+/)?.[0] ?? '*' : '';
      const marker = parent ? parentMarker + parentMarker[0] : '*';
      let index = block.endLine;
      if (parent) {
        index = parent.startLine + 1;
        while (index < block.endLine) {
          const next = code[index].trim().match(/^([*+-]+)\s/);
          if (next && next[1].length <= parentMarker.length) break;
          index++;
        }
      }
      insertAt(index, [`${marker} ${name}`]);
    } else if (block.kind === 'activity' || block.kind === 'sdl') {
      if (/[;\r\n]/.test(name)) throw new Error('Activity names cannot contain semicolons.');
      const end = [...block.elements].reverse().find(element => element.kind === 'end');
      const index = end?.startLine ?? block.endLine;
      if (edit.kind === 'start') {
        if (block.elements.some(element => element.kind === 'start')) throw new Error('This activity already has a start.');
        // Directives and the title stay above the flow they configure.
        let first = block.startLine + 1;
        while (first < block.endLine && (!code[first].trim() || /^\s*(?:title\b|skinparam\b|!|left to right|top to bottom|scale\b|hide\b|show\b)/i.test(code[first]))) first++;
        insertAt(block.elements.length ? Math.min(first, ...block.elements.map(element => element.startLine)) : first, ['start']);
      } else if (edit.kind === 'stop') insertAt(block.endLine, ['stop']);
      else if (edit.kind === 'decision') {
        if (/[()]/.test(name)) throw new Error('Decision names cannot contain parentheses in inline editing.');
        insertAt(index, [`if (${name}) then (yes)`, '  :Action;', 'else (no)', '  :Alternative;', 'endif']);
      } else if (edit.kind.startsWith('sdl-')) insertAt(index, [`:${name}; <<${edit.kind.slice(4)}>>`]);
      else if (edit.kind === 'while') insertAt(index, [`while (${name}) is (yes)`, '  :Action;', 'endwhile (no)']);
      else if (edit.kind === 'repeat') insertAt(index, ['repeat', '  :Action;', `repeat while (${name}) is (yes) not (no)`]);
      else if (edit.kind === 'fork') insertAt(index, ['fork', `  :${name};`, 'fork again', '  :Parallel action;', 'end fork']);
      else if (edit.kind === 'partition') insertAt(index, [`partition ${quote(name)} {`, '  :Action;', '}']);
      else insertAt(index, [`:${name};`]);
    } else if (block.kind === 'sequence' && ['alt', 'loop', 'opt', 'divider'].includes(edit.kind)) {
      insertAt(block.endLine, edit.kind === 'divider' ? [`== ${name} ==`] : [`${edit.kind} ${name}`, 'end']);
    } else {
      const id = edit.kind === 'note' ? newId(block, edit.kind) : aliasFor(block, edit.kind, name);
      let index = block.endLine;
      let indent = '';
      if (edit.parentId) {
        const parent = findElement(block, edit.parentId);
        if (parent.endLine <= parent.startLine || !/^\s*}\s*$/.test(code[parent.endLine])) throw new Error('Add to a container with an existing block, or use the source editor.');
        index = parent.endLine;
        indent = (lines[parent.startLine].match(/^\s*/)?.[0] ?? '') + '  ';
      } else if (block.kind === 'sequence') {
        // Participants must be declared before their first message.
        index = block.relations[0]?.startLine ?? block.endLine;
      }
      const declaration = id === name ? `${indent}${edit.kind} ${id}` : `${indent}${edit.kind} ${quote(name)} as ${id}`;
      const hasMembers = memberKinds.has(edit.kind) && block.kind !== 'sequence' && !(edit.kind === 'interface' && ['component', 'deployment'].includes(block.kind));
      if (edit.kind === 'note' && block.kind === 'sequence') {
        const participant = block.elements.find(element => element.kind !== 'note');
        if (!participant) throw new Error('Create a participant before adding a sequence note.');
        insertAt(index, [`note over ${reference(participant.id)} : ${name}`]);
      } else if (edit.kind === 'package') insertAt(index, [`${declaration} {`, `${indent}}`]);
      else insertAt(index, hasMembers ? [`${declaration} {`, `${indent}}`] : [declaration]);
    }
    return lines.join(eol);
  }

  if (edit.type === 'rename') {
    const element = findElement(block, edit.elementId);
    const name = nameValue(edit.name);
    if (['start', 'end', 'merge'].includes(element.kind)) throw new Error('This control symbol has no editable name.');
    const line = lines[element.startLine];
    if (element.meta?.annotation) {
      if (element.meta.multiline) lines.splice(element.startLine + 1, element.endLine - element.startLine - 1, name);
      else lines[element.startLine] = line.slice(0, line.indexOf(':') + 1) + ' ' + name;
    } else if (element.kind.startsWith('sequence-')) {
      if (element.kind === 'sequence-fragment') lines[element.startLine] = line.replace(/^(\s*)(alt|opt|loop|par|break|critical|group|ref)\b.*$/i, (_all, indent, type) => `${indent}${type} ${name.replace(new RegExp(`^${type}\\s+`, 'i'), '')}`);
      else if (element.kind === 'sequence-divider') lines[element.startLine] = /^\s*else\b/.test(line) ? `else ${name}` : `== ${name} ==`;
      else if (element.kind === 'sequence-delay') lines[element.startLine] = `... ${name} ...`;
      else if (element.kind === 'sequence-note') {
        if (element.meta?.multiline) lines.splice(element.startLine + 1, element.endLine - element.startLine - 1, name);
        else lines[element.startLine] = line.slice(0, line.indexOf(':') + 1) + ' ' + name;
      } else throw new Error('This sequence decoration has no editable label.');
    } else if (block.kind === 'mindmap' || block.kind === 'wbs') {
      const prefix = code[element.startLine].match(/^\s*[*+-]+(?:\[[^\]]+\])?\s+/)?.[0];
      if (!prefix) throw new Error('Use the source editor for this hierarchy label.');
      const suffix = line.slice(code[element.startLine].trimEnd().length);
      lines[element.startLine] = prefix + name + suffix;
    } else if (block.kind === 'activity' || block.kind === 'sdl') {
      if (element.kind === 'activity' || element.kind.startsWith('sdl-')) {
        if (name.includes(';')) throw new Error('Activity names cannot contain semicolons.');
        const prefix = line.match(/^\s*(?::|backward\s*:)/)?.[0] ?? ':';
        const final = lines[element.endLine], terminator = String(element.meta?.terminator ?? ';');
        const suffix = final.slice(final.lastIndexOf(terminator));
        lines.splice(element.startLine, element.endLine - element.startLine + 1, prefix + name + suffix);
      } else if (element.kind === 'decision') {
        if (/[()]/.test(name)) throw new Error('Decision names cannot contain parentheses in inline editing.');
        lines[element.startLine] = line.replace(/^(\s*(?:if|elseif|while|switch|repeat\s+while)\s*\().*?(\).*)$/i, (_match, prefix, suffix) => prefix + name + suffix);
      } else if (element.kind === 'partition') lines[element.startLine] = line.replace(/^(\s*(?:partition|group|rectangle|package)\s+).*(\s*\{)$/, (_match, prefix, suffix) => prefix + quote(name) + suffix);
      else throw new Error('Edit this control structure in the source editor.');
    } else {
      const declaration = parseDeclaration(code[element.startLine]);
      if (declaration && !element.implicit && declaration.id === element.id) {
        const alias = isIdentifier(element.id) ? element.id : newId(block, element.kind);
        const replacement = declaration.aliasSpan ? quote(name) : `${quote(name)} as ${reference(alias)}`;
        const prefix = line.slice(0, declaration.nameSpan.start);
        const shorthand = /^[\s]*[\[(:]/.test(line);
        lines[element.startLine] = `${shorthand ? `${prefix}${declaration.kind} ` : prefix}${replacement}${line.slice(declaration.nameSpan.end)}`;
        if (!declaration.aliasSpan && alias !== element.id) rewriteReferences(element, alias);
      } else {
        // Introduce a display-name declaration while keeping the original reference identity.
        // Wrapped shorthand endpoints must be replaced with their alias, not left as a second object.
        const alias = isIdentifier(element.id) ? element.id : newId(block, element.kind);
        rewriteReferences(element, alias);
        insertAt(element.startLine, [`${element.kind} ${quote(name)} as ${reference(alias)}`]);
      }
    }
    return lines.join(eol);
  }

  if (edit.type === 'members') {
    const element = findElement(block, edit.elementId);
    if (!memberKinds.has(element.kind)) throw new Error('This element does not have an editable member compartment.');
    if (!Array.isArray(edit.members) || edit.members.some(member => typeof member !== 'string' || /[\r\n]/.test(member) || /[{}]/.test(member.replace(/\{(?:static|abstract|field|method)\}/g, '')) || /^\s*[@!]/.test(member))) throw new Error('Each member must be a single member line, without block delimiters or directives.');
    const declaration = parseDeclaration(code[element.startLine]);
    if (!declaration || element.implicit) throw new Error('Declare this element first, or edit its members in the source editor.');
    if (code.slice(block.startLine + 1, block.endLine).some(text => parseMemberStatement(text)?.owner === element.id)) throw new Error('This element uses separate member statements. Edit those in the source panel.');
    const indent = lines[element.startLine].match(/^\s*/)?.[0] ?? '';
    const members = edit.members.filter(member => member.trim()).map(member => indent + '  ' + member.trim());
    if (declaration.bodyStart >= 0 && declaration.bodyEnd >= 0) {
      const line = lines[element.startLine];
      lines[element.startLine] = line.slice(0, declaration.bodyStart + 1) + eol + members.join(eol) + eol + indent + line.slice(declaration.bodyEnd);
    } else if (declaration.bodyStart >= 0) {
      if (element.endLine <= element.startLine || code[element.endLine].trim() !== '}') throw new Error('Close the element body before editing members.');
      const oldMembers = lines.slice(element.startLine + 1, element.endLine).map((raw, offset) => ({ raw, code: code[element.startLine + 1 + offset], used: false }));
      const patchedMembers = members.map(member => {
        const retained = oldMembers.find(candidate => !candidate.used && candidate.code.trim() === member.trim());
        if (retained) { retained.used = true; return retained.raw; }
        return member;
      });
      const preserved = oldMembers.flatMap(candidate => {
        if (candidate.used) return [];
        if (!candidate.code.trim()) return [candidate.raw];
        const comment = candidate.raw.slice(candidate.code.trimEnd().length).trim();
        return comment ? [indent + '  ' + comment] : [];
      });
      lines.splice(element.startLine + 1, element.endLine - element.startLine - 1, ...preserved, ...patchedMembers);
    } else {
      const column = code[element.startLine].trimEnd().length;
      lines[element.startLine] = lines[element.startLine].slice(0, column) + ' {' + lines[element.startLine].slice(column);
      insertAt(element.startLine + 1, [...members, indent + '}']);
    }
    return lines.join(eol);
  }

  if (edit.type === 'addRelation' || edit.type === 'editRelation') {
    if (['activity', 'sdl', 'mindmap', 'wbs'].includes(block.kind)) throw new Error('This diagram derives connections from its source structure. Edit the structure in the source panel.');
    if (typeof edit.label !== 'string' || /[\r\n\u0000]/.test(edit.label)) throw new Error('Relationship labels must fit on one line.');
    if (!relationArrows.has(edit.arrow)) throw new Error('Choose a supported relationship style.');
    if (edit.type === 'addRelation') {
      // A state machine's initial and final symbols exist only as the [*] end of a transition.
      const pseudo = (id: string) => id === '[*]' && block.kind === 'state';
      if (pseudo(edit.source) && pseudo(edit.target)) throw new Error('Connect the initial or final symbol to a state.');
      const from = pseudo(edit.source) ? undefined : findElement(block, edit.source);
      const to = pseudo(edit.target) ? undefined : findElement(block, edit.target);
      const endpoint = (element: DiagramElement | undefined) => !element || ['start', 'end'].includes(element.kind) ? '[*]' : reference(element.id);
      if (edit.sequenceRow !== undefined && (block.kind !== 'sequence' || !Number.isSafeInteger(edit.sequenceRow) || edit.sequenceRow < 0 || edit.sequenceRow > 20000)) throw new Error('Choose a valid sequence row.');
      insertAt(edit.sequenceRow === undefined ? block.endLine : sequenceInsertionLine(block, edit.sequenceRow), [`${endpoint(from)} ${edit.arrow} ${endpoint(to)}${edit.label.trim() ? ` : ${edit.label.trim()}` : ''}`]);
    } else {
      const relation = block.relations.find(candidate => candidate.id === edit.relationId);
      if (!relation) throw new Error('This relationship no longer exists.');
      const syntax = parseRelation(code[relation.startLine]);
      if (!syntax) throw new Error('This relationship must be edited in the source panel.');
      const raw = lines[relation.startLine];
      const comment = raw.slice(code[relation.startLine].trimEnd().length);
      const endpointPart = raw.slice(0, syntax.arrowSpan.start) + edit.arrow + raw.slice(syntax.arrowSpan.end, syntax.targetSpan.end);
      lines[relation.startLine] = endpointPart + (edit.label.trim() ? ` : ${edit.label.trim()}` : '') + comment;
    }
    return lines.join(eol);
  }

  if (edit.type === 'deleteRelation') return removeLines(new Set([relationLine(block, edit.relationId)]));
  if (edit.type === 'deleteElement') return removeLines(removalLines(block, code, findElement(block, edit.elementId)));
  throw new Error('Unknown diagram edit.');
}
