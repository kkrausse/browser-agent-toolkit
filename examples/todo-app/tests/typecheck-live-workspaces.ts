// Typecheck the live consumer and helpers against the qualification's public
// workspace declarations without rebuilding runtime or generated library peers.
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dir, '../../..')
const input = resolve(process.argv[2] ?? '')
const output = resolve(process.argv[3] ?? '')
if (!process.argv[2] || !process.argv[3]) throw Error('Usage: typecheck-live-workspaces.ts <qualified-input> <staging-directory>')
const app = join(root, 'examples/todo-app')
const config = join(output, 'tsconfig.live-workspaces.json')
await Bun.write(config, JSON.stringify({ extends: join(app, 'tsconfig.json'), compilerOptions: {
  baseUrl: app,
  types: ['bun'], typeRoots: [join(app, 'node_modules/@types'), join(root, 'opencode-chat/node_modules/@types')],
  // Source-consumed editor effects follow the library tsconfig (conditional
  // effect cleanup); all strict type/safety checks remain enabled.
  noImplicitReturns: false,
  paths: {
    '@/*': [join(app, 'src/*')],
    '@kev-browser-agent-kit/workspace': [join(input, 'workspace/index.d.ts')],
    '@kev-browser-agent-kit/workspace/*': [join(input, 'workspace/*.d.ts')],
    '@kev-browser-agent-kit/opencode-chat': [join(root, 'opencode-chat/src/types.ts')],
    '@kev-browser-agent-kit/opencode-chat/browser': [join(input, 'chat/browser.d.ts')],
    '@kev-browser-agent-kit/opencode-chat/*': [join(root, 'opencode-chat/src/*')],
  },
}, include: ['src/local-workspaces.ts', 'src/workspace-sessions.ts', 'src/workspace-sessions.test.ts', 'src/workspace-switch.ts', 'src/workspace-switch.test.ts', 'src/workspace-editor.tsx', 'src/start-editor.ts', 'src/editor-panel.tsx', 'tests/single-kernel-live-client.tsx'].map(path => join(app, path)), exclude: [] }, null, 2))
const check = Bun.spawn(['bun', 'x', '--no-install', 'tsc', '--project', config], { cwd: app, stdout: 'inherit', stderr: 'inherit' })
if (await check.exited) throw Error('Live workspace typecheck failed')
