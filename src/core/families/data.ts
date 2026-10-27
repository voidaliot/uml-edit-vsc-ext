import { applyEdits, getNodeValue, modify, parseTree, printParseErrorCode, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import { isAlias, isMap, isScalar, isSeq, parseDocument as parseYaml, type Node as YamlNode } from 'yaml';
import katex from 'katex';
import type { DiagramBlock, DiagramEdit, DiagramElement, DiagramTemplate, Point } from '../../shared/protocol';
import type { NativeFamily } from './types';

type Path = (string | number)[];
type Span = { start: number; end: number };
type Meta = Record<string, unknown>;
const wrap = (kind: string, body: string) => `@start${kind}\n${body}\n@end${kind}\n`;
const oneLine = (value: string) => { if (/[\r\n\0]/.test(value)) throw new Error('Enter a single-line label.'); return value; };
const plainName = (value: string) => { const name = oneLine(value).trim(); if (!name) throw new Error('Enter a name.'); return name; };
const id = (prefix: string, value: unknown) => `${prefix}:${encodeURIComponent(JSON.stringify(value))}`;
const meta = (element: DiagramElement): Meta => element.meta ?? {};
const quote = (value: string) => JSON.stringify(value);
const sourceLines = (source: string) => source.split(/\r?\n/);
const eolOf = (source: string) => source.includes('\r\n') ? '\r\n' : '\n';
const offsetLine = (text: string, offset: number) => text.slice(0, offset).split('\n').length - 1;
const lineOffset = (source: string, line: number) => { let at = 0; for (let index = 0; index < line; index++) { const next = source.indexOf('\n', at); if (next < 0) return source.length; at = next + 1; } return at; };
function payload(block: DiagramBlock) {
  const start = block.source.indexOf('\n') + 1;
  const endMarker = /(?:^|\n)[\t ]*@end\w+\b/i.exec(block.source.slice(start));
  const end = endMarker ? start + endMarker.index + (endMarker[0][0] === '\n' ? 1 : 0) : block.source.length;
  return { start, text: block.source.slice(start, end) };
}
function patch(source: string, block: DiagramBlock, span: Span, replacement: string): string {
  const base = lineOffset(source, block.startLine) + payload(block).start;
  return source.slice(0, base + span.start) + replacement + source.slice(base + span.end);
}
function replaceLine(source: string, line: number, replacement: string): string {
  const lines = sourceLines(source); lines.splice(line, 1, ...replacement.split(/\r?\n/)); return lines.join(eolOf(source));
}
function spliceLines(source: string, line: number, count: number, replacement: string[] = []): string {
  const lines = sourceLines(source); lines.splice(line, count, ...replacement); return lines.join(eolOf(source));
}
function fail(block: DiagramBlock, message: string, line = block.startLine): void {
  block.graphical = false; block.warnings.push(`Line ${line + 1}: ${message}`);
}
function note(block: DiagramBlock, message: string, line = block.startLine): void {
  block.warnings.push(`Line ${line + 1}: ${message}`);
}
function find(block: DiagramBlock, elementId: string): DiagramElement {
  const element = block.elements.find(candidate => candidate.id === elementId);
  if (!element) throw new Error('This element changed. Select it again before editing.');
  return element;
}
function element(block: DiagramBlock, kind: string, key: unknown, name: string, startLine: number, endLine = startLine, members: string[] = [], details: Meta = {}, parentId?: string): DiagramElement {
  const item: DiagramElement = { id: id(kind, key), kind, name, members, startLine, endLine, meta: { customContent: true, width: 220, height: Math.max(74, 62 + members.length * 18), ...details }, ...(parentId ? { parentId } : {}) };
  block.elements.push(item); return item;
}
function connect(block: DiagramBlock, source: string, target: string, label = ''): void {
  block.relations.push({ id: `data-link-${block.relations.length}`, source, target, label, arrow: '-->', startLine: block.startLine, endLine: block.startLine, meta: { editable: false } });
}
function sanitizePayload(block: DiagramBlock, text: string): string {
  let style = false;
  return text.split(/(?<=\n)/).map((line, index) => {
    if (/^\s*<style>/i.test(line)) style = true;
    if (style || /^\s*(?:title\s+|skinparam\s+|#highlight\b|!theme\b|scale\s+)/i.test(line)) {
      if (/^\s*title\s+/i.test(line)) block.title = line.replace(/^\s*title\s+/i, '').trim();
      else if (!style || /^\s*<style>/i.test(line)) note(block, 'Source styling is preserved; native data shapes use the editor theme.', block.startLine + 1 + index);
      if (/<\/style>/i.test(line)) style = false;
      return line.replace(/[^\r\n]/g, ' ');
    }
    return line;
  }).join('');
}

function parseJson(block: DiagramBlock): void {
  const body = payload(block).text;
  const text = sanitizePayload(block, body);
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !tree) { fail(block, `Invalid JSON: ${errors[0] ? printParseErrorCode(errors[0].error) : 'a value is required'}.`, block.startLine + 1 + offsetLine(text, errors[0]?.offset ?? 0)); return; }
  const visit = (node: JsonNode, path: Path, parent?: DiagramElement, keyNode?: JsonNode) => {
    const isCollection = node.type === 'object' || node.type === 'array';
    const arrayItem = typeof path.at(-1) === 'number';
    const value = getNodeValue(node);
    const name = path.length ? arrayItem && !isCollection ? (typeof value === 'string' ? value : JSON.stringify(value)) : String(path.at(-1)) : node.type === 'object' ? 'Object' : node.type === 'array' ? 'Array' : 'Value';
    const members = isCollection ? [] : [JSON.stringify(value)];
    const rows = typeof value === 'string' ? value.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 27)), 0) : 1;
    const item = element(block, `data-${node.type}`, path, name, block.startLine + 1 + offsetLine(text, node.offset), block.startLine + 1 + offsetLine(text, node.offset + node.length), members, {
      path, value, dataType: node.type, span: { start: node.offset, end: node.offset + node.length }, keySpan: keyNode ? { start: keyNode.offset, end: keyNode.offset + keyNode.length } : undefined,
      arrayItem, root: !path.length, editMembers: true, scalar: !isCollection, height: isCollection ? 78 : Math.max(80, rows * 18 + 55),
    }, parent?.id);
    if (parent) connect(block, parent.id, item.id);
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        if (property.children?.[0] && property.children[1]) {
          const key = String(property.children[0].value);
          if (keys.has(key)) { fail(block, `Duplicate JSON key ${key}; keys must be unique for graphical editing.`, block.startLine + 1 + offsetLine(text, property.offset)); continue; }
          keys.add(key); visit(property.children[1], [...path, key], item, property.children[0]);
        }
      }
    }
    if (node.type === 'array') (node.children ?? []).forEach((child, index) => visit(child, [...path, index], item));
  };
  visit(tree, []);
}

function editJson(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  const raw = payload(block).text;
  const eol = eolOf(source);
  const apply = (path: Path, value: unknown, isArrayInsertion = false) => patch(source, block, { start: 0, end: raw.length }, applyEdits(raw, modify(sanitizePayload(block, raw), path, value, { isArrayInsertion, formattingOptions: { insertSpaces: true, tabSize: 2, eol } })));
  if (edit.type === 'addElement') {
    if (!['data-value', 'data-object', 'data-array'].includes(edit.kind)) throw new Error('Choose a JSON value, object, or array.');
    const parent = edit.parentId ? find(block, edit.parentId) : block.elements[0];
    if (!parent || !['object', 'array'].includes(String(meta(parent).dataType))) throw new Error('Select an object or array to add a value.');
    const path = [...meta(parent).path as Path];
    const isArray = meta(parent).dataType === 'array';
    const name = plainName(edit.name);
    if (!isArray && block.elements.some(item => JSON.stringify(meta(item).path) === JSON.stringify([...path, name]))) throw new Error('This object already has that key.');
    path.push(isArray ? (meta(parent).value as unknown[]).length : name);
    return apply(path, edit.kind === 'data-object' ? {} : edit.kind === 'data-array' ? [] : isArray ? name : null, isArray);
  }
  if (!['rename', 'members', 'deleteElement'].includes(edit.type)) return undefined;
  const item = find(block, (edit as { elementId: string }).elementId);
  const details = meta(item), path = details.path as Path;
  if (edit.type === 'deleteElement') { if (!path.length) return apply([], null); return apply(path, undefined); }
  if (edit.type === 'members') {
    let value: unknown;
    try { value = JSON.parse(edit.members.join('\n')); } catch { throw new Error('Enter a valid JSON value, such as "text", 42, true, {}, or [].'); }
    return apply(path, value);
  }
  if (edit.type === 'rename') {
    const name = plainName(edit.name);
    if (details.keySpan) {
      const siblingPath = [...path.slice(0, -1), name];
      if (JSON.stringify(path) !== JSON.stringify(siblingPath) && block.elements.some(other => JSON.stringify(meta(other).path) === JSON.stringify(siblingPath))) throw new Error('This object already has that key.');
      return patch(source, block, details.keySpan as Span, quote(name));
    }
    if (details.scalar) {
      if (details.dataType === 'string') return apply(path, name);
      let value: unknown; try { value = JSON.parse(name); } catch { throw new Error('Enter a valid scalar value.'); }
      return apply(path, value);
    }
    throw new Error('This collection has no property name. Edit its contents or add a child value.');
  }
  return undefined;
}

