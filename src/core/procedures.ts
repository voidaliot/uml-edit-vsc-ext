import type { DiagramBlock, DiagramEdit, DiagramElement } from '../shared/protocol';
import { codeLines as lexCodeLines, parseDeclaration, parseMemberStatement, parseRelation, quote, reference, unquote } from './syntax';

interface Argument { literal: string; value: string; start: number; end: number; explicit: boolean }
interface Parameter { name: string; fallback?: string }
interface Procedure { name: string; parameters: Parameter[]; body: { text: string; line: number }[]; startLine: number; endLine: number; valid: boolean }
interface ProcedureMeta {
  procedure: true;
  procedureName: string;
  procedureParameters: Parameter[];
  procedureArguments: Argument[];
  procedureArgsStart: number;
  procedureArgsEnd: number;
  renameParameter?: string;
  renameValue?: string;
  [key: string]: unknown;
}

function diagnostic(block: DiagramBlock, line: number, message: string): void {
  block.graphical = false;
  block.warnings.push(`Line ${line + 1}: ${message}`);
}

/** Split literal arguments while retaining exact columns for subsequent targeted edits. */
function splitArguments(text: string, offset = 0): { literal: string; start: number; end: number }[] {
  if (!text.trim()) return [];
  const result: { literal: string; start: number; end: number }[] = [];
  let quoted = false, escaped = false, start = 0;
  for (let index = 0; index <= text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (!escaped && character === '"') quoted = false;
      escaped = !escaped && character === '\\';
    } else if (character === '"') quoted = true;
    if (index === text.length || character === ',' && !quoted) {
      const raw = text.slice(start, index), leading = raw.length - raw.trimStart().length, trailing = raw.length - raw.trimEnd().length;
      result.push({ literal: raw.trim(), start: offset + start + leading, end: offset + index - trailing }); start = index + 1;
    }
  }
  if (quoted) throw new Error('Close the quoted procedure argument.');
  if (result.some(argument => !argument.literal)) throw new Error('Procedure arguments cannot be empty.');
  return result;
}

function literalValue(literal: string): string {
  if (/^"(?:\\.|[^"\\])*"$/.test(literal)) return unquote(literal);
  if (/^(?:[\p{L}_][\p{L}\p{N}_.-]*|#[\da-z]+|-?\d+(?:\.\d+)?)$/iu.test(literal)) return literal;
  throw new Error('Only quoted text, identifiers, colors, and numeric procedure arguments are supported; expressions are not evaluated.');
}

function substitute(text: string, parameters: Parameter[], arguments_: Argument[]): string {
  const values = new Map(parameters.map((parameter, index) => [parameter.name, arguments_[index]]));
  let output = '', quoted = false;
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === '"') {
      let escapes = 0; for (let previous = index - 1; previous >= 0 && text[previous] === '\\'; previous--) escapes++;
      if (escapes % 2 === 0) quoted = !quoted;
    }
    if (character === '$') {
      const name = text.slice(index).match(/^\$[A-Za-z_]\w*/)?.[0];
      if (!name || !values.has(name)) throw new Error(`Unknown procedure parameter ${name ?? '$'}. Global variables and nested calls are not evaluated.`);
      const argument = values.get(name)!;
      output += quoted ? quote(argument.value).slice(1, -1) : argument.literal;
      index += name.length;
    } else { output += character; index++; }
  }
  return output;
}

