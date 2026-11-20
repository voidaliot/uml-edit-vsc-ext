import type { DiagramBlock } from '../shared/protocol';
import { declarationBlocker } from './clipboard';
import { codeLines, parseDeclaration } from './syntax';

export interface ElementProperties { stereotype: string; color: string }

/** Why these values cannot be written into a declaration line, or undefined when they can. */
export function propertiesError({ stereotype, color }: ElementProperties): string | undefined {
  if (typeof stereotype !== 'string' || typeof color !== 'string') return 'Enter a stereotype and a colour as text.';
  if (stereotype.length > 200 || /[\r\n\u0000{}"]|<<|>>/.test(stereotype)) return 'A stereotype is one line of text without quotes, braces, << or >>.';
  if (color.trim() && !/^#?(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8}|[a-z]{3,30})$/i.test(color.trim())) return 'Use a colour such as #FFAA00 or a name such as LightBlue.';
}

/** A colour as written after the `#` in source. */
export const colorText = (color: string) => color.trim().replace(/^#/, '');

/**
 * Set or clear the stereotype and background colour on an element's declaration line. Only the
 * span between the name (or alias) and the body opens is rewritten; alias, body and comments stay.
 */
export function setProperties(source: string, block: DiagramBlock, elementId: string, properties: ElementProperties): string {
  const blocker = declarationBlocker(block, 'Editing properties');
  if (blocker) throw new Error(blocker);
  const problem = propertiesError(properties);
  if (problem) throw new Error(problem);
  const element = block.elements.find(candidate => candidate.id === elementId);
  if (!element) throw new Error('This element no longer exists. Try the edit again on the current diagram.');
  if (element.meta?.editable === false || ['start', 'end'].includes(element.kind)) throw new Error('This symbol has no properties to edit.');
  if (element.implicit) throw new Error('This element is only named in a relationship. Declare it in the source to give it properties.');
  const lines = source.split(/\r?\n/), code = codeLines(source);
  const raw = lines[element.startLine], text = code[element.startLine];
  const declaration = parseDeclaration(text);
  if (!declaration || declaration.id !== element.id) throw new Error('Edit the properties of this element in the source editor.');
  const end = declaration.bodyStart >= 0 ? declaration.bodyStart : text.trimEnd().length;
  const region = text.slice(declaration.headerEnd, end);
  if (raw.slice(declaration.headerEnd, end) !== region || region.includes('[[') || (region.match(/<</g) ?? []).length > 1 || (region.match(/#/g) ?? []).length > 1 || /#\w+[^\s\w{]/.test(region)) throw new Error('This declaration has links, comments or several stereotypes. Edit its properties in the source editor.');
  const rest = region.replace(/\s*<<[^>]*>>/, '').replace(/\s*#\w+/, '').trimEnd();
  const stereotype = properties.stereotype.trim(), color = colorText(properties.color);
  const tail = `${rest}${stereotype ? ` <<${stereotype}>>` : ''}${color ? ` #${color}` : ''}${declaration.bodyStart >= 0 ? ' ' : ''}`;
  lines[element.startLine] = raw.slice(0, declaration.headerEnd) + tail + raw.slice(end);
  return lines.join(source.includes('\r\n') ? '\r\n' : '\n');
}
