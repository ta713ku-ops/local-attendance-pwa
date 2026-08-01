import assert from 'node:assert/strict';

const { default: worker } = await import('../dist/server/index.js');

async function fetchPath(pathname, init) {
  return worker.fetch(new Request(`https://example.test${pathname}`, init));
}

const indexResponse = await fetchPath('/');
assert.equal(indexResponse.status, 200);
assert.match(indexResponse.headers.get('content-type') ?? '', /^text\/html/);

const index = await indexResponse.text();
const assetPaths = [...index.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)].map(
  (match) => match[1],
);
assert.ok(assetPaths.length > 0);

for (const pathname of [...assetPaths, '/sw.js', '/manifest.webmanifest']) {
  const response = await fetchPath(pathname);
  assert.equal(response.status, 200, pathname);
}

const fallback = await fetchPath('/admin', {
  headers: { Accept: 'text/html' },
});
assert.equal(fallback.status, 200);
assert.match(await fallback.text(), /<div id="root"><\/div>/);

assert.equal((await fetchPath('/missing.png')).status, 404);
console.log(`Sites worker verified: ${assetPaths.length + 4} routes`);
