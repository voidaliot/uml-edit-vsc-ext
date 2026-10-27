import type { DiagramBlock, DiagramElement, DiagramKind, DiagramRelation, ParsedDocument } from '../shared/protocol';
import { codeLines, parseDeclaration, parseRelation, parseMemberStatement, type RelationSyntax } from './syntax';
import { supportsNativeKind } from './coverage';
import { familyFor } from './families/registry';
import { parseActivities } from './activities';
import { sequenceAnnotations, sequenceItemId } from './sequence';
import { projectProcedures } from './procedures';
import { parseLegacyActivity } from './legacy-activity';
import { sourceLineType } from './line-style';

const containerKinds = new Set(['package', 'namespace', 'frame', 'rectangle', 'node', 'cloud', 'folder', 'state', 'component', 'artifact', 'database', 'agent', 'storage']);
const nativeElementKinds = new Set(['class', 'abstract class', 'interface', 'enum', 'annotation', 'object', 'entity', 'actor', 'participant', 'boundary', 'control', 'collections', 'queue', 'database', 'component', 'node', 'artifact', 'cloud', 'package', 'namespace', 'frame', 'folder', 'rectangle', 'card', 'file', 'storage', 'stack', 'agent', 'person', 'label', 'hexagon', 'circle', 'process', 'usecase', 'state', 'action', 'note']);
const blockKinds: Record<string, DiagramKind> = { class: 'class', object: 'object', sequence: 'sequence', state: 'state', activity: 'activity', mindmap: 'mindmap', wbs: 'wbs', json: 'json', yaml: 'yaml', gantt: 'gantt', salt: 'salt', ditaa: 'ditaa', ebnf: 'ebnf', regex: 'regex', math: 'math', latex: 'latex', dot: 'dot', board: 'board', git: 'git', chen: 'chen', jcckit: 'jcckit', nwdiag: 'network', chronology: 'chronology', chart: 'chart', files: 'files' };

