import type { DiagramBlock, DiagramEdit, DiagramElement, DiagramRelation } from '../shared/protocol';
import { codeLines, quote, unquote } from './syntax';

interface Span { startLine: number; startColumn: number; endLine: number; endColumn: number }
interface Occurrence { span: Span; nameSpan?: Span; leadingArrow?: Span; declaration: boolean; quoted: boolean; source?: string }
interface LegacyData { alias?: string; occurrences: Occurrence[]; control?: string }
interface Statement { text: string; line: number; endLine: number; columns: { line: number; column: number }[] }
interface Endpoint { element: DiagramElement; end: number; occurrence: Occurrence }
interface BranchFrame { head: string; ends: string[]; branch: boolean; line: number }
interface Patch { start: number; end: number; text: string }
const endpointIdentifier = /^[\p{L}\p{N}_$][\p{L}\p{N}_.$]*/u;
const arrowPattern = /^(?:[-=.]+(?:\[[^\]]*\])?(?:(?:left|right|up|down|le|ri|u|d|l|r)[-=.]*)?>|<[-=.]+(?:(?:left|right|up|down)[-=.]*)?)/i;

function hash(value: string) { let result = 2166136261; for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619); return (result >>> 0).toString(36); }
function warn(block: DiagramBlock, line: number, message: string) { if (block.warnings.length < 12) block.warnings.push(`Line ${line + 1}: ${message}`); }
function statements(block: DiagramBlock, lines: string[]): Statement[] {
  const result: Statement[] = [];
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const first = line, columns: Statement['columns'] = [];
    let text = '', quoted = false;
    do {
      const value = lines[line] ?? '';
      if (text) { columns.push({ line: line - 1, column: lines[line - 1].length }); text += '\n'; }
      for (let column = 0; column < value.length; column++) {
        const char = value[column]; columns.push({ line, column }); text += char;
        if (char === '"') { let escapes = 0; for (let at = column - 1; at >= 0 && value[at] === '\\'; at--) escapes++; if (escapes % 2 === 0) quoted = !quoted; }
      }
      if (!quoted || line + 1 >= block.endLine) break;
      line++;
    } while (true);
    columns.push({ line, column: (lines[line] ?? '').length });
    result.push({ text, line: first, endLine: line, columns });
  }
  return result;
}
function span(statement: Statement, start: number, end: number): Span {
  const beginning = statement.columns[start], ending = statement.columns[end];
  return { startLine: beginning.line, startColumn: beginning.column, endLine: ending.line, endColumn: ending.column };
}
function data(element: DiagramElement): LegacyData { return element.meta!.legacyData as unknown as LegacyData; }
function skipSpace(text: string, start: number) { while (start < text.length && /\s/.test(text[start])) start++; return start; }
function quoteEnd(text: string, start: number) {
  for (let end = start + 1; end < text.length; end++) {
    if (text[end] === '\\') { end++; continue; }
    if (text[end] === '"') return end + 1;
  }
  return -1;
}

