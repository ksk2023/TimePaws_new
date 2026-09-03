import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Tauri 版：dev 5184（与 Electron 版 5183 隔离），build 产物给 Tauri 打包
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // prevent vite from obscuring rust errors
  clearScreen: false,
  // Tauri 固定端口/环境变量，避免重启浏览器
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  server: {
    port: 5184,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
  },
});