export function detectDiagramKind(source: string, marker = 'uml'): DiagramKind {
  if (marker !== 'uml') return Object.hasOwn(blockKinds, marker.toLowerCase()) ? blockKinds[marker.toLowerCase()] : 'unknown';
  const text = codeLines(source).join('\n');
  if (/^\s*!include.*(?:C4\/|C4_)/im.test(text) || /^\s*(?:Person|System|Container|Component)(?:_\w+)?\s*\(/m.test(text)) return 'c4';
  if (/^\s*!include.*archimate|^\s*archimate\s|^\s*(?:Business|Application|Technology|Motivation|Strategy)_\w+\s*\(/im.test(text)) return 'archimate';
  if (/^\s*nwdiag\s*\{/im.test(text)) return 'network';
  if (/^\s*(?:robust|concise|clock|binary|analog)\s/im.test(text)) return 'timing';
  if (/^\s*(?:digraph|graph)\s.*\{/im.test(text)) return 'dot';
  if (/^\s*salt\s*$/im.test(text)) return 'salt';
  if (/^\s*ditaa(?:\s|$)/im.test(text)) return 'ditaa';
  if (/<<\s*(?:input|output|procedure|load|save|continuous|task)\s*>>|^\s*:[^\n]+[<>\]\\}]\s*$/im.test(text)) return 'sdl';
  if (/\(\*(?:top)?\)/i.test(text)) return 'activity';
  if (/^\s*(?:start|stop|fork|partition)\s*$|^\s*:[^\n]*;\s*$|^\s*if\s*\(/im.test(text)) return 'activity';
  if (/^\s*(?:abstract\s+)?class\s|^\s*(?:enum|annotation)\s/im.test(text)) return 'class';
  if (/^\s*object\s/im.test(text)) return 'object';
  if (/^\s*state\s|\[\*\]/im.test(text)) return 'state';
  if (/^\s*participant\s/im.test(text)) return 'sequence';
  if (/^\s*artifact\s/im.test(text) && /^\s*(?:node|cloud|storage)\s/im.test(text)) return 'deployment';
  if (/^\s*usecase\s|(?:^|[->]\s*)\([^\n)]+\)(?:\s|$)/im.test(text)) return 'usecase';
  if (/^\s*component\s/im.test(text) && !/^\s*artifact\s/im.test(text)) return 'component';
  if (/^\s*(?:node|artifact|cloud|storage|stack|agent|person|folder|file)\s/im.test(text)) return 'deployment';
  if (/^\s*entity\s/im.test(text) && /[{}|][|o-]|[|-][|o{}]/.test(text)) return 'entity';
  if (/^\s*entity\s/im.test(text) && !/^\s*(?:actor|boundary|control|database|queue)\s/im.test(text)) return 'entity';
  if (/^\s*interface\s/im.test(text)) return 'class';
  if (/^\s*\[[^*\]\n]+\](?:\s|$)/m.test(text)) return 'component';
  if (/^\s*actor\s/im.test(text) && /^\s*left to right direction/im.test(text)) return 'usecase';
  // PlantUML interprets undeclared participants with messages as a sequence diagram.
  if (/[-=][->]|^\s*(?:actor|boundary|control|entity|database|collections|queue)\s/im.test(text)) return 'sequence';
  return 'class';
}

export function parseDocument(source: string): ParsedDocument {
  const original = source.split(/\r?\n/);
  const code = codeLines(source);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const diagrams: DiagramBlock[] = [];
  const warnings: string[] = [];
  for (let line = 0; line < code.length; line++) {
    const start = code[line].match(/^\s*@start([a-z][a-z0-9_]*)\b\s*(.*)$/i);
    if (!start) continue;
    const startLine = line;
    const marker = start[1].toLowerCase();
    let endLine = line + 1;
    while (endLine < code.length && !new RegExp(`^\\s*@end${marker}\\b`, 'i').test(code[endLine]) && !/^\s*@start\w+/i.test(code[endLine])) endLine++;
    const closed = endLine < code.length && new RegExp(`^\\s*@end${marker}\\b`, 'i').test(code[endLine]);
    if (!closed) endLine = Math.max(startLine, endLine - 1);
    const blockSource = original.slice(startLine, endLine + 1).join(eol);
    const kind = detectDiagramKind(blockSource, marker);
    const titleLine = code.slice(startLine + 1, endLine).find(text => /^\s*title(?:\s+|:)\s*\S/i.test(text));
    const block: DiagramBlock = {
      id: `diagram-${diagrams.length + 1}`, startLine, endLine, kind, source: blockSource,
      title: titleLine?.replace(/^\s*title(?:\s+|:)\s*/i, '').trim() || start[2].trim() || `${kind === 'unknown' ? marker : kind} diagram`,
      elements: [], relations: [], graphical: supportsNativeKind(kind) && closed, warnings: [],
    };
    if (!closed) block.warnings.push(`Missing @end${marker}; repair the source before graphical editing.`);
    if (!supportsNativeKind(kind)) warn(block, startLine, `Native editing for ${kind === 'unknown' ? marker : kind} diagrams is not implemented. The complete source remains available in the source panel.`);
    else try {
      if (familyFor(kind)) familyFor(kind)!.parse(block, original);
      else if (kind === 'mindmap' || kind === 'wbs') parseTree(block, code);
      else if (kind === 'activity' && /\(\*(?:top)?\)/i.test(block.source)) parseLegacyActivity(block, code);
      else if (kind === 'activity' || kind === 'sdl') parseActivities(block, code, (line, text) => sharedDirective(block, line, text));
      else parseGraph(block, code);
    } catch (error) { unsupported(block, startLine, error instanceof Error ? error.message : String(error)); }
    if (block.graphical && !block.elements.length && titleLine) {
      const titleIndex = code.findIndex((text, index) => index > startLine && index < endLine && text === titleLine);
      block.elements.push({ id: '__diagram_title', kind: 'label', name: block.title, members: [], startLine: titleIndex, endLine: titleIndex, meta: { standaloneTitle: true, editable: false, width: Math.max(190, block.title.replace(/<[^>]*>/g, '').length * 15 + 30), height: 64 } });
    }
    block.meta = { ...block.meta, lineType: sourceLineType(block) };
    if (!closed) block.graphical = false;
    diagrams.push(block);
    line = endLine;
  }
  if (diagrams.length === 0 && source.trim()) warnings.push('No @start… / @end… diagram block found. Choose a diagram type or add a PlantUML block in the source editor.');
  return { diagrams, warnings };
}

function warn(block: DiagramBlock, line: number, message: string): void {
  const warning = `Line ${line + 1}: ${message}`;
  if (block.warnings.length < 12 && !block.warnings.includes(warning)) block.warnings.push(warning);
}

function unsupported(block: DiagramBlock, line: number, message: string): void {
  if (block.graphical && block.warnings.length >= 12) block.warnings.pop();
  block.graphical = false;
  warn(block, line, `${message} Edit this construct in the source panel.`);
}

function hasRichText(text: string): boolean {
  return [...text.matchAll(/<\$([^>]+)>/g)].some(match => !['star', 'cloud', 'check_circle', 'cubes', 'exchange', 'file_code_o', 'file_image_o', 'gavel', 'gear', 'globe', 'heart', 'share_alt_square'].includes(match[1]));
}

function sharedDirective(block: DiagramBlock, line: number, text: string): boolean {
  if (/^!include\s+<tupadr3\/font-awesome\/(?:star|cloud|check_circle|cubes|exchange|file_code_o|file_image_o|gavel|gear|globe|heart|share_alt_square)>\s*$/i.test(text)) {
    if (!block.warnings.some(message => message.includes('stock icon'))) warn(block, line, 'Known stock icon names use native symbols; the source include is preserved without executing external code.');
    return true;
  }
  if (/^title(?:\s+|:)/i.test(text)) {
    if (hasRichText(text)) unsupported(block, line, 'Rich text or icons in titles are not supported by the native canvas.');
    return true;
  }
  if (/^(?:left to right direction|top to bottom direction)\s*$/i.test(text)) return true;
  if (/^skinparam(?:locked)?\s+linetype\s+(?:ortho|polyline|spline|splines|straight)\s*$/i.test(text)) return true;
  if (/^(?:skinparam|!theme|scale)\b/i.test(text)) {
    if (!block.warnings.some(message => message.includes('Source styling is preserved'))) warn(block, line, 'Source styling is preserved; supported connector routing is applied. Other styling uses VS Code theme colors and canvas zoom.');
    return true;
  }
  if (/^(?:hide|show)\b/i.test(text)) {
    const hidden = /^hide\b/i.test(text);
    if (/\bmembers\b/i.test(text)) block.meta = { ...block.meta, hiddenMembers: hidden };
    else if (/\bmethods\b/i.test(text)) block.meta = { ...block.meta, hiddenMethods: hidden };
    else if (/\b(?:fields|attributes)\b/i.test(text)) block.meta = { ...block.meta, hiddenFields: hidden };
    else warn(block, line, 'This visibility directive is preserved; the native diagram keeps its standard symbols.');
    return true;
  }
  if (/^autonumber\b/i.test(text)) {
    block.meta = { ...block.meta, autonumber: !/^autonumber\s+stop/i.test(text), numberStart: Number(text.match(/\d+/)?.[0] ?? 1) };
    return true;
  }
  return false;
}

// Activity and hierarchy syntax has no aliases. A content-derived identity keeps unrelated
// insertions from moving saved positions to different nodes. Identical labels use occurrence order.
function contentId(block: DiagramBlock, prefix: string, name: string): string {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index++) hash = Math.imul(hash ^ name.charCodeAt(index), 16777619);
  const stem = `${prefix}-${(hash >>> 0).toString(36)}`;
  let occurrence = 1;
  while (block.elements.some(element => element.id === `${stem}-${occurrence}`)) occurrence++;
  return `${stem}-${occurrence}`;
}

