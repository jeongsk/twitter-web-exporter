import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const release = resolve(root, 'release');
await mkdir(release, { recursive: true });
const target = resolve(release, `twitter-web-exporter-chrome-${pkg.version}.zip`);
// Only replace this build's generated archive, never source or user data.
await rm(target, { force: true });
execFileSync('zip', ['-qr', target, '.'], { cwd: resolve(root, 'dist/chrome') });
console.log(target);
