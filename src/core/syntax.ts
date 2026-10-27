/** Small, conservative lexer for the source spans the graphical editor owns. */
export interface TokenSpan { text: string; start: number; end: number }
export interface Declaration {
  kind: string;
  id: string;
  name: string;
  nameSpan: TokenSpan;
  aliasSpan?: TokenSpan;
  headerEnd: number;
  bodyStart: number;
  bodyEnd: number;
  tail: string;
}
export interface RelationSyntax {
  source: string;
  target: string;
  sourceSpan: TokenSpan;
  targetSpan: TokenSpan;
  arrowSpan: TokenSpan;
  arrow: string;
  label: string;
  labelStart: number;
  sourceMultiplicity: string;
  targetMultiplicity: string;
}

export interface MemberSyntax { owner: string; ownerSpan: TokenSpan; member: string }

const endpointPattern = String.raw`(?:"(?:\\.|[^"\\])*"|\[[^\]\r\n]+\]|\([^\)\r\n]+\)|:[^:\r\n]+:|[\p{L}\p{N}_$][\p{L}\p{N}_.$]*(?:::[\p{L}\p{N}_.$]+)*)`;
const endpoint = new RegExp(`^${endpointPattern}`, 'u');
const declarationStart = /^\s*((?:abstract\s+)?class|interface|enum|annotation|object|entity|actor|participant|boundary|control|collections|queue|database|component|node|artifact|cloud|package|namespace|frame|folder|rectangle|card|file|storage|stack|agent|person|process|label|hexagon|circle|usecase|state|action|note)\s+/i;
const relation = new RegExp(`^(\\s*)(${endpointPattern})(\\s*(?:"[^"\\r\\n]*"\\s*)?)([<|o*x{}\\\\/]*[-=.][\\w.\\-=<>|o*x{}\\[\\]#(),\\\\/]*?)(\\s*(?:"[^"\\r\\n]*"\\s*)?)(${endpointPattern})(\\s*)(?::\\s*(.*))?$`, 'u');
const memberStatement = new RegExp(`^(\\s*)(${endpointPattern})\\s*:\\s*(.*)$`, 'u');

export function unquote(value: string): string {
  if (value.startsWith('""') && value.endsWith('""') && value.length > 4) return unquote(value.slice(1, -1));
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('[') && value.endsWith(']')) || (value.startsWith('(') && value.endsWith(')')) || (value.startsWith(':') && value.endsWith(':'))) {
    return value.slice(1, -1).replace(/\\([\\"n])/g, (_match, escaped: string) => escaped === 'n' ? '\n' : escaped);
  }
  return value;
}

export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

export function isIdentifier(value: string): boolean {
  return /^[\p{L}_$][\p{L}\p{N}_.$]*(?:::[\p{L}\p{N}_.$]+)*$/u.test(value);
}

export function reference(value: string): string {
  return isIdentifier(value) ? value : quote(value);
}

export function parseDeclaration(line: string): Declaration | undefined {
  const beginning = line.match(declarationStart);
  const shorthand = beginning ? null : line.match(/^\s*(\[[^\]]+\]|\([^\)]+\)|:[^:]+:)(?=\s|$)/);
  if (!beginning && !shorthand) return;
  let kind = beginning ? beginning[1].toLowerCase().replace(/\s+/g, ' ') : shorthand![1][0] === '[' ? 'component' : shorthand![1][0] === '(' ? 'usecase' : 'actor';
  const start = beginning ? beginning[0].length : line.indexOf(shorthand![1]);
  const token = line.slice(start).match(/^"".+?""(?=\s|$)/)?.[0] ?? line.slice(start).match(endpoint)?.[0];
  if (!token || token === '[*]') return;
  const first: TokenSpan = { text: token, start, end: start + token.length };
  let nameSpan = first;
  let aliasSpan: TokenSpan | undefined;
  let end = first.end;
  const aliasPrefix = line.slice(end).match(/^\s+as\s+/i);
  if (aliasPrefix) {
    const aliasStart = end + aliasPrefix[0].length;
    const alias = line.slice(aliasStart).match(endpoint)?.[0];
    if (!alias) return;
    const second: TokenSpan = { text: alias, start: aliasStart, end: aliasStart + alias.length };
    // Both `class "Display" as alias` and `class alias as "Display"` occur in PlantUML.
    if (alias.startsWith('"') && !token.startsWith('"')) {
      aliasSpan = first;
      nameSpan = second;
    } else {
      aliasSpan = second;
    }
    end = second.end;
  }
  const tail = line.slice(end);
  if (shorthand && /^[ \t]*[<>|o*x{}]*[-=.]/.test(tail)) return;
  if (kind === 'note' && !first.text.startsWith('"')) return;
  const bodyStart = tail.indexOf('{') >= 0 ? end + tail.indexOf('{') : -1;
  const bodyEnd = bodyStart >= 0 ? line.lastIndexOf('}') : -1;
  return { kind, id: unquote(aliasSpan?.text ?? first.text), name: unquote(nameSpan.text), nameSpan, aliasSpan, headerEnd: end, bodyStart, bodyEnd: bodyEnd > bodyStart ? bodyEnd : -1, tail };
}

export function parseRelation(line: string): RelationSyntax | undefined {
  const match = line.trimEnd().match(relation);
  if (!match) return;
  const sourceStart = match[1].length;
  const arrowStart = sourceStart + match[2].length + match[3].length;
  const targetStart = arrowStart + match[4].length + match[5].length;
  const targetEnd = targetStart + match[6].length;
  return {
    source: unquote(match[2]), target: unquote(match[6]),
    sourceSpan: { text: match[2], start: sourceStart, end: sourceStart + match[2].length },
    targetSpan: { text: match[6], start: targetStart, end: targetEnd },
    arrowSpan: { text: match[4], start: arrowStart, end: arrowStart + match[4].length },
    arrow: match[4], label: match[8] ?? '',
    labelStart: line.indexOf(':', targetEnd),
    sourceMultiplicity: match[3].trim(), targetMultiplicity: match[5].trim(),
  };
}

export function parseMemberStatement(line: string): MemberSyntax | undefined {
  const match = line.match(memberStatement);
  if (!match) return;
  return { owner: unquote(match[2]), ownerSpan: { text: match[2], start: match[1].length, end: match[1].length + match[2].length }, member: match[3].trimEnd() };
}

/** Replace comments by spaces, keeping every original column and line number. */
export function codeLines(source: string): string[] {
  let inComment = false;
  return source.split(/\r?\n/).map(line => {
    let result = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const next = line[i + 1];
      if (inComment) {
        if (char === "'" && next === '/') { inComment = false; result += '  '; i++; }
        else result += ' ';
        continue;
      }
      if (!quoted && char === '/' && next === "'") { inComment = true; result += '  '; i++; continue; }
      if (!quoted && char === "'" && (i === 0 || /\s/.test(line[i - 1]))) { result += ' '.repeat(line.length - i); break; }
      if (char === '"') {
        let escapes = 0;
        for (let index = i - 1; index >= 0 && line[index] === '\\'; index--) escapes++;
        if (escapes % 2 === 0) quoted = !quoted;
      }
      result += char;
    }
    return result;
  });
}
