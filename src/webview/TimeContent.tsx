import type { DiagramElement } from '../shared/protocol';
import { useNodes } from '@xyflow/react';
import type { TimeAxisData, TimingSignalData, GanttTaskData, GanttCalendarData, ChronologyEventData, TimeContentData, TimeMessagesData } from '../core/families/time';
import './time.css';

const safeColor = (color?: string) => color && /^(?:#[\da-f]{3,8}|[a-z]+)$/i.test(color) ? color : undefined;
const number = (value: number) => Number(value.toFixed(2));

function Calendar({ data, width }: { data: GanttCalendarData; width: number }) {
  const { min, max, startX, unit, top, bottom } = data;
  const step = Math.max(1, Math.ceil((max - min) / 400));
  const days = Array.from({ length: Math.ceil((max - min) / step) }, (_, index) => min + index * step);
  const x = (day: number) => startX + (day - min) * unit;
  const date = (day: number) => new Date((data.project ?? 0) + day * 86400000);
  const months: { label: string; start: number; end: number }[] = [];
  if (data.project !== undefined) for (const day of days) {
    const value = date(day), label = `${['January','February','March','April','May','June','July','August','September','October','November','December'][value.getUTCMonth()]} ${value.getUTCFullYear()}`;
    if (months.at(-1)?.label === label) months.at(-1)!.end = Math.min(max, day + step);
    else months.push({ label, start: day, end: Math.min(max, day + step) });
  }
  return <svg className="native-gantt-calendar native-time-axis" width={width} height={data.height} viewBox={`0 0 ${width} ${data.height}`} role="img" aria-label="Schedule calendar">
    {days.map(day => <g key={day}>
      {data.project !== undefined && step === 1 && data.closed.includes(date(day).getUTCDay()) && <rect className="gantt-closed-day" x={x(day)} y={top} width={unit} height={bottom - top} />}
      <path className="gantt-calendar-grid" d={`M${x(day)} ${top}V${bottom}`} />
      <text x={x(day) + unit * step / 2} y={top - 5} textAnchor="middle">{data.project === undefined ? day + 1 : date(day).getUTCDate()}</text>
      <text x={x(day) + unit * step / 2} y={bottom + 13} textAnchor="middle">{data.project === undefined ? day + 1 : date(day).getUTCDate()}</text>
      {data.project !== undefined && <><text x={x(day) + unit * step / 2} y={top - 18} textAnchor="middle">{['Su','Mo','Tu','We','Th','Fr','Sa'][date(day).getUTCDay()]}</text><text x={x(day) + unit * step / 2} y={bottom + 26} textAnchor="middle">{['Su','Mo','Tu','We','Th','Fr','Sa'][date(day).getUTCDay()]}</text></>}
    </g>)}
    {months.map((month, index) => <g key={index}><text className="gantt-month" x={(x(month.start) + x(month.end)) / 2} y={12} textAnchor="middle">{month.label}</text><text className="gantt-month" x={(x(month.start) + x(month.end)) / 2} y={bottom + 40} textAnchor="middle">{month.label}</text></g>)}
    <path className="gantt-calendar-grid" d={`M${x(max)} ${top}V${bottom}M${startX} ${top}H${x(max)}M${startX} ${bottom}H${x(max)}`} />
    {data.resources.map(resource => <g key={resource.name} className="gantt-resource-row"><path className="gantt-calendar-grid" d={`M${startX} ${resource.y}H${x(max)}`} /><text className="gantt-resource-name" x={startX} y={resource.y + 12}>{resource.name}</text>{days.map(day => {
      const load = data.project !== undefined && data.closed.includes(date(day).getUTCDay()) ? 0 : resource.loads.filter(task => day >= task.start && day < task.end).length * 100;
      return load ? <text className="gantt-resource-load" key={day} x={x(day) + unit * step / 2} y={resource.y + 28} textAnchor="middle">{load}</text> : null;
    })}</g>)}
  </svg>;
}

function Axis({ data }: { data: TimeAxisData }) {
  if (data.calendar) return <Calendar data={data.calendar} width={data.width} />;
  const labelled = new Set<number>(), seen = new Set<string>();
  const first = data.ticks[0], last = data.ticks.at(-1);
  if (first) { labelled.add(0); seen.add(first.label); }
  if (last && data.ticks.length > 1) { labelled.add(data.ticks.length - 1); seen.add(last.label); }
  let right = first ? first.x + first.label.length * 6 : 0;
  const lastLeft = last ? last.x - last.label.length * 6 : data.width;
  for (let index = 1; index < data.ticks.length - 1; index++) {
    const tick = data.ticks[index], half = tick.label.length * 3;
    if (!seen.has(tick.label) && tick.x - half >= right + 16 && tick.x + half <= lastLeft - 16) { labelled.add(index); seen.add(tick.label); right = tick.x + half; }
  }
  return <svg className="native-time-axis" width={data.width} height={44} viewBox={`0 0 ${data.width} 44`} role="img" aria-label={`${data.label} axis`}>
    <path className="time-axis-line" d={`M${data.ticks[0]?.x ?? 64} 10H${data.ticks.at(-1)?.x ?? data.width - 18}`} />
    {data.ticks.map((tick, index) => <g key={index}><path className="time-axis-line" d={`M${tick.x} 5V16`} />{labelled.has(index) && <text x={tick.x} y={32} textAnchor={index === 0 ? 'start' : index === data.ticks.length - 1 ? 'end' : 'middle'}>{tick.label}</text>}</g>)}
  </svg>;
}

function Signal({ data }: { data: TimingSignalData }) {
  const { width, height, min, max, signal } = data;
  const x = (time: number) => 64 + (time - min) / (max - min) * (width - 82);
  const top = 13 + data.messages.length * 22, bottom = height - 18;
  const events = data.events.filter(event => event.time >= min && event.time <= max);
  const segments = events.map((event, index) => ({ ...event, left: x(event.time), right: x(events[index + 1]?.time ?? max) }));
  const states = data.states.filter(state => !/^\{(?:-|hidden)\}$/i.test(state));
  const values = events.map(event => Number(event.state)).filter(Number.isFinite);
  const low = Math.min(0, ...values), high = Math.max(1, ...values);
  const stateY = (state: string) => signal === 'analog'
    ? bottom - (Number(state) - low) / (high - low) * (bottom - top)
    : signal === 'binary' ? /^(?:1|true|high)$/i.test(state) ? top : bottom
    : top + (1 - Math.max(0, states.indexOf(state)) / Math.max(1, states.length - 1)) * (bottom - top);
  const paths: string[] = [];
  let path = '';
  if (signal === 'clock') {
    const period = Math.max(0.001, data.period), pulse = Math.min(period, data.pulse);
    const count = Math.ceil((max - min) / period);
    if (count <= 2000) {
      let time = Math.floor((min - data.offset) / period) * period + data.offset;
      let active = (min - data.offset - Math.floor((min - data.offset) / period) * period) < pulse;
      path = `M${x(min)},${active ? top : bottom}`;
      for (let index = 0; index < count + 2; index++, time += period) {
        for (const [at, value] of [[time, top], [time + pulse, bottom]]) {
          if (at < min || at > max) continue;
          path += `H${number(x(at))}V${value}`; active = value === top;
        }
      }
      path += `H${x(max)}`;
    }
  } else if (signal !== 'concise' && signal !== 'rectangle') {
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (/^\{(?:-|hidden)\}$/i.test(segment.state) || signal === 'analog' && !Number.isFinite(Number(segment.state))) { if (path) paths.push(path); path = ''; continue; }
      const y = stateY(segment.state);
      if (!path) path = `M${number(segment.left)},${number(y)}`;
      else path += signal === 'analog' ? `L${number(segment.left)},${number(y)}` : `H${number(segment.left)}V${number(y)}`;
      if (signal !== 'analog' || index === segments.length - 1) path += `H${number(segment.right)}`;
    }
  }
  if (path) paths.push(path);
  return <svg className={`native-timing-signal signal-${signal}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${data.alias} ${signal} waveform`}>
    {data.ticks.map((tick, index) => <path className="time-grid-line" key={index} d={`M${tick.x} 0V${bottom + 5}`} />)}
    {signal === 'robust' && states.slice(0, 12).map((state, index) => <g key={index}><path className="time-state-guide" d={`M64 ${stateY(state)}H${width - 18}`} /><text x={57} y={stateY(state) + 4} textAnchor="end">{state.length > 10 ? state.slice(0, 9) + '…' : state}<title>{state}</title></text></g>)}
    {(signal === 'binary' || signal === 'clock') && <><text x={53} y={top + 4} textAnchor="end">1</text><text x={53} y={bottom + 4} textAnchor="end">0</text></>}
    {signal === 'analog' && <><text x={53} y={top + 4} textAnchor="end">{high}</text><text x={53} y={bottom + 4} textAnchor="end">{low}</text></>}
    {(signal === 'concise' || signal === 'rectangle') && segments.map((segment, index) => {
      if (/^\{(?:-|hidden)\}$/i.test(segment.state)) return null;
      const left = segment.left, right = segment.right, middle = (top + bottom) / 2, cross = Math.min(7, (right - left) / 3);
      return <g key={index}>{signal === 'rectangle'
        ? <rect className="time-value-band" x={left} y={top + 5} width={Math.max(1, right - left)} height={bottom - top - 10} style={{ fill: safeColor(segment.color) }} />
        : <path className="time-value-band" d={`M${left} ${middle}L${left + cross} ${top + 5}H${right - cross}L${right} ${middle}L${right - cross} ${bottom - 5}H${left + cross}Z`} style={{ fill: safeColor(segment.color) }} />}
        {right - left > 32 && <text x={(left + right) / 2} y={middle + 4} textAnchor="middle">{segment.state.length * 7 > right - left - 15 ? segment.state.slice(0, Math.max(1, Math.floor((right - left - 28) / 7))) + '…' : segment.state}</text>}<title>{segment.state} at {segment.time}</title></g>;
    })}
    {paths.map((value, index) => <path key={index} className="time-signal-path" d={value} />)}
    {data.messages.map((message, index) => <g key={index}><path className="time-message" d={`M${x(message.from) + 5} ${index * 22 + 17}l-5 -4l5 -4M${x(message.from)} ${index * 22 + 13}H${x(message.to)}m-5 -4l5 4l-5 4`} /><text x={(x(message.from) + x(message.to)) / 2} y={index * 22 + 7} textAnchor="middle">{message.label}</text></g>)}
    {signal === 'clock' && Math.ceil((max - min) / data.period) > 2000 && <text x={width / 2} y={height / 2} textAnchor="middle">Clock frequency exceeds the current display scale</text>}
  </svg>;
}

