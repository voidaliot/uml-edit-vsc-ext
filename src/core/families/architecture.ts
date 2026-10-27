import type { DiagramBlock, DiagramEdit, DiagramElement, DiagramKind, DiagramRelation, DiagramTemplate, Point } from '../../shared/protocol';
import type { NativeFamily } from './types';

type Span = { start: number; end: number };
type Token = Span & { text: string; line: number };
type ElementMeta = Record<string, unknown> & { declaration?: Span; labelSpan?: Span; quoted?: boolean; suffix?: string; body?: Span; macro?: string; args?: Span[] };
const kinds: readonly DiagramKind[] = ['c4', 'archimate', 'network', 'chen', 'dot', 'ditaa', 'board', 'git', 'jcckit'];
const q = (s: string) => JSON.stringify(s);
const uq = (s: string) => { try { return s.startsWith('"') ? JSON.parse(s) as string : s; } catch { return s.replace(/^"|"$/g, ''); } };
const slug = (s: string) => s.replace(/[^\w]/g, '_').replace(/^\d/, 'n_$&') || 'element';
const meta = (e: DiagramElement) => e.meta as ElementMeta;
const safeName = (s: string) => { if (!s.trim() || /[\r\n\0]/.test(s)) throw new Error('Enter a name on one line.'); return s.trim(); };
function hash(s: string) { let n = 2166136261; for (const c of s) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return (n >>> 0).toString(36); }
function unique(block: DiagramBlock, prefix: string) { let i = 1; while (block.elements.some(e => e.id === `${prefix}_${i}`)) i++; return `${prefix}_${i}`; }
function lineAt(source: string, offset: number) { return source.slice(0, offset).split('\n').length - 1; }
function sourceLines(block: DiagramBlock): Token[] { let pos = 0; return block.source.split(/\r?\n/).map((text, index) => { const t = { text, start: pos, end: pos + text.length, line: block.startLine + index }; pos += text.length + (block.source.slice(pos + text.length, pos + text.length + 2) === '\r\n' ? 2 : 1); return t; }); }
function maskComments(source: string): string {
  const chars = source.split(''); let quoted = false, escaped = false, blockEnd = '', lineComment = false;
  for (let i = 0; i < chars.length; i++) { const c = source[i];
    if (blockEnd) { if (source.slice(i,i + 2) === blockEnd) { chars[i] = chars[i + 1] = ' '; i++; blockEnd = ''; } else if (c !== '\n' && c !== '\r') chars[i] = ' '; continue; }
    if (lineComment) { if (c === '\n') lineComment = false; else if (c !== '\r') chars[i] = ' '; continue; }
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (source.slice(i,i + 2) === "/'" || source.slice(i,i + 2) === '/*') { blockEnd = source[i + 1] === "'" ? "'/" : '*/'; chars[i] = chars[i + 1] = ' '; i++; }
    else if (c === "'" || source.slice(i,i + 2) === '//') { lineComment = true; chars[i] = ' '; }
  }
  return chars.join('');
}
/** Tokenize structural delimiters, retaining original offsets, quoted strings and comments. */
function tokens(block: DiagramBlock): Token[] {
  const s = maskComments(block.source); const result: Token[] = []; let begin = 0, quote = false, escape = false, parens = 0, brackets = 0, comment = false;
  const push = (end: number) => { const raw = s.slice(begin, end); const trim = raw.trim(); if (trim) { const start = begin + raw.indexOf(trim); result.push({ text: trim, start, end: start + trim.length, line: block.startLine + lineAt(s, start) }); } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (comment) { if (c === '\n') { comment = false; begin = i + 1; } continue; }
    if (quote) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quote = false; continue; }
    if (c === '"') { quote = true; continue; }
    if ((c === "'" || (c === '/' && s[i + 1] === '/')) && parens === 0 && brackets === 0) { push(i); comment = true; continue; }
    if (c === '(') parens++; if (c === ')') parens--;
    if (c === '[') brackets++; if (c === ']') brackets--;
    if (!parens && !brackets && /[{};\n]/.test(c)) { push(i); if (c === '{' || c === '}') result.push({ text: c, start: i, end: i + 1, line: block.startLine + lineAt(s, i) }); begin = i + 1; }
  }
  push(s.length); return result;
}
function args(t: Token): { value: string; span: Span }[] {
  const start = t.text.indexOf('(') + 1, end = t.text.lastIndexOf(')'); if (!start || end < start) return [];
  const result: { value: string; span: Span }[] = []; let begin = start, quoted = false, escape = false, depth = 0;
  const add = (i: number) => { const raw = t.text.slice(begin, i), value = raw.trim(); const p = t.start + begin + raw.indexOf(value); result.push({ value: uq(value), span: { start: p, end: p + value.length } }); };
  for (let i = start; i < end; i++) { const c = t.text[i]; if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; } else if (c === '"') quoted = true; else if ('(['.includes(c)) depth++; else if (')]'.includes(c)) depth--; else if (c === ',' && !depth) { add(i); begin = i + 1; } }
  add(end); return result;
}
function attributes(text: string) { const result: Record<string, string> = Object.create(null); for (const m of text.matchAll(/([\w/]+)\s*=\s*("(?:\\.|[^"\\])*"|[^,\]\s]+)/g)) result[m[1]] = uq(m[2]); return result; }
function labelSpan(t: Token, text: string, last = false): Span { const i = last ? t.text.lastIndexOf(text) : t.text.indexOf(text); return { start: t.start + i, end: t.start + i + text.length }; }
function add(block: DiagramBlock, t: Token, id: string, name: string, kind: string, extra: ElementMeta = {}, members: string[] = [], parentId?: string) {
  const existing = block.elements.find(e => e.id === id); if (existing) return existing;
  const element: DiagramElement = { id, name, kind, members, startLine: t.line, endLine: t.line, ...(parentId ? { parentId } : {}), meta: { width: 210, height: members.length ? 126 : 78, declaration: { start: t.start, end: t.end }, ...extra } };
  block.elements.push(element); return element;
}
function relation(block: DiagramBlock, t: Token, source: string, target: string, label = '', arrow = '-->', extra: Record<string, unknown> = {}) {
  const id = `architecture-rel-${t.start}-${block.relations.length}`; const r: DiagramRelation = { id, source, target, label, arrow, startLine: t.line, endLine: t.line };
  block.relations.push(r); (block.meta!.relationSpans as Record<string, unknown>)[id] = { declaration: { start: t.start, end: t.end }, ...extra }; return r;
}
function ignored(text: string) { return /^(?:@|!|title\b|caption\b|legend\b|endlegend\b|skinparam\b|hide\b|show\b|left to right\b|top to bottom\b|LAYOUT_|SHOW_|Add\w+\s*\(|Update\w+\s*\(|Lay_|scale\b|sprite\b|<style>|<\/style>)/i.test(text); }

function macros(block: DiagramBlock) {
  const stack: (DiagramElement | undefined)[] = []; let pending: DiagramElement | undefined;
  for (const t of tokens(block)) {
    if (t.text === '{') { stack.push(pending); if (pending) meta(pending).body = { start: t.end, end: t.end }; pending = undefined; continue; }
    if (t.text === '}') { const parent = stack.pop(); if (parent) { meta(parent).declaration!.end = t.end; meta(parent).body!.end = t.start; parent.endLine = t.line; } continue; }
    const m = t.text.match(/^([\w]+)\s*\(/); if (!m) {
      const container = t.text.match(/^(?:package|rectangle|frame|node)\s+("(?:\\.|[^"\\])*"|[\w.]+)(?:\s+as\s+(\w+))?/);
      if (container) { pending = add(block, t, container[2] || uq(container[1]), uq(container[1]), `${block.kind}-boundary`, { labelSpan: labelSpan(t, container[1]), quoted: true, suffix: container[2] ? '' : ` as ${uq(container[1])}`, container: true, width: 540, height: 280 }, [], stack.filter(Boolean).at(-1)?.id); continue; }
      if (block.kind === 'archimate') {
        const direct = t.text.match(/^archimate\s+(?:#(\w+)\s+)?("(?:\\.|[^"\\])*"|\w+)\s+as\s+(\w+)(?:\s+<<([^>]+)>>)?/i);
        if (direct) { add(block, t, direct[3], uq(direct[2]), 'archimate-' + (direct[4] || direct[1] || 'element').toLowerCase(), { labelSpan: labelSpan(t, direct[2]), quoted: true, layer: direct[1] || direct[4]?.split('-')[0], shape: direct[4] }, [], stack.filter(Boolean).at(-1)?.id); continue; }
        const edge = t.text.match(/^(\w+)\s+([<|o*+.#=\-]+>?)\s+(\w+)(?:\s*:\s*(.*))?$/); if (edge) relation(block, t, edge[1], edge[3], edge[4] || '', edge[2]);
      }
      continue;
    }
    const command = m[1], a = args(t);
    if (/^(?:Bi)?Rel(?:_|$)/i.test(command)) { const arrow = /^Bi/.test(command) ? '<-->' : /_Back/.test(command) ? '<--' : /Composition/.test(command) ? '*--' : /Aggregation/.test(command) ? 'o--' : /Realization/.test(command) ? '..|>' : '-->'; if (a.length >= 2) relation(block, t, a[0].value, a[1].value, a[2]?.value || '', arrow, { macro: command, args: a.map(x => x.span) }); continue; }
    if (ignored(t.text)) continue;
    const valid = block.kind === 'c4' ? /^(?:Person|System|Container|Component|Boundary|Enterprise|Deployment|Node)/.test(command) : /^(?:Business|Application|Technology|Physical|Motivation|Strategy|Implementation|Junction|Group|Other)/.test(command);
    if (!valid || a.length < 2) { block.graphical = false; block.warnings.push(`Line ${t.line + 1}: The custom macro ${command} has no native definition. Its source is preserved.`); continue; }
    const container = /Boundary|^Group(?:ing)?$|Deployment_Node|^Node$/.test(command); const shape = /(?:Db|Database)/i.test(command) ? 'database' : /Queue/.test(command) ? 'queue' : /^Person/.test(command) ? 'person' : /Actor/.test(command) ? 'actor' : /Junction/.test(command) ? 'ellipse' : /Service/.test(command) ? 'service' : /Process/.test(command) ? 'process' : 'box';
    const members = a.slice(2).map(x => x.value).filter(Boolean); const detailLines = members.slice(0, 2).reduce((n, s) => n + s.split('\n').reduce((k, part) => k + Math.ceil(part.length / 29), 0), 0);
    const element = add(block, t, a[0].value, a[1].value, `${block.kind}-${container ? 'boundary' : shape}`, { macro: command, args: a.map(x => x.span), labelSpan: a[1].span, quoted: true, container, shape, layer: command.split('_')[0], external: /_Ext/.test(command), editMembers: !container, width: container ? 540 : 220, height: container ? 300 : Math.max(shape === 'person' ? 190 : 130, (shape === 'person' ? 142 : 76) + detailLines * 18) }, members, stack.filter(Boolean).at(-1)?.id);
    pending = container ? element : undefined;
  }
}

function chen(block: DiagramBlock) {
  const stack: DiagramElement[] = []; let pending: DiagramElement | undefined;
  for (const t of tokens(block)) {
    if (t.text === '{') { if (pending) { stack.push(pending); meta(pending).body = { start: t.end, end: t.end }; pending = undefined; } continue; }
    if (t.text === '}') { const parent = stack.pop(); if (parent) { meta(parent).body!.end = t.start; meta(parent).declaration!.end = t.end; parent.endLine = t.line; } continue; }
    if (ignored(t.text)) continue;
    const declaration = t.text.match(/^(entity|relationship)\s+("(?:\\.|[^"\\])*"|[\w.]+)(?:\s+as\s+(\w+))?/);
    if (declaration) {
      pending = add(block, t, declaration[3] || uq(declaration[2]), uq(declaration[2]), `chen-${declaration[1]}`, { labelSpan: labelSpan(t, declaration[2]), quoted: !!declaration[3], suffix: declaration[3] ? '' : ` as ${uq(declaration[2])}`, shape: declaration[1] === 'relationship' ? 'diamond' : 'box', weak: /<<weak>>/.test(t.text), identifying: /<<identifying>>/.test(t.text), width: declaration[1] === 'relationship' ? 150 : 190, height: declaration[1] === 'relationship' ? 100 : 78 }); continue;
    }
    const edge = t.text.match(/^(\w+)\s+([-=>]+(?:\([^)]*\)|[\w<>]+)?[-=<>]+)\s+(\w+)$/);
    if (edge && !stack.length) { const r = relation(block, t, edge[1], edge[3], edge[2].replace(/^[-=]+|[-=]+$/g, ''), edge[2].includes('>') ? '-->' : '--'); r.sourceMultiplicity = r.label; r.label = ''; continue; }
    if (stack.length) {
      const m = t.text.match(/^("(?:\\.|[^"\\])*"|[^:<]+?)(?:\s+as\s+(\w+))?(?:\s*:\s*([^<]+))?(?:\s*<<.*)?$/); if (!m) continue;
      const parent = stack.at(-1)!; const name = uq(m[1].trim()); const id = `${parent.id}.${m[2] || name}`;
      pending = add(block, t, id, name, 'chen-attribute', { labelSpan: labelSpan(t, m[1].trim()), quoted: !!m[2], suffix: '', owner: parent.id, shape: 'ellipse', key: /<<key>>/.test(t.text), multi: /<<multi>>/.test(t.text), derived: /<<derived>>/.test(t.text), width: 150, height: 64 }, m[3] ? [m[3].trim()] : []);
      relation(block, t, parent.id, id, '', '--', { derived: true });
    }
  }
}

function network(block: DiagramBlock) {
  const stack: (DiagramElement | undefined)[] = []; let pending: DiagramElement | undefined;
  for (const t of tokens(block)) {
    if (t.text === '{') { stack.push(pending); if (pending) meta(pending).body = { start: t.end, end: t.end }; pending = undefined; continue; }
    if (t.text === '}') { const p = stack.pop(); if (p) { meta(p).body!.end = t.start; meta(p).declaration!.end = t.end; p.endLine = t.line; } continue; }
    if (ignored(t.text) || /^nwdiag\b/.test(t.text)) continue;
    const net = t.text.match(/^(network|group)\s*("[^"]*"|[\w.-]+)?$/);
    if (net) { const id = `${net[1]}:${uq(net[2] || unique(block, 'group'))}`; pending = add(block, t, id, uq(net[2] || 'Group'), `network-${net[1] === 'network' ? 'bus' : 'group'}`, { labelSpan: net[2] ? labelSpan(t, net[2]) : undefined, quoted: true, container: net[1] === 'group', width: 540, height: net[1] === 'group' ? 240 : 66 }); continue; }
    const setting = t.text.match(/^(address|description|color|width)\s*=\s*(.*)$/); if (setting) { const p = stack.filter(Boolean).at(-1); if (p) { if (setting[1] === 'description') p.name = uq(setting[2]); if (setting[1] === 'address') p.members = [uq(setting[2])]; meta(p)[setting[1]] = uq(setting[2]); if (setting[1] === 'description') { meta(p).labelSpan = labelSpan(t, setting[2]); meta(p).quoted = true; } } continue; }
    const peer = t.text.match(/^("[^"]+"|[\w.-]+)\s*--\s*("[^"]+"|[\w.-]+)$/); if (peer) { const a = uq(peer[1]), b = uq(peer[2]); for (const id of [a,b]) add(block, t, id, id, 'network-device', { implicit: true }); relation(block, t, a, b, '', '--'); continue; }
    const device = t.text.match(/^("[^"]+"|[\w.-]+)\s*(?:\[([\s\S]*)\])?$/); if (!device) continue;
    const id = uq(device[1]), attrs = attributes(device[2] || ''); const p = stack.filter(Boolean).at(-1);
    const description = t.text.match(/description\s*=\s*("(?:\\.|[^"\\])*"|[^,\]]+)/);
    const existing = block.elements.find(e => e.id === id); const e = add(block, t, id, attrs.description || id, `network-${attrs.shape === 'database' ? 'database' : attrs.shape === 'cloud' ? 'cloud' : 'device'}`, { labelSpan: description ? labelSpan(t, description[1]) : undefined, quoted: true, attributes: attrs, width: 180, height: 88, shape: attrs.shape || 'device' }, attrs.address ? [attrs.address] : [], p?.kind === 'network-group' ? p.id : undefined);
    if (existing && attrs.address && !e.members.includes(attrs.address)) e.members.push(attrs.address);
    if (p?.kind === 'network-group') e.parentId = p.id;
    const bus = stack.filter(item => item?.kind === 'network-bus').at(-1); if (bus) relation(block, t, bus.id, id, attrs.address || '', '--', { derived: true, membership: true });
  }
}

function dot(block: DiagramBlock) {
  const stack: (DiagramElement | undefined)[] = []; let pending: DiagramElement | undefined; let defaults: Record<string, string> = {};
  for (const t of tokens(block)) {
    if (t.text === '{') { stack.push(pending); if (pending) meta(pending).body = { start: t.end, end: t.end }; pending = undefined; continue; }
    if (t.text === '}') { const p = stack.pop(); if (p) { meta(p).body!.end = t.start; meta(p).declaration!.end = t.end; p.endLine = t.line; } continue; }
    if (ignored(t.text) || /^(?:strict\s+)?(?:di)?graph\b/.test(t.text)) continue;
    const group = t.text.match(/^subgraph\s+("[^"]*"|[\w.-]+)/); if (group) { pending = add(block, t, uq(group[1]), uq(group[1]).replace(/^cluster_?/, ''), 'dot-cluster', { container: true, width: 520, height: 280 }); continue; }
    if (/^node\s*\[/.test(t.text)) { defaults = { ...defaults, ...attributes(t.text) }; continue; }
    if (/^(?:edge|graph)\s*\[/.test(t.text)) continue;
    const setting = t.text.match(/^(\w+)\s*=\s*(.*)$/); if (setting) { const p = stack.filter(Boolean).at(-1); if (setting[1] === 'label' && p) { p.name = uq(setting[2]); meta(p).labelSpan = labelSpan(t, setting[2]); meta(p).quoted = true; } if (setting[1] === 'rankdir') block.meta!.direction = uq(setting[2]); continue; }
    const idPattern = '"(?:\\\\.|[^"\\\\])*"|[\\w.-]+';
    const edge = new RegExp(`^(${idPattern})(?::\\w+)?\\s*(->|--)\\s*([\\s\\S]*)$`).exec(t.text);
    if (edge) {
      const nodeText = t.text.split('[')[0]; const ids = nodeText.split(/\s*(?:->|--)\s*/).map(s => uq(s.trim().replace(/:\w+(?::\w+)?$/, ''))); const attrs = attributes(t.text);
      for (const id of ids) add(block, t, id, id, `dot-${defaults.shape || 'ellipse'}`, { implicit: true, shape: defaults.shape || 'ellipse', width: 160, height: 76 }, [], stack.filter(Boolean).at(-1)?.id);
      for (let i = 1; i < ids.length; i++) relation(block, t, ids[i - 1], ids[i], attrs.label || '', edge[2] === '->' ? '-->' : '--', { dot: true, chain: ids.length > 2 }); continue;
    }
    const node = new RegExp(`^(${idPattern})\\s*(?:\\[([\\s\\S]*)\\])?$`).exec(t.text); if (!node) continue;
    const id = uq(node[1]), attrs = { ...defaults, ...attributes(node[2] || '') }, label = t.text.match(/\blabel\s*=\s*("(?:\\.|[^"\\])*"|[^,\]\s]+)/); const existing = block.elements.find(e => e.id === id);
    if (existing && meta(existing).implicit) block.elements.splice(block.elements.indexOf(existing), 1);
    add(block, t, id, attrs.label || id, `dot-${attrs.shape || 'ellipse'}`, { labelSpan: label ? labelSpan(t, label[1]) : undefined, quoted: true, shape: attrs.shape || 'ellipse', attributes: attrs, width: 180, height: /diamond/.test(attrs.shape || '') ? 120 : 80 }, [], stack.filter(Boolean).at(-1)?.id);
  }
}

function board(block: DiagramBlock) {
  const parents: DiagramElement[] = []; const counts = new Map<string, number>();
  for (const t of sourceLines({ ...block, source: maskComments(block.source) })) { const m = t.text.match(/^(\s*)(\+*)\s*(.+?)\s*$/); if (!m || ignored(m[3]) || /^['#]/.test(m[3])) continue;
    const depth = m[2].length, name = m[3], key = `${depth}-${hash(name)}`, count = counts.get(key) || 0; counts.set(key, count + 1);
    const parent = depth ? parents[Math.min(depth - 1, parents.length - 1)] : undefined; const e = add(block, t, `board-${key}-${count}`, name, depth ? 'board-card' : 'board-column', { labelSpan: labelSpan(t, name, true), depth, container: depth === 0, width: depth ? 238 : 282, height: depth ? 88 : 300 }, [], parent?.id);
    parents[depth] = e; parents.length = depth + 1;
  }
  block.meta!.derivedRelations = true;
}

function git(block: DiagramBlock) {
  const rows = sourceLines(block); const stars = new Map<string, DiagramElement>();
  for (const t of rows) { const m = t.text.match(/^([| /\\.\-]*\*)[ |/\\.\-]*\s+([a-fA-F\d]{3,40}|[\w.-]+)(?:\s+\(([^)]*)\))?(?:\s+(.*))?$/); if (!m) continue;
    const lane = m[1].indexOf('*'), id = m[2], label = m[4] || id; const e = add(block, t, id, label, 'git-commit', { labelSpan: m[4] ? labelSpan(t, m[4], true) : undefined, lane, hash: id, refs: m[3] || '', width: 34, height: 34, x: 60 + lane * 60, y: 50 + block.elements.length * 108 });
    stars.set(`${lane},${t.line - block.startLine}`, e);
  }
  for (const [key, from] of stars) { const [x0, y0] = key.split(',').map(Number); const queue: [number,number][] = [[x0,y0 + 1], [x0 + 1,y0 + 1]]; const seen = new Set<string>(), targets = new Set<string>();
    while (queue.length && seen.size < rows.length * 30) { const [x,y] = queue.shift()!, k = `${x},${y}`; if (seen.has(k)) continue; seen.add(k); const target = stars.get(k); if (target) { targets.add(target.id); continue; } const c = rows[y]?.text[x] || ''; if (c === '|') { queue.push([x,y + 1]); if (rows[y + 1]?.text[x - 1] === '/') queue.push([x - 1,y + 1]); if (rows[y + 1]?.text[x + 1] === '\\') queue.push([x + 1,y + 1]); } else if (c === '\\') queue.push([x + 1,y + 1], [x,y + 1]); else if (c === '/') queue.push([x - 1,y + 1], [x,y + 1]); else if (c === '-') queue.push([x + 1,y], [x - 1,y]); }
    for (const target of targets) relation(block, rows[y0], from.id, target, '', '-->', { derived: true });
  }
  block.meta!.derivedRelations = true;
}

function ditaa(block: DiagramBlock) {
  const rows = sourceLines(block); const boxes: { e: DiagramElement; left: number; right: number; top: number; bottom: number }[] = [];
  for (let y = 1; y < rows.length - 1; y++) { const row = rows[y]; for (const m of row.text.matchAll(/[+\/]([-=:]{2,})[+\\]/g)) {
    const left = m.index!, right = left + m[0].length - 1; let bottom = y + 1;
    while (bottom < rows.length - 1 && /[|:+]/.test(rows[bottom].text[left] || '') && /[|:+]/.test(rows[bottom].text[right] || '') && !/^[-=:+]+$/.test(rows[bottom].text.slice(left + 1, right))) bottom++;
    if (bottom <= y + 1 || !/[+\\]/.test(rows[bottom]?.text[left] || '') || !/[+\/]/.test(rows[bottom]?.text[right] || '') || !/^[-=:+]+$/.test(rows[bottom].text.slice(left + 1, right))) continue;
    const inner = rows.slice(y + 1, bottom).map(r => r.text.slice(left + 1, right)); const labelRows = inner.map(s => s.replace(/\{[dsio]\}|\bc(?:[0-9A-Fa-f]{3}|BLK|BLU|GRE|PNK|RED|YEL|WHT)\b/g, '').trim()).filter(Boolean); const name = labelRows.join(' ') || 'Shape'; const labelRow = inner.findIndex(s => s.replace(/\{[dsio]\}|\bc(?:[0-9A-Fa-f]{3}|BLK|BLU|GRE|PNK|RED|YEL|WHT)\b/g, '').trim()); const labelText = labelRow >= 0 ? inner[labelRow].replace(/\{[dsio]\}|\bc(?:[0-9A-Fa-f]{3}|BLK|BLU|GRE|PNK|RED|YEL|WHT)\b/g, '').trim() : ''; const actual = rows[y + 1 + Math.max(0, labelRow)]; const start = labelText ? actual.text.indexOf(labelText, left + 1) : left + 2;
    const marker = inner.join(' '); const shape = /\{s\}/.test(marker) ? 'database' : /\{d\}/.test(marker) ? 'document' : 'box'; const markerIndex = actual.text.slice(start,right).search(/\{[dsio]\}|\bc(?:[0-9A-Fa-f]{3}|BLK|BLU|GRE|PNK|RED|YEL|WHT)\b/); const labelEnd = markerIndex < 0 ? right - 1 : start + markerIndex;
    const extraLabelSpans = inner.flatMap((text, i) => { const value = text.replace(/\{[dsio]\}|\bc(?:[0-9A-Fa-f]{3}|BLK|BLU|GRE|PNK|RED|YEL|WHT)\b/g, '').trim(); if (!value || i === labelRow) return []; const row = rows[y + 1 + i], at = row.text.indexOf(value,left + 1); return [{ start: row.start + at, end: row.start + at + value.length }]; });
    const e = add(block, row, `ditaa-${y}-${left}`, name, `ditaa-${shape}`, { labelSpan: { start: actual.start + start, end: actual.start + labelEnd }, extraLabelSpans, ditaaBox: { left, right, top: y, bottom }, shape, x: left * 12 + 40, y: (y - 1) * 22 + 40, width: Math.max(100, (right - left) * 12), height: Math.max(64, (bottom - y) * 22), fixedLabelWidth: labelEnd - start, declaration: { start: row.start + left, end: rows[bottom].start + right + 1 } }); e.endLine = rows[bottom].line; boxes.push({ e, left, right, top: y, bottom });
  } }
  const ownerAt = (x: number, y: number) => boxes.find(b => (x === b.left || x === b.right) && y > b.top && y < b.bottom || (y === b.top || y === b.bottom) && x > b.left && x < b.right);
  const connected = new Set<string>();
  for (const box of boxes) {
    const starts: [number, number][] = []; for (let y = box.top + 1; y < box.bottom; y++) { starts.push([box.left - 1, y], [box.right + 1, y]); } for (let x = box.left + 1; x < box.right; x++) starts.push([x, box.top - 1], [x, box.bottom + 1]);
    for (const [sx, sy] of starts) {
      if (!/[-=|:+<>v^]/.test(rows[sy]?.text[sx] || '')) continue;
      const queue: [number, number][] = [[sx, sy]], visited = new Set<string>(); let target: typeof box | undefined;
      while (queue.length && visited.size < 10000 && !target) { const [x, y] = queue.shift()!; const key = `${x},${y}`; if (visited.has(key)) continue; visited.add(key);
        const owner = ownerAt(x, y); if (owner && owner !== box) { target = owner; break; } if (owner === box) continue;
        const c = rows[y]?.text[x] || ''; if (!/[-=|:+<>v^]/.test(c)) continue;
        const dirs = /[-=<>]/.test(c) ? [[-1,0],[1,0]] : /[|v^]/.test(c) ? [[0,-1],[0,1]] : [[-1,0],[1,0],[0,-1],[0,1]]; for (const [dx,dy] of dirs) queue.push([x + dx, y + dy]);
      }
      if (target) { const key = [box.e.id, target.e.id].sort().join('|'); if (!connected.has(key)) { connected.add(key); relation(block, rows[sy], box.e.id, target.e.id, '', '-->', { derived: true }); } }
    }
  }
  block.meta!.derivedRelations = true;
}

function chart(block: DiagramBlock) {
  const config: Record<string, string> = Object.create(null), spans: Record<string, Span> = Object.create(null); let title = 'Chart', titleSpan: Span | undefined;
  for (const t of sourceLines(block)) { const titleMatch = t.text.match(/^\s*#\s*Aliot title:\s*(.*)$/); if (titleMatch) { title = titleMatch[1]; titleSpan = labelSpan(t, titleMatch[1]); continue; } const m = t.text.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/); if (m) { config[m[1]] = m[2]; spans[m[1]] = labelSpan(t, m[2], true); } }
  const resolve = (key: string): string | undefined => { if (Object.hasOwn(config, key)) return config[key]; const parts = key.split('/'); for (let i = parts.length - 1; i > 0; i--) { const prefix = parts.slice(0, i).join('/') + '/'; if (config[prefix] && config[prefix] !== prefix) return config[config[prefix] + parts.slice(i).join('/')]; } return undefined; };
  const names = (config['data/curves'] || '').split(/\s+/).filter(Boolean); const series = names.map((id, index) => { const x = (resolve(`data/${id}/x`) || '').split(/\s+/).filter(Boolean).map(Number); const y = (resolve(`data/${id}/y`) || '').split(/\s+/).filter(Boolean).map(Number); const def = (config['plot/curveFactory/definitions'] || '').split(/\s+/)[index]; const factory = resolve(`plot/curveFactory/${def}/symbolFactory/className`) || config['defaultDefinition/symbolFactory/className'] || ''; return { id, name: resolve(`data/${id}/title`) || id, x, y, mode: /BarFactory/.test(factory) ? 'bar' : /ErrorBar/.test(factory) ? 'error' : 'line' }; });
  const members = series.flatMap(s => [`${s.id}.title = ${s.name}`, `${s.id}.x = ${s.x.join(' ')}`, `${s.id}.y = ${s.y.join(' ')}`]);
  const first = sourceLines(block)[0]; add(block, first, 'jcckit-chart', title, 'chart-jcckit', { width: 680, height: 400, labelSpan: titleSpan, config, configSpans: spans, series, editMembers: true, xLabel: resolve('plot/coordinateSystem/xAxis/axisLabel') || 'x', yLabel: resolve('plot/coordinateSystem/yAxis/axisLabel') || 'y', xMin: Number(resolve('plot/coordinateSystem/xAxis/minimum')), xMax: Number(resolve('plot/coordinateSystem/xAxis/maximum')), yMin: Number(resolve('plot/coordinateSystem/yAxis/minimum')), yMax: Number(resolve('plot/coordinateSystem/yAxis/maximum')) }, members);
  block.meta!.derivedRelations = true;
}

function parse(block: DiagramBlock, _lines: string[]) {
  block.elements = []; block.relations = []; block.meta = { ...block.meta, family: 'architecture', relationSpans: Object.create(null) };
  const variables: Record<string,string> = Object.create(null), visible = maskComments(block.source).split(/\r?\n/);
  for (const t of sourceLines(block)) { const v = t.text.match(/^\s*!(\$\w+)\s*=\s*"([^"]+)"/); if (v) variables[v[1]] = v[2]; }
  for (const t of sourceLines(block)) {
    if (!visible[t.line - block.startLine]?.trim()) continue;
    const include = t.text.match(/^\s*!include\s+(\S+)/)?.[1].replace(/\$\w+/g, name => variables[name] || name);
    if (include && /(?:tupadr3\/plantuml-icon-font-sprites\/|^<(?:tupadr3|office|logos|devicons)\/)/.test(include)) { if (!block.warnings.some(w => w.includes('Icon styling'))) block.warnings.push('Icon styling is represented by native shape symbols; source icon declarations are preserved.'); }
    else if (include && !/^(?:<C4\/C4_[^>]+>|<archimate\/Archimate>|https:\/\/raw\.githubusercontent\.com\/plantuml-stdlib\/C4-PlantUML\/[^\s]+\/C4_[\w]+\.puml|C4_[\w]+\.puml)$/.test(include)) { block.graphical = false; block.warnings.push(`Line ${t.line + 1}: External include has no native definition; its source remains available.`); }
    else if (/^\s*!(?:function|procedure|definelong|define|if|foreach|while|includeurl)\b/.test(t.text)) { block.graphical = false; block.warnings.push(`Line ${t.line + 1}: This custom preprocessing construct needs a native definition.`); }
    if (/^\s*listsprite\b/.test(t.text)) { block.graphical = false; block.warnings.push('The sprite inventory is a source utility rather than a native editable diagram.'); }
  }
  if (block.kind === 'c4' || block.kind === 'archimate') macros(block); else if (block.kind === 'chen') chen(block); else if (block.kind === 'network') network(block); else if (block.kind === 'dot') dot(block); else if (block.kind === 'board') board(block); else if (block.kind === 'git') git(block); else if (block.kind === 'ditaa') ditaa(block); else if (block.kind === 'jcckit') chart(block);
  const positions = layout(block); for (const e of block.elements) { const p = positions[e.id]; if (p) Object.assign(e.meta!, p); }
}

function layout(block: DiagramBlock): Record<string, Point> {
  const result: Record<string, Point> = Object.create(null);
  if (block.kind === 'ditaa' || block.kind === 'git') { for (const e of block.elements) result[e.id] = { x: Number(e.meta?.x) || 40, y: Number(e.meta?.y) || 40 }; return result; }
  if (block.kind === 'jcckit') return { 'jcckit-chart': { x: 60, y: 60 } };
  if (block.kind === 'board') { let column = 0; for (const root of block.elements.filter(e => !e.parentId)) { const descendants: DiagramElement[] = []; const collect = (id: string) => { for (const child of block.elements.filter(e => e.parentId === id)) { descendants.push(child); collect(child.id); } }; collect(root.id); const x = 50 + column++ * 318; result[root.id] = { x, y: 50 }; meta(root).height = Math.max(300, 90 + descendants.length * 108); descendants.forEach((e, i) => { result[e.id] = { x: x + 22 + Math.max(0, Number(e.meta?.depth) - 1) * 12, y: 126 + i * 108 }; meta(e).width = 238 - Math.max(0, Number(e.meta?.depth) - 1) * 12; }); } return result; }
  if (block.kind === 'network') { const buses = block.elements.filter(e => e.kind === 'network-bus'); const devices = block.elements.filter(e => e.kind !== 'network-bus' && e.kind !== 'network-group'); const width = Math.max(540, devices.length * 215); buses.forEach((e, i) => { result[e.id] = { x: 40, y: 60 + i * 270 }; meta(e).width = width; }); devices.forEach((e, i) => { const memberships = block.relations.filter(r => r.target === e.id).map(r => buses.findIndex(b => b.id === r.source)).filter(n => n >= 0); result[e.id] = { x: 65 + i * 215, y: 175 + (memberships.length ? Math.min(...memberships) : 0) * 270 }; }); for (const group of block.elements.filter(e => e.kind === 'network-group')) { const children = devices.filter(e => e.parentId === group.id); const x = Math.min(...children.map(e => result[e.id].x), 65) - 20, y = Math.min(...children.map(e => result[e.id].y), 175) - 45; result[group.id] = { x, y }; meta(group).width = Math.max(260, ...children.map(e => result[e.id].x + 200 - x)); meta(group).height = Math.max(150, ...children.map(e => result[e.id].y + 110 - y)); } for (const bus of buses) meta(bus).ports = block.relations.filter(r => r.source === bus.id).map(r => { const device = devices.find(e => e.id === r.target)!; return { id: 'bus-' + r.target, x: Math.max(10, Math.min(Number(bus.meta?.width) - 10, result[device.id].x + Number(device.meta?.width) / 2 - result[bus.id].x)), above: result[device.id].y < result[bus.id].y }; }); return result; }
  if (block.kind === 'chen') { const main = block.elements.filter(e => e.kind !== 'chen-attribute'), ordered: DiagramElement[] = []; const visited = new Set<string>(); const visit = (e: DiagramElement) => { if (visited.has(e.id)) return; visited.add(e.id); ordered.push(e); for (const edge of block.relations.filter(r => r.source === e.id || r.target === e.id)) { const next = main.find(n => n.id === (edge.source === e.id ? edge.target : edge.source)); if (next) visit(next); } }; main.forEach(visit);
    const placeAttrs = (e: DiagramElement, depth = 0) => { const attrs = block.elements.filter(a => a.meta?.owner === e.id); attrs.forEach((a, j) => { result[a.id] = { x: result[e.id].x + Number(e.meta?.width) / 2 + (j - (attrs.length - 1) / 2) * 175 - 75, y: result[e.id].y - 145 }; if (depth < 20) placeAttrs(a, depth + 1); }); }; let x = 200; ordered.forEach(e => { const count = block.elements.filter(a => a.meta?.owner === e.id).length; result[e.id] = { x, y: 300 }; placeAttrs(e); x += Math.max(340, count * 180 + 100); }); return result; }
  const roots = block.elements.filter(e => !e.parentId); let x = 60, rootY = 70, rootRowHeight = 0;
  const place = (element: DiagramElement, px: number, py: number): { width: number; height: number } => {
    result[element.id] = { x: px, y: py }; const children = block.elements.filter(e => e.parentId === element.id); if (!children.length) return { width: Number(element.meta?.width) || 210, height: Number(element.meta?.height) || 90 };
    let rowHeight = 0, maxWidth = 0, y = py + 80, childX = px + 30; children.forEach((child, i) => { if (i % 2 === 0 && i) { y += rowHeight + 50; rowHeight = 0; childX = px + 30; } const size = place(child, childX, y); rowHeight = Math.max(rowHeight, size.height); maxWidth = Math.max(maxWidth, childX - px + size.width + 30); childX += size.width + 110; });
    meta(element).width = Math.max(540, maxWidth); meta(element).height = y - py + rowHeight + 35; return { width: Number(meta(element).width), height: Number(meta(element).height) };
  };
  roots.forEach(e => { const predictedWidth = Number(e.meta?.width) || 220; if (x > 60 && x + predictedWidth > 1320) { x = 60; rootY += rootRowHeight + 100; rootRowHeight = 0; } const size = place(e, x, rootY); rootRowHeight = Math.max(rootRowHeight, size.height); x += size.width + 100; }); return result;
}

function edit(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  if (edit.type === 'replaceSource' || edit.type === 'insertSnippet') return undefined;
  const offset = source.split('\n').slice(0, block.startLine).reduce((n, s) => n + s.length + 1, 0); const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const replace = (span: Span, value: string) => source.slice(0, offset + span.start) + value + source.slice(offset + span.end);
  const spliceMany = (changes: { span: Span; value: string }[]) => changes.sort((a, b) => b.span.start - a.span.start).reduce((s, c) => s.slice(0, offset + c.span.start) + c.value + s.slice(offset + c.span.end), source);
  const insert = (value: string, at?: number) => replace({ start: at ?? block.source.lastIndexOf('@end'), end: at ?? block.source.lastIndexOf('@end') }, value + eol);
  const element = 'elementId' in edit ? block.elements.find(e => e.id === edit.elementId) : undefined;
  if ('elementId' in edit && !element) throw new Error('This element no longer exists.');
  const m = element ? meta(element) : undefined;
  if (edit.type === 'rename' && element && m) {
    const name = safeName(edit.name);
    if (block.kind === 'ditaa') { const width = Number(m.fixedLabelWidth); if (name.length > width) throw new Error(`This ASCII box has room for ${width} characters. Enlarge it in source before renaming.`); return spliceMany([{ span: m.labelSpan!, value: name.padEnd(width) }, ...((m.extraLabelSpans || []) as Span[]).map(span => ({ span, value: ' '.repeat(span.end - span.start) }))]); }
    if (m.labelSpan) return replace(m.labelSpan, (m.quoted || block.kind === 'chen' ? q(name) : name) + (m.suffix || ''));
    if (block.kind === 'jcckit') return insert(`# Aliot title: ${name}`, sourceLines(block)[1].start);
    if (m.container && m.body && (block.kind === 'dot' || block.kind === 'network')) return insert(`${eol}  ${block.kind === 'dot' ? 'label' : 'description'} = ${q(name)};`, m.body.start);
    if (block.kind === 'dot' || block.kind === 'network') { const decl = m.declaration!; const old = block.source.slice(decl.start, decl.end); if (m.implicit) return insert(`${q(element.id)} [label=${q(name)}];`, graphEnd(block)); const key = block.kind === 'dot' ? 'label' : 'description'; const next = old.includes('[') ? old.replace(/\]\s*$/, `, ${key}=${q(name)}]`) : `${old} [${key}=${q(name)}]`; return replace(decl, next); }
    if (block.kind === 'git') return replace(m.declaration!, block.source.slice(m.declaration!.start, m.declaration!.end) + ' ' + name);
    throw new Error('Edit this structural label in the source panel.');
  }
  if (edit.type === 'members' && element && m) {
    if (block.kind === 'c4' || block.kind === 'archimate') { const a = m.args || []; if (!m.macro || a.length < 2) throw new Error('This declaration has no editable detail fields.'); const declaration = `${m.macro}(${block.source.slice(a[0].start, a[0].end)}, ${block.source.slice(a[1].start, a[1].end)}${edit.members.map(s => `, ${q(s)}`).join('')})`; return replace(m.declaration!, declaration); }
    if (block.kind === 'jcckit') { const configSpans = m.configSpans as Record<string, Span>; const changes: { span: Span; value: string }[] = []; const additions: string[] = []; for (const line of edit.members) { const match = line.match(/^([\w.-]+)\.(title|x|y)\s*=\s*(.*)$/); if (!match) throw new Error('Use series.title, series.x, or series.y = values.'); if (match[2] !== 'title' && match[3].split(/\s+/).some(v => !Number.isFinite(Number(v)))) throw new Error('Chart coordinates must be finite numbers.'); const key = `data/${match[1]}/${match[2]}`; if (configSpans[key]) changes.push({ span: configSpans[key], value: match[3] }); else additions.push(`${key} = ${match[3]}`); } if (additions.length) changes.push({ span: { start: block.source.lastIndexOf('@end'), end: block.source.lastIndexOf('@end') }, value: additions.join(eol) + eol }); return spliceMany(changes); }
    throw new Error('Use the source panel to edit these details.');
  }
  if (edit.type === 'deleteElement' && element && m) {
    if (block.kind === 'ditaa') { const box = m.ditaaBox as { left: number; right: number; top: number; bottom: number }; return spliceMany(sourceLines(block).slice(box.top, box.bottom + 1).map(t => ({ span: { start: t.start + box.left, end: t.start + box.right + 1 }, value: ' '.repeat(box.right - box.left + 1) }))); }
    if (block.kind === 'jcckit') return replace({ start: sourceLines(block)[1].start, end: block.source.lastIndexOf('@end') }, '');
    if (block.kind === 'git') { const row = sourceLines(block).find(t => t.line === element.startLine)!; const graph = row.text.slice(0,row.text.indexOf(String(m.hash))).replace('*','|').trimEnd(); const branched = block.source.split(/\r?\n/).some(s => /^[| /\\.\-]+$/.test(s.trim()) && /[/\\]/.test(s)); return replace({ start: row.start, end: row.end + (block.source.slice(row.end,row.end + 2) === '\r\n' ? 2 : 1) }, branched ? graph + eol : ''); }
    let span = m.declaration!;
    if (block.kind === 'board') { const rows = sourceLines(block); let end = rows.findIndex(t => t.line === element.startLine) + 1; while (end < rows.length - 1 && (rows[end].text.match(/^\s*(\+*)/)?.[1].length || 0) > Number(m.depth)) end++; span = { start: span.start, end: rows[end]?.start || span.end }; }
    const changes = [{ span, value: '' }]; const seen = new Set([`${span.start}:${span.end}`]); const ids = new Set([element.id]); for (let i = 0; i < block.elements.length; i++) for (const child of block.elements) if (child.parentId && ids.has(child.parentId)) ids.add(child.id);
    for (const r of block.relations.filter(r => ids.has(r.source) || ids.has(r.target))) { const rm = (block.meta!.relationSpans as Record<string, ElementMeta>)[r.id]; const s = rm.declaration!; if (rm.chain) throw new Error('Split this DOT edge chain in source before deleting a member.'); if (s.start >= span.start && s.end <= span.end || seen.has(`${s.start}:${s.end}`)) continue; changes.push({ span: s, value: '' }); seen.add(`${s.start}:${s.end}`); }
    return spliceMany(changes);
  }
  if (edit.type === 'addElement') {
    const name = safeName(edit.name), kind = edit.kind.replace(new RegExp(`^${block.kind}-`), ''), id = unique(block, slug(kind)); const parent = block.elements.find(e => e.id === edit.parentId); const at = parent && meta(parent).body ? meta(parent).body!.end : undefined;
    if (block.kind === 'c4') { const commands: Record<string,string> = { person: 'Person', system: 'System', container: 'Container', component: 'Component', database: 'ContainerDb', boundary: 'System_Boundary' }; const command = commands[kind] || 'Container'; return insert(`${command}(${id}, ${q(name)}${/Container|Component/.test(command) ? ', "Technology", "Description"' : ''})${kind === 'boundary' ? ` {${eol}}` : ''}`, at); }
    if (block.kind === 'archimate') { const command = /^(Business|Application|Technology|Motivation|Strategy|Physical|Implementation)_/.test(kind) ? kind : kind === 'boundary' ? 'Grouping' : 'Business_Process'; return insert(`${command}(${id}, ${q(name)})${kind === 'boundary' ? ` {${eol}}` : ''}`, at); }
    if (block.kind === 'chen') { if (kind === 'attribute') { const owner = parent || block.elements.find(e => e.kind === 'chen-entity'); if (!owner || !meta(owner).body) throw new Error('Create an entity first.'); return insert(`  ${q(name)} as ${id}`, meta(owner).body!.end); } return insert(`${kind === 'relationship' ? 'relationship' : 'entity'} ${q(name)} as ${id} {${eol}}`); }
    if (block.kind === 'dot') return insert(`${q(id)} [label=${q(name)}, shape=${kind === 'diamond' ? 'diamond' : kind === 'box' ? 'box' : 'ellipse'}];`, at ?? graphEnd(block));
    if (block.kind === 'network') { if (kind === 'bus' || kind === 'network') return insert(`network ${q(name)} {${eol}}`, networkEnd(block)); const net = parent || block.elements.find(e => e.kind === 'network-bus'); if (!net || !meta(net).body) throw new Error('Create a network first.'); return insert(`  ${id} [description=${q(name)}${kind === 'database' ? ', shape=database' : ''}];`, meta(net).body!.end); }
    if (block.kind === 'board') { if (kind === 'column') return insert(name); const owner = parent || block.elements.find(e => e.kind === 'board-column'); if (!owner) return insert(`Backlog${eol}+ ${name}`); const rows = sourceLines(block); let line = rows.findIndex(t => t.line === owner.startLine) + 1; while (line < rows.length - 1 && (rows[line].text.match(/^\s*(\+*)/)?.[1].length || 0) > Number(owner.meta?.depth)) line++; return insert(`${'+'.repeat(Number(owner.meta?.depth) + 1)} ${name}`, rows[line].start); }
    if (block.kind === 'git') { let n = 1; while (block.elements.some(e => e.id === n.toString(16).padStart(7, '0'))) n++; return insert(`* ${n.toString(16).padStart(7, '0')} ${name}`, sourceLines(block)[1].start); }
    if (block.kind === 'ditaa') { const width = Math.max(16, name.length + 4), border = '+' + '-'.repeat(width) + '+', marker = kind === 'document' ? '{d}' : kind === 'database' ? '{s}' : ''; return insert(`${eol}${border}${eol}| ${name.padEnd(width - 2)} |${eol}${marker ? `| ${marker.padEnd(width - 2)} |${eol}` : ''}${border}`); }
    if (block.kind === 'jcckit') { const chartMeta = meta(block.elements[0]); const config = chartMeta.config as Record<string,string>; const spans = chartMeta.configSpans as Record<string,Span>; let n = 1; while ((config['data/curves'] || '').split(/\s+/).includes(`curve${n}`)) n++; const series = `curve${n}`, text = `data/${series}/title = ${name}${eol}data/${series}/x = 0 1 2 3${eol}data/${series}/y = 1 3 2 4${eol}`; const changes = [{ span: { start: block.source.lastIndexOf('@end'), end: block.source.lastIndexOf('@end') }, value: text }]; if (spans['data/curves']) changes.push({ span: spans['data/curves'], value: `${config['data/curves']} ${series}`.trim() }); else changes[0].value = `data/curves = ${series}${eol}` + text; return spliceMany(changes); }
  }
  if (edit.type === 'addRelation') {
    const a = block.elements.find(e => e.id === edit.source), b = block.elements.find(e => e.id === edit.target); if (!a || !b) throw new Error('Both relationship endpoints must exist.');
    if (block.kind === 'c4') return insert(`Rel(${a.id}, ${b.id}, ${q(edit.label)})`);
    if (block.kind === 'archimate') return insert(`Rel_Association(${a.id}, ${b.id}, ${q(edit.label)})`);
    if (block.kind === 'chen') { if (!/^(?:\d+|[NMnm]|\([\dNMnm]+,[\dNMnm]+\))$/.test(edit.label || 'N')) throw new Error('Chen relationship labels are cardinalities, for example 1, N, or (0,N).'); return insert(`${a.id} -${edit.label || 'N'}- ${b.id}`); }
    if (block.kind === 'dot') return insert(`${q(a.id)} ${/digraph/.test(block.source) ? '->' : '--'} ${q(b.id)} [label=${q(edit.label)}];`, graphEnd(block));
    if (block.kind === 'network') { const bus = a.kind === 'network-bus' ? a : b.kind === 'network-bus' ? b : undefined; if (bus) { const device = bus === a ? b : a; return insert(`  ${q(device.id)}${edit.label ? ` [address=${q(edit.label)}]` : ''};`, meta(bus).body!.end); } return insert(`${q(a.id)} -- ${q(b.id)};`, networkEnd(block)); }
    throw new Error('Relationships in this format are derived from its structure. Edit the source structure to change them.');
  }
  if (edit.type === 'deleteRelation' || edit.type === 'editRelation') {
    const r = block.relations.find(r => r.id === edit.relationId); if (!r) throw new Error('This relationship no longer exists.'); const rm = (block.meta!.relationSpans as Record<string,ElementMeta>)[r.id]; if (rm.derived && !rm.membership) throw new Error('This relationship follows the document structure. Edit its source structure.'); if (rm.chain) throw new Error('Split this DOT edge chain in the source panel before editing one segment.');
    if (edit.type === 'deleteRelation') return replace(rm.declaration!, '');
    if (rm.macro) { const a = rm.args || []; if (a[2]) return replace(a[2], q(edit.label)); return replace(rm.declaration!, `${rm.macro}(${r.source}, ${r.target}, ${q(edit.label)})`); }
    if (block.kind === 'dot') return replace(rm.declaration!, `${q(r.source)} ${edit.arrow.includes('>') ? '->' : '--'} ${q(r.target)} [label=${q(edit.label)}]`);
    if (block.kind === 'chen') { if (!/^(?:\d+|[NMnm]|\([\dNMnm]+,[\dNMnm]+\))$/.test(edit.label || 'N')) throw new Error('Enter a Chen cardinality such as 1 or N.'); return replace(rm.declaration!, `${r.source} -${edit.label || 'N'}- ${r.target}`); }
    if (block.kind === 'network' && rm.membership) return replace(rm.declaration!, `${q(r.target)} [address=${q(edit.label)}]`);
    return replace(rm.declaration!, `${r.source} ${edit.arrow} ${r.target}${edit.label ? ` : ${edit.label}` : ''}`);
  }
  return undefined;
}
function graphEnd(block: DiagramBlock) { const end = block.source.lastIndexOf('}', block.source.lastIndexOf('@end')); return end >= 0 ? end : block.source.lastIndexOf('@end'); }
function networkEnd(block: DiagramBlock) { return /\bnwdiag\s*\{/.test(block.source) ? graphEnd(block) : block.source.lastIndexOf('@end'); }

const templates: DiagramTemplate[] = [
  { kind: 'c4', label: 'C4 architecture', description: 'People, software systems, containers and boundaries.', palette: ['person','system','container','component','database','boundary'], source: '@startuml\n!include <C4/C4_Container>\nPerson(reader, "Reader", "Finds publications")\nSystem_Boundary(library, "Digital library") {\n  Container(catalog, "Catalog", "Web application", "Finds available titles")\n  ContainerDb(index, "Search index", "Database", "Stores searchable entries")\n}\nRel(reader, catalog, "Searches")\nRel(catalog, index, "Queries")\n@enduml\n' },
  { kind: 'archimate', label: 'ArchiMate', description: 'Business, application and technology layers.', palette: ['Business_Actor','Business_Process','Application_Service','Technology_Node','boundary'], source: '@startuml\n!include <archimate/Archimate>\nBusiness_Actor(visitor, "Visitor")\nBusiness_Process(reserve, "Reserve a title")\nApplication_Service(catalog, "Catalog service")\nRel_Assignment(visitor, reserve, "requests")\nRel_Serving(catalog, reserve, "supports")\n@enduml\n' },
  { kind: 'network', label: 'Network', description: 'Network buses, hosts, addresses and peer links.', palette: ['bus','device','database'], source: '@startnwdiag\nnwdiag {\n  network public {\n    address = "192.0.2.0/24";\n    gateway [address = ".1", description = "Gateway"];\n    portal [address = ".20", description = "Portal"];\n  }\n  network private {\n    portal;\n    storage [address = "10.0.0.8", shape = database];\n  }\n}\n@endnwdiag\n' },
  { kind: 'chen', label: 'Chen ER', description: 'Entities, relationship diamonds and attribute ellipses.', palette: ['entity','relationship','attribute'], source: '@startchen\nentity "Reader" as READER {\n  Number <<key>>\n  Name\n}\nentity "Title" as TITLE {\n  ISBN <<key>>\n}\nrelationship "Borrows" as BORROWS {\n  Date\n}\nREADER -1- BORROWS\nBORROWS -N- TITLE\n@endchen\n' },
  { kind: 'dot', label: 'DOT graph', description: 'Directed and undirected Graphviz source as editable nodes.', palette: ['box','ellipse','diamond'], source: '@startdot\ndigraph publishing {\n  rankdir=LR;\n  draft [label="Draft", shape=box];\n  review [label="Review", shape=diamond];\n  release [label="Published", shape=ellipse];\n  draft -> review [label="submit"];\n  review -> release [label="approve"];\n}\n@enddot\n' },
  { kind: 'ditaa', label: 'Ditaa', description: 'ASCII boxes and connectors projected into native shapes.', palette: ['box','document','database'], source: '@startditaa\n+--------------+       +--------------+\n| Draft        |------>| Published    |\n|              |       | {d}          |\n+--------------+       +--------------+\n@endditaa\n' },
  { kind: 'board', label: 'Board', description: 'Columns and cards from the board outline.', palette: ['column','card'], source: '@startboard\nIdeas\n+ Catalog search\n+ Reader profiles\nBuilding\n+ Borrowing flow\nReady\n+ Library directory\n@endboard\n' },
  { kind: 'git', label: 'Git history', description: 'Commit nodes, branch lanes and history links.', palette: ['commit'], source: '@startgit\n* a12b345 (HEAD -> main) Add catalog search\n* b23c456 Build library model\n* c34d567 Start project\n@endgit\n' },
  { kind: 'jcckit', label: 'JCCKit chart', description: 'Editable data series drawn as native chart geometry.', palette: ['curve'], source: '@startjcckit(680,400)\n# Aliot title: Weekly borrowing\ndata/curves = loans returns\ndata/loans/title = Loans\ndata/loans/x = 0 1 2 3 4\ndata/loans/y = 4 8 6 12 10\ndata/returns/title = Returns\ndata/returns/x = 0 1 2 3 4\ndata/returns/y = 2 5 8 7 11\nplot/coordinateSystem/xAxis/axisLabel = Week\nplot/coordinateSystem/yAxis/axisLabel = Books\n@endjcckit\n' },
];
export const architectureFamily: NativeFamily = { kinds, templates, parse, edit, layout };
