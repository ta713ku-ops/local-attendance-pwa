import { defineConfig } from 'vite';

/**
 * PWA build configuration.  The server must keep this origin stable because
 * iOS scopes installed web apps and their offline storage by origin.
 */
export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
