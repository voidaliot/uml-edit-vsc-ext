import type { ReactNode } from 'react';
import { Braces, Brackets, FileText, Folder, Link2 } from 'lucide-react';
import type { DiagramElement } from '../shared/protocol';
import { railroadSize, type Railroad, type ChartModel, type ChartSeries, type DataTableRow } from '../core/families/data';
import './data.css';

function Rail({ node, x = 0, y = 0 }: { node: Railroad; x?: number; y?: number }): ReactNode {
  const size = railroadSize(node), middle = size.height / 2, children = node.children ?? [];
  if (node.type === 'token') return <g transform={`translate(${x},${y})`}><rect x="0" y={middle - 17} width={size.width} height="34" rx={node.terminal ? 16 : 3} className={node.terminal ? 'rail-terminal' : 'rail-rule'} /><text x={size.width / 2} y={middle + 4} textAnchor="middle">{node.text || 'empty'}</text></g>;
  if (node.type === 'seq') {
    let cursor = 0;
    return <g transform={`translate(${x},${y})`}>{children.length === 0 && <path d={`M0 ${middle} H${size.width}`} />}{children.map((child, index) => {
      const childSize = railroadSize(child), childX = cursor + 12; cursor = childX + childSize.width + 12;
      return <g key={index}><path d={`M${childX - 12} ${middle} H${childX} M${childX + childSize.width} ${middle} H${cursor}`} /><Rail node={child} x={childX} y={(size.height - childSize.height) / 2} /></g>;
    })}<path d={`M${cursor} ${middle} H${size.width}`} /></g>;
  }
  if (node.type === 'choice') {
    let cursor = 0;
    return <g transform={`translate(${x},${y})`}>{children.map((child, index) => {
      const childSize = railroadSize(child), childY = cursor, lane = childY + childSize.height / 2; cursor += childSize.height + 18;
      return <g key={index}><path d={`M0 ${middle} H10 Q20 ${middle} 20 ${lane} H30 M${30 + childSize.width} ${lane} H${size.width - 20} Q${size.width - 10} ${lane} ${size.width - 10} ${middle} H${size.width}`} /><Rail node={child} x={30} y={childY} /></g>;
    })}</g>;
  }
  const child = children[0] ?? { type: 'seq' as const, children: [] }, childSize = railroadSize(child), lane = middle;
  const label = node.type === 'optional' ? 'optional' : node.max === null ? `${node.min ?? 0}+ times` : `${node.min}${node.min === node.max ? '' : `–${node.max}`} times`;
  return <g transform={`translate(${x},${y})`}><path d={`M0 ${lane} H30 M${30 + childSize.width} ${lane} H${size.width}`} /><Rail node={child} x={30} y={(size.height - childSize.height) / 2} />{node.type === 'optional' ? <path className="rail-bypass" d={`M8 ${lane} Q16 ${lane} 16 8 H${size.width - 16} Q${size.width - 8} 8 ${size.width - 8} ${lane}`} /> : <><path d={`M${size.width - 12} ${lane} V${size.height - 8} H12 V${lane}`} /><path className="rail-arrow" d={`M${size.width / 2 + 4} ${size.height - 12} L${size.width / 2 - 3} ${size.height - 8} L${size.width / 2 + 4} ${size.height - 4}`} />{node.min === 0 && <path className="rail-bypass" d={`M8 ${lane} V4 H${size.width - 8} V${lane}`} />}</>}<text className="rail-repetition" x={size.width / 2} y={node.type === 'optional' ? 9 : size.height - 13} textAnchor="middle">{label}</text></g>;
}

function RailroadContent({ tree }: { tree: Railroad }) {
  const size = railroadSize(tree);
  return <svg className="native-railroad" role="img" aria-label="Grammar railroad diagram" width={size.width + 28} height={size.height + 18} viewBox={`0 0 ${size.width + 28} ${size.height + 18}`}><circle className="rail-dot" cx="4" cy={size.height / 2 + 9} r="3" /><path d={`M4 ${size.height / 2 + 9} H14 M${size.width + 14} ${size.height / 2 + 9} H${size.width + 24}`} /><Rail node={tree} x={14} y={9} /><circle className="rail-dot" cx={size.width + 24} cy={size.height / 2 + 9} r="3" /></svg>;
}

