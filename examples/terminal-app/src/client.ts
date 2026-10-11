// The OpenCode terminal client's start: an ordinary program of the prepared image
// (`/app/tui/main.js`, wasm-term's OpenCode port built for Node), run by the runtime on a
// terminal of its kernel. It reaches the server at `http://127.0.0.1:<port>`, which in the guest
// is the server's own listener, with the server's real credential.
import type { Launch, RuntimeFs } from '@kkrausse/browser-agent-toolkit/browser'
import { workspace } from './opencode'
import type { SignInExchange } from './signin'

export const clientEntry = '/app/tui/main.js'
/** The client's settings, prompt history and open tabs live under here, in the workspace's storage. */
const home = '/home/user'
const tapDirectory = '/tmp/opencode-client'
/** Where the client appends its log. */
export const clientLog = `${tapDirectory}/tui.log`
const tap = { script: `${tapDirectory}/tap.mjs`, file: `${tapDirectory}/signin.jsonl` }

export function clientLaunch(port: number, password: string): Launch {
  return {
    argv: ['node', '--import', tap.script, clientEntry],
    cwd: workspace,
    env: {
      PATH: '/bin', HOME: home, TERM: 'xterm-256color', COLORTERM: 'truecolor',
      OPENCODE_SERVER_URL: `http://127.0.0.1:${port}`,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DIRECTORY: workspace,
      SIGNIN_TAP_FILE: tap.file,
      // The client's own log (errors and warnings unless it is asked for more): a file, since its stderr is the terminal.
      OPENCODE_TUI_LOG: clientLog,
    },
    programs: [],
  }
}

/** Before the client starts: its preload module, and no locks of a client that a reload killed
 * (it takes one per state file and would wait a minute for each to go stale). */
export async function installClient(fs: RuntimeFs, tapScript: Uint8Array, exchange: (exchange: SignInExchange) => void): Promise<void> {
  const state = `${home}/.local/state/opencode`
  for (const directory of [state, ...await fs.readdir(state).then(names => names.map(name => `${state}/${name}`), () => [])]) await fs.remove(`${directory}/locks`)
  await fs.mkdir(tapDirectory)
  await fs.writeFile(tap.script, tapScript)
  await fs.writeFile(tap.file, '')
  let seen = 0
  const decoder = new TextDecoder()
  fs.watch(tapDirectory, () => void fs.readFile(tap.file).then(bytes => {
    const lines = decoder.decode(bytes).split('\n').filter(Boolean)
    for (const line of lines.slice(seen)) { try { exchange(JSON.parse(line) as SignInExchange) } catch { /* a line still being written */ } }
    seen = lines.length
  }, () => {}))
}