function Task({ data, barWidth }: { data: GanttTaskData; barWidth: number }) {
  const date = (offset: number) => data.project === undefined ? `D+${number(offset)}` : new Date(data.project + offset * 86400000).toISOString().slice(0, 10);
  const height = data.rowHeight ?? 22;
  return <div className={`native-gantt-content ${data.milestone ? 'gantt-milestone-content' : ''}`}>
    <svg width={Math.max(data.width, barWidth)} height={height} viewBox={`0 0 ${Math.max(data.width, barWidth)} ${height}`} role="img" aria-label={data.milestone ? `Milestone at ${date(data.start)}` : `${data.duration} day task, ${data.complete}% complete`}>
      <title>{date(data.start)}{!data.milestone && ` → ${date(Math.max(data.start, data.end - 1))} · ${data.duration} days · ${data.complete}% complete`}{data.resources.length ? ` · ${data.resources.join(', ')}` : ''}</title>
      {data.milestone ? <path className="time-milestone" d={`M0 ${height / 2}l7 -7l7 7l-7 7Z`} /> : <>
        <rect className="gantt-bar" x="0" y="2" width={Math.max(4, barWidth)} height={height - 4} style={{ fill: safeColor(data.color) }} />
        <rect className="gantt-progress" x="0" y="2" width={Math.max(0, barWidth * data.complete / 100)} height={height - 4} />
      </>}
      {data.resources.length > 0 && <text className="gantt-resource-label" x={(data.labelWidth ?? 60) + 3} y={height / 2 + 3}>{`{${data.resources.join(', ')}}`}</text>}
    </svg>
  </div>;
}

