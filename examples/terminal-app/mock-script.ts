// The scripted model's logic, without a server around it: what a Responses API request is
// answered with. `mock-model.ts` serves it from Bun on an origin of its own; the page's
// service worker (`sw.ts`) serves it at `<page>/mock/v1/` for `?mock=1`, a model that needs
// no network at all. The scripts are described at the head of `mock-model.ts`.
export type Json = Record<string, any>
interface Tool { name: string; properties: string[] }
export interface Turn { model: string; user: string; results: string[]; tools: Tool[] }
export interface Step { text: string; call?: { name: string; arguments: string }; pauseMs?: number }

// MOCK_TODO=fullstack: the scripts edit examples/todo-fullstack (React Router, src/home.tsx)
// instead of the plain TODO app (src/App.tsx).
// Read from the environment where there is one (Bun); in a service worker it is the plain app.
const env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
const fullstack = env.MOCK_TODO === 'fullstack'
const page = fullstack ? 'src/home.tsx' : 'src/App.tsx'
const file = `/workspace/${page}`
const plain = `Hello from the scripted model. This reply is streamed in small pieces by a mock on another origin that this tab fetched directly; no model was called and no tokens were spent. Ask me to change the heading (for example: set the heading to "Tasks") and I will read and edit ${page} in this tab. SCRIPTED-PLAIN-DONE`

// The theme script: what it reads and the three edits it makes, each an exact replacement in
// the TODO app's source as it is shipped. The rules are appended, since the stylesheet's
// later `border: 1px solid` would reset a border colour set above it.
const sheet = '/workspace/src/style.css'
const lastRule = 'li label { overflow-wrap: anywhere; min-width: 0; }'
const theme = `${lastRule}

:root { --accent: #8b5cf6; color-scheme: dark; }
html, body { background: #14121c; color: #e7e3f4; }
h1 { color: var(--accent); }
input:not([type="checkbox"]) { background: #1f1b2e; color: inherit; border-color: #3b3357; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
input[type="checkbox"] { accent-color: var(--accent); }
button { background: var(--accent); color: white; border-color: var(--accent); cursor: pointer; }
li { padding: .6rem .8rem; background: #1f1b2e; border: 1px solid #3b3357; border-radius: .5rem; }
.left { color: #a78bfa; }`
const titleLine = "  const [title, setTitle] = useState('')\n"
const errorLine = '  const error = todos.error ?? add.error ?? complete.error ?? remove.error\n'
const listEnd = '      </ul>\n    </main>'
const baseEdits: { file: string; say: string; before: string; after: string }[] = [
  { file: sheet, say: 'The stylesheet is small and plain. I will add a dark palette with a violet accent after its last rule.', before: lastRule, after: theme },
  fullstack
    ? { file, say: 'Now the count. First a value for the todos that are not done.', before: errorLine, after: `${errorLine}  const left = todos.data?.filter((todo) => !todo.completed).length ?? 0\n` }
    : { file, say: 'Now the count. First a value for the todos that are not done.', before: titleLine, after: `${titleLine}  const left = todos.filter((todo) => !todo.completed).length\n` },
  { file, say: 'And a line under the list that shows it.', before: listEnd, after: `      </ul>\n      <p className="left">{left} {left === 1 ? 'todo' : 'todos'} left</p>\n    </main>` },
]

// The root-layout variant, full-stack app only: what one real model also did, and what broke the preview.
const root = '/workspace/src/root.tsx', panelSheet = '/workspace/src/editor-panel.css'
const viewport = '        <meta name="viewport" content="width=device-width, initial-scale=1" />\n'
const panelRule = '.todo-editor-panel summary{cursor:pointer}'
const rootEdits: typeof baseEdits = [
  { file: root, say: 'The browser chrome should match: a theme-color in the document head.', before: viewport, after: `${viewport}        <meta name="theme-color" content="#14121c" />\n` },
  { file: panelSheet, say: 'And the editor panel gets the accent.', before: panelRule, after: `${panelRule}\n.todo-editor-panel>header{border-color:#8b5cf6}` },
]

