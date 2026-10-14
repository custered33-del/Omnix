import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.OMNIX_DEV_SERVER ?? 'http://localhost:4317';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: server, changeOrigin: false },
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
      '/mcp': { target: server },
      '/sse': { target: server },
      '/messages': { target: server },
      '/oauth': { target: server },
      '/.well-known': { target: server },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          codemirror: ['@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/language', '@codemirror/lang-python', '@codemirror/lang-javascript', '@codemirror/lang-json', '@codemirror/lang-markdown', '@codemirror/lang-css', '@codemirror/lang-html', '@codemirror/search', '@codemirror/autocomplete'],
        },
      },
    },
  },
  worker: { format: 'es' },
});
