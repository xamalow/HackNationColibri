import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'apps/hub/package.json'), 'utf8'));
if (manifest.name !== '@sauti/hub') throw new Error('Expected @sauti/hub workspace');

// Include new source during local integration; honor runtime/artifact git ignores.
const modules = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'apps/hub'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0').filter((path) => path.endsWith('.mjs'));
if (!modules.length) throw new Error('No Hub modules found');
for (const path of modules) {
  execFileSync(process.execPath, ['--check', resolve(root, path)], { cwd: root, stdio: 'inherit' });
}
console.log(`Checked syntax of ${modules.length} Hub modules. Tests run separately; Hub has no build step.`);
