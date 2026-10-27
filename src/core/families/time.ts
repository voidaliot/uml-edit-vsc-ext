import type { DiagramBlock, DiagramEdit, DiagramElement, DiagramRelation, DiagramTemplate, Point } from '../../shared/protocol';
import { codeLines, quote, unquote } from '../syntax';
import type { NativeFamily } from './types';

const DAY = 86400000;
const SIGNALS = ['robust', 'concise', 'rectangle', 'binary', 'analog', 'clock'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
interface Span { line: number; start: number; end: number }
interface Patch { start: number; end: number; text: string }
export interface TimeTick { value: number; label: string; x: number }
export interface GanttCalendarData {
  min: number; max: number; unit: number; startX: number; project?: number;
  top: number; bottom: number; height: number; closed: number[];
  resources: { name: string; y: number; loads: { start: number; end: number }[] }[];
}
export interface TimeAxisData { type: 'axis'; ticks: TimeTick[]; width: number; label: string; calendar?: GanttCalendarData }
export interface SignalEvent { time: number; state: string; line: number; color?: string }
export interface TimingSignalData {
  type: 'signal'; signal: string; alias: string; events: SignalEvent[]; states: string[];
  min: number; max: number; width: number; height: number; ticks: TimeTick[];
  period: number; pulse: number; offset: number; messages: { from: number; to: number; label: string; target?: string }[];
}
export interface TimeMessagesData { type: 'messages'; width: number; height: number; lines: { x1: number; y1: number; x2: number; y2: number; label: string; sourceId: string; targetId: string; sourceY: number; targetY: number }[] }
export interface GanttTaskData {
  type: 'task'; alias: string; start: number; end: number; duration: number; complete: number;
  resources: string[]; milestone: boolean; width: number; color?: string; project?: number; rowHeight?: number; labelWidth?: number;
}
export interface ChronologyEventData { type: 'event'; timestamp: number; date: string; above: boolean; width: number; stemToAxis: number }
export type TimeContentData = TimeAxisData | TimingSignalData | GanttTaskData | ChronologyEventData | TimeMessagesData;
interface Signal {
  alias: string; name: string; signal: string; declaration: Span; aliasSpan?: Span; nameSpan: Span;
  events: SignalEvent[]; ownLines: number[]; states: string[]; period: number; pulse: number; offset: number;
  messages: { from: number; to: number; label: string; target?: string }[];
}
interface Task {
  alias: string; name: string; nameSpan: Span; aliasSpan?: Span; declaration: Span; ownLines: number[];
  duration: number; durationSpan?: Span; complete: number; completeSpan?: Span; resources: string[]; resourceSpan?: Span;
  start: number; end: number; explicitStart?: number; explicitEnd?: number; startSpan?: Span; endSpan?: Span;
  milestone: boolean; color?: string; dependency?: Dependency; resolved?: boolean;
}
interface Dependency { source: string; target: string; anchor: 'start' | 'end'; offset: number; span: Span; type: 'constraint' | 'arrow' | 'then'; label: string }
interface GanttModel { tasks: Task[]; dependencies: Dependency[]; project?: number; closed: Set<number>; code: string[] }
interface ChronologyEvent { name: string; alias: string; nameSpan: Span; dateSpan: Span; line: number; timestamp: number; date: string }

const timeTemplates: DiagramTemplate[] = [
  { kind: 'timing', label: 'Timing', description: 'Editable signal waveforms, states, and time axes', palette: ['robust', 'concise', 'binary', 'analog', 'clock', 'rectangle'], source: '@startuml\nrobust "Controller" as controller\nbinary "Ready" as ready\n@0\ncontroller is Idle\nready is 0\n@15\ncontroller is Running\nready is 1\n@45\ncontroller is Complete\nready is 0\n@enduml\n' },
  { kind: 'gantt', label: 'Gantt', description: 'Task bars, milestones, progress, resources, and dependencies', palette: ['task', 'milestone'], source: '@startgantt\nProject starts 2026-01-05\n[Specification] as [spec] requires 4 days\n[Specification] is 75% complete\n[Build] as [build] requires 8 days\n[build] starts at [spec]\'s end\n[Release] as [release] happens at [build]\'s end\n@endgantt\n' },
  { kind: 'chronology', label: 'Chronology', description: 'Events placed on a dated timeline', palette: ['event'], source: '@startchronology\n[Idea proposed] happens on 2026-03-01\n[Prototype reviewed] happens on 2026-03-08\n[First release] happens on 2026-03-21\n@endchronology\n' },
];

function warning(block: DiagramBlock, line: number, message: string) {
  if (block.warnings.length < 12) block.warnings.push(`Line ${line + 1}: ${message}`);
}
function finite(value: number, fallback = 0) { return Number.isFinite(value) ? value : fallback; }
function round(value: number) { return Number(value.toFixed(6)); }
function dateValue(text: string): number | undefined {
  const match = text.trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
  if (!match) return;
  const parts = match.slice(1, 7).map(value => Number(value ?? 0));
  const [year, month, day, hour, minute, second] = parts;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return;
  const value = Date.UTC(year, month - 1, day, hour, minute, second, Number((match[7] ?? '').padEnd(3, '0')));
  const parsed = new Date(value);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return;
  return value;
}
function dateString(value: number, withTime = false) {
  const iso = new Date(value).toISOString();
  return withTime ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 10);
}
function parseTime(text: string, previous: number, anchors: Map<string, number>): number | undefined {
  text = text.trim();
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return text.startsWith('+') ? previous + Number(text) : Number(text);
  const anchor = text.match(/^:([\w$]+)([+-]\d+(?:\.\d+)?)?$/);
  if (anchor && anchors.has(anchor[1])) return anchors.get(anchor[1])! + Number(anchor[2] ?? 0);
  const date = dateValue(text);
  if (date !== undefined) return date / 1000;
  const clock = text.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
}
function ticks(min: number, max: number, width: number, format: (value: number) => string): TimeTick[] {
  const range = Math.max(1e-9, max - min);
  const rough = range / 8;
  const exponent = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find(size => size * exponent >= rough)! * exponent;
  const values = [min];
  for (let value = Math.ceil(min / step) * step; value < max && values.length < 20; value += step) if (value > min + range / 1000) values.push(value);
  values.push(max);
  return values.map(value => ({ value, label: format(value), x: 64 + (value - min) / range * (width - 82) }));
}
function sourceOffsets(source: string) {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1);
  return offsets;
}
function patchSource(source: string, patches: Patch[]) {
  const sorted = patches.sort((a, b) => b.start - a.start || b.end - a.end);
  let boundary = source.length + 1;
  for (const patch of sorted) {
    if (patch.end > boundary || patch.start < 0 || patch.end < patch.start) throw new Error('The source changed; refresh this diagram before editing.');
    source = source.slice(0, patch.start) + patch.text + source.slice(patch.end);
    boundary = patch.start;
  }
  return source;
}
function replaceSpan(source: string, span: Span, text: string): Patch {
  const offset = sourceOffsets(source)[span.line];
  if (offset === undefined) throw new Error('The source location no longer exists.');
  return { start: offset + span.start, end: offset + span.end, text };
}
function insertAtEnd(source: string, block: DiagramBlock, text: string): Patch {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const offset = sourceOffsets(source)[block.endLine];
  return { start: offset, end: offset, text: text.replace(/\r?\n/g, eol).replace(/\r?\n$/, '') + eol };
}
function removeCode(source: string, lines: number[]): Patch[] {
  const raw = source.split(/\r?\n/), clean = codeLines(source);
  return [...new Set(lines)].map(line => {
    // Keep every character masked by the comment lexer, including block-comment delimiters.
    const text = raw[line].split('').filter((char, index) => clean[line][index] === ' ' || /\s/.test(char)).join('');
    return replaceSpan(source, { line, start: 0, end: raw[line].length }, text);
  });
}
function textName(text: string, bracket = false) {
  const value = text.trim();
  if (!value || /[\r\n\u0000]/.test(value) || (bracket && /[\[\]]|(?:^|\s)'|\/'/.test(value))) throw new Error('Use a nonempty single-line name' + (bracket ? ' without square brackets or comment delimiters.' : '.'));
  return value;
}
function nextAlias(existing: string[], base: string) {
  const used = new Set(existing); let index = 1;
  while (used.has(`${base}${index}`)) index++;
  return `${base}${index}`;
}
function axis(block: DiagramBlock, family: string, width: number, axisTicks: TimeTick[], y = 0) {
  block.elements.unshift({ id: `${family}:axis`, name: '', kind: `${family}-axis`, members: [], startLine: block.startLine, endLine: block.startLine,
    meta: { editable: false, positionLocked: true, width, height: 46, x: 0, y, time: { type: 'axis', ticks: axisTicks, width, label: family === 'gantt' ? 'Schedule' : 'Time' } satisfies TimeAxisData } });
}

