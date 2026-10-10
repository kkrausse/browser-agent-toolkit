// node:os for the browser client: a fixed, plausible Linux machine.
const env = () => ((globalThis as any).process?.env ?? {}) as Record<string, string | undefined>
export const EOL = "\n"
export const homedir = () => env().HOME ?? "/home/web"
export const tmpdir = () => env().TMPDIR ?? "/tmp"
export const hostname = () => "wasm-term"
export const platform = () => "linux"
export const type = () => "Linux"
export const release = () => "6.0.0-wasm-term"
export const arch = () => "wasm32"
export const cpus = () => [] as unknown[]
export const totalmem = () => 0
export const freemem = () => 0
export const userInfo = () => ({ username: env().USER ?? "web", uid: 1000, gid: 1000, shell: "/bin/sh", homedir: homedir() })
export const networkInterfaces = () => ({})
export const endianness = () => "LE"
export const constants = { signals: {} }
export default {
  EOL, arch, constants, cpus, endianness, freemem, homedir, hostname, networkInterfaces, platform, release,
  tmpdir, totalmem, type, userInfo,
}
