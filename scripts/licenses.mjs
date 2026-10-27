import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function writeThirdPartyLicenses() {
  const root = JSON.parse(await readFile('package.json', 'utf8'));
  const visited = new Set();
  const notices = [];
  async function visit(name, parentDirectory) {
    const require = createRequire(join(parentDirectory, 'package.json'));
    let packagePath;
    try { packagePath = require.resolve(`${name}/package.json`); }
    catch {
      let directory = dirname(require.resolve(name));
      while (directory !== dirname(directory)) {
        const candidate = join(directory, 'package.json');
        try { if (JSON.parse(await readFile(candidate, 'utf8')).name === name) { packagePath = candidate; break; } } catch {}
        directory = dirname(directory);
      }
    }
    if (!packagePath) throw new Error(`Cannot find license metadata for ${name}`);
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    if (visited.has(key)) return;
    visited.add(key);
    const directory = dirname(packagePath);
    const licenseFiles = (await readdir(directory)).filter(file => /^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(file));
    if (licenseFiles.length === 0) throw new Error(`Missing license file for bundled dependency ${key}`);
    const license = await Promise.all(licenseFiles.map(file => readFile(join(directory, file), 'utf8')));
    notices.push(`${key}\nLicense: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)}\n${license.join('\n\n')}`);
    for (const dependency of Object.keys(pkg.dependencies || {}).sort()) await visit(dependency, directory);
  }
  for (const dependency of Object.keys(root.dependencies).sort()) await visit(dependency, resolve('.'));
  notices.sort();
  await writeFile('THIRD_PARTY_LICENSES.txt', 'Licenses for bundled npm runtime dependencies. Generated from installed package license files.\n\n' + notices.join('\n\n' + '='.repeat(78) + '\n\n'));
}
