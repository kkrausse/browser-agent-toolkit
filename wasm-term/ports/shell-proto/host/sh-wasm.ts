// bat_sh.wasm (bat-rust crates/bat-sh, target wasm32-unknown-unknown) as it
// comes out of bat-rust's own build, unchanged: 24 imports in module `sh`, the
// exports sh_alloc / sh_free / sh_run. This file binds the imports to a `Call`
// (sh-host.ts) and encodes the run request; it is the same job
// bat-rust/runtime/src/process/sh.ts does against the bat-rust kernel.

import { type Call, OP } from "./sh-host";

interface ShExports {
  memory: WebAssembly.Memory;
  sh_alloc(n: number): number;
  sh_free(p: number, n: number): void;
  sh_run(p: number, n: number): number;
}

/** Thrown through the shell's frames to end a run from outside (kill, timeout). */
export class ShAbort extends Error {
  constructor(readonly signal: number, readonly timedOut: boolean) {
    super("sh aborted");
  }
}

export interface ShRunRequest {
  argv: string[];
  env: string[]; // NAME=value
  cwd: string;
}

export interface ShRunner {
  /** Runs one shell to completion on descriptors 0..2 of the host. Returns the exit status; throws ShAbort. */
  run(request: ShRunRequest): number;
}

/** Largest read or write carried by one call (a channel's data area is bigger than this). */
export const MAX_IO = 256 * 1024;

export interface ShRunnerOptions {
  module: WebAssembly.Module;
  call: Call;
  /** Called on entry to every host call: throw ShAbort to end the run. */
  checkpoint(): void;
  /** Sleeps; must itself keep calling `checkpoint`. */
  sleep(ms: number): void;
}

export function createShRunner({ module, call, checkpoint, sleep }: ShRunnerOptions): ShRunner {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let x: ShExports | undefined;
  let stash = new Uint8Array(0);
  const str = (p: number, n: number) => decoder.decode(new Uint8Array(x!.memory.buffer, p, n).slice());
  const keep = (reply: { rc: number; data?: Uint8Array }): number => {
    if (reply.rc >= 0) stash = reply.data ?? new Uint8Array(0);
    return reply.rc;
  };
  const path1 = (op: number, n1 = 0, n2 = 0) => (p: number, n: number) => (checkpoint(), call(op, n1, n2, str(p, n), "", null).rc);

  const imports = {
    sh_open: (p: number, n: number, flags: number, mode: number) => (checkpoint(), call(OP.OPEN, flags, mode, str(p, n), "", null).rc),
    sh_close: (fd: number) => call(OP.CLOSE, fd, 0, "", "", null).rc,
    sh_read(fd: number, p: number, n: number) {
      checkpoint();
      const reply = call(OP.READ, fd, Math.min(n, MAX_IO), "", "", null);
      if (reply.rc > 0) new Uint8Array(x!.memory.buffer, p, reply.rc).set(reply.data!);
      return reply.rc;
    },
    sh_write(fd: number, p: number, n: number) {
      checkpoint();
      return call(OP.WRITE, fd, 0, "", "", new Uint8Array(x!.memory.buffer, p, Math.min(n, MAX_IO))).rc;
    },
    sh_stat(p: number, n: number, follow: number, out: number) {
      checkpoint();
      const reply = call(OP.STAT, follow, 0, str(p, n), "", null);
      if (reply.rc === 0) new Uint8Array(x!.memory.buffer, out, 32).set(reply.data!);
      return reply.rc;
    },
    sh_readdir: (p: number, n: number) => (checkpoint(), keep(call(OP.READDIR, 0, 0, str(p, n), "", null))),
    sh_readlink: (p: number, n: number) => keep(call(OP.READLINK, 0, 0, str(p, n), "", null)),
    sh_realpath: (p: number, n: number) => keep(call(OP.REALPATH, 0, 0, str(p, n), "", null)),
    sh_take(p: number, cap: number) {
      new Uint8Array(x!.memory.buffer, p, cap).set(stash.subarray(0, cap));
    },
    sh_mkdir: (p: number, n: number, mode: number) => call(OP.MKDIR, mode, 0, str(p, n), "", null).rc,
    sh_rmdir: path1(OP.RMDIR),
    sh_unlink: path1(OP.UNLINK),
    sh_rename: (p: number, n: number, q: number, m: number) => call(OP.RENAME, 0, 0, str(p, n), str(q, m), null).rc,
    sh_symlink: (p: number, n: number, q: number, m: number) => call(OP.SYMLINK, 0, 0, str(p, n), str(q, m), null).rc,
    sh_chmod: (p: number, n: number, mode: number) => call(OP.CHMOD, mode, 0, str(p, n), "", null).rc,
    sh_utimes: (p: number, n: number, ms: number) => call(OP.UTIMES, ms, 0, str(p, n), "", null).rc,
    // No child processes on this machine yet: the shell's own commands are function calls inside it,
    // and these three are only reached for a program that is not one of them (`node`, a script's interpreter).
    sh_pipe: () => -38,
    sh_spawn: () => (checkpoint(), -2),
    sh_wait: () => 127,
    sh_kill: () => 0,
    sh_now: () => Date.now(),
    sh_sleep: (ms: number) => sleep(ms),
    sh_tz: () => -new Date().getTimezoneOffset(),
    sh_pid: () => 2,
  };

  return {
    run({ argv, env, cwd }) {
      const sh = (x ??= new WebAssembly.Instance(module, { sh: imports }).exports as unknown as ShExports);
      const strings = [cwd, ...argv, ...env].map(text => encoder.encode(text));
      const size = 20 + strings.reduce((sum, bytes) => sum + 4 + bytes.length, 0) + 4;
      const p = sh.sh_alloc(size);
      const view = new DataView(sh.memory.buffer, p, size);
      const memory = new Uint8Array(sh.memory.buffer);
      [0, 1, 2].forEach((fd, index) => view.setInt32(index * 4, fd, true));
      view.setUint32(12, argv.length, true);
      view.setUint32(16, env.length, true);
      let at = 20;
      for (const bytes of [...strings, new Uint8Array(0)]) {
        view.setUint32(at, bytes.length, true);
        memory.set(bytes, p + at + 4);
        at += 4 + bytes.length;
      }
      try {
        const status = sh.sh_run(p, size);
        sh.sh_free(p, size);
        return status;
      } catch (thrown) {
        x = undefined; // left in the middle of a run (abort, or a trap: the build aborts on panic)
        throw thrown;
      }
    },
  };
}
