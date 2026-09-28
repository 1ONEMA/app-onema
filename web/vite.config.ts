import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Gera o service worker com a lista de arquivos estáticos do build e uma versão única.
 * Somente o "app shell" (HTML/JS/CSS/ícones) é armazenado. Respostas de /api nunca são cacheadas.
 */
function serviceWorker(): Plugin {
  let outDir = '';
  return {
    name: 'onema-sw',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    writeBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js' && !f.endsWith('.html'));
      const extra = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/logo-onema-saude.png', '/favicon.ico'];
      const version = `${Date.now().toString(36)}`;
      const tpl = fs.readFileSync(path.resolve(__dirname, 'src/sw-template.js'), 'utf8');
      const sw = tpl.replace('__SW_VERSION__', version).replace('__PRECACHE__', JSON.stringify([...extra, ...files.map((f) => `/${f}`)]));
      fs.writeFileSync(path.join(outDir, 'sw.js'), sw);
    },
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), serviceWorker()],
  build: { outDir: path.resolve(__dirname, 'dist'), emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  preview: { port: 4173 },
});
