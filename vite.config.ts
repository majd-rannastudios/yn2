import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const client = path.join(root, 'client');

/** Map /admin and /screen to their HTML files during Vite's own dev server. */
function mpaRoutes(): Plugin {
  return {
    name: 'mpa-routes',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/admin' || req.url?.startsWith('/admin?')) {
          req.url = '/admin.html' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
        } else if (req.url === '/screen' || req.url?.startsWith('/screen?')) {
          req.url = '/screen.html' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
        }
        next();
      });
    }
  };
}

export default defineConfig({
  root: client,
  publicDir: path.join(client, 'public'),
  plugins: [react(), mpaRoutes()],
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.join(client, 'index.html'),
        admin: path.join(client, 'admin.html'),
        screen: path.join(client, 'screen.html')
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true }
    }
  }
});
