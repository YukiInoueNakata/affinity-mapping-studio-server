import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 2 推奨設定 (https://v2.tauri.app/start/frontend/vite/)
export default defineConfig(async () => ({
  plugins: [react()],
  // ポート固定 (Tauri が devUrl で参照)
  clearScreen: false,
  server: {
    port: 1421, // kj-studio が 1420 なので 1421 で衝突回避
    strictPort: true,
    watch: {
      // src-tauri は監視対象外
      ignored: ['**/src-tauri/**'],
    },
  },
  // env vars TAURI_ENV_* を expose
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // Tauri 2 supports modern browsers; smaller bundle
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: false,
  },
}));