function parseGraph(block: DiagramBlock, lines: string[]): void {
  const sequence = block.kind === 'sequence' ? sequenceAnnotations(block, lines) : undefined;
  const procedures = projectProcedures(block, lines);
  const elements = new Map<string, DiagramElement>();
  const procedureCalls = new Map<number, DiagramElement[]>();
  for (const element of procedures.elements) {
    const call = procedureCalls.get(element.startLine) ?? [];
    call.push(element);
    procedureCalls.set(element.startLine, call);
  }
  const pending: { line: number; value: RelationSyntax; parentId?: string }[] = [];
  const containers: DiagramElement[] = [];
  const regions = new Map<string, string>();
  const scopeParent = () => { const parent = containers.at(-1)?.id; return parent ? regions.get(parent) ?? parent : undefined; };
  let body: DiagramElement | undefined;
  let specialBlock: string | undefined;
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const raw = lines[line];
    const text = raw.trim();
    if (sequence?.ignored.has(line)) continue;
    if (procedures.ignored.has(line)) {
      for (const element of procedureCalls.get(line) ?? []) {
        if (body || specialBlock) { unsupported(block, line, 'Procedure calls inside member or annotation bodies are not supported.'); continue; }
        if (elements.has(element.id)) { unsupported(block, line, `Repeated declaration of ${element.id} is ambiguous for native editing.`); continue; }
        if (scopeParent()) element.parentId = scopeParent();
        elements.set(element.id, element);
      }
      continue;
    }
    if (!text) continue;
    if (specialBlock) {
      if (text.toLowerCase() === specialBlock) specialBlock = undefined;
      continue;
    }
    if (body) {
      body.endLine = line;
      if (/^}\s*$/.test(text)) body = undefined;
      else {
        body.members.push(text);
        if (/^\s*(?:class|state|object|entity|component)\s|^\s*![a-z]/i.test(text)) unsupported(block, line, 'Nested declarations and preprocessing inside member bodies are not supported.');
        if (hasRichText(text)) unsupported(block, line, 'Rich text, icons, and generic type notation in members are not supported.');
        if (/\{(?:static|abstract)\}/.test(text)) warn(block, line, 'Static/abstract member markers are preserved as text; native member typography does not interpret these markers.');
      }
      continue;
    }
    if (/^<style>/i.test(text)) { warn(block, line, 'Source styling is preserved but not applied; the native canvas uses VS Code theme colors.'); specialBlock = '</style>'; continue; }
    if (/^(?:legend|header|footer|caption|title)\s*$/i.test(text)) {
      unsupported(block, line, 'Multiline annotations are not supported by the native canvas.');
      specialBlock = `end${text.toLowerCase()}`;
      continue;
    }
    if (sharedDirective(block, line, text)) { if (/^skinparam\b/i.test(text) && text.includes('{')) specialBlock = '}'; continue; }
    if (text === '}') {
      const container = containers.pop();
      if (container) container.endLine = line;
      else unsupported(block, line, 'Unmatched closing brace.');
      continue;
    }
    if (block.kind === 'state' && /^(?:--|\|\|)$/.test(text) && containers.length) {
      const container = containers.at(-1)!;
      if (!regions.has(container.id)) {
        const first = `${container.id}__region_1`;
        for (const child of elements.values()) if (child.parentId === container.id) child.parentId = first;
        for (const relation of pending) if (relation.parentId === container.id) relation.parentId = first;
        elements.set(first, { id: first, name: '', kind: 'state-region', members: [], parentId: container.id, startLine: container.startLine, endLine: line, meta: { container: true, editable: false, hideHeader: true } });
      }
      const next = `${container.id}__region_${line}`;
      elements.set(next, { id: next, name: '', kind: 'state-region', members: [], parentId: container.id, startLine: line, endLine: line, meta: { container: true, editable: false, hideHeader: true } });
      regions.set(container.id, next); continue;
    }
    const note = text.match(/^(?:[hr]?note)\s+(?:(left|right|top|bottom)\s+(?:of\s+)?([^:]+)|as\s+(\S+))\s*(?::\s*(.*))?$/i);
    if (note && block.kind !== 'sequence') {
      const first = line; let name = note[4] ?? '';
      if (note[4] === undefined) while (++line < block.endLine && !/^\s*end\s*[hr]?note\b/i.test(lines[line])) name += (name ? '\n' : '') + lines[line].trim();
      const id = note[3] ?? `note-${first}`;
      elements.set(id, { id, name, kind: 'note', members: [], startLine: first, endLine: line, ...(containers.length ? { parentId: containers.at(-1)!.id } : {}), meta: { annotation: true, multiline: note[4] === undefined, attachTo: note[2]?.trim() } });
      continue;
    }
    const declaration = parseDeclaration(raw);
    if (declaration) {
      if (elements.has(declaration.id)) { unsupported(block, line, `Repeated declaration of ${declaration.id} is ambiguous for native editing.`); continue; }
      const element: DiagramElement = {
        id: declaration.id, name: declaration.name, kind: declaration.kind, members: [],
        startLine: line, endLine: line, ...(scopeParent() ? { parentId: scopeParent() } : {}),
      };
      elements.set(element.id, element);
      if (!nativeElementKinds.has(element.kind)) unsupported(block, line, `The ${element.kind} shape is not implemented for native ${block.kind} diagrams.`);
      if (hasRichText(declaration.name)) unsupported(block, line, 'Rich text, multiline names, and icon labels are not supported by the native canvas.');
      if (declaration.bodyStart >= 0) {
        if (declaration.bodyEnd >= 0) {
          element.members = raw.slice(declaration.bodyStart + 1, declaration.bodyEnd).split(';').map(item => item.trim()).filter(Boolean);
          if (element.members.some(hasRichText)) unsupported(block, line, 'Rich text, icons, and generic type notation in members are not supported.');
        }
        else if (containerKinds.has(element.kind)) {
          element.meta = { ...element.meta, container: true };
          containers.push(element);
        } else body = element;
      }
      const stereotype = declaration.tail.match(/<<([^>]+)>>/)?.[1];
      const color = declaration.tail.match(/#([\w]+)/)?.[1];
      const generic = declaration.tail.match(/^\s*(<[^>]+>)(?!>)/)?.[1];
      element.meta = { ...element.meta, ...(stereotype ? { stereotype } : {}), ...(color ? { color: /^[\da-f]{3,8}$/i.test(color) ? `#${color}` : color } : {}), ...(generic ? { generic } : {}) };
      if (block.kind === 'state' && stereotype && /^(?:choice|fork|join|history|history\*|start|end)$/i.test(stereotype)) element.meta.shape = stereotype.toLowerCase();
      if (declaration.tail.trim() && !/^(?:\{|<<|#|\[\[|<)/.test(declaration.tail.trim())) unsupported(block, line, 'Additional declaration syntax is not supported by the native canvas.');
      continue;
    }
    const edge = parseRelation(raw);
    if (edge) {
      pending.push({ line, value: edge, parentId: scopeParent() });
      if (hasRichText(edge.label)) unsupported(block, line, 'Rich text and icons in relationship labels are not supported by the native canvas.');
      continue;
    }
    // State descriptions and class member shorthand are scoped to the named element.
    const member = parseMemberStatement(raw);
    if (member && block.kind !== 'sequence') {
      if (hasRichText(member.member)) unsupported(block, line, 'Rich text and icons in member descriptions are not supported by the native canvas.');
      const owner = elements.get(member.owner);
      if (owner) owner.members.push(member.member);
      else {
        const element: DiagramElement = { id: member.owner, name: member.owner, kind: block.kind === 'state' ? 'state' : block.kind, members: [member.member], startLine: line, endLine: line, implicit: true };
        elements.set(element.id, element);
      }
      continue;
    }
    unsupported(block, line, `Native editing does not yet support this statement: ${text.slice(0, 90)}`);
  }
  if (body || containers.length) unsupported(block, block.endLine, 'Unclosed element body.');
  const usedIds = new Set([...elements.keys(), ...pending.flatMap(({ value }) => [value.source, value.target])]);
  const symbolId = (stem: string) => { let id = stem, index = 1; while (usedIds.has(id)) id = `${stem}_${index++}`; usedIds.add(id); return id; };
  const symbols = new Map<string, string>();
  for (const { line, value, parentId } of pending) {
    const endpointId = (token: string, isSource: boolean): string => {
      if (token !== '*') return token;
      const key = `${parentId ?? ''}:${isSource ? 'start' : 'end'}`;
      if (!symbols.has(key)) symbols.set(key, symbolId(`${isSource ? '__start' : '__end'}${parentId ? `_${parentId}` : ''}`));
      return symbols.get(key)!;
    };
    const source = endpointId(value.source, true);
    const target = endpointId(value.target, false);
    if (hasRichText(value.source) || hasRichText(value.target)) unsupported(block, line, 'Rich text and icons in implicit element labels are not supported by the native canvas.');
    for (const [id, token, isSource] of [[source, value.sourceSpan.text, true], [target, value.targetSpan.text, false]] as const) {
      if (!elements.has(id)) {
        const kind = token === '[*]' ? (isSource ? 'start' : 'end') : token.startsWith('(') ? 'usecase' : token.startsWith('[') ? 'component' : token.startsWith(':') ? 'actor' : block.kind === 'sequence' ? 'participant' : block.kind === 'usecase' ? 'actor' : block.kind === 'state' ? 'state' : block.kind === 'deployment' ? 'node' : block.kind === 'entity' ? 'entity' : block.kind === 'object' ? 'object' : 'class';
        elements.set(id, { id, name: token === '[*]' ? (isSource ? 'Start' : 'End') : id, kind, members: [], startLine: line, endLine: line, implicit: true, ...(parentId ? { parentId } : {}) });
      }
    }
    const stem = sequence ? sequenceItemId('message', `${source}\0${target}\0${value.arrow}\0${value.label}`, 0).replace(/-0$/, '') : '';
    block.relations.push({
      id: sequence ? `${stem}-${1 + block.relations.filter(relation => relation.id.startsWith(stem + '-')).length}` : `relation-${line}-${block.relations.length}`, source, target, label: value.label, arrow: value.arrow,
      startLine: line, endLine: line,
      ...(sequence ? { meta: { row: sequence.rows.get(line) ?? block.relations.length, number: block.meta?.autonumber ? Number(block.meta.numberStart ?? 1) + block.relations.length : undefined } } : {}),
      ...(value.sourceMultiplicity ? { sourceMultiplicity: value.sourceMultiplicity.slice(1, -1) } : {}),
      ...(value.targetMultiplicity ? { targetMultiplicity: value.targetMultiplicity.slice(1, -1) } : {}),
    });
  }
  block.elements = [...elements.values(), ...(sequence?.decorations ?? [])];
  for (const element of block.elements) {
    element.meta = { hiddenMembers: block.meta?.hiddenMembers, hiddenFields: block.meta?.hiddenFields, hiddenMethods: block.meta?.hiddenMethods, ...element.meta };
    if (!sequence && (['control', 'boundary'].includes(element.kind) || element.kind === 'interface' && ['component', 'deployment', 'usecase'].includes(block.kind) && !element.members.length)) element.meta.symbolNotation = true;
    if (sequence?.bars.has(element.id)) element.meta.activations = sequence.bars.get(element.id);
  }
}

function parseTree(block: DiagramBlock, lines: string[]): void {
  const levels: DiagramElement[] = [];
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const text = lines[line].trim();
    if (!text || sharedDirective(block, line, text)) continue;
    const match = text.match(/^([*+-]+)(?:\[([^\]]+)\])?\s+(.+)$/);
    if (!match) { unsupported(block, line, `This hierarchy statement is not supported: ${text.slice(0, 90)}`); continue; }
    const depth = match[1].length - 1;
    if (depth > levels.length) { unsupported(block, line, 'The hierarchy skips a parent level.'); continue; }
    const parent = depth > 0 ? levels[depth - 1] : undefined;
    const treeSide = match[1][0] === '-' ? 'left' : match[1][0] === '+' ? 'right' : parent?.meta?.treeSide ?? 'right';
    const element: DiagramElement = { id: contentId(block, 'tree', match[3]), name: match[3], kind: block.kind === 'wbs' ? 'task' : 'idea', members: [], startLine: line, endLine: line, meta: { treeSide }, ...(parent ? { parentId: parent.id } : {}) };
    block.elements.push(element);
    if (parent) block.relations.push({ id: `relation-${line}-${block.relations.length}`, source: parent.id, target: element.id, label: '', arrow: '--', startLine: line, endLine: line });
    levels[depth] = element;
    levels.length = depth + 1;
    if (match[2] || hasRichText(match[3])) unsupported(block, line, 'Hierarchy colors, rich text, and multiline nodes are not supported by the native canvas.');
  }
}

