import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { loadModule } from './runtime.mjs';

const { nativeTemplates, unsupportedTemplates } = await loadModule('src/core/templates.ts', 'templates');
const { parseDocument } = await loadModule('src/core/parser.ts', 'parser');
const { codeLines } = await loadModule('src/core/syntax.ts', 'syntax');
const arg = process.argv.indexOf('--examples');
if (arg >= 0 && !process.argv[arg + 1]) throw new Error('--examples requires a directory.');
const corpusPath = arg >= 0 ? resolve(process.argv[arg + 1]) : undefined;
const cases = nativeTemplates.map(t => ({ name: `template/${t.kind}`, source: t.source, template: true }));
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(puml|plantuml|pu|iuml)$/.test(entry.name)) cases.push({ name: relative(corpusPath, path), source: await readFile(path, 'utf8'), template: false });
  }
}
if (corpusPath) await walk(corpusPath);
const results = cases.map(item => {
  const document = parseDocument(item.source);
  const native = document.diagrams.length > 0 && document.diagrams.every(block => block.graphical);
  // Only these exact standalone engine commands are utility listings, not diagrams.
  // Mixed utility/diagram input still counts as unsupported, never as native coverage.
  const utility = /^@startuml\s+(?:listsprite|listopeniconic|stdlib)\s+@enduml$/i.test(codeLines(item.source).map(line => line.trim()).filter(Boolean).join('\n'));
  const status = !document.diagrams.length ? 'SOURCE ONLY' : utility ? 'ENGINE UTILITY' : native ? 'NATIVE' : 'UNSUPPORTED';
  console.log(`${status} ${item.name} [${document.diagrams.map(d => d.kind).join(', ')}]`);
  return { name: item.name, template: item.template, native, status, diagrams: document.diagrams.map(({ kind, graphical, warnings }) => ({ kind, graphical, warnings })), warnings: document.warnings };
});
await mkdir('.cache', { recursive: true });
await writeFile('.cache/native-coverage-report.json', JSON.stringify({ results, unimplementedFamilies: unsupportedTemplates.map(t => t.kind) }, null, 2));
const diagrams = results.filter(result => !['ENGINE UTILITY', 'SOURCE ONLY'].includes(result.status));
console.log(`${diagrams.filter(r => r.native).length}/${diagrams.length} diagram-bearing files fit the native syntax subset (${results.filter(r => r.template).length} starters).`);
console.log(`${results.filter(r => r.status === 'ENGINE UTILITY').length} engine utility listings and ${results.filter(r => r.status === 'SOURCE ONLY').length} files without diagram blocks remain source-only. No external renderer is used.`);
console.log('Report: .cache/native-coverage-report.json');
if (results.some(item => item.template && !item.native)) process.exitCode = 1;