function yamlValue(node: unknown): unknown {
  if (isScalar(node)) return node.value;
  if (isAlias(node)) return `*${node.source}`;
  if (isMap(node)) return Object.fromEntries(node.items.map(pair => [String(yamlValue(pair.key)), yamlValue(pair.value)]));
  if (isSeq(node)) return node.items.map(yamlValue);
  return null;
}
function parseYamlData(block: DiagramBlock): void {
  const raw = payload(block).text, text = sanitizePayload(block, raw);
  const document = parseYaml(text, { keepSourceTokens: true, uniqueKeys: true });
  if (document.errors.length) { fail(block, document.errors[0].message, block.startLine + 1); return; }
  const anchors = new Map<string, string>();
  const aliases: { id: string; target: string }[] = [];
  const visit = (node: unknown, path: Path, parent?: DiagramElement, key?: unknown, pairSpan?: Span) => {
    const typed = node as YamlNode | null;
    const range = typed?.range ?? [pairSpan?.end ?? 0, pairSpan?.end ?? 0, pairSpan?.end ?? 0];
    const keyRange = (key as YamlNode | undefined)?.range;
    const collection = isMap(node) || isSeq(node);
    const dataType = isMap(node) ? 'object' : isSeq(node) ? 'array' : isAlias(node) ? 'reference' : node === null ? 'null' : typeof yamlValue(node);
    const arrayItem = typeof path.at(-1) === 'number';
    const value = yamlValue(node);
    const rows = typeof value === 'string' ? value.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 27)), 0) : 1;
    const name = path.length ? arrayItem && !collection ? String(value) : String(path.at(-1)) : collection ? (isMap(node) ? 'Object' : 'Array') : 'Value';
    const item = element(block, `data-${dataType}`, path, name, block.startLine + 1 + offsetLine(raw, range[0]), block.startLine + 1 + offsetLine(raw, range[1]), collection ? [] : [raw.slice(range[0], range[1]) || 'null'], {
      path, value, dataType, span: { start: range[0], end: range[1] }, sourceEnd: range[2], pairSpan, keySpan: keyRange ? { start: keyRange[0], end: keyRange[1] } : undefined,
      arrayItem, root: !path.length, editMembers: true, scalar: !collection, flow: (typed as { flow?: boolean } | null)?.flow ?? false, height: collection ? 78 : Math.max(80, rows * 18 + 55),
    }, parent?.id);
    if (parent) connect(block, parent.id, item.id);
    if ((typed as { anchor?: string } | null)?.anchor) anchors.set((typed as { anchor: string }).anchor, item.id);
    if (isAlias(node)) aliases.push({ id: item.id, target: node.source });
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key)) { fail(block, 'Complex YAML mapping keys need source editing.', item.startLine); continue; }
      const keyRange = pair.key.range ?? [0, 0, 0];
      const valueRange = (pair.value as YamlNode | null)?.range ?? [keyRange[1], keyRange[1], keyRange[2]];
      visit(pair.value, [...path, String(pair.key.value)], item, pair.key, { start: keyRange[0], end: valueRange[2] });
    }
    if (isSeq(node)) node.items.forEach((child, index) => visit(child, [...path, index], item));
  };
  visit(document.contents, []);
  for (const alias of aliases) {
    if (anchors.has(alias.target)) connect(block, alias.id, anchors.get(alias.target)!, 'alias');
    else fail(block, `YAML alias *${alias.target} has no matching anchor.`, block.elements.find(item => item.id === alias.id)?.startLine);
  }
}

const yamlKey = (name: string) => /^[\p{L}_][\p{L}\p{N}_ -]*$/u.test(name) && !/^(?:true|false|null|yes|no|on|off)$/i.test(name) ? name : quote(name);
function yamlDeleteSpan(raw: string, item: DiagramElement, parent?: DiagramElement): Span {
  const details = meta(item), valueSpan = details.span as Span;
  const span = details.pairSpan ? details.pairSpan as Span : { start: valueSpan.start, end: Number(details.sourceEnd ?? valueSpan.end) };
  if (parent && meta(parent).flow) {
    let start = span.start, end = valueSpan.end;
    while (/\s/.test(raw[end] ?? '') && end < raw.length) end++;
    if (raw[end] === ',') { end++; while (/[ \t]/.test(raw[end] ?? '') && end < raw.length) end++; }
    else { while (start > 0 && /\s/.test(raw[start - 1])) start--; if (raw[start - 1] === ',') start--; }
    return { start, end };
  }
  const start = raw.lastIndexOf('\n', span.start - 1) + 1;
  let end = span.end;
  if (end > start && raw[end - 1] !== '\n') { const next = raw.indexOf('\n', end); end = next < 0 ? raw.length : next + 1; }
  return { start, end };
}
function editYaml(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  const raw = payload(block).text, eol = eolOf(source);
  if (edit.type === 'addElement') {
    if (!['data-value', 'data-object', 'data-array'].includes(edit.kind)) throw new Error('Choose a YAML value, object, or array.');
    const parent = edit.parentId ? find(block, edit.parentId) : block.elements[0];
    if (!parent || !['object', 'array'].includes(String(meta(parent).dataType))) throw new Error('Select a mapping or sequence to add a value.');
    const name = plainName(edit.name), details = meta(parent), path = details.path as Path, sequence = details.dataType === 'array';
    if (!sequence && block.elements.some(item => JSON.stringify(meta(item).path) === JSON.stringify([...path, name]))) throw new Error('This mapping already has that key.');
    const value = edit.kind === 'data-object' ? '{}' : edit.kind === 'data-array' ? '[]' : sequence ? quote(name) : 'null';
    const span = details.span as Span;
    if (details.flow) {
      const end = Math.max(span.start, span.end - 1), existing = raw.slice(span.start + 1, end).trim();
      return patch(source, block, { start: end, end }, `${existing ? ', ' : ''}${sequence ? value : `${yamlKey(name)}: ${value}`}`);
    }
    const children = block.elements.filter(item => item.parentId === parent.id);
    const indent = children.length ? (raw.slice(raw.lastIndexOf('\n', (meta(children[0]).keySpan as Span | undefined)?.start ?? (meta(children[0]).span as Span).start - 1) + 1).match(/^ */)?.[0].length ?? 0) : path.length ? (raw.slice(raw.lastIndexOf('\n', span.start - 1) + 1, span.start).match(/^ */)?.[0].length ?? 0) + 2 : 0;
    const end = Number(details.sourceEnd ?? span.end);
    const prefix = end > 0 && raw[end - 1] !== '\n' ? eol : '';
    return patch(source, block, { start: end, end }, `${prefix}${' '.repeat(indent)}${sequence ? `- ${value}` : `${yamlKey(name)}: ${value}`}${eol}`);
  }
  if (!['rename', 'members', 'deleteElement'].includes(edit.type)) return undefined;
  const item = find(block, (edit as { elementId: string }).elementId), details = meta(item), span = details.span as Span, path = details.path as Path;
  if (edit.type === 'deleteElement') {
    if (!path.length) return patch(source, block, span, 'null');
    const parent = block.elements.find(candidate => candidate.id === item.parentId);
    const siblings = block.elements.filter(candidate => candidate.parentId === item.parentId);
    if (parent && siblings.length === 1) return patch(source, block, meta(parent).span as Span, meta(parent).dataType === 'array' ? '[]' : '{}');
    return patch(source, block, yamlDeleteSpan(raw, item, parent), '');
  }
  if (edit.type === 'rename') {
    const name = plainName(edit.name);
    if (details.keySpan) {
      const nextPath = [...path.slice(0, -1), name];
      if (JSON.stringify(path) !== JSON.stringify(nextPath) && block.elements.some(other => JSON.stringify(meta(other).path) === JSON.stringify(nextPath))) throw new Error('This mapping already has that key.');
      return patch(source, block, details.keySpan as Span, yamlKey(name));
    }
    if (details.scalar) {
      const replacement = details.dataType === 'string' ? quote(name) : name;
      const parsed = parseYaml(replacement); if (parsed.errors.length) throw new Error(`Invalid YAML value: ${parsed.errors[0].message}`);
      return patch(source, block, span, replacement);
    }
    throw new Error('This collection has no key to rename. Edit its contents or add a child.');
  }
  if (edit.type === 'members') {
    const replacement = edit.members.join(eol), parsed = parseYaml(replacement);
    if (parsed.errors.length) throw new Error(`Invalid YAML value: ${parsed.errors[0].message}`);
    const column = span.start - (raw.lastIndexOf('\n', span.start - 1) + 1);
    const adjusted = replacement.split(/\r?\n/).map((line, index) => index ? ' '.repeat(column) + line : line).join(eol);
    return patch(source, block, span, adjusted || 'null');
  }
  return undefined;
}

