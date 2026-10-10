#!/usr/bin/env bun
// A model that follows a script, on its own origin, for trying the example without a
// provider: `bun mock-model.ts` (PORT, default 4311). It is NOT part of the page's server.
// The OpenCode server in the tab calls it straight from the browser, cross-origin, exactly
// as it would call a real endpoint, so this also shows what such an endpoint has to allow:
// every answer carries permissive CORS headers, and the preflight (OPTIONS) is answered and
// logged with the headers the browser asked for.
//
// It speaks the OpenAI Responses API with streaming (`POST <base>/responses`), which is what
// OpenCode uses for `@opencode/ai/providers/openai` models. Scripts, by the last user message:
//
//   contains "heading"   reads src/home.tsx, then replaces the text of its <h1> with the
//                        quoted text of the prompt (`set the heading to "Tasks"`), or with
//                        the old text plus " (edited in the tab)"; ends SCRIPTED-EDIT-DONE
//   anything else        a paragraph of streamed text; ends SCRIPTED-PLAIN-DONE
//
// wasm-term's mock-llm (`?model=http://<host>:4791/v1&modelId=mock-model`) has more scripts,
// but its file scenarios write files of its own sample project, none that this preview shows.

import { appendFile } from 'node:fs/promises'

type Json = Record<string, any>
interface Tool { name: string; properties: string[] }
interface Turn { model: string; user: string; results: string[]; tools: Tool[] }
interface Step { text: string; call?: { name: string; arguments: string } }

const file = '/workspace/src/home.tsx'
const plain = 'Hello from the scripted model. This reply is streamed in small pieces by a mock on another origin that this tab fetched directly; no model was called and no tokens were spent. Ask me to change the heading (for example: set the heading to "Tasks") and I will read and edit src/home.tsx in this tab. SCRIPTED-PLAIN-DONE'

const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n') : ''

function parse(body: Json): Turn {
  const input: Json[] = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input ?? []
  let user = '', results: string[] = []
  for (const item of input) {
    const type = item.type ?? 'message'
    if (type === 'message' && item.role === 'user') {
      const text = textOf(item.content)
      // Clients wrap context in pseudo-XML user messages; those are not the prompt.
      if (!/^\s*<[a-zA-Z_-]+[ >]/.test(text)) { user = text; results = [] }
    } else if (type.endsWith('_call_output')) results.push(typeof item.output === 'string' ? item.output : textOf(item.output) || JSON.stringify(item.output ?? ''))
  }
  const tools = (body.tools ?? []).filter((tool: Json) => tool.type === 'function')
    .map((tool: Json): Tool => ({ name: tool.name, properties: Object.keys(tool.parameters?.properties ?? {}) }))
  return { model: body.model ?? '', user, results, tools }
}

/** A call of the offered tool, with the argument names its schema uses. */
function call(turn: Turn, name: string, known: Record<string, string>): Step['call'] {
  const tool = turn.tools.find(candidate => candidate.name === name)
  if (!tool) return undefined
  return { name, arguments: JSON.stringify(Object.fromEntries(Object.entries(known).filter(([key]) => tool.properties.includes(key)))) }
}

function next(turn: Turn): Step {
  // The server asks for a session title in a request of its own, without tools.
  if (!turn.tools.length) return { text: 'Scripted session' }
  if (!/\bheading\b/i.test(turn.user)) return { text: plain }
  const offered = `(offered: ${turn.tools.map(tool => tool.name).join(', ')})`
  if (turn.results.length === 0) {
    const read = call(turn, 'read', { filePath: file, file_path: file, path: file })
    return read ? { text: 'I will read `src/home.tsx` to find the heading.', call: read } : { text: `The heading script needs the read tool ${offered}.` }
  }
  if (turn.results.length === 1) {
    const old = /<h1>([^<]*)<\/h1>/.exec(turn.results[0]!)?.[1]
    if (old === undefined) return { text: `I could not find an <h1> in src/home.tsx. The read tool returned: ${turn.results[0]!.slice(0, 300)}` }
    const wanted = /"([^"\n]+)"/.exec(turn.user)?.[1] ?? `${old} (edited in the tab)`
    const before = `<h1>${old}</h1>`, after = `<h1>${wanted}</h1>`
    const edit = call(turn, 'edit', { filePath: file, file_path: file, path: file, oldString: before, old_string: before, newString: after, new_string: after })
    return edit ? { text: `The heading is "${old}". Changing it to "${wanted}".`, call: edit } : { text: `The heading script needs the edit tool ${offered}.` }
  }
  return { text: `Done. The edit tool answered: \`${turn.results[1]!.split('\n').find(line => line.trim())?.slice(0, 120) ?? ''}\`. The app beside this panel reloads by itself. SCRIPTED-EDIT-DONE` }
}

