import { defineConfig, loadEnv } from 'vite';

/**
 * PWA build configuration.  The server must keep this origin stable because
 * iOS scopes installed web apps and their offline storage by origin.
 */
export default defineConfig(({ mode }) => {
  const configuredBase = loadEnv(mode, process.cwd(), '').VITE_BASE_PATH || '/';
  const basePath = `/${configuredBase.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

  if (/[?#]/.test(basePath) || basePath.includes('..')) {
    throw new Error('VITE_BASE_PATH must be an absolute pathname such as / or /project/.');
  }

  return {
    base: basePath,
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
