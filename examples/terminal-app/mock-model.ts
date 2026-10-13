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
//   contains "heading"   reads src/App.tsx, then replaces the text of its <h1> with the
//                        quoted text of the prompt (`set the heading to "Tasks"`), or with
//                        the old text plus " (edited in the tab)"; ends SCRIPTED-EDIT-DONE
//   contains "dark theme" the demo video's prompt (demo/run.ts): reads src/style.css and src/App.tsx,
//                        appends a dark, violet theme to the stylesheet and adds a count of
//                        the todos left under the list (three edits), with a pause before
//                        each step as if it thought; ends SCRIPTED-THEME-DONE
//   … and "theme-color" with MOCK_TODO=fullstack (examples/todo-fullstack, where the page is
//                        src/home.tsx): the same, plus the two edits that left the preview's
//                        input dead on 2026-10-11
//                        (docs/experiments/2026-10-11-preview-input-dead-after-edit-handoff.md):
//                        a <meta name="theme-color"> in src/root.tsx, the root route that
//                        renders <html>, and a rule in src/editor-panel.css. They come after
//                        the other three, or before them with "theme-color first"
//   starts "run `…`"     calls the shell tool with the command between the backquotes (the
//                        page's configuration does not allow it, so the client asks first)
//                        and repeats its output; ends SCRIPTED-SHELL-DONE
//   starts "count to N"  the numbers 1 to N as text, one streamed piece each (a reply long
//                        enough to stop, steer or queue behind); ends SCRIPTED-COUNT-DONE
//   "call <tool> {json}" calls that tool with exactly those arguments and repeats its
//                        answer; ends SCRIPTED-CALL-DONE. With the tool `subagent`
//                        (`{"agent":"general","description":"…","prompt":"…"}`) the prompt
//                        is itself answered by these scripts, in the child session
//   "demo markdown"      headings, lists, a code block, a table, a quote; ends SCRIPTED-MARKDOWN-DONE
//   "think <text>"       a streamed reasoning item, then the text; ends SCRIPTED-THINK-DONE
//   "flaky N <text>"     the first N requests are answered 503 (the client retries), then
//                        the text; ends SCRIPTED-FLAKY-DONE
//   "sequence" + lines   each further line is `say <text>` or `call <tool> {json}`: the calls
//                        are made one per step, in order, with the `say` lines before a call
//                        as that step's text; ends SCRIPTED-SEQUENCE-DONE
//   anything else        a paragraph of streamed text; ends SCRIPTED-PLAIN-DONE
//
// wasm-term's mock-llm (branch `wasm-term`; `?model=http://<host>:4791/v1&modelId=mock-model`) has more scripts,
// but its file scenarios write files of its own sample project, none that this preview shows.

import { appendFile } from 'node:fs/promises'
import { next, parse, reply, type Json } from './mock-script'

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
    console.log(`[mock] ${url.pathname} from ${origin} "${turn.user.slice(0, 60).replaceAll('\n', ' ')}" results=${turn.results.length} tools=${turn.tools.length}${turn.attachments.length ? ` attachments=[${turn.attachments.join(', ')}]` : ''} -> ${step.call ? `${step.call.name} ${step.call.arguments.slice(0, 120)}` : 'text'}  (request headers: ${sent.join(', ')})`)
    return reply(turn, step, cors)
  },
})
console.log(`Mock model at ${server.url}v1  (Responses API, CORS open)`)
