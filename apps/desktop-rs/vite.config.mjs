import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Tauri 版：dev 5184（与 Electron 版 5183 隔离），build 产物给 Tauri 打包
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  server: {
    port: 5184,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    // 沙箱环境禁止批量删除，改为覆盖写入（旧 hash 资产残留无害）
    emptyOutDir: false,
    target: 'chrome110',
  },
});
