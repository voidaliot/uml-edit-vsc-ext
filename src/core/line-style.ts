import type { DiagramBlock, LineType } from '../shared/protocol';
import { codeLines } from './syntax';

/** Routing directives are data only: includes and preprocessor bodies are never evaluated. */
export function sourceLineType(block: DiagramBlock): LineType {
  let result: LineType = 'straight';
  let skinBlock = false, ignoredUntil: RegExp | undefined;
  const normalize = (value: string): LineType | undefined => {
    if (/^(?:spline|splines|curved)$/i.test(value)) return 'spline';
    if (/^(?:line|straight|false)$/i.test(value)) return 'straight';
    if (/^(?:ortho|polyline)$/i.test(value)) return value.toLowerCase() as LineType;
    return undefined;
  };
  for (const [index, line] of codeLines(block.source).entries()) {
    const text = line.trim();
    if (ignoredUntil) { if (ignoredUntil.test(text)) ignoredUntil = undefined; continue; }
    if (/^!(?:procedure|function)\b/i.test(text)) { ignoredUntil = /^!end(?:procedure|function)\b/i; continue; }
    if (/^<style>/i.test(text)) { ignoredUntil = /^<\/style>/i; continue; }
    if (/^(?:title|legend|header|footer|caption)\s*$/i.test(text)) { ignoredUntil = new RegExp(`^end${text}$`, 'i'); continue; }
    // Text in member compartments and notes must not become a drawing directive.
    const absolute = index + block.startLine;
    if (block.elements.some(element => !element.meta?.container && absolute > element.startLine && absolute <= element.endLine)) continue;
    if (/^skinparam\s*\{\s*$/i.test(text)) { skinBlock = true; continue; }
    if (skinBlock && /^}\s*$/.test(text)) { skinBlock = false; continue; }
    const match = text.match(/^skinparam(?:locked)?\s+linetype\s+(\w+)\s*$/i)
      ?? (skinBlock ? text.match(/^linetype\s+(\w+)\s*$/i) : null);
    const value = match && normalize(match[1]);
    if (value) result = value;
    if (block.kind === 'dot') {
      const setting = text.match(/(?:^|[\s[;{,])splines\s*=\s*"?(\w+)"?(?=\s|[;,\]}]|$)/i);
      const dotValue = setting && normalize(setting[1]);
      if (dotValue) result = dotValue;
    }
  }
  return result;
}
