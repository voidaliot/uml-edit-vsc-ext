import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { writeThirdPartyLicenses } from './licenses.mjs';

await mkdir('dist', { recursive: true });
await sharp('media/icon.svg').png().toFile('media/icon.png');
await writeThirdPartyLicenses();
const watch = process.argv.includes('--watch');
const shared = { bundle: true, sourcemap: true, logLevel: 'info', minify: !watch, mainFields: ['module', 'main'] };
const jobs = [
  { ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'] },
  { ...shared, entryPoints: ['src/webview/main.tsx'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') } },
];
if (watch) {
  await Promise.all(jobs.map(async options => { const ctx = await esbuild.context(options); await ctx.watch(); }));
} else {
  await Promise.all(jobs.map(options => esbuild.build(options)));
}
