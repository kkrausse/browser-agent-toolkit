import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { browserEditor, isGuest } from '@kkrausse/browser-agent-toolkit/vite'
import { defineConfig } from 'vite'

const server = `http://127.0.0.1:${process.env.API_PORT ?? 3001}`

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  // In the editor's preview the panel is never loaded (see browserEditor below), but Vite's
  // dependency scan reads the files as they are and would prebundle its packages: 2 MB of
  // optimizer cache that prepare ships for nothing.
  optimizeDeps: isGuest() ? { exclude: ['@kkrausse/browser-agent-toolkit', '@kkrausse/browser-agent-toolkit-react'] } : undefined,
  plugins: [
    tailwindcss(),
    // The preview's optimizer cache is outside node_modules (that tree is the read-only
    // image), so it is named here too: Babel would otherwise go over the optimized
    // react-dom, 1.1 MB, at every start.
    react({ exclude: [/\/node_modules\//, /\/\.browser-editor-cache\//] }),
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
