// `node:process` / `process` imports: the object the worker entry installed.
const current = (globalThis as { process?: any }).process
export default current
export const env = current?.env
export const argv = current?.argv
export const platform = current?.platform
export const stdin = current?.stdin
export const stdout = current?.stdout
export const stderr = current?.stderr
export const cwd = () => current.cwd()
export const nextTick = (...args: unknown[]) => current.nextTick(...args)