function headingParameter(template: string, parameters: Parameter[], expansion: string): string | undefined {
  const declaration = parseDeclaration(expansion);
  if (!declaration?.aliasSpan) return;
  // Use the corresponding declaration spelling with placeholder identifiers to find the label template.
  const placeholders = parameters.map(parameter => ({ literal: `PARAM_${parameter.name.slice(1)}`, value: `PARAM_${parameter.name.slice(1)}`, start: 0, end: 0, explicit: true }));
  // A dynamic shape must stay a real declaration keyword when locating the display-name span.
  const shapeMatch = template.trimStart().match(/^(\$[A-Za-z_]\w*)\s/);
  if (shapeMatch) {
    const index = parameters.findIndex(parameter => parameter.name === shapeMatch[1]);
    if (index >= 0) placeholders[index] = { ...placeholders[index], literal: declaration.kind, value: declaration.kind };
  }
  let projected: string;
  try { projected = substitute(template, parameters, placeholders); } catch { return; }
  const projectedDeclaration = parseDeclaration(projected);
  if (!projectedDeclaration) return;
  const label = projectedDeclaration.nameSpan.text;
  const candidates = parameters.filter(parameter => label.includes(`PARAM_${parameter.name.slice(1)}`)).map(parameter => parameter.name);
  const preferred = candidates.filter(name => /^\$(?:headline|heading|title|label|caption|displayName|display)$/i.test(name));
  if (preferred.length === 1) return preferred[0];
  if (candidates.length === 1) return candidates[0];
  return undefined;
}

/**
 * Project a deliberately finite subset of local PlantUML procedures: literal arguments
 * substituted into standalone declarations. No evaluator, imports, filesystem, or networking.
 */
