interface Glyph { width: number; height: number; breakAfter: boolean }

/** Estimate the safe RichText vocabulary without a DOM or evaluating source markup. */
export function measureLabel(text: string, maxWidth: number, fontSize = 12): { width: number; height: number } {
  const base = Number.isFinite(fontSize) ? Math.max(1, fontSize) : 12;
  const cap = Number.isNaN(maxWidth) ? 0 : Math.max(0, maxWidth), limit = cap || 1;
  const baseHeight = base * 1.4;
  let size = base, bold = false, line: Glyph[] = [], lineWidth = 0, lineHeight = baseHeight;
  let height = 0, naturalLine = 0, naturalWidth = 0;
  const finish = () => { height += lineHeight; line = []; lineWidth = 0; lineHeight = baseHeight; };
  const add = (glyph: Glyph) => {
    naturalLine += glyph.width;
    if (line.length && lineWidth + glyph.width > limit) {
      let split = line.length;
      for (let index = line.length - 1; index >= 0; index--) if (line[index].breakAfter) { split = index + 1; break; }
      const rest = line.slice(split);
      lineHeight = Math.max(baseHeight, ...line.slice(0, split).map(part => part.height));
      finish();
      line = rest; lineWidth = rest.reduce((sum, part) => sum + part.width, 0);
      lineHeight = Math.max(baseHeight, ...rest.map(part => part.height));
      if (line.length && lineWidth + glyph.width > limit) finish();
    }
    line.push(glyph); lineWidth += glyph.width; lineHeight = Math.max(lineHeight, glyph.height);
  };
  const decoded = text.replace(/\\[nlr]/g, '\n').replace(/\r\n?/g, '\n').replace(/<U\+([\da-f]{4,6})>/gi, (_all, value: string) => {
    const point = parseInt(value, 16); return point <= 0x10ffff ? String.fromCodePoint(point) : '';
  });
  const tokens = decoded.split(/(<[&$][\w-]+>|<\/?(?:b|i|u|s|strike)>|<color:[\w#]+>|<\/color>|<size:\d+>|<\/size>|\*\*|__|~~)/g);
  for (const token of tokens) {
    if (!token) continue;
    const changeSize = token.match(/^<size:(\d+)>$/);
    if (changeSize) { size = Math.min(32, Math.max(9, Number(changeSize[1]))); continue; }
    if (token === '</size>') { size = base; continue; }
    if (token === '**') { bold = !bold; continue; }
    if (token === '<b>' || token === '</b>') { bold = token === '<b>'; continue; }
    if (/^(?:<\/?(?:i|u|s|strike)>|<color:[\w#]+>|<\/color>|__|~~)$/.test(token)) continue;
    // Inline SVGs occupy 14px plus the canvas stylesheet's 2px margin on each side.
    if (/^<[&$][\w-]+>$/.test(token)) { add({ width: 18, height: 14, breakAfter: false }); continue; }
    for (const character of token) {
      if (character === '\n') {
        naturalWidth = Math.max(naturalWidth, naturalLine); naturalLine = 0;
        lineHeight = Math.max(lineHeight, size * 1.4); finish(); lineHeight = Math.max(baseHeight, size * 1.4); continue;
      }
      const factor = /[\p{Mark}\u200b\u200d\ufe0f]/u.test(character) ? 0
        : character === '\t' ? 2.72 : /[ \u00a0]/.test(character) ? .34
        : /[ilI1.,'`!:;|]/.test(character) ? .32 : /[MW@%&#]/.test(character) ? .9
        : character.codePointAt(0)! >= 0x2e80 ? 1 : /[A-Z]/.test(character) ? .67 : .59;
      add({ width: factor * size * (bold ? 1.04 : 1), height: size * 1.4, breakAfter: character === ' ' || character === '\t' });
    }
  }
  naturalWidth = Math.max(naturalWidth, naturalLine); finish();
  return { width: Math.min(cap, Math.ceil(naturalWidth * 100) / 100), height: Math.ceil(height * 100) / 100 };
}