const seriesColors = ['var(--vscode-charts-blue,#4c8eda)', 'var(--vscode-charts-orange,#e7a24b)', 'var(--vscode-charts-green,#77b777)', 'var(--vscode-charts-purple,#ae89c8)', 'var(--vscode-charts-red,#d46e76)'];
function Chart({ model }: { model: ChartModel }) {
  const width = 710, height = 390, plot = { x: 64, y: 24, width: 584, height: 282 };
  const horizontal = model.orientation === 'horizontal';
  const categoryAxis = horizontal ? model.vertical : model.horizontal;
  const numericAxis = horizontal ? model.horizontal : model.vertical;
  const values = model.series.flatMap(series => series.values.map(value => Array.isArray(value) ? value[1] : value));
  const count = Math.max(1, categoryAxis.categories?.length ?? Math.max(0, ...model.series.map(series => series.values.length)));
  const stackedMax = model.stacked ? Math.max(0, ...Array.from({ length: count }, (_, index) => model.series.reduce((sum, series) => sum + (typeof series.values[index] === 'number' ? Math.max(0, series.values[index] as number) : 0), 0))) : 0;
  const min = numericAxis.min ?? Math.min(0, ...values), max = numericAxis.max ?? Math.max(1, stackedMax, ...values) * 1.1;
  const spread = max - min || 1;
  const valuePosition = (value: number, series?: ChartSeries) => {
    const axis = series?.secondary ? model.secondary ?? numericAxis : numericAxis;
    const lo = axis.min ?? min, hi = axis.max ?? max, ratio = (value - lo) / (hi - lo || 1);
    return horizontal ? plot.x + ratio * plot.width : plot.y + plot.height - ratio * plot.height;
  };
  const categoryPosition = (index: number, x?: number) => {
    if (x !== undefined && model.horizontal.min !== undefined && model.horizontal.max !== undefined && !horizontal) return plot.x + (x - model.horizontal.min) / (model.horizontal.max - model.horizontal.min) * plot.width;
    return horizontal ? plot.y + (index + 0.5) / count * plot.height : plot.x + (index + 0.5) / count * plot.width;
  };
  const bars = model.series.filter(series => series.type === 'bar');
  const stacks = Array.from({ length: count }, () => ({ positive: 0, negative: 0 }));
  return <svg className="native-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Editable chart with axes and data series">
    <path className="chart-axis-line" d={`M${plot.x} ${plot.y} V${plot.y + plot.height} H${plot.x + plot.width}`} />
    {(numericAxis.ticks ?? Array.from({ length: 6 }, (_, index) => ({ value: min + spread * index / 5, label: String(Number((min + spread * index / 5).toFixed(2))) }))).map(({ value, label }, index) => { const coordinate = valuePosition(value); return <g key={index}>{numericAxis.grid && <path className="chart-grid" d={horizontal ? `M${coordinate} ${plot.y} V${plot.y + plot.height}` : `M${plot.x} ${coordinate} H${plot.x + plot.width}`} />}<text x={horizontal ? coordinate : plot.x - 8} y={horizontal ? plot.y + plot.height + 18 : coordinate + 4} textAnchor={horizontal ? 'middle' : 'end'}>{label}</text></g>; })}
    {model.secondary && !horizontal && <g><path className="chart-axis-line" d={`M${plot.x + plot.width} ${plot.y} V${plot.y + plot.height}`} />{Array.from({ length: 6 }, (_, index) => <text key={index} x={plot.x + plot.width + 8} y={plot.y + plot.height - index / 5 * plot.height + 4}>{Number(((model.secondary!.min ?? 0) + ((model.secondary!.max ?? 1) - (model.secondary!.min ?? 0)) * index / 5).toFixed(2))}</text>)}<text transform={`translate(${width - 8} ${plot.y + plot.height / 2}) rotate(90)`} textAnchor="middle">{model.secondary.name}</text></g>}
    {Array.from({ length: count }, (_, index) => { const coordinate = categoryPosition(index), label = categoryAxis.categories?.[index] ?? String(index + 1); return <text key={index} x={horizontal ? plot.x - 8 : coordinate} y={horizontal ? coordinate + 4 : plot.y + plot.height + 19} textAnchor={horizontal ? 'end' : 'middle'}>{label}</text>; })}
    <text className="chart-axis-title" x={plot.x + plot.width / 2} y={plot.y + plot.height + 42} textAnchor="middle">{model.horizontal.name}</text>
    <text className="chart-axis-title" transform={`translate(16 ${plot.y + plot.height / 2}) rotate(-90)`} textAnchor="middle">{model.vertical.name}</text>
    {model.series.map((series, seriesIndex) => {
      const color = series.color ?? seriesColors[seriesIndex % seriesColors.length];
      const points = series.values.map((entry, index) => { const x = Array.isArray(entry) ? entry[0] : undefined, value = Array.isArray(entry) ? entry[1] : entry, category = categoryPosition(index, x); return { x: horizontal ? valuePosition(value, series) : category, y: horizontal ? category : valuePosition(value, series), value, index }; });
      if (series.type === 'bar') {
        const band = (horizontal ? plot.height : plot.width) / count * 0.7, barIndex = bars.indexOf(series), thickness = model.stacked ? band : band / Math.max(1, bars.length);
        return <g key={series.id}>{points.map(point => {
          const stack = stacks[point.index], before = model.stacked ? point.value >= 0 ? stack.positive : stack.negative : 0;
          if (model.stacked) { if (point.value >= 0) stack.positive += point.value; else stack.negative += point.value; }
          const from = valuePosition(before, series), to = valuePosition(before + point.value, series), center = categoryPosition(point.index), offset = -band / 2 + (model.stacked ? 0 : barIndex * thickness);
          return <g key={point.index}><rect fill={color} opacity="0.88" x={horizontal ? Math.min(from, to) : center + offset} y={horizontal ? center + offset : Math.min(from, to)} width={horizontal ? Math.abs(to - from) : Math.max(1, thickness - 2)} height={horizontal ? Math.max(1, thickness - 2) : Math.abs(to - from)} />{series.labels && <text x={horizontal ? to + 5 : center + offset + thickness / 2} y={horizontal ? center + 4 : to - 5} textAnchor={horizontal ? 'start' : 'middle'}>{point.value}</text>}</g>;
        })}</g>;
      }
      const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
      const baseline = valuePosition(0, series), area = points.length ? `${path} L${horizontal ? baseline : points.at(-1)!.x},${horizontal ? points.at(-1)!.y : baseline} L${horizontal ? baseline : points[0].x},${horizontal ? points[0].y : baseline} Z` : '';
      return <g key={series.id}>{series.type === 'area' && <path d={area} fill={color} opacity="0.2" />}{series.type !== 'scatter' && <path d={path} stroke={color} strokeWidth="2.2" fill="none" />}{points.map((point, index) => <g key={index}><circle cx={point.x} cy={point.y} r={series.type === 'scatter' ? 4.5 : 3} fill={color} />{series.labels && <text x={point.x} y={point.y - 9} textAnchor="middle">{point.value}</text>}</g>)}</g>;
    })}
    {model.annotations.map((annotation, index) => { const category = categoryAxis.categories?.indexOf(annotation.x) ?? -1, x = category >= 0 ? categoryPosition(category) : categoryPosition(0, Number(annotation.x)); return <text className="chart-annotation" key={index} x={x} y={valuePosition(annotation.y) - 12} textAnchor="middle">{annotation.text}</text>; })}
    {model.series.map((series, index) => <g key={series.id} transform={`translate(${plot.x + index % 4 * 145},${height - 16 - Math.floor(index / 4) * 19})`}><rect width="12" height="8" y="-7" fill={series.color ?? seriesColors[index % seriesColors.length]} /><text x="18" y="0">{series.name}</text></g>)}
  </svg>;
}

