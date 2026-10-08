import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { pwa } from './pwa/build.ts';
export default defineConfig({
  plugins: [vue(), pwa()],
  server: { middlewareMode: true },
  build: { outDir: 'dist' },
});
