import { describe, expect, it } from 'vitest';
import { timeFamily, type GanttTaskData, type TimeAxisData, type TimingSignalData } from '../src/core/families/time';
import type { DiagramBlock, DiagramEdit, DiagramKind } from '../src/shared/protocol';

function parse(source: string, kind: DiagramKind): DiagramBlock {
  const lines = source.split(/\r?\n/), startLine = lines.findIndex(line => /^@start/.test(line));
  const endLine = lines.findIndex((line, index) => index > startLine && /^@end/.test(line));
  const block: DiagramBlock = { id: 'diagram-1', kind, title: 'Time test', startLine, endLine, source: lines.slice(startLine, endLine + 1).join('\n'), elements: [], relations: [], graphical: true, warnings: [] };
  timeFamily.parse(block, lines);
  return block;
}
function edit(source: string, kind: DiagramKind, operation: DiagramEdit) { return timeFamily.edit(source, parse(source, kind), operation)!; }
const uml = (body: string) => `@startuml\n${body}\n@enduml\n`;
const gantt = (body: string) => `@startgantt\n${body}\n@endgantt\n`;
const chronology = (body: string) => `@startchronology\n${body}\n@endchronology\n`;
const item = (source: string, kind: DiagramKind, id: string) => parse(source, kind).elements.find(element => element.id === id)!;
const schedule = (source: string, id: string) => item(source, 'gantt', `gantt:${id}`).meta!.time as GanttTaskData;