export function DataContent({ element }: { element: DiagramElement }): ReactNode {
  const details = element.meta ?? {}, kind = element.kind;
  if (kind === 'chart-jcckit') return null;
  if (kind.startsWith('data-')) {
    if (details.tableCollection) {
      const rows = details.tableRows as DataTableRow[];
      return <div className={`data-table-grid ${details.tableArray ? 'data-table-array' : 'data-table-object'}`} aria-label={details.tableArray ? 'Array table' : 'Object table'}>{rows.length ? rows.map(row => <div className="data-table-slot" key={row.id} style={{ height: row.height }}>{row.collection && <><span className="data-table-key">{row.key}</span><span className="data-table-reference" aria-label={`Nested collection ${row.key}`}>●</span></>}</div>) : <div className="data-table-empty">{details.tableArray ? '[]' : '{}'}</div>}</div>;
    }
    if (details.tableRow) return <div className={`data-table-row ${details.tableArrayItem ? 'data-table-array-row' : ''}`} style={{ height: Number(details.height) }}><code>{typeof details.value === 'string' ? details.value : JSON.stringify(details.value)}</code></div>;
    const collection = details.dataType === 'object' || details.dataType === 'array';
    const count = details.value && typeof details.value === 'object' ? Object.keys(details.value).length : 0;
    return <div className={`data-value data-type-${details.dataType}`}><span className="data-kind-icon">{details.dataType === 'array' ? <Brackets size={22} /> : details.dataType === 'object' ? <Braces size={22} /> : details.dataType === 'reference' ? <Link2 size={18} /> : <span>{details.dataType === 'string' ? 'Aa' : details.dataType === 'number' ? '#' : details.dataType === 'boolean' ? '◉' : '∅'}</span>}</span>{collection ? <span>{count} {count === 1 ? 'item' : 'items'}</span> : <code>{details.dataType === 'string' ? String(details.value) : details.dataType === 'reference' ? String(details.value) : JSON.stringify(details.value)}</code>}<small>{String(details.dataType)}</small></div>;
  }
  if (kind.startsWith('salt-')) {
    if (kind === 'salt-panel') return <div className="salt-panel-fill" />;
    if (kind === 'salt-spacer') return <span />;
    if (kind === 'salt-separator') return <hr className="salt-separator" />;
    const name = element.name, labelStyle = { fontWeight: details.bold ? 700 : undefined, fontStyle: details.italic ? 'italic' : undefined };
    return <div className="salt-widget" style={labelStyle}>
      {kind === 'salt-label' && <span>{name}</span>}
      {kind === 'salt-button' && <button tabIndex={-1} aria-label={`Wireframe button ${name}`} type="button">{name}</button>}
      {kind === 'salt-input' && <input value={name} readOnly tabIndex={-1} aria-label={`Wireframe input ${name}`} />}
      {kind === 'salt-select' && <select value={name} tabIndex={-1} aria-label={`Wireframe select ${name}`} onChange={() => {}}><option>{name}</option></select>}
      {(kind === 'salt-checkbox' || kind === 'salt-radio') && <label><input type={kind === 'salt-radio' ? 'radio' : 'checkbox'} checked={Boolean(details.checked)} readOnly tabIndex={-1} /><span>{name}</span></label>}
    </div>;
  }
  if (kind.startsWith('grammar-')) return details.railroad ? <RailroadContent tree={details.railroad as Railroad} /> : null;
  if (kind.startsWith('math-')) return <div className="native-math" aria-label="Mathematical formula" dangerouslySetInnerHTML={{ __html: String(details.mathml ?? '') }} />;
  if (kind === 'chart-plot') return <Chart model={details.chart as ChartModel} />;
  if (kind === 'chart-axis') { const axis = details.axisValue as { name: string; categories?: string[]; min?: number; max?: number }; return <div className="chart-data-card"><strong>{String(details.axis)} · {axis.name}</strong><code>{axis.categories?.join(' · ') ?? `${axis.min ?? 'auto'} → ${axis.max ?? 'auto'}`}</code><small>Double-click to edit the axis</small></div>; }
  if (kind.startsWith('chart-')) { const series = details.series as ChartSeries; return <div className="chart-data-card"><span className="chart-series-swatch" style={{ background: series?.color ?? seriesColors[0] }} /><code>{element.members.join(' · ')}</code><small>{series?.type} series · Double-click values to edit</small></div>; }
  if (kind.startsWith('files-')) return <div className="files-content">{kind === 'files-folder' ? <Folder size={22} /> : <FileText size={22} />}<span>{element.members.length ? element.members.join('\n') : kind === 'files-folder' ? 'Folder' : 'File'}</span></div>;
  return null;
}
