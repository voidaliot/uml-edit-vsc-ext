import type { DiagramBlock, DiagramElement, Point } from '../shared/protocol';

function textWidth(text: string, min = 0, max = 240): number {
  const plain = text.replace(/<[^>]*>/g, '').replace(/\\n/g, '\n');
  return Math.max(min, Math.min(max, Math.max(0, ...plain.split('\n').map(line => line.length)) * 6 + 22));
}

/** Compact participant columns, with enough space for message labels, notes and self calls. */
export function layoutSequence(block: DiagramBlock): Record<string, Point> {
  const points: Record<string, Point> = Object.create(null);
  const participants = block.elements.filter(element => !element.kind.startsWith('sequence-'));
  const index = new Map(participants.map((element, position) => [element.id, position]));
  const widths = participants.map(element => textWidth(element.name, 60, 190) + (element.kind === 'database' ? 12 : 0));
  const centers: number[] = [];
  widths.forEach((width, position) => { centers.push(position ? centers[position - 1] + (widths[position - 1] + width) / 2 + 24 : width / 2); });
  const constraints: { from: number; to: number; distance: number }[] = [];
  const constrain = (from: number, to: number, distance: number) => {
    if (from > to) [from, to] = [to, from];
    if (from >= 0 && to < participants.length && from !== to) constraints.push({ from, to, distance });
  };
  let selfExtent = 0;
  for (const relation of block.relations) {
    const source = index.get(relation.source), target = index.get(relation.target);
    if (source === undefined || target === undefined) continue;
    const labelWidth = relation.label ? textWidth(relation.label) + (relation.meta?.number !== undefined ? 18 : 0) : 0;
    if (source !== target) constrain(source, target, labelWidth + 24);
    else if (source < participants.length - 1) constrain(source, source + 1, 85 + labelWidth / 2);
    else selfExtent = Math.max(selfExtent, 85 + labelWidth / 2);
  }
  const notes = block.elements.filter(element => element.kind === 'sequence-note');
  const targets = (note: DiagramElement) => {
    const ids = note.meta?.participants as string[] | undefined;
    const found = (ids ?? []).map(id => index.get(id)).filter((value): value is number => value !== undefined);
    return found.length ? found.sort((a, b) => a - b) : participants.length ? [0] : [];
  };
  for (const note of notes) {
    const ids = targets(note); if (!ids.length) continue;
    const width = textWidth(note.name, 120, Infinity), first = ids[0], last = ids.at(-1)!;
    const side = String(note.meta?.side ?? 'over');
    if (side.startsWith('left') && first > 0) constrain(first - 1, first, width + 28);
    if (side.startsWith('right') && last < participants.length - 1) constrain(last, last + 1, width + 28);
    if (side === 'over' && first !== last) constrain(first, last, Math.max(0, width - 60));
  }
  // Widen the intervening gaps evenly; already satisfied spans need no extra space.
  for (const constraint of constraints) {
    const deficit = constraint.distance - (centers[constraint.to] - centers[constraint.from]);
    if (deficit <= 0) continue;
    for (let position = constraint.from + 1; position < centers.length; position++) centers[position] += deficit * Math.min(position - constraint.from, constraint.to - constraint.from) / (constraint.to - constraint.from);
  }
  let left = 0, right = centers.length ? centers.at(-1)! + Math.max(widths.at(-1)! / 2, selfExtent) : 140;
  for (const note of notes) {
    const ids = targets(note), first = ids[0] ?? 0, last = ids.at(-1) ?? first;
    const side = String(note.meta?.side ?? 'over');
    const width = Math.max(textWidth(note.name, 120, Infinity), side === 'over' && ids.length > 1 ? centers[last] - centers[first] + 60 : 0);
    const x = side.startsWith('left') ? (centers[first] ?? 0) - width - 14 : side.startsWith('right') ? (centers[last] ?? 0) + 14 : ((centers[first] ?? 0) + (centers[last] ?? 0) - width) / 2;
    const lines = note.name.replace(/\\n/g, '\n').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.replace(/<[^>]*>/g, '').length * 6 / (width - 24))), 0);
    note.meta = { ...note.meta, width, height: Math.max(43, 24 + lines * 17) };
    points[note.id] = { x, y: 137 + Number(note.meta.row ?? 0) * 52 };
    left = Math.min(left, x); right = Math.max(right, x + width);
  }
  const shift = 80 - left, sceneWidth = right - left + 40;
  participants.forEach((element, position) => {
    points[element.id] = { x: centers[position] - widths[position] / 2 + shift, y: 70 };
    const rows = Number(block.meta?.sequenceRows ?? block.relations.length);
    const ports = Array.from({ length: rows }, (_, row) => ({ id: `sequence-${row}`, offset: 78 + row * 52 }));
    for (const relation of block.relations.filter(relation => relation.source === element.id && relation.target === element.id)) ports.push({ id: `sequence-return-${relation.meta?.row ?? 0}`, offset: 108 + Number(relation.meta?.row ?? 0) * 52 });
    ports.push({ id: 'sequence-new', offset: rows ? 78 + (rows - .5) * 52 : 78 });
    element.meta = { ...element.meta, width: widths[position], sequencePorts: ports };
  });
  for (const note of notes) points[note.id].x += shift;
  for (const element of block.elements.filter(item => item.kind.startsWith('sequence-') && item.kind !== 'sequence-note')) {
    const row = Number(element.meta?.row ?? 0), y = 137 + row * 52;
    if (element.kind === 'sequence-destroy') {
      const target = index.get(String(element.meta?.attachTo));
      points[element.id] = { x: (centers[target ?? 0] ?? 0) + shift - 10, y };
      element.meta = { ...element.meta, width: 20, height: 20 };
    } else {
      points[element.id] = { x: 60, y };
      element.meta = { ...element.meta, width: sceneWidth, ...(element.kind === 'sequence-divider' ? { height: 28 } : {}), ...(element.kind === 'sequence-fragment' ? { height: Math.max(90, (Number(element.meta?.endRow ?? row + 1) - row + 1) * 52) } : {}) };
    }
  }
  const activationBottom = Math.max(0, ...participants.flatMap(element => {
    const activations = element.meta?.activations as { start: number; end: number }[] | undefined;
    return (activations ?? []).map(bar => 78 + bar.start * 52 + Math.max(22, (bar.end - bar.start) * 52));
  }));
  block.meta = { ...block.meta, sequenceHeight: Math.max(160, 100 + Number(block.meta?.sequenceRows ?? block.relations.length) * 52, activationBottom + 46), sequenceWidth: sceneWidth };
  return points;
}
