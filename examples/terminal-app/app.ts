// Which app this page shows and lets the agent edit. The default is the TODO example next
// door. `BAT_APP=<directory>` (relative to the working directory) names another one, which
// describes itself in a `terminal-app.json` in its own directory:
//
//   title           what the page calls it (tab title, frame label)
//   source          files and directories the agent may edit (installed into /workspace)
//   preview         changes to the dev-server launch (default: Vite on port 5173)
//   startupModules  a recorded start-up module list, relative to the app (optional)
//   startupOrder    a recorded start-up read order, relative to the app (optional)
//   localStorage    keys of this origin's localStorage that `?reset=1` forgets with the workspace
//
// Each app other than the default gets its own output directories, so two can be built
// and served side by side: `.editor/<name>/prepared` and `.editor/<name>/dist`.
import type { LaunchDescription } from '@kkrausse/browser-agent-toolkit/prepare'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export interface EditedApp {
  title: string
  source: string[]
  preview?: Partial<LaunchDescription>
  startupModules?: string
  startupOrder?: string
  localStorage?: string[]
}

export interface AppPaths extends EditedApp {
  /** The app's directory. */
  root: string
  prepared: string
  dist: string
}

const here = import.meta.dirname
const todo: EditedApp = {
  title: 'TODO app',
  source: ['index.html', 'src', 'vite.config.ts', 'tsconfig.json', 'package.json'],
  startupModules: 'startup-modules.json',
  startupOrder: 'editor-startup-order.txt',
  // The TODO app keeps its list in this origin's localStorage (../todo-app/src/App.tsx), not in the workspace.
  localStorage: ['todos'],
}

export function editedApp(): AppPaths {
  const given = process.env.BAT_APP
  if (!given) return { ...todo, root: resolve(here, '../todo-app'), prepared: resolve(here, '.editor/prepared'), dist: resolve(here, process.env.OUT_DIR ?? 'dist') }
  const root = resolve(given), file = join(root, 'terminal-app.json')
  if (!existsSync(file)) throw Error(`BAT_APP=${given}: no ${file} (it names the app's title and the source the agent may edit; see examples/terminal-app/app.ts)`)
  const described = JSON.parse(readFileSync(file, 'utf8')) as EditedApp
  if (typeof described.title !== 'string' || !Array.isArray(described.source) || !described.source.length) throw Error(`${file} needs a "title" and a "source" list`)
  const out = resolve(here, '.editor', basename(root))
  return { ...described, root, prepared: join(out, 'prepared'), dist: process.env.OUT_DIR ? resolve(here, process.env.OUT_DIR) : join(out, 'dist') }
}
