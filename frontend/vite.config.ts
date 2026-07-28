import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Cargo writes/locks files under src-tauri/target while compiling;
      // watching them too causes EBUSY on Windows.
      ignored: ['**/src-tauri/**'],
    },
  },
})
