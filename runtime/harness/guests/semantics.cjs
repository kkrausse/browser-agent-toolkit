// Process lifetime: exit codes, uncaught errors, unhandled rejections, unref, beforeExit, unsettled TLA.
const cp = require('child_process')
const run = (code, args = []) => {
  const r = cp.spawnSync(process.execPath, [...args, '-e', code], { encoding: 'utf8' })
  return `${r.status} out=${JSON.stringify(r.stdout)} err=${JSON.stringify(r.stderr.split('\n')[0].slice(0, 90))}`
}
const cases = {
  'plain exit': 'console.log(1)',
  'process.exit(4) stops everything': 'process.on("exit", c => console.log("exit", c)); setTimeout(() => console.log("never"), 0); process.exit(4); console.log("never")',
  'exitCode': 'process.exitCode = 9',
  'throw': 'throw new Error("boom")',
  'throw in timer': 'setTimeout(() => { throw new TypeError("late") }, 1)',
  'uncaughtException handler': 'process.on("uncaughtException", e => { console.log("caught", e.message) }); setTimeout(() => { throw new Error("x") }, 1); setTimeout(() => console.log("still alive"), 5)',
  'unhandled rejection': 'Promise.reject(new Error("rejected"))',
  'unhandledRejection handler': 'process.on("unhandledRejection", (r) => console.log("handled", r.message)); Promise.reject(new Error("r"))',
  'unref timer does not hold': 'setTimeout(() => console.log("never"), 500).unref(); console.log("done")',
  'ref timer holds': 'setTimeout(() => console.log("fired"), 20)',
  'interval cleared': 'let n = 0; const i = setInterval(() => { if (++n === 3) { clearInterval(i); console.log("n", n) } }, 2)',
  'beforeExit reschedules once': 'let n = 0; process.on("beforeExit", () => { if (n++ < 2) setTimeout(() => console.log("again", n), 1) })',
  'nextTick before promise before timer': 'setTimeout(() => console.log("t"), 0); Promise.resolve().then(() => console.log("p")); process.nextTick(() => console.log("n")); console.log("s")',
  'stdin eof': 'process.stdin.on("data", d => console.log("d", String(d))).on("end", () => console.log("end"))',
  'signal handler': 'process.on("SIGTERM", () => { console.log("term"); process.exit(0) }); setTimeout(() => process.kill(process.pid, "SIGTERM"), 5); setTimeout(() => {}, 1000)',
  'esm tla settles': ['await new Promise(r => setTimeout(r, 5)); console.log("tla")', ['--input-type=module']],
  'esm tla never settles': ['await new Promise(() => {})', ['--input-type=module']],
  'print': ['[1,2].map(x => x * 2)', ['-p']],
}
for (const [name, c] of Object.entries(cases)) {
  const [code, args] = Array.isArray(c) ? c : [c, []]
  console.log(name.padEnd(38), args[0] === '-p' ? (() => { const r = cp.spawnSync(process.execPath, ['-p', code], { encoding: 'utf8' }); return `${r.status} out=${JSON.stringify(r.stdout)}` })() : run(code, args))
}