function parseActivity(block: DiagramBlock, lines: string[]): void {
  let tail: string | undefined;
  let pendingLabel = '';
  const decisions: { decision: string; yesTail?: string; noLabel: string; inElse: boolean }[] = [];
  const addEdge = (source: string, target: string, label: string, line: number) => {
    if (hasRichText(label)) unsupported(block, line, 'Rich text and icons in activity branch labels are not supported by the native canvas.');
    block.relations.push({ id: `relation-${line}-${block.relations.length}`, source, target, label, arrow: '-->', startLine: line, endLine: line });
  };
  const add = (name: string, kind: string, line: number) => {
    if (hasRichText(name)) unsupported(block, line, 'Rich text and icons in activity labels are not supported by the native canvas.');
    const id = contentId(block, `activity-${kind}`, name);
    block.elements.push({ id, name, kind, members: [], startLine: line, endLine: line });
    if (tail) addEdge(tail, id, pendingLabel, line);
    pendingLabel = '';
    tail = id;
    return id;
  };
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const text = lines[line].trim();
    if (!text || sharedDirective(block, line, text)) continue;
    if (text === 'start') { add('Start', 'start', line); continue; }
    if (text === 'stop' || text === 'end') { add('End', 'end', line); tail = undefined; continue; }
    const action = text.match(/^:(.*);$/);
    if (action) { add(action[1], 'activity', line); continue; }
    const branch = text.match(/^if\s*\((.*?)\)\s*(?:then\s*\((.*)\))?\s*$/i);
    if (branch) {
      const id = add(branch[1], 'decision', line);
      decisions.push({ decision: id, noLabel: 'no', inElse: false });
      pendingLabel = branch[2] ?? 'yes';
      continue;
    }
    const otherwise = text.match(/^else\s*(?:\((.*)\))?$/i);
    if (otherwise && decisions.length) {
      const current = decisions.at(-1)!;
      if (current.inElse) { unsupported(block, line, 'Repeated else branch.'); continue; }
      current.yesTail = tail;
      current.inElse = true;
      current.noLabel = otherwise[1] ?? 'no';
      tail = current.decision;
      pendingLabel = current.noLabel;
      continue;
    }
    if (/^endif$/i.test(text) && decisions.length) {
      const current = decisions.pop()!;
      const branchTail = tail;
      const branchLabel = pendingLabel;
      if (current.inElse && !current.yesTail && !branchTail) { tail = undefined; pendingLabel = ''; continue; }
      tail = undefined;
      const merge = add('', 'merge', line);
      if (branchTail) addEdge(branchTail, merge, branchLabel, line);
      if (current.inElse) {
        if (current.yesTail) addEdge(current.yesTail, merge, '', line);
      } else addEdge(current.decision, merge, current.noLabel, line);
      pendingLabel = '';
      continue;
    }
    const label = text.match(/^->\s*(.*);$/);
    if (label) { pendingLabel = label[1]; continue; }
    unsupported(block, line, `This activity control structure is not supported: ${text.slice(0, 90)}`);
  }
  if (decisions.length) unsupported(block, block.endLine, 'Unclosed activity decision.');
}
