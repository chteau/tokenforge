import { defineConfig } from 'vite';

// Served from https://chteau.github.io/tokenforge/ (GitHub Pages project site).
export default defineConfig({
  base: '/tokenforge/',
  build: { target: 'es2022' },
});