describe('native timing waveforms', () => {
  it('leaves enough waveform space to read the final concise state', () => {
    const source = uml('concise "My Timeline" as T\n@T\n0 is Alpha\n+100 is Bravo\n+100 is Charlie\n@50 <-> @+100 : My Note');
    const signal = item(source, 'timing', 'timing:T').meta!.time as TimingSignalData;
    const last = signal.events.at(-1)!;
    const tailWidth = (signal.max - last.time) / (signal.max - signal.min) * (signal.width - 82);
    expect(tailWidth).toBeGreaterThanOrEqual(last.state.length * 7 + 23.9);
    expect(signal.messages).toEqual([{ from: 50, to: 150, label: 'My Note' }]);
  });
  it('parses global and participant-relative signals onto the same time axis', () => {
    const source = uml('robust "Input" as input\nbinary "Enable" as enable\n@0\ninput is Idle\nenable is 0\n@20\ninput is Busy\n@enable\n0 is 0\n+12 is 1\n+15 is 0');
    const block = parse(source, 'timing');
    expect(block.elements.map(element => element.kind)).toEqual(['timing-axis', 'timing-robust', 'timing-binary']);
    const signal = block.elements[2].meta!.time as TimingSignalData;
    expect(signal.events.map(event => event.time)).toEqual([0, 0, 12, 27]);
    expect(signal.max).toBeGreaterThan(27);
    expect(block.elements[1].meta!.y).toBeLessThan(block.elements[2].meta!.y as number);
    expect(block.meta!.derivedRelations).toBe(true);
  });
  it('handles clocks, anchor times, analog values, and timing constraints', () => {
    const source = uml('clock "Oscillator" as clk with period 8 pulse 3 offset 1\nanalog "Voltage" as volts\n@0 as :origin\nvolts is 0\n@:origin+4\nvolts is 2.5\n@volts\n8 is 1.5\n@4 <-> @+4 : sample');
    const block = parse(source, 'timing');
    const clock = block.elements.find(element => element.id === 'timing:clk')!.meta!.time as TimingSignalData;
    expect(clock).toMatchObject({ period: 8, pulse: 3, offset: 1 });
    const voltage = block.elements.find(element => element.id === 'timing:volts')!.meta!.time as TimingSignalData;
    expect(voltage.events.map(event => event.time)).toEqual([0, 4, 8]);
    expect(voltage.messages).toEqual([{ from: 4, to: 8, label: 'sample' }]);
    expect(block.warnings).toEqual([]);
  });
  it('keeps shared time markers, other signals, comments, CRLF, and adjoining source when editing states', () => {
    const source = 'before\r\n' + uml('robust "First" as first\nrobust "Second" as second\n@0\nfirst is Idle \' keep this\nsecond is Ready\n@10\nfirst is Busy\nsecond is Done').replaceAll('\n', '\r\n') + 'after\r\n';
    const updated = edit(source, 'timing', { type: 'members', elementId: 'timing:first', members: ['0 is Waiting', '25 is Complete'] });
    expect(updated).toContain("' keep this");
    expect(updated).toContain('second is Ready\r\n@10');
    expect(updated).toContain('second is Done\r\n');
    expect(updated.startsWith('before\r\n')).toBe(true);
    expect(updated.endsWith('@enduml\r\nafter\r\n')).toBe(true);
    expect(item(updated, 'timing', 'timing:first').members).toEqual(['0 is Waiting', '25 is Complete']);
    expect(item(updated, 'timing', 'timing:second').members).toEqual(['0 is Ready', '10 is Done']);
  });
  it('renames only the declaration and retains references and quoted names', () => {
    const source = uml('robust Sender\n@0\nSender is Idle\n@20\nSender is Busy');
    const updated = edit(source, 'timing', { type: 'rename', elementId: 'timing:Sender', name: 'Sender "A"' });
    expect(updated).toContain('robust "Sender \\"A\\"" as Sender'.replace('\\\\', '\\'));
    expect(item(updated, 'timing', 'timing:Sender').name).toBe('Sender "A"');
    expect(updated).toContain('Sender is Busy');
  });
  it('adds and deletes signals without removing other assignments', () => {
    let source = uml('concise "Mode" as mode\n@0\nmode is Standby');
    source = edit(source, 'timing', { type: 'addElement', kind: 'rectangle', name: 'Channel' });
    expect(item(source, 'timing', 'timing:signal1').members).toEqual(['0 is Idle', '10 is Active']);
    source = edit(source, 'timing', { type: 'deleteElement', elementId: 'timing:signal1' });
    expect(parse(source, 'timing').elements.map(element => element.id)).toEqual(['timing:axis', 'timing:mode']);
    expect(source).toContain('mode is Standby');
  });
  it('validates signal and clock edits before changing the source', () => {
    const source = uml('clock C with period 10\nrobust S\n@0\nS is idle');
    expect(() => edit(source, 'timing', { type: 'members', elementId: 'timing:C', members: ['period: 0'] })).toThrow();
    expect(() => edit(source, 'timing', { type: 'members', elementId: 'timing:C', members: ['period: 3', 'pulse: 4'] })).toThrow();
    expect(() => edit(source, 'timing', { type: 'members', elementId: 'timing:S', members: ['0 is idle\n@enduml'] })).toThrow();
    const updated = edit(source, 'timing', { type: 'members', elementId: 'timing:C', members: ['period: 12', 'pulse: 4', 'offset: 2'] });
    expect(updated).toContain('clock C with period 12 pulse 4 offset 2');
  });
});