let serial = 0
const id = (prefix: string) => `${prefix}_scripted${(++serial).toString(36).padStart(6, '0')}`
const delay = Number(process.env.SCRIPTED_MODEL_DELAY_MS ?? 25)

function reply(turn: Turn, step: Step): Response {
  const usage = { input_tokens: Math.ceil(turn.user.length / 4) + 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: Math.ceil(step.text.length / 4) + 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 }
  usage.total_tokens = usage.input_tokens + usage.output_tokens
  const items: Json[] = [{ type: 'message', id: id('msg'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] }]
  if (step.call) items.push({ type: 'function_call', id: id('fc'), status: 'completed', call_id: id('call'), name: step.call.name, arguments: step.call.arguments })
  const base = { id: id('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), model: turn.model, output: [] as Json[], usage: null as Json | null }
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sequence = 0
      const send = async (type: string, data: Json) => {
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`))
        if (delay > 0) await Bun.sleep(delay)
      }
      try {
        await send('response.created', { response: { ...base, status: 'in_progress' } })
        await send('response.in_progress', { response: { ...base, status: 'in_progress' } })
        for (const [output_index, item] of items.entries()) {
          const item_id = item.id
          if (item.type === 'message') {
            await send('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', content: [] } })
            await send('response.content_part.added', { item_id, output_index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
            for (const delta of step.text.match(/\s*\S+\s*/g) ?? []) await send('response.output_text.delta', { item_id, output_index, content_index: 0, delta })
            await send('response.output_text.done', { item_id, output_index, content_index: 0, text: step.text })
            await send('response.content_part.done', { item_id, output_index, content_index: 0, part: item.content[0] })
          } else {
            await send('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', arguments: '' } })
            await send('response.function_call_arguments.delta', { item_id, output_index, delta: item.arguments })
            await send('response.function_call_arguments.done', { item_id, output_index, arguments: item.arguments })
          }
          await send('response.output_item.done', { output_index, item })
        }
        await send('response.completed', { response: { ...base, status: 'completed', output: items, usage } })
      } catch { /* the client went away */ }
      try { controller.close() } catch { /* already closed */ }
    },
  })
  return new Response(stream, { headers: { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}

/** What a browser needs from a model endpoint it calls directly. `*` is enough here: the
 * request carries no cookies (the key travels in `Authorization`, which the preflight names). */
const diagFile = process.env.DIAG_FILE ?? '/tmp/bat-terminal-diag.jsonl'
const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' }

const server = Bun.serve({
  hostname: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT) || 4311,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url), origin = request.headers.get('origin')
    if (request.method === 'OPTIONS') {
      const asked = request.headers.get('access-control-request-headers') ?? ''
      console.log(`[mock] preflight ${url.pathname} from ${origin}: method ${request.headers.get('access-control-request-method')}, headers [${asked}]`)
      return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': asked || '*', 'access-control-max-age': '600' } })
    }
    // The page's diagnostics (src/diag.ts): one JSON line per event.
    if (request.method === 'POST' && url.pathname === '/diag') {
      const events = await request.json().catch(() => []) as Json[]
      await appendFile(diagFile, events.map(event => JSON.stringify({ at: new Date().toISOString(), origin, ...event })).join('\n') + '\n')
      return new Response(null, { status: 204, headers: cors })
    }
    if (request.method !== 'POST' || !/\/responses$/.test(url.pathname)) return Response.json({ error: { message: `mock model: no handler for ${request.method} ${url.pathname}`, type: 'not_found' } }, { status: 404, headers: cors })
    const turn = parse(await request.json() as Json)
    const step = next(turn)
    const sent = [...request.headers.keys()].filter(name => !/^(host|connection|content-length|accept-encoding|accept-language|sec-|origin$|referer$|priority$)/.test(name))
    console.log(`[mock] ${url.pathname} from ${origin} "${turn.user.slice(0, 60).replaceAll('\n', ' ')}" results=${turn.results.length} tools=${turn.tools.length} -> ${step.call ? `${step.call.name} ${step.call.arguments.slice(0, 120)}` : 'text'}  (request headers: ${sent.join(', ')})`)
    return reply(turn, step)
  },
})
console.log(`Mock model at ${server.url}v1  (Responses API, CORS open)`)
