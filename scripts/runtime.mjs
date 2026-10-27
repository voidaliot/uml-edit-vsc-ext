import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function loadModule(entry, name) {
  await mkdir('.cache/modules', { recursive: true });
  const outfile = resolve('.cache/modules', `${name}.mjs`);
  await build({ entryPoints: [entry], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', mainFields: ['module', 'main'], external: ['vscode'], logLevel: 'silent' });
  return import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}
