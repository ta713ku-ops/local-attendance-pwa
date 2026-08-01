import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const workerSource = `const worker = {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);

    if (
      response.status === 404 &&
      request.method === 'GET' &&
      (request.headers.get('accept') ?? '').includes('text/html')
    ) {
      const indexUrl = new URL('/index.html', request.url);
      return env.ASSETS.fetch(new Request(indexUrl, request));
    }

    return response;
  },
};

export default worker;
`;

await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await writeFile('dist/server/index.js', workerSource, 'utf8');
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
