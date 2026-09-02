import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Zips the extension for the Chrome Web Store.
 *
 * Only the files the extension actually needs go in. node_modules and the
 * unbundled sources are the largest things in the repository and none of it is
 * loaded at runtime — the bundle is — so shipping them would cost the user a
 * download for nothing and give a reviewer more to read than there is product.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', `niulai-fight-${manifest.version}.zip`);

mkdirSync(join(root, 'dist'), { recursive: true });
rmSync(out, { force: true });

const include = ['manifest.json', 'index.html', 'icons', 'assets',
                 'dist/bundle.js', 'src/background.js', 'src/boot-check.js'];
execFileSync('zip', ['-r', '-q', out, ...include], { cwd: root });

const size = execFileSync('du', ['-h', out]).toString().split('\t')[0];
console.log(`${out}\n  version ${manifest.version} — "${manifest.name}"\n  ${size}`);