function themeStep(turn: Turn, offered: string): Step {
  const done = turn.results.length, pauseMs = 1200
  const withRoot = fullstack && /theme-color/i.test(turn.user)
  const themeEdits = !withRoot ? baseEdits : /theme-color first/i.test(turn.user) ? [...rootEdits, ...baseEdits] : [...baseEdits, ...rootEdits]
  const reads = [[sheet, 'I will look at the stylesheet first.'], [file, 'Then the page that draws the list.']] as const
  if (done < reads.length) {
    const [path, text] = reads[done]!
    const read = call(turn, 'read', { filePath: path, file_path: path, path })
    return read ? { text, call: read, pauseMs } : { text: `The theme script needs the read tool ${offered}.` }
  }
  const change = themeEdits[done - reads.length]
  if (!change) return { text: 'Done. The app is dark with a violet accent, and the number of todos left is shown under the list. The preview beside this panel updated by itself. SCRIPTED-THEME-DONE', pauseMs }
  const edit = call(turn, 'edit', { filePath: change.file, file_path: change.file, path: change.file, oldString: change.before, old_string: change.before, newString: change.after, new_string: change.after })
  return edit ? { text: change.say, call: edit, pauseMs: 2200 } : { text: `The theme script needs the edit tool ${offered}.` }
}

const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n') : ''

export function parse(body: Json): Turn {
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

export function next(input: Turn): Step {
  // The server asks for a session title in a request of its own, without tools.
  if (!input.tools.length) return { text: 'Scripted session' }
  // A subagent's prompt is the delegated one under this line: the same scripts apply to it.
  const turn = { ...input, user: input.user.replace(/^You are a subagent spawned by another session\.\n/, '') }
  const offered = `(offered: ${turn.tools.map(tool => tool.name).join(', ')})`
  const counted = /^count to (\d+)/i.exec(turn.user)
  if (counted) return { text: `${Array.from({ length: Math.min(Number(counted[1]), 5000) }, (_, index) => index + 1).join(' ')} SCRIPTED-COUNT-DONE` }
  const direct = /^call (\w+) (\{[\s\S]*\})\s*$/i.exec(turn.user)
  if (direct) {
    const [, name, json] = direct
    if (turn.results.length) return { text: `The ${name} tool answered: ${turn.results[0]!.trim().slice(0, 300)} SCRIPTED-CALL-DONE` }
    if (!turn.tools.some(tool => tool.name === name)) return { text: `The call script needs the ${name} tool ${offered}.` }
    try { JSON.parse(json!) } catch { return { text: `The call script needs JSON arguments; got ${json}` } }
    return { text: `Calling ${name}.`, call: { name: name!, arguments: json! } }
  }
  const command = /^run `([^`\n]+)`/i.exec(turn.user)?.[1]
  if (command) {
    if (turn.results.length) return { text: `The shell tool answered: ${turn.results[0]!.trim().slice(0, 300)} SCRIPTED-SHELL-DONE` }
    const shell = call(turn, 'shell', { command })
    return shell ? { text: `Running \`${command}\`.`, call: shell } : { text: `The run script needs the shell tool ${offered}.` }
  }
  if (/\bdark theme\b/i.test(turn.user)) return themeStep(turn, offered)
  if (!/\bheading\b/i.test(turn.user)) return { text: plain }
  if (turn.results.length === 0) {
    const read = call(turn, 'read', { filePath: file, file_path: file, path: file })
    return read ? { text: `I will read \`${page}\` to find the heading.`, call: read } : { text: `The heading script needs the read tool ${offered}.` }
  }
  if (turn.results.length === 1) {
    const old = /<h1>([^<]*)<\/h1>/.exec(turn.results[0]!)?.[1]
    if (old === undefined) return { text: `I could not find an <h1> in ${page}. The read tool returned: ${turn.results[0]!.slice(0, 300)}` }
    const wanted = /"([^"\n]+)"/.exec(turn.user)?.[1] ?? `${old} (edited in the tab)`
    const before = `<h1>${old}</h1>`, after = `<h1>${wanted}</h1>`
    const edit = call(turn, 'edit', { filePath: file, file_path: file, path: file, oldString: before, old_string: before, newString: after, new_string: after })
    return edit ? { text: `The heading is "${old}". Changing it to "${wanted}".`, call: edit } : { text: `The heading script needs the edit tool ${offered}.` }
  }
  return { text: `Done. The edit tool answered: \`${turn.results[1]!.split('\n').find(line => line.trim())?.slice(0, 120) ?? ''}\`. The app beside this panel reloads by itself. SCRIPTED-EDIT-DONE` }
}

let serial = 0
const id = (prefix: string) => `${prefix}_scripted${(++serial).toString(36).padStart(6, '0')}`
const delay = Number(env.SCRIPTED_MODEL_DELAY_MS ?? 25)
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** The step as a streamed Responses API answer; `headers` are the endpoint's own (CORS, where it is another origin). */
export function reply(turn: Turn, step: Step, headers: Record<string, string> = {}): Response {
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
        if (delay > 0) await sleep(delay)
      }
      try {
        if (step.pauseMs) await sleep(step.pauseMs)
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
  return new Response(stream, { headers: { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}