function Event({ data }: { data: ChronologyEventData }) {
  return <div className="native-chronology-content"><svg width={data.width} height="29" viewBox={`0 0 ${data.width} 29`} role="img" aria-label={`Event on ${data.date}`}><path className="chronology-stem" d={`M0 ${data.stemToAxis}V21H165`} /><circle className="chronology-dot" cx="0" cy="21" r="5" /></svg><div className="chronology-date">{data.date}</div></div>;
}

function Messages({ data }: { data: TimeMessagesData }) {
  const nodes = useNodes();
  return <svg className="native-time-messages" width={data.width} height={data.height} viewBox={`0 0 ${data.width} ${data.height}`} role="img" aria-label="Messages between timing signals">{data.lines.map((original, index) => {
    const line = { ...original, y1: original.y1 + (nodes.find(node => node.id === original.sourceId)?.position.y ?? original.sourceY) - original.sourceY, y2: original.y2 + (nodes.find(node => node.id === original.targetId)?.position.y ?? original.targetY) - original.targetY };
    const length = Math.max(1, Math.hypot(line.x2 - line.x1, line.y2 - line.y1)), dx = (line.x2 - line.x1) / length, dy = (line.y2 - line.y1) / length;
    return <g key={index}><path className="time-message" d={`M${line.x1} ${line.y1}L${line.x2} ${line.y2}M${line.x2 - dx * 7 + dy * 4} ${line.y2 - dy * 7 - dx * 4}L${line.x2} ${line.y2}L${line.x2 - dx * 7 - dy * 4} ${line.y2 - dy * 7 + dx * 4}`} /><text x={(line.x1 + line.x2) / 2 + 6} y={(line.y1 + line.y2) / 2 - 5}>{line.label}</text></g>;
  })}</svg>;
}

export function TimeContent({ element }: { element: DiagramElement }) {
  const data = element.meta?.time as TimeContentData | undefined;
  if (!data) return null;
  if (data.type === 'axis') return <Axis data={data} />;
  if (data.type === 'signal') return <Signal data={data} />;
  if (data.type === 'task') return <Task data={data} barWidth={Number(element.meta?.barWidth ?? data.width)} />;
  if (data.type === 'event') return <Event data={data} />;
  if (data.type === 'messages') return <Messages data={data} />;
  return null;
}
