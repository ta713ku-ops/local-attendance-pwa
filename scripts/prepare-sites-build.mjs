import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, relative } from 'node:path';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === 'server' || entry.name === '.openai') continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else files.push(path);
  }

  return files;
}

const assets = {};
for (const file of await collectFiles('dist')) {
  const pathname = `/${relative('dist', file)}`;
  assets[pathname] = {
    body: (await readFile(file)).toString('base64'),
    contentType: contentTypes[extname(file)] ?? 'application/octet-stream',
  };
}

const workerSource = `const ASSETS = ${JSON.stringify(assets)};

function decodeBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

const worker = {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    let asset = ASSETS[pathname];
    if (
      !asset &&
      request.method === 'GET' &&
      (request.headers.get('accept') ?? '').includes('text/html')
    ) {
      pathname = '/index.html';
      asset = ASSETS[pathname];
    }

    if (!asset || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = new Headers({
      'Content-Type': asset.contentType,
      'X-Content-Type-Options': 'nosniff',
    });
    if (pathname === '/index.html' || pathname === '/sw.js') {
      headers.set('Cache-Control', 'no-cache');
    } else if (pathname.startsWith('/assets/')) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      headers.set('Cache-Control', 'public, max-age=86400');
    }
    if (pathname === '/sw.js') headers.set('Service-Worker-Allowed', '/');

    return new Response(
      request.method === 'HEAD' ? null : decodeBase64(asset.body),
      { status: 200, headers },
    );
  },
};

export default worker;
`;

await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await writeFile('dist/server/index.js', workerSource, 'utf8');
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
