// node:console `Console`: OpenTUI builds one over capture streams so that
// console.* calls made while the TUI owns the screen land in its overlay.
interface Sink {
  write(chunk: string): unknown
}

function format(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg
      if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(" ")
}

export function Console(options: { stdout: Sink; stderr?: Sink } | Sink, stderrArg?: Sink) {
  const stdout = "stdout" in options ? options.stdout : options
  const stderr = ("stdout" in options ? options.stderr : stderrArg) ?? stdout
  const out = (...args: unknown[]) => void stdout.write(format(args) + "\n")
  const err = (...args: unknown[]) => void stderr.write(format(args) + "\n")
  return {
    log: out, info: out, debug: out, dir: out, table: out, trace: err, warn: err, error: err,
    assert: (condition: unknown, ...args: unknown[]) => void (condition || err("Assertion failed", ...args)),
    group: out, groupCollapsed: out, groupEnd() {}, time() {}, timeEnd() {}, timeLog() {}, count() {}, countReset() {}, clear() {},
  }
}

export default globalThis.console