export interface Railroad {
  type: 'token' | 'seq' | 'choice' | 'repeat' | 'optional';
  text?: string;
  terminal?: boolean;
  children?: Railroad[];
  min?: number;
  max?: number | null;
}
const sequence = (children: Railroad[]): Railroad => children.length === 1 ? children[0] : { type: 'seq', children };
const alternative = (children: Railroad[]): Railroad => children.length === 1 ? children[0] : { type: 'choice', children };

/** Parse grammar structure instead of displaying its source as a rectangular diagram. */
export function parseRailroad(expression: string, regex = false): Railroad {
  if (expression.length > 12000) throw new Error('This expression is too large for the interactive railroad editor.');
  if (regex) {
    let at = 0;
    const choice = (): Railroad => {
      const branches = [seq()];
      while (expression[at] === '|') { at++; branches.push(seq()); }
      return alternative(branches);
    };
    const seq = (): Railroad => {
      const children: Railroad[] = [];
      while (at < expression.length && expression[at] !== ')' && expression[at] !== '|') {
        let node = atom();
        const quantifier = expression[at];
        if (quantifier === '*' || quantifier === '+' || quantifier === '?') {
          at++; node = quantifier === '?' ? { type: 'optional', children: [node] } : { type: 'repeat', children: [node], min: quantifier === '+' ? 1 : 0, max: null };
          if (expression[at] === '?') at++;
        } else if (quantifier === '{') {
          const count = expression.slice(at).match(/^\{(\d+)(?:,(\d*))?\}/);
          if (!count) throw new Error('A repetition must use {n}, {n,}, or {n,m}.');
          at += count[0].length;
          const min = Number(count[1]), max = count[2] === undefined ? min : count[2] === '' ? null : Number(count[2]);
          if (max !== null && max < min) throw new Error('A repetition maximum cannot be smaller than its minimum.');
          node = { type: 'repeat', children: [node], min, max };
          if (expression[at] === '?') at++;
        }
        const previous = children.at(-1);
        if (node.type === 'token' && node.terminal && previous?.type === 'token' && previous.terminal) previous.text = (previous.text ?? '') + (node.text ?? '');
        else children.push(node);
      }
      return sequence(children);
    };
    const atom = (): Railroad => {
      const char = expression[at++];
      if (char === '(') {
        let assertion = '';
        if (expression[at] === '?') {
          const prefix = expression.slice(at).match(/^\?(?::|=|!|<=|<!|<[A-Za-z_]\w*>)/);
          if (!prefix) throw new Error('Unsupported regular-expression group prefix.');
          assertion = prefix[0] === '?:' ? '' : prefix[0].startsWith('?<') && prefix[0].endsWith('>') ? `capture ${prefix[0].slice(2, -1)}` : ({ '?=': 'look ahead', '?!': 'negative look ahead', '?<=': 'look behind', '?<!': 'negative look behind' }[prefix[0]] ?? prefix[0]);
          at += prefix[0].length;
        }
        const child = choice();
        if (expression[at++] !== ')') throw new Error('Close the regular-expression group with ).');
        return assertion ? { type: 'seq', children: [{ type: 'token', text: assertion }, child] } : child;
      }
      if (char === '[') {
        const start = at - 1; let escaped = false;
        while (at < expression.length) { const next = expression[at++]; if (!escaped && next === ']') return { type: 'token', text: expression.slice(start, at), terminal: false }; escaped = !escaped && next === '\\'; }
        throw new Error('Close the character class with ].');
      }
      if (char === '\\') {
        const next = expression[at++]; if (!next) throw new Error('Complete the escape after \\.');
        if ((next === 'p' || next === 'P') && expression[at] === '{') { const end = expression.indexOf('}', at); if (end < 0) throw new Error('Close the Unicode property with }.'); const name = expression.slice(at + 1, end); at = end + 1; return { type: 'token', text: `${next === 'P' ? 'not ' : ''}${name}` }; }
        const labels: Record<string, string> = { d: 'digit', D: 'not digit', w: 'word character', W: 'not word', s: 'whitespace', S: 'not whitespace', b: 'word boundary', B: 'not boundary', n: 'newline', r: 'return', t: 'tab' };
        return { type: 'token', text: labels[next] ?? (/\d/.test(next) ? `reference ${next}` : next), terminal: !labels[next] && !/\d/.test(next) };
      }
      if ('*+?{}'.includes(char)) throw new Error(`Unexpected ${char}; a repetition needs a preceding expression.`);
      return { type: 'token', text: char === '.' ? 'any character' : char === '^' ? 'start' : char === '$' ? 'end' : char, terminal: !'.^$'.includes(char) };
    };
    const result = choice(); if (at !== expression.length) throw new Error('Unexpected closing parenthesis.'); return result;
  }
  const tokens: string[] = [];
  let cursor = 0;
  const stripped = expression.replace(/\(\*[\s\S]*?\*\)/g, match => ' '.repeat(match.length));
  while (cursor < stripped.length) {
    const match = stripped.slice(cursor).match(/^\s+|^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\?[^?]*\?|[A-Za-z_][\w-]*|\d+|[{}\[\](),|*+\-])/);
    if (!match) throw new Error(`Unsupported EBNF token near ${stripped.slice(cursor, cursor + 20)}.`);
    cursor += match[0].length; if (match[0].trim()) tokens.push(match[0]);
  }
  let at = 0;
  const choice = (): Railroad => { const branches = [seq()]; while (tokens[at] === '|') { at++; branches.push(seq()); } return alternative(branches); };
  const seq = (): Railroad => {
    const children: Railroad[] = [];
    while (at < tokens.length && !['|', ')', ']', '}'].includes(tokens[at])) {
      if (tokens[at] === ',') { at++; continue; }
      let count: number | undefined;
      if (/^\d+$/.test(tokens[at]) && tokens[at + 1] === '*') { count = Number(tokens[at]); at += 2; }
      const token = tokens[at++];
      let node: Railroad;
      if (['(', '[', '{'].includes(token)) {
        const child = choice(), close = ({ '(': ')', '[': ']', '{': '}' } as Record<string, string>)[token];
        if (tokens[at++] !== close) throw new Error(`Close the EBNF group with ${close}.`);
        node = token === '(' ? child : token === '[' ? { type: 'optional', children: [child] } : { type: 'repeat', children: [child], min: 0, max: null };
        if (token === '{' && tokens[at] === '-') { at++; node.min = 1; }
      } else node = { type: 'token', text: /^['"?]/.test(token) ? token.slice(1, -1) : token, terminal: /^['"]/.test(token) };
      if (count !== undefined) node = { type: 'repeat', children: [node], min: count, max: count };
      children.push(node);
    }
    return sequence(children);
  };
  const result = choice(); if (at !== tokens.length) throw new Error('Unexpected closing EBNF group.'); return result;
}

export function railroadSize(node: Railroad): { width: number; height: number } {
  if (node.type === 'token') return { width: Math.max(58, (node.text?.length ?? 0) * 7.2 + 26), height: 38 };
  const children = (node.children ?? []).map(railroadSize);
  if (node.type === 'seq') return { width: children.reduce((sum, child) => sum + child.width + 24, 0) + 8, height: Math.max(38, ...children.map(child => child.height)) };
  if (node.type === 'choice') return { width: Math.max(40, ...children.map(child => child.width)) + 60, height: children.reduce((sum, child) => sum + child.height + 18, 0) - 18 };
  return { width: (children[0]?.width ?? 30) + 60, height: (children[0]?.height ?? 38) + 40 };
}
function parseGrammar(block: DiagramBlock): void {
  const body = payload(block).text;
  const text = sanitizePayload(block, body);
  if (block.kind === 'regex') {
    const start = text.search(/\S/); if (start < 0) return;
    const end = text.trimEnd().length, expression = text.slice(start, end).replace(/\r?\n/g, '');
    try {
      const railroad = parseRailroad(expression, true), size = railroadSize(railroad);
      element(block, 'grammar-regex', 'expression', expression, block.startLine + 1 + offsetLine(text, start), block.startLine + 1 + offsetLine(text, end), [expression], { expression, railroad, span: { start, end }, editMembers: true, width: Math.max(300, size.width + 40), height: size.height + 85, x: 80, y: 80 });
    } catch (error) { fail(block, (error as Error).message, block.startLine + 1 + offsetLine(text, start)); }
    return;
  }
  const masked = text.replace(/\(\*[\s\S]*?\*\)/g, match => match.replace(/[^\r\n]/g, ' '));
  const rule = /([A-Za-z_][\w-]*)\s*=\s*((?:[^;'"?]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\?[^?]*\?)*);/g;
  let match: RegExpExecArray | null, y = 60, covered = masked.split('');
  while ((match = rule.exec(masked))) {
    const start = match.index, nameStart = start, expressionStart = start + match[0].indexOf('=') + 1;
    const expression = match[2].trim();
    try {
      const railroad = parseRailroad(expression), size = railroadSize(railroad);
      element(block, 'grammar-rule', match[1], match[1], block.startLine + 1 + offsetLine(text, start), block.startLine + 1 + offsetLine(text, start + match[0].length), [expression], { expression, railroad, nameSpan: { start: nameStart, end: nameStart + match[1].length }, span: { start, end: start + match[0].length }, expressionSpan: { start: expressionStart, end: start + match[0].length - 1 }, editMembers: true, width: Math.max(300, size.width + 40), height: size.height + 85, x: 80, y });
      y += size.height + 130;
    } catch (error) { fail(block, (error as Error).message, block.startLine + 1 + offsetLine(text, start)); }
    for (let index = start; index < start + match[0].length; index++) covered[index] = /[\r\n]/.test(covered[index]) ? covered[index] : ' ';
  }
  const remaining = covered.join('');
  if (remaining.trim()) fail(block, 'Expected an EBNF rule in the form name = expression;.', block.startLine + 1 + offsetLine(text, remaining.search(/\S/)));
}
function editGrammar(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  if (edit.type === 'addElement') {
    const name = plainName(edit.name);
    if (block.kind === 'regex') {
      const existing = block.elements[0];
      const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return existing ? patch(source, block, meta(existing).span as Span, String(meta(existing).expression) + literal) : spliceLines(source, block.endLine, 0, [literal]);
    }
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error('A grammar rule name must be an identifier.');
    if (block.elements.some(item => item.name === name)) throw new Error('That grammar rule already exists.');
    return spliceLines(source, block.endLine, 0, [`${name} = "value";`]);
  }
  if (!['rename', 'members', 'deleteElement'].includes(edit.type)) return undefined;
  const item = find(block, (edit as { elementId: string }).elementId), details = meta(item);
  if (edit.type === 'deleteElement') return patch(source, block, details.span as Span, '');
  if (edit.type === 'rename' && block.kind === 'ebnf') {
    const name = plainName(edit.name);
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error('A grammar rule name must be an identifier.');
    if (block.elements.some(other => other.id !== item.id && other.name === name)) throw new Error('That grammar rule already exists.');
    // Update references only outside quoted terminals and EBNF comments.
    const body = payload(block).text;
    const replacement = body.replace(/\(\*[\s\S]*?\*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\?[^?]*\?|[A-Za-z_][\w-]*/g, token => token === item.name ? name : token);
    return patch(source, block, { start: 0, end: body.length }, replacement);
  }
  const expression = edit.type === 'rename' ? oneLine(edit.name) : edit.type === 'members' ? edit.members.join('\n') : '';
  parseRailroad(expression, block.kind === 'regex');
  return patch(source, block, (block.kind === 'regex' ? details.span : details.expressionSpan) as Span, block.kind === 'regex' ? expression : ` ${expression}`);
}

/** A small expression converter; TeX layout itself is delegated to KaTeX's native MathML output. */
export function asciiMathToTex(source: string): string {
  const tokens = source.match(/"[^"]*"|<=>|<=|>=|!=|->|<-|=>|\+-|[A-Za-z]+|\d+(?:\.\d+)?|\S/g) ?? [];
  let at = 0;
  const symbols: Record<string, string> = { sum: '\\sum', prod: '\\prod', int: '\\int', oo: '\\infty', infinity: '\\infty', pi: '\\pi', alpha: '\\alpha', beta: '\\beta', gamma: '\\gamma', delta: '\\delta', theta: '\\theta', lambda: '\\lambda', mu: '\\mu', sigma: '\\sigma', phi: '\\phi', omega: '\\omega', epsilon: '\\epsilon', in: '\\in', notin: '\\notin', subset: '\\subset', sup: '\\sup', inf: '\\inf', and: '\\land', or: '\\lor', not: '\\neg', '->': '\\to', '<-': '\\leftarrow', '=>': '\\Rightarrow', '<=>': '\\Leftrightarrow', '<=': '\\le', '>=': '\\ge', '!=': '\\ne', '*': '\\cdot', '+-': '\\pm' };
  const functions = new Set(['sin', 'cos', 'tan', 'sinh', 'cosh', 'log', 'ln', 'exp', 'lim', 'min', 'max']);
  const expr = (closing?: string): string => {
    const pieces: string[] = [];
    while (at < tokens.length && tokens[at] !== closing) {
      let value = atom();
      while (tokens[at] === '_' || tokens[at] === '^') { const op = tokens[at++]; value += `${op}{${atom(true)}}`; }
      if (tokens[at] === '/') { at++; value = `\\frac{${value}}{${atom(true)}}`; }
      pieces.push(value);
    }
    if (closing) { if (tokens[at++] !== closing) throw new Error(`Close the math group with ${closing}.`); }
    return pieces.join(' ');
  };
  const atom = (stripGrouping = false): string => {
    const token = tokens[at++]; if (!token) return '';
    if (token === '(' || token === '[' || token === '{') { const close = token === '(' ? ')' : token === '[' ? ']' : '}', content = expr(close); return stripGrouping ? content : `\\left${token === '{' ? '\\{' : token} ${content} \\right${close === '}' ? '\\}' : close}`; }
    if (token === 'sqrt') return `\\sqrt{${atom(true)}}`;
    if (token === 'frac') { const numerator = atom(true); return `\\frac{${numerator}}{${atom(true)}}`; }
    if (token === 'root') { const degree = atom(true); return `\\sqrt[${degree}]{${atom(true)}}`; }
    if (['bb', 'mathbf', 'bold', 'vec', 'hat', 'bar', 'abs'].includes(token)) {
      const value = atom(true); if (token === 'abs') return `\\left|${value}\\right|`;
      return `\\${['bb', 'bold'].includes(token) ? 'mathbf' : token}{${value}}`;
    }
    if (token.startsWith('"')) return `\\text{${token.slice(1, -1).replace(/[{}\\]/g, '')}}`;
    if (functions.has(token)) return `\\${token}`;
    if (symbols[token]) return symbols[token];
    if (/^[A-Za-z]{2,}$/.test(token)) return `\\mathrm{${token}}`;
    if (['&', '%', '#', '$'].includes(token)) return `\\${token}`;
    return token;
  };
  return expr();
}
function parseMath(block: DiagramBlock): void {
  const text = sanitizePayload(block, payload(block).text);
  const start = text.search(/\S/); if (start < 0) return;
  const end = text.trimEnd().length, formula = text.slice(start, end);
  try {
    const tex = block.kind === 'latex' ? formula : asciiMathToTex(formula);
    const mathml = katex.renderToString(tex, { output: 'mathml', displayMode: true, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000 });
    element(block, `math-${block.kind}`, 'formula', formula, block.startLine + 1 + offsetLine(text, start), block.startLine + 1 + offsetLine(text, end), [formula], { formula, mathml, span: { start, end }, editMembers: true, width: Math.max(360, Math.min(950, formula.length * 11)), height: 170, x: 80, y: 80 });
  } catch (error) { fail(block, `Invalid formula: ${(error as Error).message}`, block.startLine + 1 + offsetLine(text, start)); }
}
function editMath(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  if (edit.type === 'addElement') {
    const formula = plainName(edit.name), existing = block.elements[0];
    return existing ? patch(source, block, meta(existing).span as Span, `${String(meta(existing).formula)} + ${formula}`) : spliceLines(source, block.endLine, 0, [formula]);
  }
  if (!['rename', 'members', 'deleteElement'].includes(edit.type)) return undefined;
  const item = find(block, (edit as { elementId: string }).elementId);
  const formula = edit.type === 'deleteElement' ? '' : edit.type === 'rename' ? oneLine(edit.name) : edit.type === 'members' ? edit.members.join(eolOf(source)) : '';
  if (formula) katex.renderToString(block.kind === 'latex' ? formula : asciiMathToTex(formula), { output: 'mathml', throwOnError: true, trust: false, maxExpand: 1000 });
  return patch(source, block, meta(item).span as Span, formula);
}

interface SaltCell { start: number; end: number; raw: string }
function saltCells(line: string): SaltCell[] {
  const cells: SaltCell[] = []; let start = 0, quoteState = false, brackets = 0;
  for (let index = 0; index <= line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== '\\') quoteState = !quoteState;
    if (!quoteState && char === '[') brackets++;
    if (!quoteState && char === ']') brackets--;
    if (index === line.length || char === '|' && !quoteState && brackets === 0) {
      const value = line.slice(start, index), leading = value.length - value.trimStart().length, trailing = value.length - value.trimEnd().length;
      cells.push({ start: start + leading, end: index - trailing, raw: value.trim() }); start = index + 1;
    }
  }
  return cells;
}
const cleanSalt = (value: string) => value.replace(/<\/?(?:b|i|u|s|size(?::[^>]+)?|color(?::[^>]+)?)>/gi, '').replace(/\\n/g, '\n');
function saltWidget(raw: string): { kind: string; name: string; checked?: boolean; prefix?: string; suffix?: string } {
  if (/^\([Xx* ]?\)\s*/.test(raw)) { const match = raw.match(/^(\([Xx* ]?\)\s*)(.*)$/)!; return { kind: 'salt-radio', name: cleanSalt(match[2]), checked: /[Xx*]/.test(match[1]), prefix: match[1] }; }
  if (/^\[[Xx* ]?\]\s+/.test(raw) || /^\[\]\s*/.test(raw)) { const match = raw.match(/^(\[[Xx* ]?\]\s*)(.*)$/)!; return { kind: 'salt-checkbox', name: cleanSalt(match[2]), checked: /[Xx*]/.test(match[1]), prefix: match[1] }; }
  if (/^\[.*\]$/.test(raw)) return { kind: 'salt-button', name: cleanSalt(raw.slice(1, -1)), prefix: '[', suffix: ']' };
  if (/^".*"$/.test(raw)) return { kind: 'salt-input', name: cleanSalt(raw.slice(1, -1)).trimEnd(), prefix: '"', suffix: '"' };
  if (/^\^.*\^$/.test(raw)) return { kind: 'salt-select', name: cleanSalt(raw.slice(1, -1)), prefix: '^', suffix: '^' };
  if (/^([-=~.])\1{1,}$/.test(raw)) return { kind: 'salt-separator', name: 'Separator' };
  if (raw === '.') return { kind: 'salt-spacer', name: '' };
  return { kind: 'salt-label', name: cleanSalt(raw) };
}
function parseSalt(block: DiagramBlock, lines: string[]): void {
  const groups: DiagramElement[] = [];
  let row = 0, maxColumns = 1;
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const raw = lines[line], trimmed = raw.trim();
    if (!trimmed || /^['!]/.test(trimmed) || trimmed === 'salt') continue;
    if (/^title\s+/i.test(trimmed)) { block.title = trimmed.replace(/^title\s+/i, ''); continue; }
    if (/^\{[+#^!T/SI-]*\s*$/.test(trimmed)) {
      const panel = element(block, 'salt-panel', line, groups.length ? 'Panel' : 'Window', line, line, [], { editable: false, container: true, width: 500, height: 80, x: 60 + groups.length * 18, y: 50 + row * 64, startRow: row, columns: 1 }, groups.at(-1)?.id);
      groups.push(panel); row++; continue;
    }
    if (trimmed === '}') {
      const group = groups.pop(); if (!group) { fail(block, 'Unmatched Salt panel closing brace.', line); continue; }
      group.endLine = line; group.meta = { ...meta(group), width: Math.max(260, Number(meta(group).columns) * 225 + 40), height: (row - Number(meta(group).startRow)) * 64 + 18 };
      row++; continue;
    }
    const cells = saltCells(raw); maxColumns = Math.max(maxColumns, cells.length);
    if (groups.length) for (const group of groups) group.meta = { ...meta(group), columns: Math.max(Number(meta(group).columns), cells.length) };
    cells.forEach((cell, column) => {
      if (!cell.raw) return;
      const widget = saltWidget(cell.raw);
      element(block, widget.kind, [line, column], widget.name, line, line, ['salt-checkbox', 'salt-radio'].includes(widget.kind) ? [widget.checked ? 'checked' : 'unchecked'] : [], {
        cellStart: cell.start, cellEnd: cell.end, raw: cell.raw, checked: widget.checked, prefix: widget.prefix, suffix: widget.suffix,
        bold: /<b>|\*\*/i.test(cell.raw), italic: /<i>/i.test(cell.raw), editMembers: ['salt-checkbox', 'salt-radio'].includes(widget.kind),
        editable: !['salt-separator', 'salt-spacer'].includes(widget.kind), width: Math.max(160, Math.min(300, widget.name.length * 8 + 36)), height: 48,
        x: 90 + column * 225 + Math.max(0, groups.length - 1) * 18, y: 56 + row * 64,
      }, groups.at(-1)?.id);
    });
    row++;
  }
  if (groups.length) fail(block, 'Close the Salt panel with }.', groups.at(-1)!.startLine);
  block.meta = { ...block.meta, width: maxColumns * 225 + 100, height: row * 64 + 80 };
}
function encodeSalt(kind: string, name: string, checked = false): string {
  if (/[|\r\n{}]/.test(name)) throw new Error('Salt labels cannot contain row or panel delimiters.');
  if (kind === 'salt-button') return `[${name.replace(/[\[\]]/g, '')}]`;
  if (kind === 'salt-input') return `"${name.replace(/"/g, '')}   "`;
  if (kind === 'salt-select') return `^${name.replace(/\^/g, '')}^`;
  if (kind === 'salt-checkbox') return `[${checked ? 'X' : ''}] ${name}`;
  if (kind === 'salt-radio') return `(${checked ? 'X' : ''}) ${name}`;
  if (kind === 'salt-separator') return '----';
  return name;
}
function editSalt(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  if (edit.type === 'addElement') {
    if (!['salt-label', 'salt-button', 'salt-input', 'salt-select', 'salt-checkbox', 'salt-radio', 'salt-separator'].includes(edit.kind)) throw new Error('Choose a Salt control.');
    const parent = edit.parentId ? find(block, edit.parentId) : block.elements.find(item => item.kind === 'salt-panel');
    const insertion = parent?.kind === 'salt-panel' ? parent.endLine : block.endLine;
    const widget = encodeSalt(edit.kind, plainName(edit.name));
    return parent ? spliceLines(source, insertion, 0, ['  ' + widget]) : spliceLines(source, block.endLine, 0, ['{', '  ' + widget, '}']);
  }
  if (!['rename', 'members', 'deleteElement'].includes(edit.type)) return undefined;
  const item = find(block, (edit as { elementId: string }).elementId), details = meta(item);
  if (item.kind === 'salt-panel') throw new Error('Edit the panel structure through its child controls.');
  const line = sourceLines(source)[item.startLine], start = Number(details.cellStart), end = Number(details.cellEnd);
  if (edit.type === 'deleteElement') {
    const cells = saltCells(line);
    if (cells.length === 1) return spliceLines(source, item.startLine, 1);
    let begin = start, finish = end;
    const right = line.indexOf('|', end);
    if (right >= 0) { finish = right + 1; while (line[finish] === ' ') finish++; }
    else { const left = line.lastIndexOf('|', start); if (left >= 0) begin = left; }
    return replaceLine(source, item.startLine, line.slice(0, begin) + line.slice(finish));
  }
  const name = edit.type === 'rename' ? plainName(edit.name) : item.name;
  const checked = edit.type === 'members' ? /^(?:checked|true|yes|x)$/i.test(edit.members[0]?.trim() ?? '') : Boolean(details.checked);
  const style = String(details.raw).match(/^(?:<(?:b|i|u)>)+/)?.[0] ?? '';
  const replacement = encodeSalt(item.kind, style + name, checked);
  return replaceLine(source, item.startLine, line.slice(0, start) + replacement + line.slice(end));
}

export interface ChartAxis { name: string; categories?: string[]; min?: number; max?: number; grid?: boolean; ticks?: { value: number; label: string }[] }
export interface ChartSeries { id: string; type: 'bar' | 'line' | 'area' | 'scatter'; name: string; values: number[] | [number, number][]; color?: string; labels?: boolean; secondary?: boolean }
export interface ChartModel { horizontal: ChartAxis; vertical: ChartAxis; secondary?: ChartAxis; orientation: string; stacked: boolean; series: ChartSeries[]; annotations: { text: string; x: string; y: number }[] }
function chartValues(raw: string): number[] | [number, number][] {
  if (raw.includes('(')) {
    const matches = [...raw.matchAll(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g)];
    if (!matches.length || raw.replace(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g, '').replace(/[,\s]/g, '')) throw new Error('Use numeric (x,y) pairs.');
    return matches.map(match => [Number(match[1]), Number(match[2])] as [number, number]);
  }
  const values = raw.split(',').map(value => Number(value.trim()));
  if (!raw.trim()) return [];
  if (values.some(value => !Number.isFinite(value))) throw new Error('Chart values must be numbers.');
  return values;
}
function chartAxis(raw: string): ChartAxis {
  const name = raw.match(/^\s*"((?:\\.|[^"\\])*)"/)?.[1] ?? '';
  const list = raw.match(/\[([^\]]*)\]/), range = raw.match(/(-?\d+(?:\.\d+)?)\s*-->\s*(-?\d+(?:\.\d+)?)/);
  if (range && Number(range[1]) >= Number(range[2])) throw new Error('An axis maximum must exceed its minimum.');
  const ticks = raw.match(/\bticks\s*\[([^\]]*)\]/)?.[1];
  return { name, ...(list && !range ? { categories: list[1].split(',').map(label => label.trim().replace(/^"|"$/g, '')) } : {}), ...(range ? { min: Number(range[1]), max: Number(range[2]) } : {}), ...(ticks ? { ticks: [...ticks.matchAll(/(-?[\d.]+)\s*:\s*"([^"]*)"/g)].map(match => ({ value: Number(match[1]), label: match[2] })) } : {}), grid: /\bgrid\b/.test(raw) };
}
function parseChart(block: DiagramBlock, lines: string[]): void {
  const model: ChartModel = { horizontal: { name: '' }, vertical: { name: '' }, orientation: 'vertical', stacked: false, series: [], annotations: [] };
  let style = false;
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const text = lines[line].trim(); if (!text || /^'/.test(text)) continue;
    if (/^<style>/i.test(text)) { style = !/<\/style>/i.test(text); note(block, 'Chart styles are preserved; source series colors and native geometry are used.', line); continue; }
    if (style) { if (/<\/style>/i.test(text)) style = false; continue; }
    if (/^title\s+/i.test(text)) { block.title = text.replace(/^title\s+/i, ''); continue; }
    if (/^orientation\s+/i.test(text)) { model.orientation = text.split(/\s+/)[1]; continue; }
    if (/^stackMode\s+/i.test(text)) { model.stacked = /stacked/i.test(text); continue; }
    if (/^(?:legend|spacing|label-right|label-top)\b/.test(text)) continue;
    const axis = text.match(/^(h-axis|v-axis|v2-axis)\s+(.*)$/);
    if (axis) {
      try {
        const parsed = chartAxis(axis[2]);
        if (axis[1] === 'h-axis') model.horizontal = parsed; else if (axis[1] === 'v-axis') model.vertical = parsed; else model.secondary = parsed;
        element(block, 'chart-axis', axis[1], parsed.name || axis[1], line, line, [axis[2].replace(/^\s*"(?:\\.|[^"\\])*"\s*/, '')], { axis: axis[1], axisValue: parsed, raw: axis[2], editMembers: true, width: 230, height: 95, x: 850, y: 65 + block.elements.length * 120 });
      } catch (error) { fail(block, (error as Error).message, line); }
      continue;
    }
    const series = text.match(/^(bar|line|area|scatter)\s+(?:<<[^>]+>>\s*)?(?:"((?:\\.|[^"\\])*)"\s*)?\[(.*)\](.*)$/);
    if (series) {
      try {
        const values = chartValues(series[3]);
        const name = series[2] ?? `Series ${model.series.length + 1}`;
        const seriesId = id(`chart-${series[1]}`, [name, model.series.filter(item => item.name === name).length]);
        const color = series[4].match(/#([\w]+)/)?.[1];
        const data: ChartSeries = { id: seriesId, type: series[1] as ChartSeries['type'], name, values, color: color ? /^[\da-f]{3,8}$/i.test(color) ? '#' + color : color : undefined, labels: /\blabels\b/.test(series[4]), secondary: /\bv2\b/.test(series[4]) };
        model.series.push(data);
        const item = element(block, `chart-${series[1]}`, [name, model.series.filter(item => item.name === name).length - 1], name, line, line, values.map(value => Array.isArray(value) ? `(${value.join(',')})` : String(value)), { series: data, values, editMembers: true, width: 230, height: 105, x: 850, y: 65 + block.elements.length * 120 });
        item.id = seriesId;
      } catch (error) { fail(block, (error as Error).message, line); }
      continue;
    }
    const annotation = text.match(/^annotation\s+"([^"]*)"\s+at\s*\(([^,]+),\s*(-?[\d.]+)\)/);
    if (annotation) { model.annotations.push({ text: annotation[1], x: annotation[2].trim(), y: Number(annotation[3]) }); continue; }
    fail(block, `Unrecognized chart statement: ${text.slice(0, 70)}`, line);
  }
  element(block, 'chart-plot', 'plot', block.title === 'chart diagram' ? 'Chart' : block.title, block.startLine + 1, block.endLine - 1, [], { chart: model, editable: false, width: 740, height: 470, x: 60, y: 60 });
  block.meta = { ...block.meta, chart: model };
}
function editChart(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  if (edit.type === 'addElement') {
    if (!['chart-bar', 'chart-line', 'chart-area', 'chart-scatter'].includes(edit.kind)) throw new Error('Choose a bar, line, area, or scatter series.');
    const model = block.meta?.chart as ChartModel, categories = model.horizontal.categories ?? model.vertical.categories;
    const count = categories?.length ?? 4;
    return spliceLines(source, block.endLine, 0, [`${edit.kind.slice(6)} ${quote(plainName(edit.name))} [${Array.from({ length: count }, (_, index) => (index + 1) * 10).join(', ')}]`]);
  }
  if (!['rename', 'members', 'deleteElement'].includes(edit.type)) return undefined;
  const item = find(block, (edit as { elementId: string }).elementId), line = sourceLines(source)[item.startLine];
  if (item.kind === 'chart-plot') throw new Error('Edit a series or axis beside the chart.');
  if (edit.type === 'deleteElement') return spliceLines(source, item.startLine, 1);
  if (item.kind === 'chart-axis') {
    const axis = String(meta(item).axis), raw = String(meta(item).raw);
    const body = edit.type === 'rename' ? `${quote(plainName(edit.name))} ${raw.replace(/^\s*"(?:\\.|[^"\\])*"\s*/, '')}` : `${quote((meta(item).axisValue as ChartAxis).name)} ${edit.type === 'members' ? edit.members.join(' ') : ''}`;
    chartAxis(body); return replaceLine(source, item.startLine, `${line.match(/^\s*/)?.[0] ?? ''}${axis} ${body}`);
  }
  if (edit.type === 'rename') {
    const prefix = line.match(/^(\s*(?:bar|line|area|scatter)\s+(?:<<[^>]+>>\s*)?)(?:"(?:\\.|[^"\\])*"\s*)?/)!;
    return replaceLine(source, item.startLine, prefix[1] + quote(plainName(edit.name)) + ' ' + line.slice(prefix[0].length));
  }
  if (edit.type === 'members') {
    const values = edit.members.join(', '); chartValues(values);
    const start = line.indexOf('['), end = line.lastIndexOf(']');
    return replaceLine(source, item.startLine, line.slice(0, start + 1) + values + line.slice(end));
  }
  return undefined;
}

function parseFiles(block: DiagramBlock, lines: string[]): void {
  const entries = new Map<string, DiagramElement>();
  const root = element(block, 'files-folder', '/', '/', block.startLine, block.startLine, [], { path: '/', editable: false, width: 190, height: 70 }); entries.set('/', root);
  let previous = root, inNote = false, noteStart = 0, noteLines: string[] = [];
  for (let line = block.startLine + 1; line < block.endLine; line++) {
    const text = lines[line].trim(); if (!text || /^'/.test(text)) continue;
    if (text === '<note>') { inNote = true; noteStart = line; noteLines = []; continue; }
    if (inNote) {
      if (text === '</note>') { previous.members = noteLines; previous.meta = { ...meta(previous), noteStart, noteEnd: line, editMembers: true, height: 70 + noteLines.length * 16 }; inNote = false; }
      else noteLines.push(lines[line]);
      continue;
    }
    if (/^title\s+/i.test(text)) { block.title = text.replace(/^title\s+/i, ''); continue; }
    if (!text.startsWith('/')) { fail(block, 'A file entry must start with /.', line); continue; }
    const segments = text.split('/').filter(Boolean); let parent = root, path = '';
    for (let index = 0; index < segments.length; index++) {
      path += '/' + segments[index];
      let child = entries.get(path);
      const folder = index < segments.length - 1 || text.endsWith('/');
      if (!child) { child = element(block, folder ? 'files-folder' : 'files-file', path, segments[index], line, line, [], { path, explicit: index === segments.length - 1, editMembers: true, width: 200, height: 70 }, parent.id); entries.set(path, child); connect(block, parent.id, child.id); }
      else if (folder && child.kind !== 'files-folder') child.kind = 'files-folder';
      child.meta = { ...meta(child), sourceLines: [...new Set([...(meta(child).sourceLines as number[] ?? []), line])], explicit: Boolean(meta(child).explicit) || index === segments.length - 1 };
      parent = child;
    }
    previous = parent;
  }
  if (inNote) fail(block, 'Close the file note with </note>.', noteStart);
}
function editFiles(source: string, block: DiagramBlock, edit: DiagramEdit): string | undefined {
  if (edit.type === 'addElement') {
    if (!['files-file', 'files-folder'].includes(edit.kind)) throw new Error('Choose a file or folder.');
    const parent = edit.parentId ? find(block, edit.parentId) : block.elements[0];
    const base = String(meta(parent).path).replace(/\/$/, ''), name = plainName(edit.name).replace(/^\/+/, '');
    if (name.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Use a valid relative file path.');
    const path = base + '/' + name;
    if (block.elements.some(item => meta(item).path === path)) throw new Error('That path already exists in the tree.');
    return spliceLines(source, block.endLine, 0, [path + (edit.kind === 'files-folder' ? '/' : '')]);
  }
  if (!['rename', 'members', 'deleteElement'].includes(edit.type)) return undefined;
  const item = find(block, (edit as { elementId: string }).elementId), details = meta(item), path = String(details.path);
  if (path === '/') throw new Error('The file-tree root cannot be renamed or removed.');
  const lines = sourceLines(source);
  if (edit.type === 'rename') {
    const name = plainName(edit.name); if (/[\/\\]/.test(name)) throw new Error('Rename one path segment at a time.');
    const next = path.slice(0, path.lastIndexOf('/') + 1) + name;
    if (block.elements.some(other => other.id !== item.id && meta(other).path === next)) throw new Error('That path already exists.');
    for (const line of details.sourceLines as number[] ?? []) { const trimmed = lines[line].trim(); if (trimmed === path || trimmed.startsWith(path + '/')) lines[line] = lines[line].replace(path, next); }
    return lines.join(eolOf(source));
  }
  if (edit.type === 'deleteElement') {
    const removed = new Set<number>();
    for (const descendant of block.elements) if (meta(descendant).path === path || String(meta(descendant).path).startsWith(path + '/')) {
      for (const line of meta(descendant).sourceLines as number[] ?? []) removed.add(line);
      if (typeof meta(descendant).noteStart === 'number') for (let line = Number(meta(descendant).noteStart); line <= Number(meta(descendant).noteEnd); line++) removed.add(line);
    }
    return lines.filter((_, index) => !removed.has(index)).join(eolOf(source));
  }
  if (edit.type === 'members') {
    if (edit.members.some(line => /^\s*<\/?note>\s*$/.test(line))) throw new Error('Enter note text without note delimiters.');
    if (typeof details.noteStart === 'number') return spliceLines(source, Number(details.noteStart) + 1, Number(details.noteEnd) - Number(details.noteStart) - 1, edit.members);
    const ownedLines = details.sourceLines as number[];
    return spliceLines(source, Math.max(...ownedLines) + 1, 0, ['<note>', ...edit.members, '</note>']);
  }
  return undefined;
}

const dataTemplates: DiagramTemplate[] = [
  { kind: 'json', label: 'JSON', description: 'Editable object, array, and value trees', palette: ['data-value', 'data-object', 'data-array'], source: wrap('json', '{\n  "order": {\n    "reference": "B-42",\n    "items": ["Notebook", "Pencil"],\n    "confirmed": true\n  }\n}') },
  { kind: 'yaml', label: 'YAML', description: 'Mappings, sequences, scalar values, and aliases', palette: ['data-value', 'data-object', 'data-array'], source: wrap('yaml', 'order:\n  reference: B-42\n  items:\n    - Notebook\n    - Pencil\n  confirmed: true') },
  { kind: 'salt', label: 'Wireframe / Salt', description: 'Native form controls arranged in panels and rows', palette: ['salt-label', 'salt-button', 'salt-input', 'salt-checkbox', 'salt-radio', 'salt-select', 'salt-separator'], source: wrap('salt', '{+\n  <b>Account settings\n  Name | "Your name       "\n  Theme | ^System^\n  [X] Send updates\n  () Standard | (X) Priority\n  [Cancel] | [Save]\n}') },
  { kind: 'ebnf', label: 'EBNF', description: 'Editable grammar rules with native railroad diagrams', palette: ['grammar-rule'], source: wrap('ebnf', 'command = "ship", identifier, [ "express" ];\nidentifier = letter, { letter | digit };\nletter = "a" | "b" | "c";') },
  { kind: 'regex', label: 'Regular expression', description: 'Railroads for groups, choices, classes, and repetition', palette: ['grammar-token'], source: wrap('regex', '[A-Z]{2}-[0-9]{4}(draft|final)?') },
  { kind: 'math', label: 'AsciiMath', description: 'Editable formulas using native MathML typesetting', palette: ['math-expression'], source: wrap('math', 'total = sum_(i=1)^n price_i * quantity_i') },
  { kind: 'latex', label: 'LaTeX formula', description: 'Native MathML for TeX mathematical notation', palette: ['math-expression'], source: wrap('latex', '\\sum_{i=1}^{n} p_i q_i = \\frac{a+b}{2}') },
  { kind: 'chart', label: 'Chart', description: 'Bars, lines, areas, scatter, axes, and series', palette: ['chart-bar', 'chart-line', 'chart-area', 'chart-scatter'], source: wrap('chart', 'h-axis [Jan, Feb, Mar, Apr]\nv-axis "Orders" 0 --> 100 grid\nbar "Completed" [35, 52, 67, 81] #4c8eda\nline "Target" [40, 55, 70, 85] #e7a24b\nlegend bottom') },
  { kind: 'files', label: 'Files tree', description: 'Directories, files, and attached notes', palette: ['files-file', 'files-folder'], source: wrap('files', '/src/main.ts\n/src/model/order.ts\n/tests/order.test.ts\n/README.md') },
];

function treeLayout(block: DiagramBlock): Record<string, Point> {
  const positions: Record<string, Point> = Object.create(null);
  const children = new Map<string, DiagramElement[]>();
  for (const item of block.elements) if (item.parentId) children.set(item.parentId, [...children.get(item.parentId) ?? [], item]);
  const sizes = new Map<string, number>();
  const measure = (item: DiagramElement): number => {
    const height = Math.max(Number(meta(item).height ?? 80) + 42, (children.get(item.id) ?? []).reduce((sum, child) => sum + measure(child), 0));
    sizes.set(item.id, height); return height;
  };
  const visit = (item: DiagramElement, depth: number, y: number) => {
    positions[item.id] = { x: 70 + depth * 290, y: y + (sizes.get(item.id)! - Number(meta(item).height ?? 80)) / 2 };
    const descendants = children.get(item.id) ?? [];
    let childY = y + (sizes.get(item.id)! - descendants.reduce((sum, child) => sum + sizes.get(child.id)!, 0)) / 2;
    for (const child of descendants) { visit(child, depth + 1, childY); childY += sizes.get(child.id)!; }
  };
  let y = 60;
  for (const root of block.elements.filter(item => !item.parentId)) { const size = measure(root); visit(root, 0, y); y += size; }
  return positions;
}

export interface DataTableRow {
  id: string;
  key: string;
  collection: boolean;
  offset: number;
  height: number;
}

/** Keep the source-backed property nodes, but present them as editable table rows. */
function prepareDataTables(block: DiagramBlock): void {
  const children = new Map<string, DiagramElement[]>();
  for (const item of block.elements) if (item.parentId) children.set(item.parentId, [...children.get(item.parentId) ?? [], item]);
  for (const item of block.elements) {
    const details = meta(item);
    if (!['object', 'array'].includes(String(details.dataType))) continue;
    const array = details.dataType === 'array', descendants = children.get(item.id) ?? [];
    const text = (child: DiagramElement) => {
      const value = meta(child).value;
      return typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
    };
    const keyWidth = Math.max(60, ...descendants.map(child => child.name.length * 7 + 24));
    const valueWidth = Math.max(65, ...descendants.filter(child => meta(child).scalar).map(child => Math.max(...text(child).split('\n').map(line => line.length)) * 7 + 24));
    const width = Math.min(480, Math.max(array ? 100 : 180, array ? valueWidth : Math.max(keyWidth / .45, valueWidth / .55)));
    let offset = 0;
    const rows: DataTableRow[] = descendants.map(child => {
      const collection = !meta(child).scalar;
      const columns = Math.max(8, Math.floor((array ? width : width * .55) / 7) - 3);
      const valueLines = collection ? 1 : text(child).split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length / columns)), 0);
      const keyLines = array ? 1 : Math.max(1, Math.ceil(child.name.length / Math.max(6, Math.floor(width * .45 / 7) - 3)));
      const height = Math.max(34, Math.max(valueLines, keyLines) * 18 + 12);
      const row = { id: child.id, key: array ? String((meta(child).path as Path).at(-1)) : child.name, collection, offset, height };
      offset += height;
      if (!collection) child.meta = { ...child.meta, tableRow: true, tableArrayItem: array, hideHeader: array, positionLocked: true, fixedPosition: true, width: width - 2, height };
      return row;
    });
    item.meta = { ...details, tableCollection: true, tableArray: array, tableRows: rows, tablePorts: rows.filter(row => row.collection).map(row => ({ id: `table-${row.id}`, offset: row.offset + row.height / 2 + 1 })), container: true, hideHeader: Boolean(details.root), width, height: Math.max(36, offset + 2) };
  }
  for (const relation of block.relations) {
    if (relation.label === 'alias') continue;
    const target = block.elements.find(item => item.id === relation.target);
    if (!target) continue;
    relation.meta = { ...relation.meta, ...(meta(target).scalar ? { tableInternal: true } : { sourceHandle: `table-${target.id}`, targetHandle: 'left' }) };
  }
}

function dataTableLayout(block: DiagramBlock): Record<string, Point> {
  const positions: Record<string, Point> = Object.create(null);
  const elements = new Map(block.elements.map(item => [item.id, item]));
  const place = (item: DiagramElement, x: number, y: number): number => {
    const details = meta(item), rows = details.tableRows as DataTableRow[] | undefined;
    positions[item.id] = { x, y };
    let bottom = y + Number(details.height ?? 80), nextTableY = -Infinity;
    for (const row of rows ?? []) {
      const child = elements.get(row.id)!;
      if (row.collection) {
        const top = Math.max(nextTableY, y + row.offset + row.height / 2 - Number(meta(child).height ?? 36) / 2);
        const childBottom = place(child, x + Number(details.width) + 70, top);
        nextTableY = childBottom + 40; bottom = Math.max(bottom, childBottom);
      } else positions[child.id] = { x: x + 1, y: y + row.offset + 1 };
    }
    return bottom;
  };
  let bottom = 70;
  for (const root of block.elements.filter(item => !item.parentId)) bottom = place(root, 70, bottom) + 50;
  const minY = Math.min(70, ...Object.values(positions).map(point => point.y));
  if (minY < 70) for (const point of Object.values(positions)) point.y += 70 - minY;
  return positions;
}

export const dataFamily: NativeFamily = {
  kinds: ['json', 'yaml', 'salt', 'wireframe', 'ebnf', 'regex', 'math', 'latex', 'chart', 'files'],
  templates: dataTemplates,
  parse(block, lines) {
    block.graphical = true;
    try {
      if (block.kind === 'json') parseJson(block);
      else if (block.kind === 'yaml') parseYamlData(block);
      else if (block.kind === 'salt' || block.kind === 'wireframe') parseSalt(block, lines);
      else if (block.kind === 'ebnf' || block.kind === 'regex') parseGrammar(block);
      else if (block.kind === 'math' || block.kind === 'latex') parseMath(block);
      else if (block.kind === 'chart') parseChart(block, lines);
      else if (block.kind === 'files') parseFiles(block, lines);
      if (block.kind === 'json' || block.kind === 'yaml') prepareDataTables(block);
    } catch (error) { fail(block, (error as Error).message); }
  },
  edit(source, block, edit) {
    if (block.kind === 'json') return editJson(source, block, edit);
    if (block.kind === 'yaml') return editYaml(source, block, edit);
    if (block.kind === 'salt' || block.kind === 'wireframe') return editSalt(source, block, edit);
    if (block.kind === 'ebnf' || block.kind === 'regex') return editGrammar(source, block, edit);
    if (block.kind === 'math' || block.kind === 'latex') return editMath(source, block, edit);
    if (block.kind === 'chart') return editChart(source, block, edit);
    if (block.kind === 'files') return editFiles(source, block, edit);
    return undefined;
  },
  layout(block) {
    if (block.kind === 'json' || block.kind === 'yaml') return dataTableLayout(block);
    if (block.kind === 'files') return treeLayout(block);
    return Object.fromEntries(block.elements.map(item => [item.id, { x: Number(meta(item).x ?? 80), y: Number(meta(item).y ?? 80) }]));
  },
};
