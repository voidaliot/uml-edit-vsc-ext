import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';

// Every mutable VS Code directory is scoped to this repository's ignored cache.
const root = resolve('.');
const nativeRoot = resolve('.cache/native');
const workspace = join(nativeRoot, 'workspace');
const profile = join(nativeRoot, 'user-data');
const extensions = join(nativeRoot, 'extensions');
await Promise.all([workspace, profile, extensions].map(path => mkdir(path, { recursive: true })));
await writeFile(join(workspace, 'smoke.puml'), '@startuml\ntitle Native editor smoke\nclass Customer {\n  +name: String\n}\nclass Order\nCustomer "1" --> "*" Order : places\n@enduml\n');
if (process.argv.includes('--host-only')) {
  // Browser tests may own an active webview bundle. Refresh the extension host
  // independently and leave that browser build untouched.
  if (!existsSync('dist/webview.js') || !existsSync('dist/webview.css')) throw new Error('--host-only needs an existing webview build.');
  await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], mainFields: ['module', 'main'], minify: true, sourcemap: true });
} else await import('./build.mjs');
const extensionTestsPath = join(nativeRoot, 'suite.cjs');
await build({ entryPoints: ['test/native/suite.ts'], outfile: extensionTestsPath, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], mainFields: ['module', 'main'] });

let vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
if (!vscodeExecutablePath && process.platform === 'win32') {
  try {
    const candidates = execFileSync('where.exe', ['code'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
    vscodeExecutablePath = candidates.map(candidate => join(dirname(dirname(candidate)), 'Code.exe')).find(candidate => existsSync(candidate));
  } catch { /* The SDK downloads an isolated copy if Code is not installed. */ }
}
console.log(`Native smoke host: ${vscodeExecutablePath || 'isolated VS Code 1.104.3 download'}`);
await runTests({
  vscodeExecutablePath,
  version: '1.104.3',
  cachePath: resolve('.cache/vscode-test'),
  extensionDevelopmentPath: root,
  extensionTestsPath,
  reuseMachineInstall: false,
  launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`],
});
