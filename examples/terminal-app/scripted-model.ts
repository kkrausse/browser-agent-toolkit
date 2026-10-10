// placeholder, replaced once the server's wire format is confirmed
import type { ModelCatalog } from '@kkrausse/browser-agent-toolkit/server'

export function scriptedCatalog(id: string, name: string): ModelCatalog {
  return { defaultModel: id, models: { [id]: {
    name, package: '@opencode/ai/providers/openai', websocket: false,
    capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 200000, output: 8192 },
  } } }
}

export async function scriptedModel(request: Request, path: string): Promise<Response> {
  console.log('[scripted]', request.method, path, (await request.text()).slice(0, 3000))
  return Response.json({ error: { message: 'not implemented' } }, { status: 400 })
}
