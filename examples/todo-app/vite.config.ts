import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { browserEditor } from '@kkrausse/browser-agent-toolkit/vite'
import { defineConfig } from 'vite'

const server = `http://127.0.0.1:${process.env.API_PORT ?? 3001}`

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [
    tailwindcss(),
    react(),
    // In the guest `src/editing.tsx` renders nothing; on the host the chunks only
    // `src/editor-panel.tsx` reaches are listed for the server to keep private.
    browserEditor({ module: 'src/editing.tsx', privateEntry: 'src/editor-panel.tsx' }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/editor': server, '/editing-policy': server },
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
})
