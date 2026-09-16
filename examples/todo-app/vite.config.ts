import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { browserEditorBoundary } from '@kev-browser-agent-kit/opencode-chat/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite'
import { authorizeEditing } from './src/server/editing'

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths(), browserEditorBoundary('src/editing.tsx', 'src/editor-panel.tsx', authorizeEditing)],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://localhost:3001', '/editor': 'http://localhost:3001', '/editing-policy': 'http://localhost:3001' },
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
})
