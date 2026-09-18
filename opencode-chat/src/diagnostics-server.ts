import { appendFile, mkdir, rename, stat, watch } from 'node:fs/promises';
import { join } from 'node:path';
import { boundDiagnostic, sanitizeDiagnostic, type ControllerDiagnosticEvent, type DiagnosticBatch } from '@kev-browser-agent-kit/workspace/diagnostics';

export type DiagnosticContext = { actorId?: string };
export type StoredEditorDiagnostic = ControllerDiagnosticEvent & { id: string; clientId: string; actorId: string; receivedAt: string };
export type EditorDiagnosticSink = {
  /** Opt in on the server; the prepared editor discovers this setting automatically. */
  enabled?: boolean;
  write(batch: DiagnosticBatch, context: DiagnosticContext): Promise<void>;
  read?(): Promise<StoredEditorDiagnostic[]>;
};
const noStore = { 'Cache-Control': 'no-store' };
const identifier = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && /^[\w.-]+$/.test(value);

/** Called only after the application authorizes the editor request. */
export async function handleDiagnosticRequest(request: Request, sink: EditorDiagnosticSink | undefined, context: DiagnosticContext): Promise<Response> {
  if (!sink?.enabled) return request.method === 'POST' ? new Response(null, { status: 204, headers: noStore }) : Response.json([], { headers: noStore });
  if (request.method === 'GET') return Response.json(await sink.read?.() ?? [], { headers: noStore });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: noStore });
  const reader = request.body?.getReader();
  if (!reader) return new Response('Missing diagnostic batch', { status: 400, headers: noStore });
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) { void reader.cancel().catch(() => {}); return new Response('Diagnostic batch too large', { status: 413, headers: noStore }); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch { return new Response('Invalid diagnostic body', { status: 400, headers: noStore }); }
  finally { reader.releaseLock(); }
  let batch: DiagnosticBatch;
  try {
    const input = JSON.parse(text);
    if (!identifier(input.clientId) || !Array.isArray(input.events) || !input.events.length || input.events.length > 50) throw Error('Invalid batch');
    const events = input.events.map((event: ControllerDiagnosticEvent) => {
      if (!event || !identifier(event.runId) || !identifier(event.event, 100) || typeof event.time !== 'string' || event.time.length > 40 || !Number.isFinite(Date.parse(event.time))
        || (event.id !== undefined && !identifier(event.id))) throw Error('Invalid event');
      // Never accept actor/server metadata supplied by a browser.
      return boundDiagnostic({ id: event.id, runId: event.runId, time: event.time, event: event.event, data: event.data });
    });
    batch = { clientId: input.clientId, events };
  } catch { return new Response('Invalid diagnostic batch', { status: 400, headers: noStore }); }
  try { await sink.write(batch, context); }
  catch { return new Response('Diagnostic sink unavailable', { status: 503, headers: noStore }); }
  return new Response(null, { status: 204, headers: noStore });
}

/** Optional local storage adapter. The application chooses the directory and retention. */
export function createFileDiagnosticSink(options: { directory: string; enabled?: boolean; maxFileBytes?: number }): EditorDiagnosticSink & { read(limit?: number): Promise<StoredEditorDiagnostic[]> } {
  const file = join(options.directory, 'events.jsonl');
  const maximum = Math.max(65536, options.maxFileBytes ?? 1024 * 1024);
  const seen = new Set<string>();
  let pending = Promise.resolve();
  return {
    enabled: options.enabled ?? true,
    write(batch, context) {
      if (options.enabled === false || !batch.events.length) return Promise.resolve();
      const records = batch.events.map(event => ({ ...boundDiagnostic(event), clientId: batch.clientId, actorId: context.actorId ?? 'server', receivedAt: new Date().toISOString() } as StoredEditorDiagnostic));
      const write = pending.then(async () => {
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        let size = await stat(file).then(info => info.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
        for (const record of records) {
          const key = `${record.actorId}/${record.clientId}/${record.id}`;
          if (seen.has(key)) continue;
          const text = JSON.stringify(record) + '\n', bytes = Buffer.byteLength(text);
          if (size && size + bytes > maximum) { await rename(file, file + '.1'); size = 0; }
          await appendFile(file, text, { mode: 0o600 }); size += bytes;
          seen.add(key);
          while (seen.size > 4000) seen.delete(seen.values().next().value!);
        }
      });
      pending = write.catch(() => {});
      return write;
    },
    async read(limit: number = 200) { await pending; return readEditorDiagnostics(options.directory, limit); },
  };
}

export async function readEditorDiagnostics(directory: string, limit = 200): Promise<StoredEditorDiagnostic[]> {
  const events: StoredEditorDiagnostic[] = [];
  for (const name of ['events.jsonl.1', 'events.jsonl']) {
    const file = Bun.file(join(directory, name));
    if (!await file.exists()) continue;
    for (const line of (await file.text()).split('\n')) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* An append may still be in flight. */ }
    }
  }
  return events.slice(-Math.min(10000, Math.max(1, limit)));
}

/** Error responses only; bounded by bytes and time, without consuming the proxy's response. */
export async function editorModelError(response: Response): Promise<unknown> {
  if (response.ok || !response.body) return undefined;
  const reader = response.clone().body!.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Error body timed out')), 2000); });
  try {
    while (bytes < 6000) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      text += decoder.decode(value.subarray(0, 6000 - bytes), { stream: true }); bytes += value.length;
    }
    text += decoder.decode();
    try { const parsed = JSON.parse(text); return sanitizeDiagnostic(parsed.error ?? parsed); }
    catch { return sanitizeDiagnostic(text); }
  } catch { return text ? sanitizeDiagnostic(text) : '[error response body unavailable]'; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function formatEditorDiagnostic(event: StoredEditorDiagnostic): string {
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : undefined;
  const detail = /(?:guest|host)\.output$/.test(event.event) && typeof data?.message === 'string'
    ? `[${String(data.label ?? 'process')}]\n${data.message.trimEnd()}` : JSON.stringify(event.data ?? null);
  return `${event.receivedAt} [${event.clientId.slice(0, 8)}/${event.runId.slice(0, 8)}] ${event.event} ${detail}`;
}

/** Application CLI hook: bun editor:logs [--follow] [--json] [--run ID] [--event PREFIX]. */
export async function runEditorLogs(options: { directory: string; args?: string[] }): Promise<void> {
  const args = options.args ?? process.argv.slice(2);
  if (args.includes('--help')) { console.log('editor:logs [--follow] [--json] [--run ID] [--event PREFIX]\n' + options.directory); return; }
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const seen = new Set<string>(), run = value('--run'), eventPrefix = value('--event');
  const print = async () => {
    for (const event of await readEditorDiagnostics(options.directory, 10000)) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (run && !event.runId.startsWith(run) || eventPrefix && !event.event.startsWith(eventPrefix)) continue;
      console.log(args.includes('--json') ? JSON.stringify(event) : formatEditorDiagnostic(event));
    }
    while (seen.size > 20000) seen.delete(seen.values().next().value!);
  };
  if (args.includes('--follow')) {
    await mkdir(options.directory, { recursive: true });
    const watcher = watch(options.directory);
    console.error(`Following ${join(options.directory, 'events.jsonl')}`);
    await print();
    for await (const _event of watcher) await print();
  } else {
    await print();
    if (!seen.size) console.error(`No editor diagnostics yet. Storage: ${options.directory}`);
  }
}
