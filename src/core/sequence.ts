import type { DiagramBlock, DiagramElement } from '../shared/protocol';
import { parseDeclaration, parseRelation, reference } from './syntax';

/** Content identities survive row insertion and reordering, like hierarchy nodes. */
export function sequenceItemId(kind: string, text: string, occurrence: number): string {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${kind}-${(hash >>> 0).toString(36)}-${occurrence}`;
}

export function sequenceEvents(block: DiagramBlock): { id: string; row: number; startLine: number; endLine: number }[] {
  return [
    ...block.relations.map(relation => ({ ...relation, row: Number(relation.meta?.row ?? 0) })),
    ...block.elements.filter(element => element.kind.startsWith('sequence-')).flatMap(element => [
      { ...element, row: Number(element.meta?.row ?? 0), endLine: element.kind === 'sequence-fragment' ? element.startLine : element.endLine },
      ...(element.kind === 'sequence-fragment' ? [{ id: `${element.id}-end`, row: Number(element.meta?.endRow ?? 0), startLine: element.endLine, endLine: element.endLine }] : []),
    ]),
  ].sort((a, b) => a.row - b.row || a.startLine - b.startLine);
}

export function sequenceInsertionLine(block: DiagramBlock, row: number): number {
  return sequenceEvents(block).find(event => event.row >= row)?.startLine ?? block.endLine;
}

export function moveSequenceEvent(source: string, block: DiagramBlock, eventId: string, row: number): string {
  if (block.kind !== 'sequence' || !Number.isSafeInteger(row) || row < 0 || row > 20000) throw new Error('Choose a valid sequence row.');
  const event = block.relations.find(item => item.id === eventId) ?? block.elements.find(item => item.id === eventId && item.kind === 'sequence-divider');
  if (!event) throw new Error('This message or divider no longer exists.');
  const current = Number(event.meta?.row ?? 0);
  if (row === current) return source;
  const lines = source.split(/\r?\n/), eol = source.includes('\r\n') ? '\r\n' : '\n';
  let end = event.endLine;
  // Explicit activations/destruction immediately following a message belong to
  // that message; moving them together retains their intended association.
  while (end + 1 < block.endLine && /^\s*(?:activate|deactivate|destroy)\s+/i.test(lines[end + 1])) end++;
  let before = sequenceInsertionLine(block, row + (row > current ? 1 : 0));
  const fragment = block.elements.find(element => element.id === event.meta?.fragment);
  if (fragment) before = Math.max(fragment.startLine + 1, Math.min(fragment.endLine, before));
  if (before >= event.startLine && before <= end + 1) return source;
  const moved = lines.splice(event.startLine, end - event.startLine + 1);
  if (before > end) before -= moved.length;
  lines.splice(before, 0, ...moved);
  // An implicit participant's first message normally determines its column.
  // Materialize those declarations so reordering a message keeps lifelines put.
  const implicit = block.elements.filter(element => element.implicit && !element.kind.startsWith('sequence-'));
  if (implicit.length) {
    let lastDeclaration = block.startLine;
    for (let line = block.startLine + 1; line < block.endLine; line++) if (parseDeclaration(lines[line])) lastDeclaration = line;
    lines.splice(lastDeclaration + 1, 0, ...implicit.map(element => `participant ${reference(element.id)}`));
  }
  return lines.join(eol);
}

export function sequenceAnnotations(block: DiagramBlock, lines: string[]) {
  const ignored = new Set<number>(), rows = new Map<number, number>();
  const decorations: DiagramElement[] = [];
  const frames: DiagramElement[] = [];
  const active = new Map<string, { row: number; line: number }[]>();
  const bars = new Map<string, { start: number; end: number }[]>();
  let row = 0;
  const identities = new Map<string, number>();
  const add = (kind: string, name: string, line: number, meta: Record<string, unknown> = {}) => {
    const key = `${kind}\0${name}`, occurrence = (identities.get(key) ?? 0) + 1;
    identities.set(key, occurrence);
    const element: DiagramElement = { id: sequenceItemId(kind, name, occurrence), kind, name, members: [], startLine: line, endLine: line, meta: { row, ...meta } };
    decorations.push(element); return element;
  };
  const activation = (id: string, begin: boolean, line: number) => {
    if (begin) active.set(id, [...(active.get(id) ?? []), { row, line }]);
    else { const start = active.get(id)?.pop(); if (start) bars.set(id, [...(bars.get(id) ?? []), { start: start.row, end: Math.max(start.row + 1, row) }]); }
  };
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const text = lines[line].trim();
    const relation = parseRelation(lines[line]);
    if (relation) { rows.set(line, row); if (/\+\+(?:\s|:|$)/.test(text)) activation(relation.target, true, line); if (/\s--(?:\s|:|$)/.test(text)) activation(relation.source, false, line); row++; continue; }
    const frame = text.match(/^(alt|opt|loop|par|break|critical|group|ref)\b\s*(.*)$/i);
    if (frame) { const item = add('sequence-fragment', frame[2] || frame[1], line, { frameType: frame[1], container: true }); frames.push(item); ignored.add(line); row++; continue; }
    const branch = text.match(/^else\b\s*(.*)$/i);
    if (branch && frames.length) { add('sequence-divider', branch[1] || 'else', line, { fragment: frames.at(-1)!.id }); ignored.add(line); row++; continue; }
    if (/^end$/i.test(text) && frames.length) { const frame = frames.pop()!; frame.endLine = line; frame.meta!.endRow = row; ignored.add(line); row++; continue; }
    const divider = text.match(/^==\s*(.*?)\s*==$/); if (divider) { add('sequence-divider', divider[1], line); ignored.add(line); row++; continue; }
    const delay = text.match(/^\.\.\.\s*(.*?)\s*\.\.\.$|^\|\|\|?\s*(\d+)?\s*$/); if (delay) { add('sequence-delay', delay[1] ?? '', line); ignored.add(line); row++; continue; }
    const note = text.match(/^(?:[hr]?note)\s+(over|left(?:\s+of)?|right(?:\s+of)?)\s*([^:]*?)(?:\s*:\s*(.*))?$/i);
    if (note) {
      const begin = line; let name = note[3] ?? '';
      ignored.add(line);
      if (note[3] === undefined) { while (++line < block.endLine && !/^\s*end\s*[hr]?note/i.test(lines[line])) { ignored.add(line); name += (name ? '\n' : '') + lines[line].trim(); } ignored.add(line); }
      const item = add('sequence-note', name, begin, { participants: note[2].split(',').map(id => id.trim()).filter(Boolean), side: note[1], multiline: note[3] === undefined }); item.endLine = line; row += Math.max(1, Math.ceil(name.split('\n').length / 2)); continue;
    }
    const act = text.match(/^(activate|deactivate|destroy)\s+(\S+)/i);
    if (act) { ignored.add(line); if (act[1].toLowerCase() === 'destroy') add('sequence-destroy', '×', line, { attachTo: act[2], editable: false }); else activation(act[2], act[1].toLowerCase() === 'activate', line); continue; }
    if (/^(?:autoactivate|hide footbox|show footbox|newpage|page|box|end box|skinparam sequenceMessageAlign)\b/i.test(text)) { ignored.add(line); if (/box/i.test(text)) block.warnings.push('Sequence participant boxes are preserved; combined fragments and lifelines remain editable.'); }
  }
  for (const frame of frames) { block.graphical = false; block.warnings.push(`Line ${frame.startLine + 1}: Unclosed sequence ${frame.meta?.frameType} fragment.`); }
  for (const [id, starts] of active) for (const start of starts) bars.set(id, [...(bars.get(id) ?? []), { start: start.row, end: row }]);
  block.meta = { ...block.meta, sequenceRows: row };
  return { ignored, rows, decorations, bars };
}