function timingModel(block: DiagramBlock, lines: string[]) {
  const code = codeLines(lines.join('\n'));
  const signals: Signal[] = [], aliases = new Map<string, Signal>();
  const anchors = new Map<string, number>();
  const times: number[] = [0];
  let current = 0, participant: Signal | undefined;
  const participantTimes = new Map<string, number>();
  const unresolvedMessages: { source: string; target: string; from: number; to: number; label: string; line: number }[] = [];
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const text = code[line].trim();
    if (!text) continue;
    const declaration = code[line].match(/^\s*(robust|concise|rectangle|binary|analog|clock)\s+("(?:\\.|[^"\\])*"|[\w.$]+)(?:\s+as\s+([\w.$]+))?/i);
    if (declaration) {
      const [, kind, name, alias] = declaration;
      const id = alias ?? unquote(name);
      if (aliases.has(id)) { warning(block, line, `Duplicate signal '${id}' is left in source.`); continue; }
      const nameStart = code[line].indexOf(name, declaration[0].indexOf(kind) + kind.length);
      const span = { line, start: nameStart, end: nameStart + name.length };
      const period = Number(text.match(/\bperiod\s+([\d.]+)/i)?.[1] ?? 10);
      const pulse = Number(text.match(/\bpulse\s+([\d.]+)/i)?.[1] ?? period / 2);
      const offset = Number(text.match(/\boffset\s+([+-]?[\d.]+)/i)?.[1] ?? 0);
      const signal: Signal = { alias: id, name: unquote(name), signal: kind.toLowerCase(), declaration: { line, start: 0, end: code[line].trimEnd().length }, nameSpan: span,
        aliasSpan: alias ? { line, start: declaration[0].lastIndexOf(alias), end: declaration[0].lastIndexOf(alias) + alias.length } : undefined,
        events: [], ownLines: [line], states: [], period: Math.max(0.001, finite(period, 10)), pulse: Math.max(0, finite(pulse, 5)), offset: finite(offset), messages: [] };
      signals.push(signal); aliases.set(id, signal); continue;
    }
    const marker = text.match(/^@(.+?)(?:\s+as\s+:([\w$]+))?$/);
    if (marker && !/<[-=]+>/.test(text)) {
      const selected = aliases.get(marker[1]);
      if (selected) { participant = selected; selected.ownLines.push(line); continue; }
      const value = parseTime(marker[1], current, anchors);
      if (value !== undefined) { current = value; participant = undefined; times.push(value); if (marker[2]) anchors.set(marker[2], value); }
      else warning(block, line, 'Unresolved timing marker remains in source.');
      continue;
    }
    const named = text.match(/^([\w.$]+)\s+is\s+(.+)$/i);
    const local = participant && text.match(/^(.+?)\s+is\s+(.+)$/i);
    if (named && aliases.has(named[1]) || local) {
      const signal = named && aliases.has(named[1]) ? aliases.get(named[1])! : participant!;
      const stateText = named && aliases.has(named[1]) ? named[2] : local![2];
      const value = named && aliases.has(named[1]) ? current : parseTime(local![1], participantTimes.get(signal.alias) ?? 0, anchors);
      if (value === undefined) { warning(block, line, 'Unresolved signal time remains in source.'); continue; }
      const color = stateText.match(/\s+(#[\w]+)\s*$/)?.[1];
      const state = unquote(stateText.replace(/\s+#[\w]+\s*$/, '').trim());
      signal.events.push({ time: value, state, line, color }); signal.ownLines.push(line); times.push(value); participantTimes.set(signal.alias, value); continue;
    }
    const has = text.match(/^([\w.$]+)\s+has\s+(.+)$/i);
    if (has && aliases.has(has[1])) { aliases.get(has[1])!.states = has[2].split(',').map(state => unquote(state.trim())); aliases.get(has[1])!.ownLines.push(line); continue; }
    const message = text.match(/^([\w.$]+)(?:@([^\s]+))?\s*[-=]+>\s*([\w.$]+)(?:@([^\s]+))?\s*:\s*(.*)$/);
    if (message) {
      const from = message[2] ? parseTime(message[2], current, anchors) : current;
      const to = message[4] ? parseTime(message[4], current, anchors) : current;
      if (from !== undefined && to !== undefined) unresolvedMessages.push({ source: message[1], target: message[3], from, to, label: message[5], line });
      continue;
    }
    const constraint = text.match(/^@?([^\s]+)\s*<[-=]+>\s*@?([^\s]+)\s*:\s*(.*)$/);
    if (constraint) {
      const from = parseTime(constraint[1], current, anchors), to = from === undefined ? undefined : parseTime(constraint[2], from, anchors);
      if (from !== undefined && to !== undefined) { (participant ?? signals.at(-1))?.messages.push({ from, to, label: constraint[3] }); times.push(from, to); }
      continue;
    }
    if (!/^(?:title\b|caption\b|header\b|footer\b|skinparam\b|hide\b|show\b|scale\b|highlight\b|note\b|end note\b|[{}]|!pragma\b)/i.test(text)) warning(block, line, 'This timing directive is retained in source but has no native annotation yet.');
  }
  for (const message of unresolvedMessages) {
    const source = aliases.get(message.source), target = aliases.get(message.target);
    if (source && target) {
      source.messages.push({ from: message.from, to: message.to, label: message.label, target: target.alias });
      times.push(message.from, message.to);
    } else warning(block, message.line, 'A timing message references an unknown signal.');
  }
  if (signals.some(signal => signal.events.some(event => Math.abs(event.time) > 1e8))) times.splice(times.indexOf(0), 1);
  let min = Math.min(...times), max = Math.max(...times);
  if (max <= min) max = min + Math.max(10, ...signals.filter(signal => signal.signal === 'clock').map(signal => signal.period * 8));
  else {
    // The final state needs a readable segment after the last event, just like the earlier states.
    const finalLabel = Math.max(0, ...signals.filter(signal => signal.signal === 'concise' || signal.signal === 'rectangle').map(signal => (signal.events.slice().sort((a, b) => a.time - b.time).at(-1)?.state.length ?? 0) * 7 + 24));
    const labelSpace = Math.min(220, Math.max(60, finalLabel));
    const endStep = 10 ** Math.floor(Math.log10((max - min) / 8));
    max = round(Math.ceil((max + Math.max((max - min) * 0.08, (max - min) * labelSpace / (678 - labelSpace))) / endStep) * endStep);
  }
  const scale = code.slice(block.startLine, block.endLine).join('\n').match(/\bscale\s+([\d.]+)\s+as\s+([\d.]+)\s+pixels/i);
  const width = scale ? Math.max(400, Math.min(3000, (max - min) / Number(scale[1]) * Number(scale[2]) + 82)) : 760;
  return { signals, min, max, width, code };
}

function parseTiming(block: DiagramBlock, lines: string[]) {
  const model = timingModel(block, lines);
  block.meta = { ...block.meta, derivedRelations: true };
  const axisTicks = ticks(model.min, model.max, model.width, value => Math.abs(value) > 1e8 ? dateString(value * 1000, true) : String(round(value)));
  let y = 62;
  for (const signal of model.signals) {
    signal.events.sort((a, b) => a.time - b.time || a.line - b.line);
    const states = [...new Set([...signal.states, ...signal.events.map(event => event.state)])];
    const constraints = signal.messages.filter(message => !message.target);
    const height = (signal.signal === 'robust' ? Math.max(100, Math.min(240, states.length * 28 + 38)) : 106) + Math.max(0, constraints.length - 1) * 22;
    const time: TimingSignalData = { type: 'signal', signal: signal.signal, alias: signal.alias, events: signal.events, states,
      min: model.min, max: model.max, width: model.width, height, ticks: axisTicks, period: signal.period, pulse: signal.pulse, offset: signal.offset, messages: constraints };
    block.elements.push({ id: `timing:${signal.alias}`, name: signal.name, kind: `timing-${signal.signal}`, members: signal.signal === 'clock' ? [`period: ${signal.period}`, `pulse: ${signal.pulse}`, `offset: ${signal.offset}`] : signal.events.map(event => `${round(event.time)} is ${event.state}`),
      startLine: signal.declaration.line, endLine: Math.max(...signal.ownLines), meta: { width: model.width, height: height + 38, x: 0, y, editMembers: true, lockX: true, time } });
    y += height + 58;
  }
  const messages: TimeMessagesData['lines'] = [];
  const x = (value: number) => 64 + (value - model.min) / (model.max - model.min) * (model.width - 82);
  for (const signal of model.signals) for (const message of signal.messages.filter(message => message.target)) {
    const source = block.elements.find(element => element.id === `timing:${signal.alias}`)!;
    const target = block.elements.find(element => element.id === `timing:${message.target}`)!;
    if (target) messages.push({ x1: x(message.from), y1: Number(source.meta!.y) + Number(source.meta!.height) / 2, x2: x(message.to), y2: Number(target.meta!.y) + Number(target.meta!.height) / 2, label: message.label, sourceId: source.id, targetId: target.id, sourceY: Number(source.meta!.y), targetY: Number(target.meta!.y) });
  }
  if (messages.length) block.elements.push({ id: 'timing:messages', name: '', kind: 'timing-messages', members: [], startLine: block.startLine, endLine: block.startLine,
    meta: { editable: false, hideHeader: true, positionLocked: true, width: model.width, height: y, x: 0, y: 0, time: { type: 'messages', width: model.width, height: y, lines: messages } satisfies TimeMessagesData } });
  axis(block, 'timing', model.width, axisTicks);
}

function durationDays(value: string, closed: Set<number>) {
  const chunks = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(day|week)s?/gi)];
  return chunks.reduce((total, match) => total + Number(match[1]) * (match[2].toLowerCase() === 'week' ? Math.max(1, 7 - closed.size) : 1), 0);
}
function workingEnd(start: number, duration: number, project: number | undefined, closed: Set<number>) {
  if (!project || !closed.size) return start + duration;
  let cursor = start, remaining = duration;
  for (let guard = 0; remaining > 0 && guard < 100000; guard++, cursor++) {
    const weekday = new Date(project + Math.floor(cursor) * DAY).getUTCDay();
    if (!closed.has(weekday)) remaining -= Math.min(1, remaining);
  }
  return cursor;
}
function taskDate(text: string, project: number | undefined): number | undefined {
  const relative = text.match(/^D\s*\+\s*(\d+(?:\.\d+)?)$/i);
  if (relative) return Number(relative[1]);
  const date = dateValue(text);
  if (date !== undefined && project !== undefined) return (date - project) / DAY;
}
function ganttModel(block: DiagramBlock, lines: string[]): GanttModel {
  const code = codeLines(lines.join('\n')), tasks: Task[] = [], dependencies: Dependency[] = [], aliases = new Map<string, Task>(), closed = new Set<number>();
  const content = code.slice(block.startLine + 1, block.endLine).join('\n');
  let project = dateValue(content.match(/\bProject\s+starts\s+(\d{4}-\d{2}-\d{2})/i)?.[1] ?? '');
  if (project === undefined) {
    const dates = [...content.matchAll(/\b(?:starts|ends|happens on)\s+(?:at\s+)?(\d{4}-\d{2}-\d{2})/gi)].map(match => dateValue(match[1])!).filter(value => value !== undefined);
    if (dates.length) project = Math.min(...dates);
  }
  for (const match of content.matchAll(/^\s*(\w+)s?\s+are\s+closed\s*$/gim)) {
    const day = WEEKDAYS.indexOf(match[1].toLowerCase().replace(/s$/, ''));
    if (day >= 0) closed.add(day);
  }
  let previous: Task | undefined;
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const raw = code[line], text = raw.trim();
    if (!text) continue;
    const arrow = raw.match(/^\s*\[([^\]]+)\]\s*(-+>|<+-+)\s*\[([^\]]+)\](?:\s*:\s*(.*))?\s*$/);
    if (arrow) {
      dependencies.push({ source: arrow[2].startsWith('<') ? arrow[3] : arrow[1], target: arrow[2].startsWith('<') ? arrow[1] : arrow[3], anchor: 'end', offset: 0, span: { line, start: 0, end: raw.trimEnd().length }, type: 'arrow', label: arrow[4] ?? '' }); continue;
    }
    const owner = raw.match(/^(\s*)(then\s+)?\[([^\]]+)\](?:\s+as\s+\[([^\]]+)\])?/i);
    if (!owner) {
      if (!/^(?:Project\b|printscale\b|\w+s? are (?:closed|open)\b|\d{4}-\d{2}-\d{2}\b|title\b|caption\b|header\b|footer\b|skinparam\b|hide\b|show\b|--|[{}]|!pragma\b)/i.test(text)) warning(block, line, 'This schedule directive is retained in source but has no native annotation yet.');
      continue;
    }
    const name = owner[3], id = owner[4] ?? name;
    let task = aliases.get(id);
    if (!task) {
      const nameStart = raw.indexOf('[') + 1;
      const aliasStart = owner[4] ? raw.indexOf('[', nameStart + name.length) + 1 : undefined;
      task = { alias: id, name, nameSpan: { line, start: nameStart, end: nameStart + name.length }, aliasSpan: aliasStart !== undefined ? { line, start: aliasStart, end: aliasStart + id.length } : undefined,
        declaration: { line, start: 0, end: raw.trimEnd().length }, ownLines: [], duration: 1, complete: 0, resources: [], start: 0, end: 1, milestone: false };
      tasks.push(task); aliases.set(id, task); if (!aliases.has(name)) aliases.set(name, task);
      if (owner[2] && previous) {
        const dependency: Dependency = { source: previous.alias, target: task.alias, anchor: 'end', offset: 0, span: { line, start: owner[1].length, end: owner[1].length + owner[2].length }, type: 'then', label: '' };
        task.dependency = dependency; dependencies.push(dependency);
      }
      previous = task;
    }
    task.ownLines.push(line);
    const rest = raw.slice(owner[0].length);
    const duration = rest.match(/\b(?:lasts|requires)\s+((?:\d+(?:\.\d+)?\s*(?:day|week)s?)(?:\s+and\s+\d+(?:\.\d+)?\s*(?:day|week)s?)*)/i);
    if (duration) { task.duration = Math.max(0, Math.min(100000, durationDays(duration[1], closed))); task.durationSpan = { line, start: owner[0].length + duration.index! + duration[0].indexOf(duration[1]), end: owner[0].length + duration.index! + duration[0].length }; }
    const completion = rest.match(/\bis\s+(\d+(?:\.\d+)?)%\s+complete(?:d)?/i);
    if (completion) { task.complete = Math.max(0, Math.min(100, Number(completion[1]))); task.completeSpan = { line, start: owner[0].length + completion.index! + completion[0].indexOf(completion[1]), end: owner[0].length + completion.index! + completion[0].indexOf(completion[1]) + completion[1].length }; }
    const resource = rest.match(/\bon\s+((?:\{[^}]+\}\s*(?:and\s*)?)+)/i);
    if (resource) { task.resources = [...resource[1].matchAll(/\{([^}]+)\}/g)].map(match => match[1]); task.resourceSpan = { line, start: owner[0].length + resource.index!, end: owner[0].length + resource.index! + resource[0].length }; }
    const relation = rest.match(/\b(starts|ends|happens)\s+(?:at\s+)?\[([^\]]+)\]'s\s+(start|end)(?:\s*([+-])\s*(\d+)\s*days?)?/i);
    if (relation) {
      const dependency: Dependency = { source: relation[2], target: task.alias, anchor: relation[3].toLowerCase() as 'start' | 'end', offset: Number(relation[5] ?? 0) * (relation[4] === '-' ? -1 : 1), span: { line, start: owner[0].length + relation.index!, end: owner[0].length + relation.index! + relation[0].length }, type: 'constraint', label: relation[3].toLowerCase() === 'start' ? 'start' : '' };
      if (relation[1].toLowerCase() === 'ends') dependency.label = `end at ${dependency.anchor}`;
      task.dependency = dependency; dependencies.push(dependency);
      if (relation[1].toLowerCase() === 'happens') task.milestone = true;
    }
    const date = rest.match(/\b(starts|ends|happens)\s+(?:(?:at|on)\s+)?(D\s*\+\s*\d+(?:\.\d+)?|\d{4}-\d{2}-\d{2})/i);
    if (date) {
      const value = taskDate(date[2], project);
      const span = { line, start: owner[0].length + date.index! + date[0].indexOf(date[2]), end: owner[0].length + date.index! + date[0].length };
      if (date[1].toLowerCase() === 'ends') { task.explicitEnd = value === undefined ? undefined : value + 1; task.endSpan = span; }
      else { task.explicitStart = value; task.startSpan = span; if (date[1].toLowerCase() === 'happens') task.milestone = true; }
    }
    const color = rest.match(/\bis\s+colored\s+in\s+([#\w]+)/i);
    if (color) task.color = color[1];
    if (!duration && !completion && !resource && !relation && !date && !color && !/\blinks\s+to\b|\bdisplays\s+on\s+same\s+row\b/i.test(rest) && rest.trim()) warning(block, line, 'This task directive is retained in source but has no native annotation yet.');
  }
  const resolve = (task: Task, visiting: Set<string>) => {
    if (task.resolved) return;
    if (visiting.has(task.alias)) { warning(block, task.declaration.line, 'Cyclic schedule dependencies cannot determine a start date.'); return; }
    visiting.add(task.alias);
    task.start = task.explicitStart ?? 0;
    const dependency = task.dependency;
    if (dependency) {
      const predecessor = aliases.get(dependency.source);
      if (predecessor) {
        dependency.source = predecessor.alias;
        resolve(predecessor, visiting);
        const anchor = (dependency.anchor === 'start' ? predecessor.start : predecessor.end) + dependency.offset;
        task.start = dependency.label.startsWith('end at') ? anchor - task.duration : anchor;
      } else warning(block, dependency.span.line, `Unknown predecessor '${dependency.source}'.`);
    }
    task.end = task.milestone ? task.start : task.explicitEnd ?? workingEnd(task.start, task.duration, project, closed);
    if (task.explicitEnd !== undefined && task.explicitStart === undefined && !dependency) task.start = task.end - task.duration;
    if (task.end < task.start) { warning(block, task.declaration.line, 'Task end precedes its start.'); task.end = task.start; }
    if (task.explicitEnd !== undefined) task.duration = Math.max(0, task.end - task.start);
    task.resolved = true; visiting.delete(task.alias);
  };
  tasks.forEach(task => resolve(task, new Set()));
  for (const dependency of dependencies) { dependency.source = aliases.get(dependency.source)?.alias ?? dependency.source; dependency.target = aliases.get(dependency.target)?.alias ?? dependency.target; }
  return { tasks, dependencies, project, closed, code };
}

function parseGantt(block: DiagramBlock, lines: string[]) {
  const model = ganttModel(block, lines);
  const min = Math.floor(Math.min(0, ...model.tasks.map(task => task.start))), max = Math.ceil(Math.max(1, ...model.tasks.map(task => task.end)));
  const unit = 16, startX = 12, width = startX + (max - min) * unit + 12;
  const top = model.project === undefined ? 20 : 46;
  let y = top + 2;
  for (let index = 0; index < model.tasks.length; index++) {
    const task = model.tasks[index];
    const name = task.name.replace(/\\n/g, '\n'), labelWidth = Math.max(...name.split('\n').map(line => Array.from(line).length * 6.5)) + 8;
    const rowHeight = Math.max(22, name.split('\n').length * 13 + 6);
    const actualWidth = task.milestone ? 14 : Math.max(4, (task.end - task.start) * unit);
    const time: GanttTaskData = { type: 'task', alias: task.alias, start: task.start, end: task.end, duration: task.duration, complete: task.complete, resources: task.resources, milestone: task.milestone, width: Math.max(actualWidth, labelWidth + (task.milestone ? 18 : 0) + (task.resources.length ? task.resources.join(', ').length * 6.5 + 20 : 0)), color: task.color, project: model.project, rowHeight, labelWidth };
    block.elements.push({ id: `gantt:${task.alias}`, name: task.name.replace(/\\n/g, '\n'), kind: task.milestone ? 'gantt-milestone' : 'gantt-task', startLine: task.declaration.line, endLine: Math.max(...task.ownLines),
      members: [...(task.milestone ? [] : [`duration: ${task.duration} days`, `complete: ${task.complete}%`]), `start: ${task.dependency ? `after [${task.dependency.source}] ${task.dependency.anchor}${task.dependency.offset ? ` ${task.dependency.offset > 0 ? '+' : ''}${task.dependency.offset} days` : ''}` : model.project === undefined ? `D+${task.start}` : dateString(model.project + task.start * DAY)}`, ...(task.resources.length ? [`resources: ${task.resources.join(', ')}`] : [])],
      meta: { width: time.width, height: rowHeight, x: startX + (task.start - min) * unit, y, editMembers: true, moveEdit: true, timeScale: unit, time, barWidth: actualWidth, connectionWidth: actualWidth } });
    y += rowHeight + 2;
  }
  for (const [index, dependency] of model.dependencies.entries()) {
    if (!model.tasks.some(task => task.alias === dependency.source) || !model.tasks.some(task => task.alias === dependency.target)) continue;
    block.relations.push({ id: `gantt:dependency:${index + 1}`, source: `gantt:${dependency.source}`, target: `gantt:${dependency.target}`, arrow: '-->', label: dependency.type === 'arrow' ? dependency.label : [dependency.label, dependency.offset ? `${dependency.offset > 0 ? '+' : ''}${dependency.offset} days` : ''].filter(Boolean).join(' '), startLine: dependency.span.line, endLine: dependency.span.line, meta: { dependency, ganttDependency: true, sourceHandle: dependency.anchor === 'start' ? 'left' : 'right', targetHandle: 'left' } });
  }
  const axisTicks = ticks(min, max, width, value => model.project === undefined ? `D+${round(value)}` : dateString(model.project + value * DAY));
  // Tick x values use the same fixed day scale as bars.
  axisTicks.forEach(tick => tick.x = startX + (tick.value - min) * unit);
  const resources = [...new Set(model.tasks.flatMap(task => task.resources))].map((name, index) => ({ name, y: y + index * 36 + 4, loads: model.tasks.filter(task => task.resources.includes(name) && !task.milestone).map(task => ({ start: task.start, end: task.end })) }));
  const bottom = y + resources.length * 36 + (resources.length ? 4 : 0);
  const calendar: GanttCalendarData = { min, max, unit, startX, project: model.project, top, bottom, height: bottom + top, closed: [...model.closed], resources };
  axis(block, 'gantt', width, axisTicks);
  const scheduleAxis = block.elements[0];
  scheduleAxis.meta = { ...scheduleAxis.meta, height: calendar.height, time: { type: 'axis', ticks: axisTicks, width, label: 'Schedule', calendar } satisfies TimeAxisData };
}

function chronologyModel(block: DiagramBlock, lines: string[]) {
  const code = codeLines(lines.join('\n')), events: ChronologyEvent[] = [];
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const match = code[line].match(/^\s*\[([^\]]+)\]\s+happens\s+on\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)\s*$/i);
    if (match) {
      const timestamp = dateValue(match[2]);
      if (timestamp === undefined) { warning(block, line, 'Invalid chronology date remains in source.'); continue; }
      const nameStart = code[line].indexOf('[') + 1, dateStart = code[line].indexOf(match[2], nameStart + match[1].length);
      const alias = events.some(event => event.name === match[1]) ? `${match[1]}:${line}` : match[1];
      events.push({ name: match[1], alias, nameSpan: { line, start: nameStart, end: nameStart + match[1].length }, dateSpan: { line, start: dateStart, end: dateStart + match[2].length }, line, timestamp, date: match[2] });
    } else if (code[line].trim() && !/^\s*(?:title\b|caption\b|header\b|footer\b|skinparam\b|printscale\b|[{}])/i.test(code[line])) warning(block, line, 'This chronology directive is retained in source but has no native annotation yet.');
  }
  return events;
}
function parseChronology(block: DiagramBlock, lines: string[]) {
  const events = chronologyModel(block, lines), times = events.map(event => event.timestamp);
  const min = times.length ? Math.min(...times) : Date.UTC(2026, 0, 1), last = times.length ? Math.max(...times) : min, max = last > min ? last : min + DAY, width = Math.max(760, Math.min(2400, events.length * 160));
  block.meta = { ...block.meta, derivedRelations: true };
  const short = max - min < DAY * 2;
  const axisTicks = ticks(min, max, width, value => dateString(value, short));
  const occupied: number[] = [];
  for (const event of events.sort((a, b) => a.timestamp - b.timestamp || a.line - b.line)) {
    const x = 64 + (event.timestamp - min) / (max - min) * (width - 82);
    let row = 0; while (occupied[row] !== undefined && occupied[row] + 180 > x) row++;
    occupied[row] = x;
    const time: ChronologyEventData = { type: 'event', timestamp: event.timestamp, date: event.date, above: row % 2 === 0, width: 170, stemToAxis: -(72 + row * 116 + 30 - 10) };
    block.elements.push({ id: `chronology:${event.alias}`, name: event.name.replace(/\\n/g, '\n'), kind: 'chronology-event', members: [`date: ${event.date}`], startLine: event.line, endLine: event.line, meta: { width: 170, height: 94, x, y: 72 + row * 116, editMembers: true, moveEdit: true, timeScale: (width - 82) / (max - min), time } });
  }
  axis(block, 'chronology', width + 170, axisTicks);
}