/** Original native projection of PlantUML's legacy arrow-based activity syntax. */
export function parseLegacyActivity(block: DiagramBlock, absoluteCodeLines: string[]): void {
  const names = new Map<string, DiagramElement>(), aliases = new Map<string, DiagramElement>(), bars = new Map<string, DiagramElement>();
  const partitions = new Map<string, DiagramElement>(), groups: DiagramElement[] = [], frames: BranchFrame[] = [];
  let tail: string | undefined, pendingLabel = '', styleDepth = 0;
  const add = (id: string, name: string, kind: string, line: number, meta: Record<string, unknown> = {}) => {
    const existing = block.elements.find(element => element.id === id);
    if (existing) return existing;
    const element: DiagramElement = { id, name, kind, members: [], startLine: line, endLine: line, ...(groups.length ? { parentId: groups.at(-1)!.id } : {}), meta: { legacyData: { occurrences: [] } satisfies LegacyData, ...meta } };
    block.elements.push(element); return element;
  };
  const connect = (from: string | undefined, to: string, line: number, label = '', arrow = '-->', arrowSpan?: Span) => {
    if (!from) return;
    const relation: DiagramRelation = { id: `legacy-flow-${line}-${block.relations.length}`, source: from, target: to, label, arrow, startLine: line, endLine: arrowSpan?.endLine ?? line, meta: { legacyArrow: arrowSpan, editable: Boolean(arrowSpan) } };
    if (arrow.startsWith('<')) { relation.source = to; relation.target = from; }
    block.relations.push(relation);
  };
  const endpoint = (statement: Statement, start: number, role: 'source' | 'target', leadingArrow?: Span, source?: string): Endpoint | undefined => {
    const text = statement.text;
    let cursor = skipSpace(text, start), end = cursor, element: DiagramElement, nameSpan: Span | undefined, declaration = false, quoted = false;
    const initial = text.slice(cursor).match(/^\(\*(?:top)?\)/i);
    const bar = text.slice(cursor).match(/^={2,}\s*([^=\r\n]+?)\s*={2,}/);
    if (initial) {
      end += initial[0].length;
      const isStart = role === 'source';
      element = add(isStart ? 'legacy-start' : 'legacy-end', isStart ? 'Start' : 'End', isStart ? 'start' : 'end', statement.line, { editable: false });
    } else if (bar) {
      end += bar[0].length;
      const key = bar[1].trim();
      element = bars.get(key) ?? add(`legacy-bar-${hash(key)}`, key, 'fork', statement.line, { editable: false });
      bars.set(key, element);
    } else if (text[cursor] === '"') {
      const ending = quoteEnd(text, cursor);
      if (ending < 0) { warn(block, statement.line, 'Unclosed quoted activity label.'); return; }
      end = ending; quoted = true; declaration = true;
      const name = unquote(text.slice(cursor, end));
      nameSpan = span(statement, cursor, end);
      const aliasMatch = text.slice(end).match(/^\s+as\s+([\p{L}\p{N}_$][\p{L}\p{N}_.$]*)/u);
      const alias = aliasMatch?.[1];
      if (aliasMatch) end += aliasMatch[0].length;
      element = alias ? aliases.get(alias) ?? add(`legacy:${alias}`, name, 'activity', statement.line) : names.get(name) ?? add(`legacy-action-${hash(name)}`, name, 'activity', statement.line);
      if (alias) { data(element).alias = alias; aliases.set(alias, element); }
      if (!names.has(name)) names.set(name, element);
      // A previously implicit alias gets its display label at the first declaration.
      if (element.implicit) { element.name = name; element.implicit = false; }
    } else {
      const identifier = text.slice(cursor).match(endpointIdentifier)?.[0];
      if (!identifier) return;
      end += identifier.length;
      element = aliases.get(identifier) ?? names.get(identifier) ?? add(`legacy:${identifier}`, identifier, 'activity', statement.line);
      if (!aliases.has(identifier) && !names.has(identifier)) { aliases.set(identifier, element); data(element).alias = identifier; element.implicit = true; }
      if (element.implicit) nameSpan = span(statement, cursor, end);
    }
    const occurrence: Occurrence = { span: span(statement, cursor, end), nameSpan, leadingArrow, declaration, quoted, source };
    data(element).occurrences.push(occurrence);
    element.endLine = Math.max(element.endLine, statement.endLine);
    const decoration = text.slice(end).match(/^\s*(?:<<([^>]+)>>)?\s*(#[\w]+)?/);
    if (decoration?.[1]) element.meta!.stereotype = decoration[1];
    if (decoration?.[2]) element.meta!.color = decoration[2];
    if (decoration && decoration[0].trim()) { end += decoration[0].length; occurrence.span = span(statement, cursor, end); }
    return { element, end, occurrence };
  };
  const openIf = (statement: Statement, cursor: number, from: string | undefined, arrow?: { value: string; label: string; span: Span }) => {
    const prefix = statement.text.slice(cursor).match(/^if\s+/i);
    if (!prefix) return false;
    const start = cursor + prefix[0].length, end = statement.text[start] === '"' ? quoteEnd(statement.text, start) : -1;
    if (end < 0 || !/^\s+then\s*$/i.test(statement.text.slice(end))) { warn(block, statement.line, 'Use a quoted condition followed by then in legacy activities.'); return false; }
    const name = unquote(statement.text.slice(start, end));
    const decision = add(`legacy-decision-${statement.line}`, name, 'decision', statement.line, { legacyData: { control: 'if', occurrences: [{ span: span(statement, cursor, statement.text.trimEnd().length), nameSpan: span(statement, start, end), declaration: true, quoted: true }] } satisfies LegacyData });
    connect(from, decision.id, statement.line, arrow?.label ?? pendingLabel, arrow?.value, arrow?.span);
    frames.push({ head: decision.id, ends: [], branch: false, line: statement.line });
    tail = decision.id; pendingLabel = 'yes'; return true;
  };
  const all = statements(block, absoluteCodeLines);
  for (let index = 0; index < all.length; index++) {
    const statement = all[index];
    let cursor = skipSpace(statement.text, 0), text = statement.text.trim();
    if (!text) continue;
    if (styleDepth) { styleDepth += (text.match(/\{/g)?.length ?? 0) - (text.match(/\}/g)?.length ?? 0); if (text === '</style>') styleDepth = 0; continue; }
    if (/^skinparam\b.*\{|^<style>/i.test(text)) { styleDepth = 1; continue; }
    if (/^(?:title\b|caption\b|header\b|footer\b|skinparam\b|hide\b|show\b|scale\b|left to right direction\b|!|<<)/i.test(text)) continue;
    const partition = statement.text.match(/^\s*partition\s+("(?:\\.|[^"\\])*"|[^#{]+?)\s*(#[\w]+)?\s*\{\s*$/i);
    if (partition) {
      const name = unquote(partition[1].trim()), start = statement.text.indexOf(partition[1]);
      const group = partitions.get(name) ?? add(`legacy-partition-${hash(name)}`, name, 'partition', statement.line, { container: true, color: partition[2] });
      partitions.set(name, group); groups.push(group);
      data(group).occurrences.push({ span: span(statement, 0, statement.text.length), nameSpan: span(statement, start, start + partition[1].length), declaration: true, quoted: partition[1].startsWith('"') }); continue;
    }
    if (text === '}') { const group = groups.pop(); if (group) group.endLine = statement.line; else warn(block, statement.line, 'Unmatched partition close.'); continue; }
    if (/^note\s+(?:left|right|top|bottom)\b/i.test(text)) {
      const colon = statement.text.indexOf(':');
      let name = colon >= 0 ? statement.text.slice(colon + 1).trim() : '', endLine = statement.endLine;
      if (colon < 0) while (++index < all.length && !/^\s*end\s*note\b/i.test(all[index].text)) { name += (name ? '\n' : '') + all[index].text.trim(); endLine = all[index].endLine; }
      if (colon < 0 && index < all.length) endLine = all[index].endLine;
      const note = add(`legacy-note-${statement.line}`, name, 'note', statement.line, { attachTo: tail, legacyNote: true }); note.endLine = endLine;
      if (colon >= 0) data(note).occurrences.push({ span: span(statement, 0, statement.text.length), nameSpan: span(statement, colon + 1, statement.text.trimEnd().length), declaration: true, quoted: false });
      else note.meta!.editable = false;
      continue;
    }
    if (/^else\b/i.test(text)) {
      const frame = frames.at(-1);
      if (!frame) { warn(block, statement.line, 'An else has no matching if.'); continue; }
      if (tail && tail !== frame.head) frame.ends.push(tail);
      frame.branch = true; tail = frame.head; pendingLabel = 'no';
      cursor += statement.text.slice(cursor).match(/^else\s*/i)![0].length;
      text = statement.text.slice(cursor).trim(); if (!text) continue;
    }
    if (/^endif\s*$/i.test(text)) {
      const frame = frames.pop();
      if (!frame) { warn(block, statement.line, 'An endif has no matching if.'); continue; }
      if (tail && tail !== 'legacy-end') frame.ends.push(tail);
      if (!frame.branch) frame.ends.push(frame.head);
      const ends = [...new Set(frame.ends)].filter(id => id !== 'legacy-end');
      if (!ends.length) tail = undefined;
      else if (ends.length === 1 && ends[0] !== frame.head) tail = ends[0];
      else {
        const merge = add(`legacy-merge-${statement.line}`, '', 'merge', statement.line, { editable: false });
        for (const from of ends) connect(from, merge.id, statement.line, from === frame.head ? 'no' : '');
        tail = merge.id;
      }
      pendingLabel = ''; continue;
    }
    if (/^if\s+/i.test(text)) { openIf(statement, cursor, tail); continue; }
    let current: Endpoint | undefined;
    if (!arrowPattern.test(statement.text.slice(cursor))) {
      current = endpoint(statement, cursor, 'source');
      if (!current) { warn(block, statement.line, 'Unrecognized legacy activity statement remains in source.'); continue; }
      tail = current.element.id; cursor = current.end;
    }
    while ((cursor = skipSpace(statement.text, cursor)) < statement.text.length) {
      const arrow = statement.text.slice(cursor).match(arrowPattern)?.[0];
      if (!arrow) { warn(block, statement.line, 'Unrecognized legacy activity suffix remains in source.'); break; }
      const arrowStart = cursor; cursor += arrow.length; const arrowEnd = cursor;
      cursor = skipSpace(statement.text, cursor);
      let label = pendingLabel;
      const labelMatch = statement.text.slice(cursor).match(/^\[([^\]]*)\]/);
      if (labelMatch) { label = labelMatch[1]; cursor += labelMatch[0].length; }
      const arrowSpan = span(statement, arrowStart, labelMatch ? cursor : arrowEnd);
      cursor = skipSpace(statement.text, cursor);
      if (/^if\s+/i.test(statement.text.slice(cursor))) { openIf(statement, cursor, tail, { value: arrow, label, span: arrowSpan }); cursor = statement.text.length; break; }
      const from = tail;
      const target = endpoint(statement, cursor, 'target', arrowSpan, from);
      if (!target) { warn(block, statement.line, 'The legacy arrow has no recognized target.'); break; }
      connect(from, target.element.id, statement.line, label, arrow, arrowSpan);
      tail = target.element.kind === 'end' ? undefined : target.element.id; pendingLabel = ''; cursor = target.end; current = target;
    }
  }
  if (frames.length) warn(block, frames.at(-1)!.line, 'Unclosed legacy if block.');
  if (groups.length) warn(block, groups.at(-1)!.startLine, 'Unclosed legacy partition.');
  for (const bar of bars.values()) {
    const incoming = block.relations.filter(relation => relation.target === bar.id).length, outgoing = block.relations.filter(relation => relation.source === bar.id).length;
    if (incoming > outgoing) bar.kind = 'join';
  }
  block.meta = { ...block.meta, legacy: true, derivedRelations: false };
}

function lineOffsets(source: string) { const offsets = [0]; for (let index = 0; index < source.length; index++) if (source[index] === '\n') offsets.push(index + 1); return offsets; }
function patch(source: string, span: Span, text: string): Patch { const offsets = lineOffsets(source); return { start: offsets[span.startLine] + span.startColumn, end: offsets[span.endLine] + span.endColumn, text }; }
function apply(source: string, patches: Patch[]) {
  let boundary = source.length + 1;
  for (const replacement of patches.sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (replacement.end > boundary) throw new Error('Overlapping activity edits need a source edit.');
    source = source.slice(0, replacement.start) + replacement.text + source.slice(replacement.end); boundary = replacement.start;
  }
  return source;
}
function nameValue(name: string) { const value = name.trim(); if (!value || /[\r\n\u0000]/.test(value)) throw new Error('Use a nonempty single-line activity name.'); return value; }
function legacyRef(element: DiagramElement) {
  if (element.kind === 'start' || element.kind === 'end') return '(*)';
  if (element.kind === 'fork' || element.kind === 'join') return `===${element.name}===`;
  if (element.kind !== 'activity') throw new Error('This generated control node has no explicit source alias.');
  return data(element).alias ?? quote(element.name);
}
function insertEnd(source: string, block: DiagramBlock, text: string): Patch { const offset = lineOffsets(source)[block.endLine], eol = source.includes('\r\n') ? '\r\n' : '\n'; return { start: offset, end: offset, text: text.replace(/\r?\n/g, eol) + eol }; }

/** Edits source tokens and arrows; control structures remain explicitly represented. */
export function editLegacyActivity(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  if (edit.type === 'insertSnippet' || edit.type === 'replaceSource' || edit.type === 'move') return;
  const element = 'elementId' in edit ? block.elements.find(item => item.id === edit.elementId) : undefined;
  if (edit.type === 'rename') {
    if (!element || element.meta?.editable === false) throw new Error('This generated control symbol has no editable name.');
    const name = nameValue(edit.name), legacy = data(element);
    const occurrences = legacy.occurrences.filter(occurrence => occurrence.nameSpan);
    if (!occurrences.length) throw new Error('This element has no inline label to edit.');
    if (element.kind === 'activity' && legacy.alias) {
      const quoted = occurrences.filter(occurrence => occurrence.quoted);
      if (!quoted.length) return apply(source, [patch(source, occurrences[0].span, `${quote(name)} as ${legacy.alias}`)]);
      return apply(source, quoted.map(occurrence => patch(source, occurrence.nameSpan!, quote(name))));
    }
    const collisions = element.kind === 'activity' ? block.elements.filter(other => other.id !== element.id && other.kind === 'activity' && other.name === name) : [];
    if (collisions.length) {
      const used = new Set(block.elements.map(other => data(other).alias));
      const patches: Patch[] = [];
      for (const target of [element, ...collisions]) {
        let alias = data(target).alias;
        if (!alias) { let index = 1; while (used.has(`activity${index}`)) index++; alias = `activity${index}`; used.add(alias); }
        let declared = Boolean(data(target).alias);
        for (const occurrence of data(target).occurrences.filter(item => item.nameSpan)) {
          const labelPatch = patch(source, occurrence.nameSpan!, ''), tokenPatch = patch(source, occurrence.span, '');
          if (declared && /^\s+as\s+/.test(source.slice(labelPatch.end, tokenPatch.end))) continue;
          patches.push({ ...labelPatch, text: declared ? alias : `${quote(target === element ? name : target.name)} as ${alias}` });
          declared = true;
        }
      }
      return apply(source, patches);
    }
    return apply(source, occurrences.map(occurrence => patch(source, occurrence.nameSpan!, element.kind === 'note' ? ` ${name}` : quote(name))));
  }
  if (edit.type === 'addElement') {
    const name = nameValue(edit.name), used = new Set(block.elements.map(item => data(item).alias));
    let index = 1; while ([`activity${index}`, `activity${index}yes`, `activity${index}no`].some(alias => used.has(alias))) index++;
    const alias = `activity${index}`;
    let token = `${quote(name)} as ${alias}`;
    if (edit.kind === 'decision') token = `if ${quote(name)} then\n-->[yes] "Accepted" as ${alias}yes\nelse\n-->[no] "Rejected" as ${alias}no\nendif`;
    else if (edit.kind === 'fork' || edit.kind === 'join') token = `===${alias}===`;
    else if (edit.kind === 'note') return apply(source, [insertEnd(source, block, `note right: ${name}`)]);
    else if (edit.kind !== 'activity' && edit.kind !== 'action') throw new Error('Choose an activity, decision, synchronization bar, or note.');
    const terminal = block.elements.find(item => item.kind === 'end');
    const occurrence = terminal ? data(terminal).occurrences.find(item => item.leadingArrow) : undefined;
    if (occurrence) return apply(source, [patch(source, occurrence.span, `${token}\n--> (*)`.replace(/\n/g, source.includes('\r\n') ? '\r\n' : '\n'))]);
    const tail = [...block.elements].reverse().find(item => item.kind === 'activity' || item.kind === 'start' || item.kind === 'fork' || item.kind === 'join');
    return apply(source, [insertEnd(source, block, `${tail ? legacyRef(tail) + ' --> ' : '(*) --> '}${token}`)]);
  }
  if (edit.type === 'deleteElement') {
    if (!element || element.kind !== 'activity') throw new Error('Delete this control structure in the source panel.');
    const incoming = block.relations.filter(relation => relation.target === element.id);
    if (incoming.length > 1 || incoming.some(relation => relation.source === element.id)) throw new Error('This activity has several incoming paths; remove it in the source panel to choose how those paths reconnect.');
    const predecessor = incoming.length ? block.elements.find(item => item.id === incoming[0].source) : undefined;
    const occurrences = data(element).occurrences;
    const patches: Patch[] = [];
    for (const occurrence of occurrences) {
      if (occurrence.leadingArrow) {
        patches.push(patch(source, { ...occurrence.leadingArrow, endLine: occurrence.span.endLine, endColumn: occurrence.span.endColumn }, ''));
      } else if (predecessor) patches.push(patch(source, occurrence.span, legacyRef(predecessor)));
      else {
        const outgoing = block.relations.find(relation => relation.source === element.id && relation.startLine === occurrence.span.startLine);
        const arrowSpan = outgoing?.meta?.legacyArrow as Span | undefined;
        patches.push(patch(source, arrowSpan ? { ...occurrence.span, endLine: arrowSpan.endLine, endColumn: arrowSpan.endColumn } : occurrence.span, ''));
      }
    }
    return apply(source, patches);
  }
  if (edit.type === 'addRelation') {
    const from = block.elements.find(item => item.id === edit.source), to = block.elements.find(item => item.id === edit.target);
    if (!from || !to) throw new Error('Select two activity elements.');
    if (from.kind === 'end' || to.kind === 'start') throw new Error('A start has outgoing links and an end has incoming links.');
    if (!/^(?:--?>|-(?:left|right|up|down)->)$/.test(edit.arrow)) throw new Error('Legacy activity links use directional arrows.');
    if (/[\]\r\n\u0000]/.test(edit.label)) throw new Error('Use a single-line arrow label without a closing bracket.');
    return apply(source, [insertEnd(source, block, `${legacyRef(from)} ${edit.arrow}${edit.label ? `[${edit.label}]` : ''} ${legacyRef(to)}`)]);
  }
  if (edit.type === 'editRelation' || edit.type === 'deleteRelation') {
    const relation = block.relations.find(item => item.id === edit.relationId), arrowSpan = relation?.meta?.legacyArrow as Span | undefined;
    if (!relation || !arrowSpan) throw new Error('This connection is derived from an if block; edit that control structure in source.');
    if (edit.type === 'deleteRelation') {
      const target = block.elements.find(item => item.id === relation.target)!;
      if (target.kind === 'end' || target.kind === 'decision') throw new Error('Remove this control connection in the source panel.');
      const line = source.split(/\r?\n/)[arrowSpan.startLine];
      return apply(source, [patch(source, arrowSpan, line.slice(0, arrowSpan.startColumn).trim() ? source.includes('\r\n') ? '\r\n' : '\n' : '')]);
    }
    if (!/^(?:--?>|-(?:left|right|up|down)->)$/.test(edit.arrow) || /[\]\r\n\u0000]/.test(edit.label)) throw new Error('Use a directional arrow and a single-line label without a closing bracket.');
    return apply(source, [patch(source, arrowSpan, `${edit.arrow}${edit.label ? `[${edit.label}]` : ''}`)]);
  }
  if (edit.type === 'members') throw new Error('Legacy activities have labels; edit the name directly on the node.');
}
