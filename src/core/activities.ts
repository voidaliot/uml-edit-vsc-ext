import type { DiagramBlock, DiagramElement } from '../shared/protocol';

/** Structured control-flow projection; backward edges are retained, never flattened. */
export function parseActivities(block: DiagramBlock, lines: string[], directive: (line: number, text: string) => boolean): void {
  type Frame = { type: string; head: string; ends: string[]; exitLabel?: string; breaks: string[]; branch?: boolean };
  const frames: Frame[] = [];
  const groups: DiagramElement[] = [];
  let tail: string | undefined, label = '', lane = '', skipStyle = false;
  const lanes = new Map<string, DiagramElement>();
  const edge = (from: string | undefined, to: string, text = '', line = block.startLine) => {
    if (from) block.relations.push({ id: `flow-${line}-${block.relations.length}`, source: from, target: to, label: text, arrow: '-->', startLine: line, endLine: line });
  };
  const add = (name: string, kind: string, line: number, endLine = line, meta: Record<string, unknown> = {}) => {
    let hash = 2166136261; for (const char of `${kind}:${name}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const stem = `activity-${kind}-${(hash >>> 0).toString(36)}`;
    let n = 1; while (block.elements.some(element => element.id === `${stem}-${n}`)) n++;
    const id = `${stem}-${n}`;
    block.elements.push({ id, name, kind, members: [], startLine: line, endLine, ...(groups.length ? { parentId: groups.at(-1)!.id } : {}), meta: { lane, ...meta } });
    edge(tail, id, label, line); tail = id; label = ''; return id;
  };
  const bad = (line: number, text: string) => { block.graphical = false; block.warnings.push(`Line ${line + 1}: Cannot interpret activity statement: ${text}`); };
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const text = lines[line].trim();
    if (skipStyle) { if (text === '</style>' || text === '}') skipStyle = false; continue; }
    if (/^<style>|^skinparam\b.*\{/i.test(text)) { skipStyle = true; block.warnings.push('Source styles are preserved; native theme styling is used.'); continue; }
    if (!text || directive(line, text)) continue;
    const swimlane = text.match(/^\|(?:#[\w]+\|)?([^|]+)\|$/);
    if (swimlane) {
      lane = swimlane[1];
      if (!lanes.has(lane)) { const element: DiagramElement = { id: `lane-${lanes.size}`, name: lane, kind: 'swimlane', members: [], startLine: line, endLine: line, meta: { container: true, lane, editable: false } }; lanes.set(lane, element); }
      continue;
    }
    const group = text.match(/^(?:partition|group|rectangle|package)\s+(?:"([^"]+)"|([^\{]+))\s*\{$/i);
    if (group) { const item: DiagramElement = { id: `partition-${line}`, name: (group[1] ?? group[2]).trim(), kind: 'partition', members: [], startLine: line, endLine: line, ...(groups.length ? { parentId: groups.at(-1)!.id } : {}), meta: { container: true } }; groups.push(item); block.elements.push(item); continue; }
    if (text === '}' || /^end\s+group$/i.test(text)) { const group = groups.pop(); if (group) group.endLine = line; else bad(line, text); continue; }
    if (/^start$/i.test(text)) { add('Start', 'start', line); continue; }
    if (/^(?:stop|end)(?:\s*\([^)]*\))?$/i.test(text)) { add('End', 'end', line); tail = undefined; continue; }
    if (/^(?:kill|detach)$/i.test(text)) { tail = undefined; continue; }
    if (/^break$/i.test(text)) { const loop = [...frames].reverse().find(frame => /while|repeat/.test(frame.type)); if (loop && tail) loop.breaks.push(tail); else if (!loop) bad(line, text); tail = undefined; continue; }
    const actionStart = text.match(/^(?:#\w+:|:|backward\s*:)(.*)$/i);
    if (actionStart) {
      const first = line; let body = actionStart[1];
      while (!/[;|/<>\]\\}]\s*$/.test(body) && line + 1 < block.endLine) body += '\n' + lines[++line].trim();
      const inlineStereotype = body.match(/;\s*<<([\w-]+)>>\s*$/)?.[1];
      if (inlineStereotype) body = body.replace(/\s*<<[\w-]+>>\s*$/, '');
      const ending = body.match(/([;|/<>\]\\}])\s*$/)?.[1];
      if (!ending) { bad(first, 'Unclosed action'); continue; }
      const followingStereotype = !inlineStereotype ? lines[line + 1]?.trim().match(/^<<([\w-]+)>>$/)?.[1] : undefined;
      const stereotype = inlineStereotype ?? followingStereotype;
      const kind = stereotype ? `sdl-${stereotype}` : ending === ';' ? 'activity' : ({ '|': 'sdl-procedure', '/': 'sdl-save', '\\': 'sdl-load', '<': 'sdl-input', '>': 'sdl-output', ']': 'sdl-task', '}': 'sdl-continuous' } as Record<string, string>)[ending] ?? 'activity';
      add(body.slice(0, body.lastIndexOf(ending)).replace(/\\n/g, '\n'), kind, first, line, { terminator: ending, stereotype }); if (followingStereotype) line++; continue;
    }
    const condition = text.match(/^(if|elseif|while|switch)\s*\((.*?)\)\s*(?:(?:then|is|equals)\s*\((.*?)\))?.*$/i);
    if (condition) {
      const type = condition[1].toLowerCase();
      if (type === 'elseif') { const frame = frames.at(-1); if (!frame || frame.type !== 'if') { bad(line, text); continue; } if (tail) frame.ends.push(tail); tail = frame.head; label = 'no'; const id = add(condition[2], 'decision', line); frame.head = id; label = condition[3] ?? 'yes'; continue; }
      const id = add(condition[2], 'decision', line, line, { control: type });
      frames.push({ type, head: id, ends: [], breaks: [], exitLabel: 'no' });
      label = type === 'switch' ? '' : condition[3] ?? 'yes'; continue;
    }
    const branch = text.match(/^(else|case)\s*(?:\((.*)\))?$/i);
    if (branch) { const frame = frames.at(-1); if (!frame || !['if', 'switch'].includes(frame.type)) { bad(line, text); continue; } if (tail && tail !== frame.head) frame.ends.push(tail); tail = frame.head; label = branch[2] ?? 'no'; frame.branch = true; continue; }
    if (/^(endif|endswitch)$/i.test(text)) {
      const frame = frames.pop(); if (!frame || !['if', 'switch'].includes(frame.type)) { bad(line, text); continue; }
      if (tail) frame.ends.push(tail); if (!frame.branch) frame.ends.push(frame.head);
      if (!frame.ends.length) { tail = undefined; continue; }
      tail = undefined; const merge = add('', 'merge', line);
      for (const endpoint of frame.ends) edge(endpoint, merge, endpoint === frame.head ? frame.exitLabel : '', line);
      continue;
    }
    if (/^repeat(?:\s*:.*;)?$/i.test(text)) { const id = add(text.includes(':') ? text.slice(text.indexOf(':') + 1, -1) : '', 'merge', line); frames.push({ type: 'repeat', head: id, ends: [], breaks: [] }); continue; }
    const repeatEnd = text.match(/^repeat\s+while\s*\((.*?)\)(?:\s*is\s*\((.*?)\))?(?:\s*not\s*\((.*?)\))?.*$/i);
    if (repeatEnd) { const frame = frames.pop(); if (!frame || frame.type !== 'repeat') { bad(line, text); continue; } const decision = add(repeatEnd[1], 'decision', line, line, { control: 'repeat while' }); edge(decision, frame.head, repeatEnd[2] ?? 'yes', line); tail = undefined; const exit = add('', 'merge', line); edge(decision, exit, repeatEnd[3] ?? 'no', line); for (const from of frame.breaks) edge(from, exit, 'break', line); continue; }
    const whileEnd = text.match(/^endwhile(?:\s*\((.*?)\))?.*$/i);
    if (whileEnd) { const frame = frames.pop(); if (!frame || frame.type !== 'while') { bad(line, text); continue; } edge(tail, frame.head, '', line); tail = undefined; const exit = add('', 'merge', line); edge(frame.head, exit, whileEnd[1] ?? 'no', line); for (const from of frame.breaks) edge(from, exit, 'break', line); continue; }
    if (/^(fork|split)$/i.test(text)) { const id = add('', text.toLowerCase() === 'fork' ? 'fork' : 'merge', line); frames.push({ type: text.toLowerCase(), head: id, ends: [], breaks: [] }); continue; }
    if (/^(fork again|split again)$/i.test(text)) { const frame = frames.at(-1); if (!frame || !['fork', 'split'].includes(frame.type)) { bad(line, text); continue; } if (tail) frame.ends.push(tail); tail = frame.head; continue; }
    if (/^end\s*(fork|split)(?:\s+\{.*)?$/i.test(text) || /^end\s+merge$/i.test(text)) { const frame = frames.pop(); if (!frame || !['fork', 'split'].includes(frame.type)) { bad(line, text); continue; } if (tail) frame.ends.push(tail); tail = undefined; const id = add('', frame.type === 'fork' ? 'join' : 'merge', line); for (const endpoint of frame.ends) edge(endpoint, id, '', line); continue; }
    const linkLabel = text.match(/^->\s*(.*);$/); if (linkLabel) { label = linkLabel[1]; continue; }
    if (/^note\s/i.test(text)) { const start = line; let name = text.includes(':') ? text.slice(text.indexOf(':') + 1).trim() : ''; if (!name) { while (++line < block.endLine && !/^\s*end\s*note/i.test(lines[line])) name += (name ? '\n' : '') + lines[line].trim(); } block.elements.push({ id: `activity-note-${start}`, name, kind: 'note', members: [], startLine: start, endLine: line, meta: { note: true, attachTo: tail } }); continue; }
    if (/^<<#?\w+>>$/.test(text)) continue;
    bad(line, text);
  }
  if (frames.length || groups.length) bad(block.endLine, 'Unclosed activity control structure');
  block.elements.push(...lanes.values());
  block.meta = { ...block.meta, derivedRelations: true };
}