function editTiming(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  const model = timingModel({ ...block, warnings: [] }, source.split(/\r?\n/));
  const signal = 'elementId' in edit ? model.signals.find(item => `timing:${item.alias}` === edit.elementId) : undefined;
  if (edit.type === 'rename') {
    if (!signal) throw new Error('Select a signal to rename.');
    const name = textName(edit.name);
    return patchSource(source, [replaceSpan(source, signal.nameSpan, quote(name) + (signal.aliasSpan ? '' : ` as ${signal.alias}`))]);
  }
  if (edit.type === 'members') {
    if (!signal) throw new Error('Select a signal to edit.');
    if (signal.signal === 'clock') {
      const values = new Map(edit.members.map(member => { const match = member.match(/^(period|pulse|offset)\s*:\s*([+-]?\d+(?:\.\d+)?)$/i); if (!match) throw new Error('Use period: number, pulse: number, and offset: number.'); return [match[1].toLowerCase(), Number(match[2])] as const; }));
      const period = values.get('period') ?? signal.period, pulse = values.get('pulse') ?? signal.pulse, offset = values.get('offset') ?? signal.offset;
      if (period <= 0 || pulse < 0 || pulse > period || period > 1e9 || Math.abs(offset) > 1e12) throw new Error('Clock period must be positive and pulse must be between zero and the period.');
      const raw = source.split(/\r?\n/)[signal.declaration.line], clean = model.code[signal.declaration.line].trimEnd();
      const end = signal.aliasSpan?.end ?? signal.nameSpan.end;
      const remainder = clean.slice(end).replace(/\s+with\s+period\s+[\d.]+(?:\s+pulse\s+[\d.]+)?(?:\s+offset\s+[+-]?[\d.]+)?/i, '');
      return patchSource(source, [replaceSpan(source, { line: signal.declaration.line, start: end, end: clean.length }, ` with period ${period} pulse ${pulse} offset ${offset}${remainder}`)]);
    }
    let previous = 0;
    const events = edit.members.map(member => {
      const match = member.match(/^([+-]?\d+(?:\.\d+)?)\s+is\s+(.+)$/i);
      if (!match || /[\r\n\u0000]/.test(member)) throw new Error('Enter one state per line as “0 is Idle” or “+10 is Active”.');
      const time = parseTime(match[1], previous, new Map())!; previous = time;
      const state = match[2].trim();
      if (!state || Math.abs(time) > 1e12 || /(?:^|\s)'|\/'/.test(state)) throw new Error('Use a state name without source comments.');
      return `${round(time)} is ${state}`;
    });
    const patches = removeCode(source, signal.events.map(event => event.line));
    if (events.length) patches.push(insertAtEnd(source, block, `@${signal.alias}\n${events.join('\n')}`));
    return patchSource(source, patches);
  }
  if (edit.type === 'addElement') {
    const kind = edit.kind.replace(/^timing-/, '').toLowerCase();
    if (!SIGNALS.includes(kind)) throw new Error('Choose a timing signal type.');
    const alias = nextAlias(model.signals.map(item => item.alias), 'signal');
    const declaration = `${kind} ${quote(textName(edit.name))} as ${alias}`;
    const text = kind === 'clock' ? `${declaration} with period 10 pulse 5 offset 0` : `${declaration}\n@${alias}\n0 is ${kind === 'binary' || kind === 'analog' ? '0' : 'Idle'}\n10 is ${kind === 'binary' || kind === 'analog' ? '1' : 'Active'}`;
    return patchSource(source, [insertAtEnd(source, block, text)]);
  }
  if (edit.type === 'deleteElement') {
    if (!signal) throw new Error('The time axis is generated from signal data.');
    const refs = model.code.map((line, index) => ({ line, index })).filter(item => new RegExp(`^\\s*${escapeRegex(signal.alias)}(?:@[^\\s]+)?\\s*[-=]+>|[-=]+>\\s*${escapeRegex(signal.alias)}(?:@|\\s|:)`).test(item.line) && item.index > block.startLine && item.index < block.endLine).map(item => item.index);
    return patchSource(source, removeCode(source, [...signal.ownLines, ...refs]));
  }
  if (['addRelation', 'editRelation', 'deleteRelation'].includes(edit.type)) throw new Error('Timing messages use timestamped source statements; edit them in the source panel.');
}
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function editGantt(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  const model = ganttModel({ ...block, warnings: [] }, source.split(/\r?\n/));
  const task = 'elementId' in edit ? model.tasks.find(item => `gantt:${item.alias}` === edit.elementId) : undefined;
  const byId = (id: string) => model.tasks.find(item => `gantt:${item.alias}` === id);
  if (edit.type === 'move') {
    if (!task) throw new Error('Select a task or milestone to move.');
    const element = block.elements.find(element => element.id === edit.elementId)!;
    let days = Math.round((edit.position.x - Number(element.meta?.x)) / Number(element.meta?.timeScale));
    if (!Number.isFinite(days) || Math.abs(days) > 100000) throw new Error('Move this task within 100000 days of its current start.');
    if (model.project === undefined && task.start + days < 0) days = -task.start;
    if (!days) return source;
    const value = (offset: number) => model.project === undefined ? `D+${round(offset)}` : dateString(model.project + offset * DAY);
    const patches: Patch[] = [];
    if (task.dependency) {
      const dependency = task.dependency, offset = dependency.offset + days;
      const constraint = `${task.milestone ? 'happens' : dependency.label.startsWith('end at') ? 'ends' : 'starts'} at [${dependency.source}]'s ${dependency.anchor}${offset ? ` ${offset > 0 ? '+' : '-'} ${Math.abs(offset)} days` : ''}`;
      patches.push(replaceSpan(source, dependency.span, dependency.type === 'then' ? '' : constraint));
      if (dependency.type === 'then') patches.push(insertAtEnd(source, block, `[${task.alias}] ${constraint}`));
    } else if (task.startSpan) patches.push(replaceSpan(source, task.startSpan, value(task.start + days)));
    else if (!task.endSpan) patches.push(insertAtEnd(source, block, `[${task.alias}] ${task.milestone ? 'happens on' : 'starts at'} ${value(task.start + days)}`));
    if (task.endSpan) patches.push(replaceSpan(source, task.endSpan, value(task.end + days - 1)));
    return patchSource(source, patches);
  }
  if (edit.type === 'rename') {
    if (!task) throw new Error('Select a task or milestone to rename.');
    const name = textName(edit.name, true);
    const suffix = task.aliasSpan ? '' : `] as [${task.alias}`;
    return patchSource(source, [replaceSpan(source, task.nameSpan, name + suffix)]);
  }
  if (edit.type === 'members') {
    if (!task) throw new Error('Select a task or milestone to edit.');
    const fields = new Map<string, string>();
    for (const member of edit.members) {
      const match = member.match(/^(duration|complete|start|resources)\s*:\s*(.*)$/i);
      if (!match || /[\r\n\u0000]/.test(member)) throw new Error('Use duration: N days, complete: N%, start: date or D+N, and resources: names.');
      fields.set(match[1].toLowerCase(), match[2].trim());
    }
    const patches: Patch[] = [], additions: string[] = [];
    const duration = fields.get('duration');
    if (duration !== undefined) {
      if (!/^\d+(?:\.\d+)?\s+days?$/.test(duration)) throw new Error('Duration must be a positive number of days.');
      const days = Number(duration.split(/\s+/)[0]);
      if (days <= 0 || days > 100000 || task.milestone) throw new Error('Tasks need 1–100000 days; milestones have no duration.');
      if (days !== task.duration) {
        if (task.explicitEnd !== undefined) throw new Error('This task has an explicit end date; edit that date in source before changing its duration.');
        if (task.durationSpan) patches.push(replaceSpan(source, task.durationSpan, duration)); else additions.push(`[${task.alias}] requires ${duration}`);
      }
    }
    const completion = fields.get('complete');
    if (completion !== undefined) {
      if (!/^\d+(?:\.\d+)?%$/.test(completion) || Number(completion.slice(0, -1)) > 100) throw new Error('Completion must be between 0% and 100%.');
      const value = Number(completion.slice(0, -1));
      if (value !== task.complete) { if (task.completeSpan) patches.push(replaceSpan(source, task.completeSpan, String(value))); else additions.push(`[${task.alias}] is ${value}% complete`); }
    }
    const start = fields.get('start');
    if (start !== undefined) {
      if (task.dependency) {
        const existing = block.elements.find(element => element.id === `gantt:${task.alias}`)?.members.find(member => member.startsWith('start: '))?.slice(7);
        if (start !== existing) throw new Error('Edit the dependency connection to change this linked start.');
      } else {
        const value = taskDate(start, model.project);
        if (value === undefined) throw new Error('Use a valid YYYY-MM-DD date or D+N for the start.');
        if (value !== task.start) { if (task.startSpan) patches.push(replaceSpan(source, task.startSpan, start)); else additions.push(`[${task.alias}] ${task.milestone ? 'happens on' : 'starts at'} ${start}`); }
      }
    }
    const resources = fields.get('resources');
    if (resources !== undefined) {
      const names = resources.split(',').map(name => name.trim()).filter(Boolean);
      if (names.some(name => /[{}\r\n]|(?:^|\s)'|\/'/.test(name))) throw new Error('Resource names cannot contain braces or comments.');
      if (names.join(', ') !== task.resources.join(', ')) {
        const value = names.length ? `on ${names.map(name => `{${name}}`).join(' ')} ` : '';
        if (task.resourceSpan) patches.push(replaceSpan(source, task.resourceSpan, value));
        else if (names.length) patches.push(replaceSpan(source, { line: task.declaration.line, start: (task.aliasSpan ?? task.nameSpan).end + 1, end: (task.aliasSpan ?? task.nameSpan).end + 1 }, ` ${value.trimEnd()}`));
      }
    }
    if (additions.length) patches.push(insertAtEnd(source, block, additions.join('\n')));
    return patchSource(source, patches);
  }
  if (edit.type === 'addElement') {
    const milestone = edit.kind === 'milestone' || edit.kind === 'gantt-milestone';
    if (!milestone && edit.kind !== 'task' && edit.kind !== 'gantt-task') throw new Error('Choose a task or milestone.');
    const alias = nextAlias(model.tasks.map(item => item.alias), milestone ? 'milestone' : 'task');
    const start = Math.max(0, ...model.tasks.map(item => item.end));
    return patchSource(source, [insertAtEnd(source, block, `[${textName(edit.name, true)}] as [${alias}] ${milestone ? `happens on D+${start}` : `requires 5 days\n[${alias}] starts at D+${start}`}`)]);
  }
  if (edit.type === 'addRelation') {
    const from = byId(edit.source), to = byId(edit.target);
    if (!from || !to || from === to) throw new Error('Connect two different tasks or milestones.');
    if (to.dependency) throw new Error('This task already has a scheduling dependency; edit its existing connection.');
    const visited = new Set<string>(); let predecessor: Task | undefined = from;
    while (predecessor) {
      if (predecessor === to) throw new Error('This connection would create a cyclic schedule.');
      if (visited.has(predecessor.alias)) break;
      visited.add(predecessor.alias); const alias: string | undefined = predecessor.dependency?.source;
      predecessor = alias ? model.tasks.find(item => item.alias === alias) : undefined;
    }
    const offset = dependencyOffset(edit.label);
    return patchSource(source, [insertAtEnd(source, block, `[${to.alias}] ${to.milestone ? 'happens' : 'starts'} at [${from.alias}]'s end${offset ? ` ${offset > 0 ? '+' : '-'} ${Math.abs(offset)} days` : ''}`)]);
  }
  if (edit.type === 'editRelation' || edit.type === 'deleteRelation') {
    const index = Number(edit.relationId.replace('gantt:dependency:', '')) - 1, dependency = model.dependencies[index];
    if (!dependency) throw new Error('This dependency no longer exists.');
    if (edit.type === 'deleteRelation') {
      if (dependency.type === 'arrow') return patchSource(source, removeCode(source, [dependency.span.line]));
      const dependent = model.tasks.find(item => item.alias === dependency.target)!;
      if (dependency.type === 'then') return patchSource(source, [replaceSpan(source, dependency.span, ''), insertAtEnd(source, block, `[${dependent.alias}] starts at D+${dependent.start}`)]);
      return patchSource(source, [replaceSpan(source, dependency.span, `${dependent.milestone ? 'happens on' : 'starts at'} D+${dependent.start}`)]);
    }
    if (dependency.type === 'arrow') {
      if (/[\r\n\u0000]/.test(edit.label)) throw new Error('Use a single-line dependency label.');
      return patchSource(source, [replaceSpan(source, dependency.span, `[${dependency.source}] -> [${dependency.target}]${edit.label ? ` : ${edit.label}` : ''}`)]);
    }
    const offset = dependencyOffset(edit.label.replace(/^(?:start|end at (?:start|end))\s*/, ''));
    if (dependency.type === 'then') {
      return patchSource(source, [replaceSpan(source, dependency.span, ''), insertAtEnd(source, block, `[${dependency.target}] starts at [${dependency.source}]'s end${offset ? ` ${offset > 0 ? '+' : '-'} ${Math.abs(offset)} days` : ''}`)]);
    }
    const target = model.tasks.find(item => item.alias === dependency.target)!;
    return patchSource(source, [replaceSpan(source, dependency.span, `${target.milestone ? 'happens' : dependency.label.startsWith('end at') ? 'ends' : 'starts'} at [${dependency.source}]'s ${dependency.anchor}${offset ? ` ${offset > 0 ? '+' : '-'} ${Math.abs(offset)} days` : ''}`)]);
  }
  if (edit.type === 'deleteElement') {
    if (!task) throw new Error('The schedule axis is generated from tasks.');
    const patches = removeCode(source, task.ownLines);
    for (const dependency of model.dependencies.filter(item => item.source === task.alias && !task.ownLines.includes(item.span.line))) {
      if (dependency.type === 'arrow') patches.push(...removeCode(source, [dependency.span.line]));
      else {
        const dependent = model.tasks.find(item => item.alias === dependency.target)!;
        const substitute = dependency.type === 'then' ? '' : `${dependent.milestone ? 'happens on' : 'starts at'} D+${dependent.start}`;
        patches.push(replaceSpan(source, dependency.span, substitute));
        if (dependency.type === 'then') patches.push(insertAtEnd(source, block, `[${dependent.alias}] starts at D+${dependent.start}`));
      }
    }
    // Explicit arrow references to the deleted target are separate from its declarations.
    for (const dependency of model.dependencies.filter(item => item.target === task.alias && item.type === 'arrow' && !task.ownLines.includes(item.span.line))) patches.push(...removeCode(source, [dependency.span.line]));
    return patchSource(source, patches);
  }
}
function dependencyOffset(text: string) {
  if (!text.trim()) return 0;
  const match = text.trim().match(/^([+-]?\d+)\s*(?:days?)?$/i);
  if (!match || Math.abs(Number(match[1])) > 100000) throw new Error('Use an optional scheduling offset such as +2 days or -1 day.');
  return Number(match[1]);
}
function editChronology(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  const events = chronologyModel({ ...block, warnings: [] }, source.split(/\r?\n/));
  const event = 'elementId' in edit ? events.find(item => `chronology:${item.alias}` === edit.elementId) : undefined;
  if (edit.type === 'move') {
    if (!event) throw new Error('Select an event to move.');
    const element = block.elements.find(element => element.id === edit.elementId)!;
    const unit = event.date.length > 10 ? 1000 : DAY;
    const delta = Math.round((edit.position.x - Number(element.meta?.x)) / Number(element.meta?.timeScale) / unit) * unit;
    const timestamp = event.timestamp + delta;
    if (!Number.isFinite(timestamp) || timestamp < Date.UTC(100, 0, 1) || timestamp > Date.UTC(9999, 11, 31, 23, 59, 59)) throw new Error('Move this event within the supported calendar years 0100–9999.');
    return patchSource(source, [replaceSpan(source, event.dateSpan, dateString(timestamp, unit === 1000))]);
  }
  if (edit.type === 'rename') {
    if (!event) throw new Error('Select an event to rename.');
    return patchSource(source, [replaceSpan(source, event.nameSpan, textName(edit.name, true))]);
  }
  if (edit.type === 'members') {
    if (!event || edit.members.length !== 1) throw new Error('Enter one date: YYYY-MM-DD HH:mm:ss field.');
    const date = edit.members[0].replace(/^date\s*:\s*/i, '').trim();
    if (dateValue(date) === undefined || !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(date)) throw new Error('Use a valid YYYY-MM-DD date, optionally followed by HH:mm:ss.');
    return patchSource(source, [replaceSpan(source, event.dateSpan, date)]);
  }
  if (edit.type === 'addElement') {
    if (edit.kind !== 'event' && edit.kind !== 'chronology-event') throw new Error('Choose an event.');
    const date = dateString(events.length ? Math.max(...events.map(item => item.timestamp)) + DAY : Date.UTC(2026, 0, 1));
    return patchSource(source, [insertAtEnd(source, block, `[${textName(edit.name, true)}] happens on ${date}`)]);
  }
  if (edit.type === 'deleteElement') {
    if (!event) throw new Error('The timeline axis is generated from event dates.');
    return patchSource(source, removeCode(source, [event.line]));
  }
  if (['addRelation', 'editRelation', 'deleteRelation'].includes(edit.type)) throw new Error('Chronology events are positioned by their dates.');
}

export const timeFamily: NativeFamily = {
  kinds: ['timing', 'gantt', 'chronology'], templates: timeTemplates,
  parse(block, lines) {
    if (block.kind === 'timing') parseTiming(block, lines);
    else if (block.kind === 'gantt') parseGantt(block, lines);
    else parseChronology(block, lines);
  },
  edit(source, block, edit) {
    if (edit.type === 'replaceSource' || edit.type === 'insertSnippet') return;
    return block.kind === 'timing' ? editTiming(source, block, edit) : block.kind === 'gantt' ? editGantt(source, block, edit) : editChronology(source, block, edit);
  },
  layout(block) {
    const positions = Object.create(null) as Record<string, Point>;
    for (const element of block.elements) positions[element.id] = { x: Number(element.meta?.x ?? 0), y: Number(element.meta?.y ?? 0) };
    return positions;
  },
};
