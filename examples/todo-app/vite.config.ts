import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { browserEditorBoundary, isBrowserEditorModule } from '@kev-browser-agent-kit/workspace/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite'
import { authorizeEditing } from './src/server/editing'

// The preview in the browser guest. React Router leaves Vite's dependency scan without
// entries (unless future.unstable_optimizeDeps), so the scan sees only React Router's own
// includes and the application's client dependencies turn up at the first page load: a
// second optimizer run and a reload of the frame on every fresh open. Name the ones the
// client imports. Guest only: the host's dev server and build are as they were.
const guestOptimizeDeps = process.env.BROWSER_AGENT_GUEST === '1'
  ? { include: ['@tanstack/react-query', '@trpc/react-query', '@trpc/tanstack-react-query', '@trpc/client'] }
  : undefined

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: guestOptimizeDeps,
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths(), {
    name: 'todo-editor-access',
    configureServer(server) {
      if (process.env.BROWSER_AGENT_GUEST === '1') return
      server.middlewares.use((request, response, next) => {
        try {
          if (!isBrowserEditorModule(request.url ?? '', 'src/editor-panel.tsx')) return next()
          const headers = new Headers()
          for (const [name, value] of Object.entries(request.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
          if (authorizeEditing(new Request(`http://${request.headers.host}${request.url}`, { headers }))) return next()
          response.statusCode = 403
        } catch { response.statusCode = 400 }
        response.setHeader('Cache-Control', 'no-store')
        response.end('Editing is not authorized')
      })
    },
  }, browserEditorBoundary('src/editing.tsx', 'src/editor-panel.tsx', () => [
    '@kev-browser-agent-kit/opencode-chat/editor',
    '@kev-browser-agent-kit/opencode-chat/diagnostics',
    '@kev-browser-agent-kit/opencode-chat/editor.css',
    '@kev-browser-agent-kit/workspace',
    '@kev-browser-agent-kit/workspace/react',
    '@kev-browser-agent-kit/workspace/diagnostics',
  ].map(name => Bun.resolveSync(name, import.meta.dir)))],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://localhost:3001', '/editor': 'http://localhost:3001', '/editing-policy': 'http://localhost:3001' },
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
})