describe('native Gantt schedule', () => {
  it('uses compact corpus task rows with a shared daily grid and resource workloads', () => {
    const source = gantt('[Task1] on {Alice} requires 8 days\nthen [Task2] on {Bob} requires 4 days and is 50% complete\nthen [Task3] on {Carol} lasts 2 days and is 25% complete');
    const block = parse(source, 'gantt'), tasks = block.elements.filter(element => element.kind.startsWith('gantt-') && element.kind !== 'gantt-axis');
    expect(tasks.map(task => task.meta!.height)).toEqual([22, 22, 22]);
    expect(Number(tasks[1].meta!.y) - Number(tasks[0].meta!.y)).toBe(24);
    expect(tasks.map(task => task.meta!.barWidth)).toEqual([128, 64, 32]);
    const calendar = (block.elements[0].meta!.time as TimeAxisData).calendar!;
    expect(calendar).toMatchObject({ min: 0, max: 14, unit: 16, top: 20 });
    expect(calendar.resources.map(resource => resource.name)).toEqual(['Alice', 'Bob', 'Carol']);
    expect(calendar.resources[1].loads).toEqual([{ start: 8, end: 12 }]);
    expect(calendar.height).toBeLessThan(250);
    expect(tasks[2].meta!.connectionWidth).toBe(32);
  });

  it('keeps multiline phase labels compact and projects the dated calendar and closed days', () => {
    const source = gantt('Project starts 2022-01-01\nsaturday are closed\nsunday are closed\n[Phase 01\\nSkateboard] as [phase_01] lasts 4 weeks\nthen [Phase 02\\nScooter] as [phase_02] lasts 4 weeks');
    const block = parse(source, 'gantt'), phase = block.elements.find(element => element.id === 'gantt:phase_01')!;
    expect(phase.name).toBe('Phase 01\nSkateboard');
    expect(phase.meta!.height).toBe(32);
    const calendar = (block.elements[0].meta!.time as TimeAxisData).calendar!;
    expect(calendar.project).toBe(Date.UTC(2022, 0, 1));
    expect(calendar.top).toBe(46);
    expect(calendar.closed.sort()).toEqual([0, 6]);
    expect(calendar.height).toBeGreaterThan(Number(phase.meta!.y) + 32);
  });
  it('lays out actual duration bars, progress, resources, and milestone dependencies', () => {
    const source = gantt('Project starts 2026-02-02\n[Draft] as [draft] on {Mira} requires 3 days\n[draft] is 40% complete\nthen [Build] as [build] lasts 1 week\n[Gate] happens at [build]\'s end');
    const block = parse(source, 'gantt');
    expect(schedule(source, 'draft')).toMatchObject({ start: 0, end: 3, duration: 3, complete: 40, resources: ['Mira'] });
    expect(schedule(source, 'build')).toMatchObject({ start: 3, end: 10 });
    expect(schedule(source, 'Gate')).toMatchObject({ start: 10, end: 10, milestone: true });
    expect(block.relations).toHaveLength(2);
    expect(item(source, 'gantt', 'gantt:build').meta!.x).toBeGreaterThan(item(source, 'gantt', 'gantt:draft').meta!.x as number);
    expect(item(source, 'gantt', 'gantt:build').meta!.barWidth).toBeGreaterThan(item(source, 'gantt', 'gantt:draft').meta!.barWidth as number);
  });
  it('counts working days across closed weekends and inclusive explicit end dates', () => {
    const source = gantt('Project starts 2026-02-06\nsaturday are closed\nsunday are closed\n[Work] requires 3 days\n[Span] starts 2026-02-06\n[Span] ends 2026-02-09');
    expect(schedule(source, 'Work')).toMatchObject({ start: 0, end: 5, duration: 3 });
    expect(schedule(source, 'Span')).toMatchObject({ start: 0, end: 4, duration: 4 });
  });
  it('edits duration and progress narrowly without changing dependencies or comments', () => {
    const source = gantt('[Stage A] as [a] requires 4 days \' duration comment\n[a] is 20% complete\n[Stage B] as [b] requires 6 days\n[b] starts at [a]\'s end + 2 days');
    const updated = edit(source, 'gantt', { type: 'members', elementId: 'gantt:a', members: ['duration: 8 days', 'complete: 65%', 'start: D+0', 'resources: Dana, Lee'] });
    expect(updated).toContain("requires 8 days ' duration comment");
    expect(updated).toContain('[a] is 65% complete');
    expect(updated).toContain("[b] starts at [a]'s end + 2 days");
    expect(schedule(updated, 'b').start).toBe(10);
    expect(schedule(updated, 'a').resources).toEqual(['Dana', 'Lee']);
  });
  it('preserves task aliases when names change', () => {
    const source = gantt('[Draft] requires 4 days\n[Review] requires 2 days\n[Review] starts at [Draft]\'s end');
    const updated = edit(source, 'gantt', { type: 'rename', elementId: 'gantt:Draft', name: 'Design draft' });
    expect(updated).toContain('[Design draft] as [Draft] requires 4 days');
    expect(schedule(updated, 'Review').start).toBe(4);
    expect(item(updated, 'gantt', 'gantt:Draft').name).toBe('Design draft');
  });
  it('creates, changes, and removes dependencies while retaining task duration', () => {
    let source = gantt('[A] requires 4 days\n[B] requires 7 days');
    source = edit(source, 'gantt', { type: 'addRelation', source: 'gantt:A', target: 'gantt:B', arrow: '-->', label: '+2 days' });
    expect(schedule(source, 'B').start).toBe(6);
    source = edit(source, 'gantt', { type: 'editRelation', relationId: 'gantt:dependency:1', arrow: '-->', label: '+4 days' });
    expect(schedule(source, 'B').start).toBe(8);
    source = edit(source, 'gantt', { type: 'deleteRelation', relationId: 'gantt:dependency:1' });
    expect(parse(source, 'gantt').relations).toHaveLength(0);
    expect(schedule(source, 'B')).toMatchObject({ start: 8, duration: 7, end: 15 });
  });
  it('deletes a predecessor while keeping dependent tasks at their previous dates', () => {
    const source = gantt('[A] requires 4 days\nthen [B] requires 3 days\n[C] requires 2 days\n[C] starts at [A]\'s end + 1 day\n[A] -> [C]');
    const updated = edit(source, 'gantt', { type: 'deleteElement', elementId: 'gantt:A' });
    expect(parse(updated, 'gantt').elements.map(element => element.id)).toEqual(['gantt:axis', 'gantt:B', 'gantt:C']);
    expect(schedule(updated, 'B')).toMatchObject({ start: 4, duration: 3 });
    expect(schedule(updated, 'C')).toMatchObject({ start: 5, duration: 2 });
    expect(parse(updated, 'gantt').relations).toHaveLength(0);
  });
  it('adds task/milestone from scratch and prevents cyclic dependencies and invalid edits', () => {
    let source = gantt('');
    source = edit(source, 'gantt', { type: 'addElement', kind: 'task', name: 'Plan' });
    source = edit(source, 'gantt', { type: 'addElement', kind: 'milestone', name: 'Ready' });
    expect(schedule(source, 'task1').duration).toBe(5);
    expect(schedule(source, 'milestone1')).toMatchObject({ start: 5, milestone: true });
    source = edit(source, 'gantt', { type: 'addRelation', source: 'gantt:task1', target: 'gantt:milestone1', arrow: '-->', label: '' });
    expect(() => edit(source, 'gantt', { type: 'addRelation', source: 'gantt:milestone1', target: 'gantt:task1', arrow: '-->', label: '' })).toThrow(/cyclic/);
    expect(() => edit(source, 'gantt', { type: 'rename', elementId: 'gantt:task1', name: 'x]\n@endgantt' })).toThrow();
    expect(() => edit(source, 'gantt', { type: 'members', elementId: 'gantt:task1', members: ['duration: -2 days'] })).toThrow();
  });
  it('moves dated bars by changing start and end dates, preserving their duration and comments', () => {
    const source = gantt('Project starts 2026-06-01\n[Range] starts 2026-06-02 \' keep start note\n[Range] ends 2026-06-05\n[Other] requires 2 days');
    const element = item(source, 'gantt', 'gantt:Range');
    const updated = edit(source, 'gantt', { type: 'move', elementId: element.id, position: { x: Number(element.meta!.x) + Number(element.meta!.timeScale) * 3, y: 999 } });
    expect(updated).toContain("[Range] starts 2026-06-05 ' keep start note");
    expect(updated).toContain('[Range] ends 2026-06-08');
    expect(schedule(updated, 'Range')).toMatchObject({ start: 4, end: 8, duration: 4 });
    expect(updated).toContain('[Other] requires 2 days');
  });
  it('moves linked tasks by changing the scheduling offset, including implicit then constraints', () => {
    for (const body of ['[A] requires 4 days\nthen [B] requires 3 days', '[A] requires 4 days\n[B] requires 3 days\n[B] starts at [A]\'s end']) {
      const source = gantt(body), element = item(source, 'gantt', 'gantt:B');
      const updated = edit(source, 'gantt', { type: 'move', elementId: element.id, position: { x: Number(element.meta!.x) + Number(element.meta!.timeScale) * 2, y: 70 } });
      expect(schedule(updated, 'B')).toMatchObject({ start: 6, duration: 3 });
      expect(updated).toContain("starts at [A]'s end + 2 days");
      expect(parse(updated, 'gantt').relations).toHaveLength(1);
    }
  });
});

