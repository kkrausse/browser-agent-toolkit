(() => {
  // mock-script.ts
  var env = globalThis.process?.env ?? {};
  var fullstack = env.MOCK_TODO === "fullstack";
  var page = fullstack ? "src/home.tsx" : "src/App.tsx";
  var file = `/workspace/${page}`;
  var plain = `Hello from the scripted model. This reply is streamed in small pieces by a mock on another origin that this tab fetched directly; no model was called and no tokens were spent. Ask me to change the heading (for example: set the heading to "Tasks") and I will read and edit ${page} in this tab. SCRIPTED-PLAIN-DONE`;
  var sheet = "/workspace/src/style.css";
  var lastRule = "li label { overflow-wrap: anywhere; min-width: 0; }";
  var theme = `${lastRule}

:root { --accent: #8b5cf6; color-scheme: dark; }
html, body { background: #14121c; color: #e7e3f4; }
h1 { color: var(--accent); }
input:not([type="checkbox"]) { background: #1f1b2e; color: inherit; border-color: #3b3357; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
input[type="checkbox"] { accent-color: var(--accent); }
button { background: var(--accent); color: white; border-color: var(--accent); cursor: pointer; }
li { padding: .6rem .8rem; background: #1f1b2e; border: 1px solid #3b3357; border-radius: .5rem; }
.left { color: #a78bfa; }`;
  var titleLine = `  const [title, setTitle] = useState('')
`;
  var errorLine = `  const error = todos.error ?? add.error ?? complete.error ?? remove.error
`;
  var listEnd = `      </ul>
    </main>`;
  var baseEdits = [
    { file: sheet, say: "The stylesheet is small and plain. I will add a dark palette with a violet accent after its last rule.", before: lastRule, after: theme },
    fullstack ? { file, say: "Now the count. First a value for the todos that are not done.", before: errorLine, after: `${errorLine}  const left = todos.data?.filter((todo) => !todo.completed).length ?? 0
` } : { file, say: "Now the count. First a value for the todos that are not done.", before: titleLine, after: `${titleLine}  const left = todos.filter((todo) => !todo.completed).length
` },
    { file, say: "And a line under the list that shows it.", before: listEnd, after: `      </ul>
      <p className="left">{left} {left === 1 ? 'todo' : 'todos'} left</p>
    </main>` }
  ];
  var root = "/workspace/src/root.tsx";
  var panelSheet = "/workspace/src/editor-panel.css";
  var viewport = `        <meta name="viewport" content="width=device-width, initial-scale=1" />
`;
  var panelRule = ".todo-editor-panel summary{cursor:pointer}";
  var rootEdits = [
    { file: root, say: "The browser chrome should match: a theme-color in the document head.", before: viewport, after: `${viewport}        <meta name="theme-color" content="#14121c" />
` },
    { file: panelSheet, say: "And the editor panel gets the accent.", before: panelRule, after: `${panelRule}
.todo-editor-panel>header{border-color:#8b5cf6}` }
  ];
  function themeStep(turn, offered) {
    const done = turn.results.length, pauseMs = 1200;
    const withRoot = fullstack && /theme-color/i.test(turn.user);
    const themeEdits = !withRoot ? baseEdits : /theme-color first/i.test(turn.user) ? [...rootEdits, ...baseEdits] : [...baseEdits, ...rootEdits];
    const reads = [[sheet, "I will look at the stylesheet first."], [file, "Then the page that draws the list."]];
    if (done < reads.length) {
      const [path, text] = reads[done];
      const read = call(turn, "read", { filePath: path, file_path: path, path });
      return read ? { text, call: read, pauseMs } : { text: `The theme script needs the read tool ${offered}.` };
    }
    const change = themeEdits[done - reads.length];
    if (!change)
      return { text: "Done. The app is dark with a violet accent, and the number of todos left is shown under the list. The preview beside this panel updated by itself. SCRIPTED-THEME-DONE", pauseMs };
    const edit = call(turn, "edit", { filePath: change.file, file_path: change.file, path: change.file, oldString: change.before, old_string: change.before, newString: change.after, new_string: change.after });
    return edit ? { text: change.say, call: edit, pauseMs: 2200 } : { text: `The theme script needs the edit tool ${offered}.` };
  }
  var textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join(`
`) : "";
  function parse(body) {
    const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input ?? [];
    let user = "", results = [];
    for (const item of input) {
      const type = item.type ?? "message";
      if (type === "message" && item.role === "user") {
        const text = textOf(item.content);
        if (!/^\s*<[a-zA-Z_-]+[ >]/.test(text)) {
          user = text;
          results = [];
        }
      } else if (type.endsWith("_call_output"))
        results.push(typeof item.output === "string" ? item.output : textOf(item.output) || JSON.stringify(item.output ?? ""));
    }
    const tools = (body.tools ?? []).filter((tool) => tool.type === "function").map((tool) => ({ name: tool.name, properties: Object.keys(tool.parameters?.properties ?? {}) }));
    return { model: body.model ?? "", user, results, tools };
  }
  function call(turn, name, known) {
    const tool = turn.tools.find((candidate) => candidate.name === name);
    if (!tool)
      return;
    return { name, arguments: JSON.stringify(Object.fromEntries(Object.entries(known).filter(([key]) => tool.properties.includes(key)))) };
  }
  function next(turn) {
    if (!turn.tools.length)
      return { text: "Scripted session" };
    const offered = `(offered: ${turn.tools.map((tool) => tool.name).join(", ")})`;
    const command = /^run `([^`\n]+)`/i.exec(turn.user)?.[1];
    if (command) {
      if (turn.results.length)
        return { text: `The shell tool answered: ${turn.results[0].trim().slice(0, 300)} SCRIPTED-SHELL-DONE` };
      const shell = call(turn, "shell", { command });
      return shell ? { text: `Running \`${command}\`.`, call: shell } : { text: `The run script needs the shell tool ${offered}.` };
    }
    if (/\bdark theme\b/i.test(turn.user))
      return themeStep(turn, offered);
    if (!/\bheading\b/i.test(turn.user))
      return { text: plain };
    if (turn.results.length === 0) {
      const read = call(turn, "read", { filePath: file, file_path: file, path: file });
      return read ? { text: `I will read \`${page}\` to find the heading.`, call: read } : { text: `The heading script needs the read tool ${offered}.` };
    }
    if (turn.results.length === 1) {
      const old = /<h1>([^<]*)<\/h1>/.exec(turn.results[0])?.[1];
      if (old === undefined)
        return { text: `I could not find an <h1> in ${page}. The read tool returned: ${turn.results[0].slice(0, 300)}` };
      const wanted = /"([^"\n]+)"/.exec(turn.user)?.[1] ?? `${old} (edited in the tab)`;
      const before = `<h1>${old}</h1>`, after = `<h1>${wanted}</h1>`;
      const edit = call(turn, "edit", { filePath: file, file_path: file, path: file, oldString: before, old_string: before, newString: after, new_string: after });
      return edit ? { text: `The heading is "${old}". Changing it to "${wanted}".`, call: edit } : { text: `The heading script needs the edit tool ${offered}.` };
    }
    return { text: `Done. The edit tool answered: \`${turn.results[1].split(`
`).find((line) => line.trim())?.slice(0, 120) ?? ""}\`. The app beside this panel reloads by itself. SCRIPTED-EDIT-DONE` };
  }
  var serial = 0;
  var id = (prefix) => `${prefix}_scripted${(++serial).toString(36).padStart(6, "0")}`;
  var delay = Number(env.SCRIPTED_MODEL_DELAY_MS ?? 25);
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function reply(turn, step, headers = {}) {
    const usage = { input_tokens: Math.ceil(turn.user.length / 4) + 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: Math.ceil(step.text.length / 4) + 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
    const items = [{ type: "message", id: id("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: step.text, annotations: [] }] }];
    if (step.call)
      items.push({ type: "function_call", id: id("fc"), status: "completed", call_id: id("call"), name: step.call.name, arguments: step.call.arguments });
    const base = { id: id("resp"), object: "response", created_at: Math.floor(Date.now() / 1000), model: turn.model, output: [], usage: null };
    const encoder = new TextEncoder;
    const stream = new ReadableStream({
      async start(controller) {
        let sequence = 0;
        const send = async (type, data) => {
          controller.enqueue(encoder.encode(`event: ${type}
data: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}

`));
          if (delay > 0)
            await sleep(delay);
        };
        try {
          if (step.pauseMs)
            await sleep(step.pauseMs);
          await send("response.created", { response: { ...base, status: "in_progress" } });
          await send("response.in_progress", { response: { ...base, status: "in_progress" } });
          for (const [output_index, item] of items.entries()) {
            const item_id = item.id;
            if (item.type === "message") {
              await send("response.output_item.added", { output_index, item: { ...item, status: "in_progress", content: [] } });
              await send("response.content_part.added", { item_id, output_index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
              for (const delta of step.text.match(/\s*\S+\s*/g) ?? [])
                await send("response.output_text.delta", { item_id, output_index, content_index: 0, delta });
              await send("response.output_text.done", { item_id, output_index, content_index: 0, text: step.text });
              await send("response.content_part.done", { item_id, output_index, content_index: 0, part: item.content[0] });
            } else {
              await send("response.output_item.added", { output_index, item: { ...item, status: "in_progress", arguments: "" } });
              await send("response.function_call_arguments.delta", { item_id, output_index, delta: item.arguments });
              await send("response.function_call_arguments.done", { item_id, output_index, arguments: item.arguments });
            }
            await send("response.output_item.done", { output_index, item });
          }
          await send("response.completed", { response: { ...base, status: "completed", output: items, usage } });
        } catch {}
        try {
          controller.close();
        } catch {}
      }
    });
    return new Response(stream, { headers: { ...headers, "content-type": "text/event-stream", "cache-control": "no-store" } });
  }

  // sw.ts
  var worker = self;
  var scope = new URL(worker.registration.scope);
  var preview = `${scope.pathname}preview/`;
  var mock = `${scope.pathname}mock/`;
  worker.importScripts(new URL("editor/runtime/sw.js", scope).href);
  var gzipped = new Set(["display/display.js", "display/ghostty-vt.wasm", "editor/image-27cd8dcda44aa075.batimg", "editor/image-09dca18d6a0d3d59.batimg", "editor/program-opencode-server-0e047e0ceef29226.js", "editor/derived-13d3de04172f5760.json", "editor/manifest.json", "editor/runtime/bat-process.js", "editor/runtime/bat-nodelib.js", "editor/runtime/bat-kerneld.js", "editor/runtime/bat_modules.wasm", "editor/runtime/bat_node_native.wasm", "editor/runtime/bat_sh.wasm", "editor/runtime/host.js", "editor/runtime/bat-netd.js", "editor/runtime/kernel.wasm", "editor/runtime/sqlite3.wasm", "editor/runtime/bat_tls.wasm", "editor/program-start-preview-56b514284aa04db4.js"]);
  var isolation = [
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Embedder-Policy", "require-corp"],
    ["Cross-Origin-Resource-Policy", "same-origin"]
  ];
  var types = { js: "text/javascript", mjs: "text/javascript", wasm: "application/wasm", json: "application/json", map: "application/json", scm: "text/plain; charset=utf-8" };
  var hashed = /-[0-9a-f]{16}\./;
  async function serve(request, url) {
    let path = url.pathname.slice(scope.pathname.length);
    try {
      path = decodeURIComponent(path);
    } catch {}
    if (gzipped.has(path)) {
      const response2 = await fetch(`${url.origin}${url.pathname}.gz`, { cache: hashed.test(path) ? "default" : "no-cache", signal: request.signal });
      if (!response2.ok || !response2.body)
        return new Response(`${path}.gz: HTTP ${response2.status}`, { status: response2.status || 502, headers: isolation });
      const headers2 = new Headers(isolation);
      headers2.set("Content-Type", types[path.slice(path.lastIndexOf(".") + 1)] ?? "application/octet-stream");
      const modified = response2.headers.get("last-modified");
      if (modified)
        headers2.set("Last-Modified", modified);
      return new Response(request.method === "HEAD" ? null : response2.body.pipeThrough(new DecompressionStream("gzip")), { headers: headers2 });
    }
    const response = await (request.mode === "navigate" ? fetch(request) : fetch(url.href, { method: request.method, headers: request.headers, cache: hashed.test(path) ? "default" : "no-cache", signal: request.signal }));
    if (response.status === 0)
      return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of isolation)
      headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  worker.addEventListener("fetch", (event) => {
    const request = event.request, url = new URL(request.url);
    if (url.origin === scope.origin && url.pathname.startsWith(mock)) {
      event.respondWith(request.method === "POST" && url.pathname.endsWith("/responses") ? request.json().then((body) => {
        const turn = parse(body);
        return reply(turn, next(turn));
      }, (error) => Response.json({ error: { message: `mock model: ${error}` } }, { status: 400 })) : Promise.resolve(Response.json({ error: { message: `mock model: no handler for ${request.method} ${url.pathname}`, type: "not_found" } }, { status: 404 })));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return;
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname) || url.pathname.startsWith(preview))
      return;
    if (request.referrer.startsWith(scope.origin + preview))
      return;
    event.respondWith(serve(request, url));
  });
})();
