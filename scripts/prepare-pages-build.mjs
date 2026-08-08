import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

const outputDirectory = 'dist';

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else files.push(path);
  }

  return files;
}

const files = (await collectFiles(outputDirectory))
  .filter((file) => relative(outputDirectory, file) !== 'sw.js')
  .sort();
const precachePaths = files.map((file) => `./${relative(outputDirectory, file)}`);
precachePaths.unshift('./');

const digest = createHash('sha256');
for (const file of files) {
  digest.update(relative(outputDirectory, file));
  digest.update(await readFile(file));
}
const cacheVersion = digest.digest('hex').slice(0, 16);

const workerPath = `${outputDirectory}/sw.js`;
let worker = await readFile(workerPath, 'utf8');
worker = worker
  .replace(
    /^const CACHE_VERSION = .*; \/\/ __CACHE_VERSION__$/m,
    `const CACHE_VERSION = ${JSON.stringify(cacheVersion)}; // __CACHE_VERSION__`,
  )
  .replace(
    /^const PRECACHE_PATHS = .*; \/\/ __PRECACHE_MANIFEST__$/m,
    `const PRECACHE_PATHS = ${JSON.stringify(precachePaths)}; // __PRECACHE_MANIFEST__`,
  );

await writeFile(workerPath, worker, 'utf8');
console.log(`Prepared Pages service worker ${cacheVersion} with ${precachePaths.length} URLs`);
