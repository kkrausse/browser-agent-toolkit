import type { ChatEndpoint } from './chat/types';

/** A native OpenCode session as its own export endpoint returns it: resumable, unlike a transcript. */
export interface SessionBundle {
  info: { id: string; parentID?: string } & Record<string, unknown>;
  messages: Record<string, unknown>[];
}

function parseBundle(input: unknown): SessionBundle {
  const bundle = input as { info?: { id?: unknown; parentID?: unknown }; messages?: unknown } | null;
  if (!bundle || typeof bundle !== 'object' || !bundle.info || typeof bundle.info.id !== 'string' || !bundle.info.id
    || !Array.isArray(bundle.messages) || bundle.messages.some(message => !message || typeof message !== 'object'))
    throw Error('Invalid native session bundle');
  if (bundle.info.parentID != null && typeof bundle.info.parentID !== 'string') throw Error('Invalid native session parent');
  const { parentID, ...info } = bundle.info as SessionBundle['info'];
  return { info: { ...info, ...(parentID ? { parentID } : {}) }, messages: bundle.messages as Record<string, unknown>[] };
}

/** Parents before children; rejects duplicates, cycles and missing parents. */
export function orderSessions(sessions: SessionBundle[]): SessionBundle[] {
  const byId = new Map(sessions.map(session => [session.info.id, session]));
  if (byId.size !== sessions.length) throw Error('Duplicate saved session ID');
  const ordered: SessionBundle[] = [], visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw Error('Cyclic saved session hierarchy');
    const session = byId.get(id);
    if (!session) throw Error('Missing saved parent session: ' + id);
    visiting.add(id);
    if (session.info.parentID) visit(session.info.parentID);
    visiting.delete(id); visited.add(id); ordered.push(session);
  }
  for (const session of sessions) visit(session.info.id);
  return ordered;
}

async function request(endpoint: ChatEndpoint, path: string, init?: RequestInit): Promise<any> {
  const response = await endpoint.fetch(path, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) { await response.arrayBuffer(); throw Error(`Native session transfer ${path.split('?')[0]}: HTTP ${response.status}`); }
  return response.json();
}

type SessionPage = { data: { id: string }[]; cursor?: { next?: string | null } | null };
const listPath = (directory: string, cursor?: string) =>
  `/api/session?${new URLSearchParams({ directory, limit: '100', ...(cursor ? { cursor } : {}) })}`;

/** Every session of the directory, as resumable bundles, parents first. */
export async function exportSessions(endpoint: ChatEndpoint, directory: string): Promise<SessionBundle[]> {
  const sessions: SessionBundle[] = [], ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page: SessionPage = await request(endpoint, listPath(directory, cursor));
    for (const { id } of page.data) {
      if (ids.has(id)) throw Error('Repeated session in native export pagination');
      ids.add(id);
      sessions.push(parseBundle((await request(endpoint, `/api/session/${encodeURIComponent(id)}/export`)).data));
    }
    // The server sends null for exhausted pagination cursors.
    cursor = page.cursor?.next ?? undefined;
    if (ids.size > 10_000) throw Error('Too many sessions to save');
  } while (cursor);
  return orderSessions(sessions);
}

/** Replace the directory's sessions with the bundles. Resolves with saved ID → imported ID
 * (the same, unless an ID is still taken outside this directory). No chat client may be
 * mid-run: hold the chat first. */
export async function importSessions(endpoint: ChatEndpoint, directory: string, input: unknown[]): Promise<Map<string, string>> {
  const sessions = orderSessions(input.map(parseBundle));
  for (let attempt = 0; ; attempt++) {
    const page: SessionPage = await request(endpoint, listPath(directory));
    if (!page.data.length) break;
    if (attempt >= 100) throw Error('Could not empty replacement session store');
    for (const { id } of page.data) {
      const response = await endpoint.fetch(`/api/session/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) });
      await response.arrayBuffer();
      if (!response.ok && response.status !== 404) throw Error('Could not delete outgoing native session');
    }
  }
  // Keep the saved IDs: the store was just emptied, and OpenCode accepts an import
  // under a deleted session's ID (checked against 2.0.3), so anything that names a
  // session stays valid. The session list is ordered by update time, which an import
  // sets to now: import in reverse of the saved list order, parents still first, and
  // the list reads as it was saved.
  const ids = new Map<string, string>();
  for (const session of orderSessions([...sessions].reverse())) {
    const parentID = session.info.parentID ? ids.get(session.info.parentID) : undefined;
    const transfer = (id: string) => request(endpoint, '/api/session/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...session, info: { ...session.info, id, ...(parentID ? { parentID } : {}) }, location: { directory } }),
    });
    let id = session.info.id;
    // An ID still taken outside this directory's list cannot be emptied here.
    const result = await transfer(id).catch(error => {
      if (!String(error).includes('HTTP 409')) throw error;
      return transfer(id = 'ses_' + crypto.randomUUID().replaceAll('-', ''));
    });
    if (result?.data?.id !== id) throw Error('Native session import returned unexpected ID');
    await request(endpoint, `/api/session/${encodeURIComponent(id)}/message?order=desc&limit=50`);
    ids.set(session.info.id, id);
  }
  return ids;
}
