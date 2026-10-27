import { Fragment, type ReactNode } from 'react';
import { Cloud, KeyRound, Check, X, User, Database, Server, Settings, Heart, Star, Lock, Mail, Home, Globe, CircleHelp, CircleCheck, Boxes, ArrowLeftRight, FileCode, FileImage, Gavel, Share2 } from 'lucide-react';

const icons: Record<string, typeof Cloud> = { cloud: Cloud, key: KeyRound, check: Check, x: X, person: User, user: User, database: Database, server: Server, cog: Settings, heart: Heart, star: Star, lock: Lock, envelope: Mail, home: Home, globe: Globe, check_circle: CircleCheck, cubes: Boxes, exchange: ArrowLeftRight, file_code_o: FileCode, file_image_o: FileImage, gavel: Gavel, gear: Settings, share_alt_square: Share2 };
/** Interpret a small safe label vocabulary as React nodes. Source HTML is never executed. */
export function RichText({ text }: { text: string }) {
  const tokens = text.replace(/\\[nlr]/g, '\n').replace(/<U\+([\da-f]{4,6})>/gi, (_all, value) => { const code = parseInt(value, 16); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; }).split(/(<[&$][\w-]+>|<\/?(?:b|i|u|s|strike)>|<color:[\w#]+>|<\/color>|<size:\d+>|<\/size>|\*\*|__|~~)/g);
  const flags: { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; size?: number } = {};
  const result: ReactNode[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!token) continue;
    if (token === '**') { flags.bold = !flags.bold; continue; }
    if (token === '__') { flags.underline = !flags.underline; continue; }
    if (token === '~~') { flags.strike = !flags.strike; continue; }
    const icon = token.match(/^<[&$]([\w-]+)>$/);
    if (icon) { const Icon = icons[icon[1]] ?? CircleHelp; result.push(<Icon key={index} size={14} className="label-icon" aria-label={icon[1]} />); continue; }
    const tag = token.match(/^<(\/?)(b|i|u|s|strike)>$/);
    if (tag) { flags[({ b: 'bold', i: 'italic', u: 'underline', s: 'strike', strike: 'strike' } as const)[tag[2] as 'b']] = !tag[1]; continue; }
    const color = token.match(/^<color:([\w#]+)>$/); if (color) { flags.color = color[1]; continue; }
    if (token === '</color>') { flags.color = undefined; continue; }
    const size = token.match(/^<size:(\d+)>$/); if (size) { flags.size = Math.min(32, Math.max(9, Number(size[1]))); continue; }
    if (token === '</size>') { flags.size = undefined; continue; }
    result.push(<span key={index} style={{ fontWeight: flags.bold ? 700 : undefined, fontStyle: flags.italic ? 'italic' : undefined, textDecoration: [flags.underline ? 'underline' : '', flags.strike ? 'line-through' : ''].join(' ').trim() || undefined, color: flags.color, fontSize: flags.size }}>{token}</span>);
  }
  return <Fragment>{result}</Fragment>;
}
