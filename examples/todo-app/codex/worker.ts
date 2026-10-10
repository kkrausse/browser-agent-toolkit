// The Worker that runs codex in the TODO example: wasm-term's program Worker
// (wasm-term/host/worker.ts: pty, WASI, network) with two things replaced so
// that codex works on the files the dev server serves:
//
//   - `/workspace` of codex's filesystem is the toolkit kernel's (kernel-fs.ts);
//   - its commands are kernel processes (kernel-proc.ts), so `node` exists.
//
// The page sends the kernel's module and shared memory (`ProgramOptions.host`);
// this Worker attaches to it the way a process worker does and becomes a host
// process of its own (a pid with a descriptor table, parent of the commands).
import { attachKernel } from '../../../runtime/src/kernel/attach'
import { createKernel } from '../../../runtime/src/kernel/kernel'
import { setWorkerHooks } from '../../../wasm-term/host/worker'
import { createKernelMount } from './kernel-fs'
import { createKernelProcesses } from './kernel-proc'

/** `ProgramOptions.host` for this Worker. */
export interface CodexHostInit {
  module: WebAssembly.Module
  memory: WebAssembly.Memory
  /** The directory of the guest's filesystem that is the kernel's directory of the same path. */
  mount: string
  /** Environment added to every command. */
  commandEnv: Record<string, string>
}
/** What this Worker tells the page once attached: what the page must release before terminating it. */
export interface CodexHostAttached {
  attached: { thread: number; pid: number }
}

setWorkerHooks({
  async setup({ init, machine, vfs, post }) {
    const host = init.host as CodexHostInit | undefined
    if (!host) return
    const instance = await attachKernel({ module: host.module, memory: host.memory, canBlock: true })
    const kernel = createKernel(instance)
    const pid: number = kernel.x.bat_host_proc_new()
    post({ t: 'host', data: { attached: { thread: instance.thread, pid } } satisfies CodexHostAttached })
    // So that the mount point shows in a listing of its parent; what is below it never comes from here.
    vfs.mkdirp(host.mount)
    const mount = createKernelMount(kernel, host.mount)
    return {
      processes: createKernelProcesses({ kernel, machine, fallbackCwd: host.mount, env: host.commandEnv }),
      imports: mount.install,
      setMemory: mount.setMemory,
    }
  },
})
