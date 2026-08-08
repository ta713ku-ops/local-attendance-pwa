import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const index = await readFile('dist/index.html', 'utf8');
const manifest = JSON.parse(await readFile('dist/manifest.webmanifest', 'utf8'));
const worker = await readFile('dist/sw.js', 'utf8');

assert.ok(!index.includes('%BASE_URL%'), 'index.html contains an unresolved BASE_URL token');
assert.equal(manifest.start_url, './');
assert.equal(manifest.scope, './');
assert.ok(manifest.icons.every((icon) => icon.src.startsWith('./')));
assert.doesNotMatch(worker, /const CACHE_VERSION = 'dev'/);
assert.match(worker, /const CACHE_VERSION = "[a-f0-9]{16}"/);
assert.match(worker, /self\.registration\.scope/);

const references = [...index.matchAll(/(?:src|href)="([^"#?]+)"/g)]
  .map((match) => match[1]);
const basePath = references.find((reference) => reference.includes('manifest.webmanifest'))
  ?.replace(/manifest\.webmanifest$/, '') ?? '/';

for (const reference of references) {
  assert.ok(reference.startsWith(basePath), `${reference} is outside build base ${basePath}`);
  const outputPath = reference.slice(basePath.length);
  if (outputPath) await access(`dist/${outputPath}`);
}

const precacheLine = worker.match(/^const PRECACHE_PATHS = (.*); \/\/ __PRECACHE_MANIFEST__$/m);
assert.ok(precacheLine, 'service worker precache manifest was not generated');
const precachePaths = JSON.parse(precacheLine[1]);
const hashedAssets = references
  .filter((reference) => /\/assets\/.*\.(?:js|css)$/.test(reference))
  .map((reference) => `./${reference.slice(basePath.length)}`);
assert.ok(hashedAssets.length > 0, 'index.html has no hashed JS/CSS assets');
for (const asset of hashedAssets) {
  assert.ok(precachePaths.includes(asset), `${asset} is missing from the precache manifest`);
}

console.log(`Pages build verified at ${basePath} with ${precachePaths.length} precached URLs`);
