// node --import <this file>: CPU-profile the process from its first user-land moment and
// write the .cpuprofile (same format as --cpu-prof) to the file named by
// BAT_MEASURE_CPUPROFILE when SIGTERM arrives (or at exit).
//
// Why not plain `NODE_OPTIONS=--cpu-prof`: that does pass through vite-crawl.mjs and bwrap,
// but Node writes the profile only on an orderly exit, and the crawl harness ends the dev
// server by signalling its process group and leaving at once; no profile appears. Here the
// profile is written synchronously inside the SIGTERM handler, before Vite's own handler.
//
//   node vite-crawl.mjs <app> <out> --port 4107 \
//     --env NODE_OPTIONS=--import=/abs/measure-cpuprofile-preload.mjs --env BAT_MEASURE_CPUPROFILE=/abs/dir/%p.cpuprofile
import inspector from 'node:inspector';
import fs from 'node:fs';
import { threadId } from 'node:worker_threads';

// NODE_OPTIONS reaches child processes and worker threads too (with the old substitutions
// esbuild-wasm runs its Go Wasm in a child `node .../esbuild-wasm/bin/esbuild`), so the
// file name must carry %p: it becomes <pid>-<thread id>, and a line per profiled thread
// (pid, thread, argv) is appended to <dir>/processes.txt.
const pattern = process.env.BAT_MEASURE_CPUPROFILE;
const out = pattern?.replace('%p', `${process.pid}-${threadId}`);
if (out) {
  fs.appendFileSync(out.replace(/[^/]*$/, 'processes.txt'), `${process.pid}-${threadId} ${process.argv.slice(1).join(' ')}\n`);
  const session = new inspector.Session();
  session.connect();
  session.post('Profiler.enable');
  session.post('Profiler.setSamplingInterval', { interval: Number(process.env.BAT_MEASURE_CPUPROFILE_INTERVAL_US ?? 500) });
  session.post('Profiler.start');
  let written = false;
  const write = () => {
    if (written) return;
    written = true;
    // In-process inspector sessions answer synchronously.
    session.post('Profiler.stop', (error, result) => {
      try {
        if (error) throw error;
        fs.writeFileSync(out, JSON.stringify(result.profile));
      } catch (failure) { fs.writeFileSync(`${out}.error`, String(failure?.stack ?? failure)); }
    });
  };
  process.prependListener('SIGTERM', write);
  process.on('exit', write);
}
