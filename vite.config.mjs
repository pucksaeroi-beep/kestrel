import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: './',
  build: { outDir: '../dist', emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 8000 },
  server: { port: 5173, strictPort: true },
});
