import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { browserEditor, isGuest } from '@kkrausse/browser-agent-toolkit/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite'

// The preview in the browser guest. React Router leaves Vite's dependency scan without
// entries, so the application's client dependencies would turn up at the first page load:
// a second optimizer run and a reload of the frame on every fresh open. Name the ones the
// client imports. Guest only: the host's dev server and build are as they were.
const guestOptimizeDeps = isGuest()
  ? { include: ['@tanstack/react-query', '@trpc/react-query', '@trpc/tanstack-react-query', '@trpc/client'] }
  : undefined
const api = `http://127.0.0.1:${process.env.API_PORT ?? 3001}`

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: guestOptimizeDeps,
  plugins: [
    tailwindcss(), reactRouter(), tsconfigPaths(),
    // In the guest `src/editing.tsx` renders nothing; on the host the chunks only
    // `src/editor-panel.tsx` reaches are listed for the server to keep private.
    browserEditor({ module: 'src/editing.tsx', privateEntry: 'src/editor-panel.tsx' }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': api, '/editor': api, '/editing-policy': api },
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
})
