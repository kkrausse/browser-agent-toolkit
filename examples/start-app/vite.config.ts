import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { browserEditor } from '@kkrausse/browser-agent-toolkit/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    // Only acts in the browser tab, where it sets the preview's base path and optimizer
    // cache. Before tanstackStart(), which reads the base path when it is configured.
    browserEditor(),
    tailwindcss(),
    tanstackStart(),
    react(),
  ],
  server: { port: Number(process.env.PORT) || 5273, strictPort: true },
})