export function projectProcedures(block: DiagramBlock, lines: string[]): { ignored: Set<number>; elements: DiagramElement[] } {
  const ignored = new Set<number>(), elements: DiagramElement[] = [], procedures = new Map<string, Procedure>();
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    if (!/^\s*!procedure\b/.test(lines[line])) continue;
    const start = line, signature = lines[line].match(/^\s*!procedure\s+(\$[A-Za-z_]\w*)\s*\((.*)\)\s*$/);
    let end = line + 1;
    while (end < block.endLine && !/^\s*!endprocedure\b/.test(lines[end])) end++;
    for (let index = start; index <= Math.min(end, block.endLine - 1); index++) ignored.add(index);
    if (end >= block.endLine) { diagnostic(block, start, 'Close the local procedure with !endprocedure.'); break; }
    line = end;
    if (!signature) { diagnostic(block, start, 'Expected !procedure $name($parameter, ...).'); continue; }
    const definition: Procedure = { name: signature[1], parameters: [], body: [], startLine: start, endLine: end, valid: true };
    try {
      definition.parameters = splitArguments(signature[2]).map(argument => {
        const parameter = argument.literal.match(/^(\$[A-Za-z_]\w*)(?:\s*=\s*(.*))?$/);
        if (!parameter) throw new Error('Procedure parameters must be named $identifiers with optional literal defaults.');
        if (parameter[2] !== undefined) literalValue(parameter[2]);
        return { name: parameter[1], ...(parameter[2] !== undefined ? { fallback: parameter[2] } : {}) };
      });
      if (new Set(definition.parameters.map(parameter => parameter.name)).size !== definition.parameters.length) throw new Error('Procedure parameter names must be unique.');
      for (let index = start + 1; index < end; index++) {
        const text = lines[index].trim(); if (!text) continue;
        if (/^[!@]|%[A-Za-z_]\w*\s*\(|\$[A-Za-z_]\w*\s*\(/.test(text)) throw new Error('Conditional, looping, evaluation, include, and nested-procedure bodies are not executed; use literal declarations.');
        definition.body.push({ text: lines[index], line: index });
      }
      if (!definition.body.length) throw new Error('The procedure has no declaration to display.');
      if (procedures.has(definition.name)) throw new Error(`Procedure ${definition.name} is declared more than once.`);
    } catch (error) { definition.valid = false; diagnostic(block, start, (error as Error).message); }
    procedures.set(definition.name, definition);
  }
  const usedIds = new Set<string>();
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    if (ignored.has(line)) continue;
    const call = lines[line].match(/^(\s*)(\$[A-Za-z_]\w*)\s*\((.*)\)\s*$/);
    if (!call || !procedures.has(call[2])) continue;
    ignored.add(line);
    const procedure = procedures.get(call[2])!;
    if (!procedure.valid) continue;
    try {
      const argsStart = lines[line].indexOf('(', call[1].length) + 1, argsEnd = lines[line].lastIndexOf(')');
      const supplied = splitArguments(call[3], argsStart);
      if (supplied.length > procedure.parameters.length) throw new Error(`${procedure.name} accepts ${procedure.parameters.length} arguments.`);
      const arguments_: Argument[] = procedure.parameters.map((parameter, index) => {
        const explicit = supplied[index];
        const literal = explicit?.literal ?? parameter.fallback;
        if (literal === undefined) throw new Error(`Supply a literal value for ${parameter.name}.`);
        return { literal, value: literalValue(literal), start: explicit?.start ?? argsEnd, end: explicit?.end ?? argsEnd, explicit: Boolean(explicit) };
      });
      const projected: DiagramElement[] = [];
      for (const statement of procedure.body) {
        const expansion = substitute(statement.text, procedure.parameters, arguments_);
        const declaration = parseDeclaration(expansion);
        if (!declaration || declaration.bodyStart >= 0 && declaration.bodyEnd < 0 || declaration.tail.trim() && !/^(?:\{|<<|#|\[\[)/.test(declaration.tail.trim())) throw new Error('Local procedure bodies must contain complete standalone declarations; block control flow is not executed.');
        if (usedIds.has(declaration.id) || projected.some(item => item.id === declaration.id)) throw new Error(`Procedure calls produce the same element identity ${declaration.id}. Supply distinct identity arguments.`);
        const renameParameter = headingParameter(statement.text, procedure.parameters, expansion);
        const renameIndex = procedure.parameters.findIndex(parameter => parameter.name === renameParameter);
        const data: ProcedureMeta = {
          procedure: true, procedureName: procedure.name, procedureParameters: procedure.parameters, procedureArguments: arguments_,
          procedureArgsStart: argsStart, procedureArgsEnd: argsEnd, renameParameter, renameValue: renameIndex >= 0 ? arguments_[renameIndex].value : undefined,
          editMembers: true, procedureDefinitionLine: procedure.startLine, procedureTemplate: statement.text, renderedLabel: declaration.name,
          width: Math.max(220, Math.min(460, Math.max(...declaration.name.split('\n').map(part => part.replace(/<[^>]+>/g, '').length)) * 8 + 40)),
          height: Math.max(90, declaration.name.split('\n').length * 20 + 35),
        };
        const color = declaration.tail.match(/#([A-Za-z0-9]+)/)?.[1]; if (color) data.color = /^[\da-f]{3,8}$/i.test(color) ? '#' + color : color;
        projected.push({ id: declaration.id, kind: declaration.kind, name: declaration.name, members: procedure.parameters.map((parameter, index) => `${parameter.name} = ${arguments_[index].literal}`), startLine: line, endLine: line, meta: data });
      }
      for (const item of projected) { usedIds.add(item.id); elements.push(item); }
    } catch (error) { diagnostic(block, line, (error as Error).message); }
  }
  return { ignored, elements };
}

function patchArguments(source: string, element: DiagramElement, updates: Map<string, string>): string {
  const data = element.meta as ProcedureMeta, eol = source.includes('\r\n') ? '\r\n' : '\n', lines = source.split(/\r?\n/), original = lines[element.startLine];
  const replacements: { start: number; end: number; text: string }[] = [];
  let highestDefault = -1;
  for (const [name, literal] of updates) {
    const index = data.procedureParameters.findIndex(parameter => parameter.name === name);
    if (index < 0) throw new Error(`Unknown parameter ${name}.`);
    literalValue(literal);
    const argument = data.procedureArguments[index];
    if (argument.explicit) replacements.push({ start: argument.start, end: argument.end, text: literal });
    else highestDefault = Math.max(highestDefault, index);
  }
  if (highestDefault >= 0) {
    const explicitCount = data.procedureArguments.filter(argument => argument.explicit).length;
    const values = data.procedureParameters.slice(explicitCount, highestDefault + 1).map((parameter, offset) => updates.get(parameter.name) ?? data.procedureArguments[explicitCount + offset].literal);
    replacements.push({ start: data.procedureArgsEnd, end: data.procedureArgsEnd, text: `${explicitCount ? ', ' : ''}${values.join(', ')}` });
  }
  let changed = original;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) changed = changed.slice(0, replacement.start) + replacement.text + changed.slice(replacement.end);
  lines[element.startLine] = changed;
  return lines.join(eol);
}

export function editProcedure(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  if (!['rename', 'members', 'deleteElement'].includes(edit.type)) return undefined;
  const id = (edit as { elementId: string }).elementId;
  const item = block.elements.find(element => element.id === id && element.meta?.procedure === true);
  if (!item) return undefined;
  const data = item.meta as ProcedureMeta;
  if (edit.type === 'deleteElement') {
    const eol = source.includes('\r\n') ? '\r\n' : '\n', lines = source.split(/\r?\n/); lines.splice(item.startLine, 1); return lines.join(eol);
  }
  const updates = new Map<string, string>();
  if (edit.type === 'rename') {
    if (!data.renameParameter) throw new Error('This procedure has no separate unambiguous heading argument. Edit its parameters in the element instead.');
    if (!edit.name.trim() || /[\r\n\0]/.test(edit.name)) throw new Error('Enter a single-line heading.');
    updates.set(data.renameParameter, quote(edit.name.trim()));
  } else if (edit.type === 'members') {
    for (const line of edit.members) {
      const assignment = line.match(/^\s*(\$?[A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
      if (!assignment) throw new Error('Use one $parameter = literal assignment per line.');
      const name = assignment[1].startsWith('$') ? assignment[1] : '$' + assignment[1];
      if (updates.has(name)) throw new Error(`Parameter ${name} is repeated.`);
      updates.set(name, assignment[2]);
    }
  }
  const changed = patchArguments(source, item, updates);
  const changedLines = lexCodeLines(changed), delta = changed.split(/\r?\n/).length - source.split(/\r?\n/).length;
  const candidate: DiagramBlock = { ...block, endLine: block.endLine + delta, elements: [], relations: [], warnings: [], graphical: true };
  const projected = projectProcedures(candidate, changedLines);
  if (!candidate.graphical || !projected.elements.some(element => element.startLine === item.startLine)) throw new Error(candidate.warnings[0] ?? 'These arguments do not produce a valid declaration.');
  const originalProjection = projectProcedures({ ...block, warnings: [], graphical: true }, lexCodeLines(source));
  const before = originalProjection.elements.filter(element => element.startLine === item.startLine);
  const after = projected.elements.filter(element => element.startLine === item.startLine);
  if (before.length !== after.length) throw new Error('These arguments change the declaration structure. Edit the source instead.');
  const aliases = new Map(before.flatMap((element, index) => element.id === after[index].id ? [] : [[element.id, after[index].id] as const]));
  if (!aliases.size) return changed;
  const callIds = new Set(before.map(element => element.id));
  for (const alias of aliases.values()) {
    if (block.elements.some(element => element.id === alias && !callIds.has(element.id))) throw new Error(`Element identity ${alias} already belongs to another element. Choose a distinct identity argument.`);
  }
  // An identity argument can change several declarations at once. Rewrite original
  // endpoint spans together so swaps stay valid and labels/comments remain intact.
  const eol = source.includes('\r\n') ? '\r\n' : '\n', lines = changed.split(/\r?\n/);
  const relationLines = new Set(block.relations.map(relation => relation.startLine));
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    if (originalProjection.ignored.has(line)) continue;
    const patches: { start: number; end: number; value: string }[] = [];
    const relation = relationLines.has(line) ? parseRelation(changedLines[line]) : undefined;
    if (relation) {
      for (const [id, span] of [[relation.source, relation.sourceSpan], [relation.target, relation.targetSpan]] as const) {
        const alias = aliases.get(id);
        if (alias !== undefined) patches.push({ ...span, value: reference(alias) });
      }
    } else {
      const member = parseMemberStatement(changedLines[line]);
      const alias = member ? aliases.get(member.owner) : undefined;
      if (member && alias !== undefined) patches.push({ ...member.ownerSpan, value: reference(alias) });
    }
    for (const patch of patches.sort((first, second) => second.start - first.start)) lines[line] = lines[line].slice(0, patch.start) + patch.value + lines[line].slice(patch.end);
  }
  return lines.join(eol);
}
