import { test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { parseDocument } from '../src/core/parser';
import { layoutGraph, setGraphEngine } from '../src/core/graph-layout';
import { nativeTemplates } from '../src/core/templates';
import type { Point } from '../src/shared/protocol';
// Prints both engines' numbers for the same diagrams:
// COMPARE_LAYOUTS=1 npx vitest run test/layout-engines.compare.test.ts
const dir = new URL('./fixtures/layout-compare', import.meta.url).pathname;
const hits = (a: Point, b: Point, r: { x: number; y: number; width: number; height: number }) => { let f = 0, t = 1; for (const [d, lo, hi] of [[b.x - a.x, r.x + 2 - a.x, r.x + r.width - 2 - a.x], [b.y - a.y, r.y + 2 - a.y, r.y + r.height - 2 - a.y]]) { if (Math.abs(d) < 1e-9) { if (lo >= 0 || hi <= 0) return false; continue; } f = Math.max(f, Math.min(lo / d, hi / d)); t = Math.min(t, Math.max(lo / d, hi / d)); if (f >= t) return false; } return true; };
const cross = (p: Point, q: Point, r: Point, s: Point) => { const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x); if (Math.abs(d) < 1e-9) return false; const t = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d, u = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d; return t > .02 && t < .98 && u > .02 && u < .98; };
test.skipIf(!process.env.COMPARE_LAYOUTS)('compare', () => {
  const cases: [string, string][] = [...readdirSync(dir).filter(f => f.endsWith('.puml')).map(f => [f.replace('.puml', ''), readFileSync(`${dir}/${f}`, 'utf8')] as [string, string]), ...nativeTemplates.filter(t => ['class', 'state', 'usecase', 'component', 'deployment', 'entity', 'object', 'c4', 'archimate', 'dot'].includes(t.kind)).map(t => [`tpl-${t.kind}`, t.source] as [string, string])];
  const out: string[] = [];
  for (const [name, source] of cases) for (const engine of ['native', 'dagre'] as const) {
    setGraphEngine(engine);
    const block = parseDocument(source).diagrams[0], t0 = performance.now(), points = layoutGraph(block), ms = performance.now() - t0;
    const box = (id: string) => { const e = block.elements.find(x => x.id === id)!; return { ...points[id], width: Number(e.meta?.width), height: Number(e.meta?.height) }; };
    const c = (id: string) => { const b = box(id); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const lines = block.relations.filter(r => points[r.source] && points[r.target] && r.source !== r.target).map(r => ({ r, path: [c(r.source), ...(r.meta?.route as Point[] ?? []), c(r.target)] }));
    let through = 0, crossings = 0, length = 0;
    for (const { r, path } of lines) { for (const e of block.elements) if (!e.meta?.container && e.id !== r.source && e.id !== r.target && path.slice(1).some((p, i) => hits(path[i], p, box(e.id)))) through++; path.slice(1).forEach((p, i) => { length += Math.hypot(p.x - path[i].x, p.y - path[i].y); }); }
    for (let a = 0; a < lines.length; a++) for (let b = a + 1; b < lines.length; b++) { const A = lines[a], B = lines[b]; if ([A.r.source, A.r.target].some(id => id === B.r.source || id === B.r.target)) continue; if (A.path.slice(1).some((p, i) => B.path.slice(1).some((q, j) => cross(A.path[i], p, B.path[j], q)))) crossings++; }
    let overlap = 0; const leaves = block.elements.filter(e => !e.meta?.container); for (let a = 0; a < leaves.length; a++) for (let b = a + 1; b < leaves.length; b++) { const p = box(leaves[a].id), q = box(leaves[b].id); if (p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height) overlap++; }
    const all = block.elements.map(e => box(e.id)), w = Math.max(...all.map(b => b.x + b.width)) - Math.min(...all.map(b => b.x)), h = Math.max(...all.map(b => b.y + b.height)) - Math.min(...all.map(b => b.y));
    out.push(`${name.padEnd(14)} ${engine.padEnd(6)} nodes=${String(block.elements.length).padStart(3)} edges=${String(lines.length).padStart(3)} through=${through} crossings=${String(crossings).padStart(2)} overlaps=${overlap} size=${Math.round(w)}x${Math.round(h)} edgeLen=${Math.round(length)} ms=${ms.toFixed(1)}`);
  }
  process.stderr.write('\n' + out.join('\n') + '\n');
});
