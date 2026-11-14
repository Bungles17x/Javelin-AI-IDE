import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 3000,
    open: true
  },
  resolve: {
    alias: {
      // Exclude local-model from browser build
      // It will only be used in Electron main process
      '@local-model': '/local-model/index-browser.js'
    }
  },
  optimizeDeps: {
    exclude: ['local-model']
  }
})
