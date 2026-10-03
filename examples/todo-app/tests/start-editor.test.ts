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
      export const openCodeTrace = {dumpPath: '/__opencode_trace'};
      export const viteTrace = {entry: '/trace-entry', dumpPath: '/__vite_trace'};
      export const installViteTrace = async () => {};
      export const tracedPreviewLaunch = preview => preview;
    `, loader: 'js' }))
  } }],
})
if (!built.success) throw new AggregateError(built.logs)
const code = await built.outputs[0]!.text()

type Failure = 'listen' | 'http' | 'client' | 'chat'
function harness(options: { failure?: Failure | Failure[]; search?: string; modelConfig?: object; holdChat?: boolean } = {}) {
  const failures = new Set([options.failure ?? []].flat())
  const calls: string[] = []
  const gate = () => { let open!: () => void; const closed = new Promise<void>(resolve => { open = resolve }); return { closed, open } }
  // The preview is held before it listens, then before its first response; chat only when asked.
  const listen = gate(), http = gate(), chatGate = gate()
  if (!options.holdChat) chatGate.open()
  const context: any = { calls, modelConfig: options.modelConfig ?? {}, AbortSignal, TextEncoder, URLSearchParams, location: {port:'54770',protocol:'http:',search:options.search ?? ''}, fetch: async () => ({ok:true,json:async()=>({version:'pin'})}) }
  runInNewContext(code, context)
  const controller: any = {
    signal: new AbortController().signal, diagnostic() {}, log() {},
    workspace: {fs:{stat:async()=>({})},flush:async()=>{}}, runtime: {},
    open: async () => {}, steps: async (steps: any[]) => {for(const [,task] of steps) await task()},
    async launch(name: string, _options: unknown, _port: unknown, connect: any) {
      calls.push(name + '.launch')
      if (name === 'vite') {
        await listen.closed
        if (failures.has('listen')) throw Error('listen failed')
        calls.push('vite.listening')
        await connect({url:'http://preview/',fetch:async()=>{ await http.closed; return {ok:!failures.has('http'),status:503} }})
      } else {
        await chatGate.closed
        if (failures.has('chat')) throw Error('chat failed')
      }
      return {name}
    },
    async waitForClient(name: string) { calls.push(name + '.client'); if (name === 'vite' && failures.has('client')) throw Error('client failed') },
    status() {calls.push('ready')},
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return {calls,settle,listen:listen.open,respond:http.open,releaseChat:chatGate.open,release(){listen.open();http.open()},config:()=>context.installedConfig,
    start:()=>context.start(controller,{beforeChatConnect:async()=>{calls.push('chat.restore')},chatConnectReady:()=>{calls.push('chat.connect')}})}
}
const chatOrder = ['chat.start','chat.launch','chat.restore','chat.connect','chat.client']

test('startup passes the prepared approved catalog and paid default through the library, not a guest rewrite', async () => {
  const models = { 'muse-spark-1.3': { name: 'Muse Spark 1.3' } }
  const h = harness({ modelConfig: { modelCatalog: models, editorDefaultModel: 'muse-spark-1.3' } })
  const task = h.start(); h.release(); await task
  expect(h.config().models).toBe(models)
  expect(h.config().defaultModel).toBe('muse-spark-1.3')
  expect(h.config().modelBaseURL).toBe('http://host.vivari.internal:54770/editor/model/opencode/')
  expect(h.config().additionalToolActions).toEqual(['shell'])
})

test('chat boot never starts before the cold preview listens, then overlaps its first render', async () => {
  const h = harness()
  const task = h.start()
  await h.settle()
  // Not listening yet: the listen budget is the preview's alone.
  expect(h.calls).toEqual(['vite.launch'])
  h.listen(); await h.settle()
  // Listening, first response still pending: chat has started, restored and connected in its own order.
  expect(h.calls).toEqual(['vite.launch','vite.listening',...chatOrder])
  h.respond(); await task
  expect(h.calls).toEqual(['vite.launch','vite.listening',...chatOrder,'vite.client','ready'])
})

test('?startup=serial keeps the qualified order: preview ready, then chat', async () => {
  const h = harness({ search: '?startup=serial' })
  const task = h.start()
  await h.settle()
  expect(h.calls).toEqual(['vite.launch'])
  h.listen(); await h.settle()
  expect(h.calls).toEqual(['vite.launch','vite.listening'])
  h.respond(); await task
  expect(h.calls).toEqual(['vite.launch','vite.listening','vite.client',...chatOrder,'ready'])
})

test('?startup=parallel starts chat with the preview', async () => {
  const h = harness({ search: '?startup=parallel' })
  const task = h.start()
  await h.settle()
  // Chat is through before the preview has even listened.
  expect(h.calls.filter(call => call.startsWith('chat.'))).toEqual(chatOrder)
  expect(h.calls).not.toContain('vite.listening')
  h.release(); await task
  expect(h.calls.at(-1)).toBe('ready')
})

test('a preview that never listens does not start chat or publish ready', async () => {
  for (const search of ['', '?startup=serial']) {
    const h = harness({ failure: 'listen', search }), task = h.start()
    h.release()
    await expect(task).rejects.toThrow('listen failed')
    expect(h.calls).not.toContain('chat.start')
    expect(h.calls).not.toContain('ready')
  }
})

test('serial order: preview HTTP and client failures never start chat', async () => {
  for (const failure of ['http','client'] as const) {
    const h = harness({ failure, search: '?startup=serial' }), task = h.start()
    h.release()
    await expect(task).rejects.toThrow()
    expect(h.calls).not.toContain('chat.start')
    expect(h.calls).not.toContain('ready')
  }
})

test('a preview failure after listening is reported only once the overlapping chat start has settled', async () => {
  for (const failure of ['http','client'] as const) {
    const h = harness({ failure, holdChat: true }), task = h.start()
    let settled = false
    void task.then(() => { settled = true }, () => { settled = true })
    h.release(); await h.settle(); await h.settle()
    // The preview has failed; the chat launch is still in flight and stays owned by this step.
    expect(h.calls).toContain('chat.launch')
    expect(settled).toBe(false)
    h.releaseChat()
    await expect(task).rejects.toThrow(failure === 'http' ? 'Preview HTTP 503' : 'client failed')
    expect(h.calls).not.toContain('ready')
  }
})

test('when both fail the preview failure is the one reported', async () => {
  const h = harness({ failure: ['http','chat'] }), task = h.start()
  h.release()
  await expect(task).rejects.toThrow('Preview HTTP 503')
  expect(h.calls).not.toContain('ready')
})

test('chat failure remains a failed startup after the preview is ready', async () => {
  for (const search of ['', '?startup=serial', '?startup=parallel']) {
    const h = harness({ failure: 'chat', search }), task = h.start()
    h.release()
    await expect(task).rejects.toThrow('chat failed')
    expect(h.calls).toContain('vite.client')
    expect(h.calls).not.toContain('chat.restore')
    expect(h.calls).not.toContain('ready')
  }
})