describe('native chronology', () => {
  it('positions dates and second-resolution events proportionally with collision lanes', () => {
    const source = chronology('[Kickoff] happens on 2026-04-01 10:00:00\n[Decision] happens on 2026-04-01 10:00:10\n[Delivery] happens on 2026-04-02 10:00:00');
    const block = parse(source, 'chronology');
    expect(block.elements).toHaveLength(4);
    const [first, second, third] = block.elements.slice(1);
    expect(second.meta!.x).toBeGreaterThan(first.meta!.x as number);
    expect(third.meta!.x).toBeGreaterThan(second.meta!.x as number);
    expect(second.meta!.y).not.toBe(first.meta!.y);
    expect(block.meta!.derivedRelations).toBe(true);
  });
  it('renames and edits event date in place preserving comments and neighboring blocks', () => {
    const source = chronology('[Checkpoint] happens on 2026-04-01 \' owner note') + uml('class Unrelated');
    let updated = edit(source, 'chronology', { type: 'members', elementId: 'chronology:Checkpoint', members: ['date: 2026-05-02 13:45:20'] });
    updated = edit(updated, 'chronology', { type: 'rename', elementId: 'chronology:Checkpoint', name: 'Acceptance' });
    expect(updated).toContain("[Acceptance] happens on 2026-05-02 13:45:20 ' owner note");
    expect(updated.endsWith(uml('class Unrelated'))).toBe(true);
  });
  it('adds/removes events and rejects impossible dates', () => {
    let source = chronology('[First] happens on 2026-01-31');
    source = edit(source, 'chronology', { type: 'addElement', kind: 'event', name: 'Next' });
    expect(source).toContain('[Next] happens on 2026-02-01');
    expect(() => edit(source, 'chronology', { type: 'members', elementId: 'chronology:Next', members: ['date: 2026-02-30'] })).toThrow();
    source = edit(source, 'chronology', { type: 'deleteElement', elementId: 'chronology:First' });
    expect(parse(source, 'chronology').elements.map(element => element.id)).toEqual(['chronology:axis', 'chronology:Next']);
  });
  it('moves date and timestamp events by their semantic axis scale', () => {
    const source = chronology('[One] happens on 2026-05-01\n[Two] happens on 2026-05-11');
    const element = item(source, 'chronology', 'chronology:One');
    const updated = edit(source, 'chronology', { type: 'move', elementId: element.id, position: { x: Number(element.meta!.x) + Number(element.meta!.timeScale) * 2 * 86400000, y: 0 } });
    expect(updated).toContain('[One] happens on 2026-05-03');
    const secondsSource = chronology('[A] happens on 2026-05-01 12:00:00\n[B] happens on 2026-05-01 12:00:30');
    const timed = item(secondsSource, 'chronology', 'chronology:A');
    const timedUpdate = edit(secondsSource, 'chronology', { type: 'move', elementId: timed.id, position: { x: Number(timed.meta!.x) + Number(timed.meta!.timeScale) * 5000, y: 0 } });
    expect(timedUpdate).toContain('[A] happens on 2026-05-01 12:00:05');
  });
  it('provides native geometry and safe own-key layout for all original starter templates', () => {
    for (const template of timeFamily.templates) {
      const block = parse(template.source, template.kind);
      expect(block.warnings, template.kind).toEqual([]);
      expect(block.elements.length).toBeGreaterThan(1);
      const positions = timeFamily.layout!(block)!;
      expect(Object.getPrototypeOf(positions)).toBeNull();
      for (const element of block.elements) expect(Number.isFinite(positions[element.id].x) && Number.isFinite(positions[element.id].y)).toBe(true);
    }
  });
});
