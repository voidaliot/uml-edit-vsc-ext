import type { CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { DiagramElement } from '../shared/protocol';
import './architecture.css';

const colors = ['#62a7e8', '#e3ad54', '#6fc3a0', '#c895dc', '#eb8892', '#75c4db'];
interface Series { id: string; name: string; x: number[]; y: number[]; mode: string }
function Chart({ element }: { element: DiagramElement }) {
  const m = element.meta || {}, series = (m.series || []) as Series[];
  const values = series.flatMap(s => s.x.flatMap((x, i) => Number.isFinite(x) && Number.isFinite(s.y[i]) ? [{ x, y: s.y[i] }] : []));
  const bounds = (key: string, fallback: number) => typeof m[key] === 'number' && Number.isFinite(m[key]) ? Number(m[key]) : fallback;
  const xmin = bounds('xMin', Math.min(0, ...values.map(p => p.x))), xmax = bounds('xMax', Math.max(1, ...values.map(p => p.x)));
  const ymin = bounds('yMin', Math.min(0, ...values.map(p => p.y))), ymax = bounds('yMax', Math.max(1, ...values.map(p => p.y)));
  const x = (n: number) => 62 + (n - xmin) / (xmax - xmin || 1) * 552;
  const y = (n: number) => 274 - (n - ymin) / (ymax - ymin || 1) * 232;
  return <svg className="architecture-chart" viewBox="0 0 660 345" role="img" aria-label={`${element.name}, ${series.length} data series`}>
    {[0, 1, 2, 3, 4].map(i => <g key={i} className="chart-grid"><line x1="62" x2="614" y1={42 + i * 58} y2={42 + i * 58} /><text x="50" y={46 + i * 58} textAnchor="end">{Number((ymax - (ymax - ymin) * i / 4).toPrecision(3))}</text><text x={62 + i * 138} y="293" textAnchor="middle">{Number((xmin + (xmax - xmin) * i / 4).toPrecision(3))}</text></g>)}
    <path className="chart-axis" d="M62 35V274H622" />
    {series.map((s, index) => { const points = s.x.flatMap((n, i) => Number.isFinite(n) && Number.isFinite(s.y[i]) ? [{ x: x(n), y: y(s.y[i]), value: s.y[i] }] : []); return <g key={s.id} style={{ color: colors[index % colors.length] }}>
      {s.mode === 'bar' ? points.map((p, i) => <rect key={i} x={p.x - 10 + index * 8} y={Math.min(y(0), p.y)} width="16" height={Math.max(1, Math.abs(y(0) - p.y))} fill="currentColor" opacity=".8"><title>{s.name}: {p.value}</title></rect>) : <><polyline points={points.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2.5" />{points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="4" fill="currentColor"><title>{s.name}: {p.value}</title></circle>)}</>}
      <line x1={70 + index % 3 * 185} x2={89 + index % 3 * 185} y1={323 + Math.floor(index / 3) * 18} y2={323 + Math.floor(index / 3) * 18} stroke="currentColor" strokeWidth="3" /><text x={95 + index % 3 * 185} y={327 + Math.floor(index / 3) * 18} className="chart-legend">{s.name}</text>
    </g>; })}
    <text className="chart-axis-label" x="335" y="312" textAnchor="middle">{String(m.xLabel || 'x')}</text><text className="chart-axis-label" transform="translate(17 162) rotate(-90)" textAnchor="middle">{String(m.yLabel || 'y')}</text>
  </svg>;
}

function Shape({ element }: { element: DiagramElement }) {
  const m = element.meta || {}, shape = String(m.shape || ''), kind = element.kind;
  let body;
  if (kind === 'network-bus') body = <><path d="M2 58H218" strokeWidth="6" /><path d="M2 49V67M218 49V67" strokeWidth="2" /></>;
  else if (kind === 'git-commit') body = <><circle cx="17" cy="17" r="12" /><circle cx="17" cy="17" r="4" fill="currentColor" /></>;
  else if (shape === 'diamond') body = <><polygon points="110,2 218,50 110,98 2,50" />{m.identifying === true && <polygon points="110,8 205,50 110,92 15,50" />}</>;
  else if (shape === 'ellipse' || /chen-attribute|dot-(?:oval|ellipse|circle|doublecircle)/.test(kind)) body = <><ellipse cx="110" cy="50" rx="107" ry="47" />{m.multi === true || kind === 'dot-doublecircle' ? <ellipse cx="110" cy="50" rx="100" ry="40" /> : null}</>;
  else if (shape === 'database' || /database/.test(kind)) body = <><path d="M3 15C3 0 217 0 217 15V84C217 102 3 102 3 84Z" /><path d="M3 15C3 32 217 32 217 15" /></>;
  else if (shape === 'document') body = <path d="M3 3H217V82C161 55 75 111 3 87Z" />;
  else if (shape === 'cloud') body = <path d="M24 74C-3 74-1 37 25 34C24 9 54 3 70 18C90-4 120 3 130 16C154 4 185 18 182 37C219 27 236 78 198 83C184 105 149 102 133 87C99 108 65 97 60 88C40 103 22 91 24 74Z" />;
  else if (shape === 'person') body = <><circle cx="110" cy="19" r="16" /><path d="M77 73V62C77 35 143 35 143 62V73Z" /></>;
  else if (shape === 'actor') body = <><rect x="2" y="2" width="216" height="96" rx="3" /><circle cx="199" cy="15" r="5" /><path d="M199 20V34M190 26H208M199 34L191 42M199 34L207 42" /></>;
  else if (shape === 'queue') body = <><rect x="2" y="2" width="216" height="96" rx="12" /><path d="M18 3V97M201 3V97" /></>;
  else body = <><rect x="2" y="2" width="216" height="96" rx={shape === 'service' || shape === 'process' || kind.startsWith('board-') ? 10 : 2} />{m.weak === true && <rect x="8" y="8" width="204" height="84" />}{shape === 'process' && <path d="M185 14H207L199 7M207 14L199 21" />}</>;
  return <svg className={`architecture-shape ${m.derived === true ? 'derived' : ''} ${m.external === true ? 'external' : ''}`} viewBox={kind === 'git-commit' ? '0 0 34 34' : '0 0 220 100'} preserveAspectRatio="none" aria-hidden="true">{body}</svg>;
}

export function ArchitectureContent({ element }: { element: DiagramElement }) {
  if (!/^(?:c4-|archimate-|network-|chen-|dot-|ditaa-|board-|git-|chart-jcckit)/.test(element.kind)) return null;
  const m = element.meta || {};
  if (element.kind === 'chart-jcckit') return <div className="architecture-native architecture-chart-wrap"><Chart element={element} /></div>;
  const layer = String(m.layer || '').toLowerCase();
  const style = { '--architecture-layer': layer === 'business' ? '#a99237' : layer === 'application' ? '#3587a0' : layer === 'technology' || layer === 'physical' ? '#54975f' : layer === 'motivation' ? '#9774aa' : '#638fb4' } as CSSProperties;
  return <div className={`architecture-native architecture-${element.kind} ${m.container ? 'architecture-container' : ''} ${m.key ? 'attribute-key' : ''}`} style={style}>
    <Shape element={element} />
    {element.kind === 'network-bus' && ((m.ports || []) as { id: string; x: number; above: boolean }[]).map(port => <Handle key={port.id} type="source" id={port.id} position={port.above ? Position.Top : Position.Bottom} className="uml-handle" style={{ left: port.x, top: '58%', bottom: 'auto' }} />)}
    {element.kind.startsWith('archimate-') && <span className="architecture-layer">{String(m.macro || m.layer || 'ArchiMate').replace(/_/g, ' ')}</span>}
    {element.kind.startsWith('c4-') && !m.container && <span className="architecture-type">[{String(m.macro || 'Element').replace(/_/g, ' ')}]</span>}
    {element.kind === 'git-commit' && <div className="git-ref"><code>{String(m.hash)}</code>{m.refs ? <span>{String(m.refs)}</span> : null}</div>}
    {element.members.length > 0 && <div className="architecture-details">{element.members.map((line, i) => <div key={i}>{line}</div>)}</div>}
  </div>;
}
