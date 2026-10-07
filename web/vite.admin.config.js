import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  root: 'admin', base: '/admin/', publicDir: '../public', plugins: [react()],
  build: { outDir: '../dist-admin', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5178, proxy: { '/admin/api': { target: 'http://127.0.0.1:3420', changeOrigin: true } } }
})
