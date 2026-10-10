// Page side of codex in the TODO example. Bundled by ../codex.ts into
// `.editor/codex/terminal.js` and loaded by the editor panel only when the
// user chooses Codex, so the app's own bundle carries none of it.
//
// `mountCodex` puts wasm-term's terminal into an element and runs `codex-local`
// (codex 0.162.0: TUI, app-server and agent core as one wasm module) in a
// Worker (worker.ts) that is attached to the toolkit's kernel: `/workspace` and
// the commands are the kernel's, everything else is wasm-term's machine.
//
// Network is what the static codex build offers (wasm-term/README.md):
//   direct  the browser's fetch straight to OpenAI. An API key and the sign-in work
//           from any origin; a ChatGPT subscription only from the origins chatgpt.com
//           accepts (http://localhost:3000 and a few others)
//   tunnel  codex's own TLS over a TCP relay that only copies bytes (`tcpRelay`,
//           wasm-term/web/tcp-relay-main.ts)
// Sign-in happens in the TUI. `auth.json` and the rest of CODEX_HOME are kept in
// this origin's IndexedDB (database `wasm-term`, namespace `todo-codex`).
import type { HttpBlocked, HttpSeen } from '../../../wasm-term/host/index'
import { openPersistStore } from '../../../wasm-term/host/persist-store'
import { chatgptAllows, originRefusedMessage } from '../../../wasm-term/web/direct'
import { mountTerminal } from '../../../wasm-term/web/embed'
import environment from './environment.md' with { type: 'text' }
import type { CodexModule, CodexOptions, MountedCodex } from '../src/codex-api'
import type { CodexHostAttached, CodexHostInit } from './worker'

const NAMESPACE = 'todo-codex'
const CODEX_HOME = '/home/user/.codex'
const CREDENTIALS = [`${CODEX_HOME}/auth.json`]

interface CodexManifest {
  module: string
  bytes: number
}

export async function mountCodex(options: CodexOptions): Promise<MountedCodex> {
  const assets = new URL(options.assets, location.href).href
  const manifest = (await (await fetch(`${assets}codex.json`, { cache: 'no-store' })).json()) as CodexManifest
  const { kernel } = options
  let attached: CodexHostAttached['attached'] | undefined
  const requests: HttpSeen[] = []

  function blocked(request: HttpBlocked): { status: number; body: string } | undefined {
    if (navigator.onLine === false) return undefined
    const url = new URL(request.url)
    // What a browser cannot tell apart from a dead network: chatgpt.com answers only a fixed list of origins.
    if (url.pathname.startsWith('/backend-api/') && !chatgptAllows(location.origin)) {
      const message = originRefusedMessage(location.origin)
      options.onNotice?.(message)
      return { status: 400, body: message }
    }
    options.onNotice?.(`A request to ${url.host} failed before any answer (${request.error}): the network, or ${url.host} does not allow requests from ${location.origin}.`)
    return undefined
  }

  /** The kernel's kill gate (docs/design/kernel-abi.md, "Detaching"): a Worker terminated while it holds a kernel
   * lock would leave it held for everyone, so it is first told to park at its next lock. Its commands go with it. */
  function release(): void {
    if (!attached) return
    const { thread, pid } = attached
    attached = undefined
    try {
      const all = kernel.procList()
      const doomed = [pid]
      for (let index = 0; index < doomed.length; index++) for (const entry of all) if (entry.ppid === doomed[index] && entry.state !== 2) doomed.push(entry.pid)
      for (const child of doomed.slice(1).reverse()) {
        try {
          kernel.kill(child, 9)
        } catch {
          // gone already
        }
      }
      kernel.x.bat_thread_mark_dying!(thread)
      const until = performance.now() + 2000
      while (kernel.x.bat_thread_lock_depth!(thread) !== 0 && performance.now() < until) {
        // spin: critical sections are short, and the Worker is usually asleep outside the kernel
      }
      kernel.x.bat_proc_mark_exited!(pid, 137)
      setTimeout(() => kernel.x.bat_thread_free!(thread), 5000)
    } catch (error) {
      console.warn('codex: could not release the kernel thread', error)
    }
  }

  const mounted = await mountTerminal({
    container: options.container,
    assets,
    guest: 'codex-local',
    fontSize: options.fontSize ?? 13,
    env: {
      TERM_PROGRAM: 'ghostty',
      CODEX_HOME,
      CODEX_WASM_BACKEND: options.backend,
      WASM_TERM_NET: options.net,
      CODEX_WASM_CWD: options.workspace,
      PWD: options.workspace,
      // The project is the app's source, not the sample the module carries.
      CODEX_WASM_SEED: '0',
      ...(options.mockUrl ? { CODEX_WASM_MOCK_URL: options.mockUrl } : {}),
    },
    persist: { namespace: NAMESPACE, roots: [CODEX_HOME], exclude: [`${CODEX_HOME}/tmp/`, `${CODEX_HOME}/log/`, '.sqlite', '/thread-writer-locks/'] },
    onExit: options.onExit,
    program: {
      guestUrl: `${assets}${manifest.module}`,
      workerUrl: `${assets}codex-worker.js`,
      // What this machine is, for the model, in place of the text built into the module (which says nothing can run).
      args: ['codex-local', '-c', `developer_instructions=${JSON.stringify(environment.trim())}`],
      // codex looks for a shell at these paths in its own filesystem; what runs is the kernel's (kernel-proc.ts).
      files: { '/bin/bash': '', '/bin/sh': '', '/usr/bin/bash': '', '/usr/bin/env': '' },
      tcpRelay: options.net === 'tunnel' ? options.tcpRelay : undefined,
      http: {
        seen(entry) {
          requests.push(entry)
          if (requests.length > 200) requests.shift()
        },
        blocked: options.net === 'direct' ? blocked : undefined,
      },
      host: {
        module: kernel.inst.module,
        memory: kernel.inst.memory,
        mount: options.workspace,
        commandEnv: { PATH: `${options.workspace}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`, HOME: '/home/user' },
      } satisfies CodexHostInit,
      onHostMessage(data) {
        attached = (data as CodexHostAttached).attached ?? attached
      },
      beforeTerminate: release,
      onLoad: options.onLoad,
    },
  })

  return {
    screen: mounted.screen,
    write: data => mounted.program.write(data),
    focus: () => mounted.terminal.focus(),
    procs: mounted.program.procs,
    requests,
    async readFile(path) {
      const data = await mounted.program.readFile(path)
      return data && new TextDecoder().decode(data)
    },
    dispose: mounted.dispose,
  }
}

/** `/logout` in the TUI also revokes the token; this only deletes the stored file. */
export async function clearCodexCredentials(): Promise<void> {
  const store = openPersistStore(NAMESPACE)
  for (const path of CREDENTIALS) store.save(path, null)
  await store.flush()
}

export async function hasCodexCredentials(): Promise<boolean> {
  const files = await openPersistStore(NAMESPACE).load()
  return CREDENTIALS.some(path => path in files)
}

/** The workspace is the editor's and is not touched. */
export const forgetCodexState = (): Promise<void> => openPersistStore(NAMESPACE).clear()

// The panel loads this file by URL and knows it as `CodexModule`.
void ({ mountCodex, clearCodexCredentials, hasCodexCredentials, forgetCodexState } satisfies CodexModule)
