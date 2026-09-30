import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

// Execute the actual app recipe, replacing only its library/browser boundaries.
const built = await Bun.build({
  entrypoints: ['startup-test-entry'], target: 'browser',
  plugins: [{ name: 'startup-boundaries', setup(build) {
    build.onResolve({ filter: /^startup-test-entry$/ }, () => ({ path: 'entry', namespace: 'startup-entry' }))
    build.onLoad({ filter: /.*/, namespace: 'startup-entry' }, () => ({ contents: `import {startBrowserEditor} from ${JSON.stringify(resolve(import.meta.dir, '../src/start-editor.ts'))}; globalThis.start = startBrowserEditor;`, loader: 'ts' }))
    build.onResolve({ filter: /^@kev-browser-agent-kit\// }, args => ({ path: args.path, namespace: 'startup-library' }))
    build.onLoad({ filter: /.*/, namespace: 'startup-library' }, () => ({ contents: `
      export const createDiagnosticScope = () => ({});
      export const loadPrepared = async () => ({runtimeVersion:'pin',project:{},preview:{entry:'vite'},...globalThis.modelConfig});
      export const preparedApps = () => ({});
      export const installSource = async () => {};
      export const installOpenCodeConfig = async (_workspace, options) => {globalThis.installedConfig = options};
      export const startOpenCode = async controller => {globalThis.calls.push('chat.start'); return controller.launch('chat');};
    `, loader: 'js' }))
  } }],
})
if (!built.success) throw new AggregateError(built.logs)
const code = await built.outputs[0]!.text()

function harness(failure?: 'listen' | 'http' | 'client' | 'chat', modelConfig = {}) {
  const calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const context: any = { calls, modelConfig, AbortSignal, TextEncoder, location: {port:'54770',protocol:'http:'}, fetch: async () => ({ok:true,json:async()=>({version:'pin'})}) }
  runInNewContext(code, context)
  const controller: any = {
    signal: new AbortController().signal, diagnostic() {}, log() {},
    workspace: {fs:{stat:async()=>({})},flush:async()=>{}}, runtime: {},
    open: async () => {}, steps: async (steps: any[]) => {for(const [,task] of steps) await task()},
    async launch(name: string, _options: unknown, _port: unknown, connect: any) {
      calls.push(name + '.launch')
      if (name === 'vite') {
        await gate
        if (failure === 'listen') throw Error('listen failed')
        await connect({url:'http://preview/',fetch:async()=>({ok:failure !== 'http',status:503})})
      } else if (failure === 'chat') throw Error('chat failed')
      return {name}
    },
    async waitForClient(name: string) { calls.push(name + '.client'); if (name === 'vite' && failure === 'client') throw Error('client failed') },
    status() {calls.push('ready')},
  }
  return {calls,release,config:()=>context.installedConfig,start:()=>context.start(controller,{beforeChatConnect:async()=>{calls.push('chat.restore')},chatConnectReady:()=>{calls.push('chat.connect')}})}
}

test('startup passes the prepared approved catalog and paid default through the library, not a guest rewrite', async () => {
  const models = { 'muse-spark-1.3': { name: 'Muse Spark 1.3' } }
  const h = harness(undefined, { modelCatalog: models, editorDefaultModel: 'muse-spark-1.3' })
  const task = h.start(); h.release(); await task
  expect(h.config().models).toBe(models)
  expect(h.config().defaultModel).toBe('muse-spark-1.3')
  expect(h.config().modelBaseURL).toBe('http://host.vivari.internal:54770/editor/model/opencode/')
  expect(h.config().additionalToolActions).toEqual(['shell'])
})

test('cold preview qualification precedes chat boot without altering readiness budgets', async () => {
  const h = harness()
  const task = h.start()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(h.calls).toEqual(['vite.launch'])
  h.release(); await task
  expect(h.calls).toEqual(['vite.launch','vite.client','chat.start','chat.launch','chat.restore','chat.connect','chat.client','ready'])
})

test('preview listen, HTTP and client failures never start chat or publish ready', async () => {
  for (const failure of ['listen','http','client'] as const) {
    const h = harness(failure), task = h.start()
    h.release()
    await expect(task).rejects.toThrow()
    expect(h.calls).not.toContain('chat.start')
    expect(h.calls).not.toContain('ready')
  }
})

test('chat failure after preview readiness remains a failed startup', async () => {
  const h = harness('chat'), task = h.start()
  h.release()
  await expect(task).rejects.toThrow('chat failed')
  expect(h.calls).toContain('vite.client')
  expect(h.calls).not.toContain('chat.restore')
  expect(h.calls).not.toContain('ready')
})
