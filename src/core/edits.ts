import type { DiagramBlock, DiagramEdit, DiagramElement } from '../shared/protocol';
import { parseDocument } from './parser';
import { codeLines, isIdentifier, parseDeclaration, parseRelation, parseMemberStatement, quote, reference } from './syntax';
import { getNativeTemplate } from './templates';
import { familyFor } from './families/registry';
import { editProcedure } from './procedures';
import { editLegacyActivity } from './legacy-activity';
import { moveSequenceEvent, sequenceInsertionLine } from './sequence';

const memberKinds = new Set(['class', 'abstract class', 'interface', 'enum', 'annotation', 'object', 'entity']);
const relationArrows = new Set(['-->', '->', '<--', '<-', '--', '..', '..>', '<..', '<|--', '--|>', '<|..', '..|>', '*--', '--*', 'o--', '--o', '||--o{', '}o--||', '||--||', '}o--o{', '-->>', '->>', '<->', '<-->']);

function nameValue(name: string): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Enter a non-empty name.');
  if (/[\r\n\u0000]/.test(name)) throw new Error('Names must fit on one line. Use the source editor for multiline labels.');
  if (name.length > 2000) throw new Error('This label is too long for an inline edit.');
  return name.trim();
}

function newId(block: DiagramBlock, kind: string): string {
  const stem = kind.replace(/[^a-zA-Z0-9_]/g, '_') || 'element';
  let index = 1;
  while (block.elements.some(element => element.id === `${stem}_${index}`)) index++;
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

/** Apply a narrowly scoped source patch; never serialize the parsed graph back over the document. */
export function applyDiagramEdit(source: string, diagramId: string, edit: DiagramEdit): string {
  if (diagramId === 'document') {
    if (edit.type !== 'replaceSource' || typeof edit.source !== 'string') throw new Error('Only explicit source replacement can edit the whole document.');
    return edit.source;
  }
  const block = parseDocument(source).diagrams.find(candidate => candidate.id === diagramId);
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
  if (edit.type === 'moveSequenceEvent') return moveSequenceEvent(source, block, edit.eventId, edit.row);
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
      if (edit.kind === 'decision') {
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
      const id = newId(block, edit.kind);
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
      const declaration = `${indent}${edit.kind} ${quote(name)} as ${id}`;
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
      const from = findElement(block, edit.source);
      const to = findElement(block, edit.target);
      const endpoint = (element: DiagramElement) => ['start', 'end'].includes(element.kind) ? '[*]' : reference(element.id);
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

  if (edit.type === 'deleteRelation') {
    if (['activity', 'sdl', 'mindmap', 'wbs'].includes(block.kind)) throw new Error('This connection is derived from the diagram structure. Edit the structure in the source panel.');
    const relation = block.relations.find(candidate => candidate.id === edit.relationId);
    if (!relation) throw new Error('This relationship no longer exists.');
    return removeLines(new Set([relation.startLine]));
  }
  if (edit.type === 'deleteElement') {
    const element = findElement(block, edit.elementId);
    if (!block.graphical) throw new Error('This diagram contains advanced syntax. Delete in the source panel to review all references.');
    if (['start', 'end', 'decision', 'merge'].includes(element.kind)) throw new Error('Delete this control structure in the source editor.');
    const remove = new Set<number>();
    if (block.kind === 'activity' || block.kind === 'sdl') for (let line = element.startLine; line <= element.endLine; line++) remove.add(line);
    else if (block.kind === 'mindmap' || block.kind === 'wbs') {
      const ids = new Set([element.id]);
      for (const candidate of block.elements) if (candidate.parentId && ids.has(candidate.parentId)) ids.add(candidate.id);
      for (const candidate of block.elements) if (ids.has(candidate.id)) remove.add(candidate.startLine);
    } else {
      if (block.elements.some(candidate => candidate.parentId === element.id)) {
        const descendants = new Set([element.id]);
        const children = new Map<string, string[]>();
        for (const candidate of block.elements) if (candidate.parentId) children.set(candidate.parentId, [...children.get(candidate.parentId) ?? [], candidate.id]);
        const queue = [element.id];
        while (queue.length) for (const id of children.get(queue.shift()!) ?? []) if (!descendants.has(id)) { descendants.add(id); queue.push(id); }
        for (const relation of block.relations) if (descendants.has(relation.source) || descendants.has(relation.target)) remove.add(relation.startLine);
      }
      if (!element.implicit) for (let line = element.startLine; line <= element.endLine; line++) remove.add(line);
      for (const relation of block.relations) if (relation.source === element.id || relation.target === element.id) remove.add(relation.startLine);
      for (let line = block.startLine + 1; line < block.endLine; line++) {
        if (parseMemberStatement(code[line])?.owner === element.id) remove.add(line);
      }
    }
    return removeLines(remove);
  }
  throw new Error('Unknown diagram edit.');
}
