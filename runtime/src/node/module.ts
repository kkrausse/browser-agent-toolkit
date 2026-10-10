// `node:module`: the loader's public face.
import { fileURLToPath, pathToFileURL } from '../loader/loader'
import type { Runtime } from '../process/runtime'
import { registerBuiltin } from './registry'

function createModule(rt: Runtime): any {
  const loader = rt.loader!
  const Module: any = loader.Module
  const builtins = () => rt.builtins!
  const toFilename = (from: unknown): string => {
    const s = from instanceof URL ? from.href : String(from)
    if (s.startsWith('file:')) return fileURLToPath(s)
    if (!s.startsWith('/')) {
      throw Object.assign(new TypeError(`The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received '${s}'`), { code: 'ERR_INVALID_ARG_VALUE' })
    }
    return s
  }
  const cwdFile = () => {
    const cwd = rt.kernel.getcwd()
    return `${cwd === '/' ? '' : cwd}/`
  }
  Module.Module = Module
  Module.createRequire = (from: unknown) => loader.createRequire(toFilename(from))
  Module.builtinModules = builtins().names()
  Module.isBuiltin = (id: unknown) => typeof id === 'string' && builtins().canonical(id) !== undefined
  Module.register = () => {}
  Module.registerHooks = () => ({ deregister() {} })
  Module.syncBuiltinESMExports = () => {}
  Module.findSourceMap = () => undefined
  Module.SourceMap = class SourceMap {
    payload: unknown
    constructor(payload: unknown) {
      this.payload = payload
    }
    findEntry() {
      return {}
    }
    findOrigin() {
      return {}
    }
  }
  Module.globalPaths = []
  Module.wrapper = ['(function (exports, require, module, __filename, __dirname) { ', '\n});']
  Module.wrap = (code: string) => Module.wrapper[0] + code + Module.wrapper[1]
  Module._resolveFilename = (request: string, parent?: any, _isMain?: boolean, options?: { paths?: string[] }) => {
    const id = loader.resolve(String(request), parent?.filename ?? parent?.id ?? cwdFile(), 'require', options)
    return id.startsWith('node:') && !String(request).startsWith('node:') ? id.slice(5) : id
  }
  Module._load = (request: string, parent?: any) => loader.require(String(request), parent?.filename ?? parent?.id ?? cwdFile())
  Module._findPath = (request: string, paths: string[]) => {
    try {
      return loader.resolve(request, cwdFile(), 'require', { paths })
    } catch {
      return false
    }
  }
  Module._resolveLookupPaths = (request: string, parent?: any) => (/^\.\.?\//.test(request) ? [parent?.path ?? '.'] : Module._nodeModulePaths(parent?.path ?? rt.kernel.getcwd()))
  Module._initPaths = () => {}
  Module._preloadModules = () => {}
  Module._pathCache = Object.create(null)
  Module.runMain = (main = rt.process.argv[1]) => loader.runMain(main)
  Module.findPackageJSON = (specifier: unknown, base?: unknown) => {
    const from = base === undefined ? undefined : toFilename(base)
    let target: string
    const s = specifier instanceof URL ? specifier.href : String(specifier)
    if (s.startsWith('file:')) target = fileURLToPath(s)
    else if (s.startsWith('/')) target = s
    else {
      try {
        target = loader.resolve(s, from ?? cwdFile(), 'import')
      } catch {
        return undefined
      }
    }
    return loader.resolver.packageScope(target)?.path
  }
  Module.enableCompileCache = () => ({ status: 3, message: 'Compile cache is managed by the host runtime' })
  Module.getCompileCacheDir = () => undefined
  Module.flushCompileCache = () => {}
  Module.constants = { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } }
  Module.stripTypeScriptTypes = () => {
    throw Object.assign(new Error('module.stripTypeScriptTypes is not implemented in this runtime'), { code: 'ERR_METHOD_NOT_IMPLEMENTED' })
  }
  Module.getSourceMapsSupport = () => ({ enabled: false, nodeModules: false, generatedCode: false })
  Module.setSourceMapsSupport = () => {}
  void pathToFileURL
  return Module
}

registerBuiltin('module', createModule)
