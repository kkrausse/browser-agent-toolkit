// Experiment-only wire checks for the frozen packaged OpenCode 2.0.3 routes.
// SDK adapters unwrap some {data} responses; raw endpoint.fetch never does.
const check = (value: unknown, message: string) => { if (!value) throw Error('Pilot contract: '+message); };
const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function pilotSession(body: any) {
  check(object(body) && object(body.data) && !body._tag && !body.error, 'session data envelope');
  const session = body.data;
  check(typeof session.id === 'string' && typeof session.projectID === 'string' && object(session.location) && typeof session.location.directory === 'string', 'session identity/location');
  check(object(session.time) && typeof session.time.created === 'number' && typeof session.time.updated === 'number' && typeof session.cost === 'number' && object(session.tokens), 'session details');
  return session;
}
export function assertPilotRoot(body: any, id: string) {
  const session = pilotSession(body);
  check(session.id === id && session.location.directory === '/workspace' && session.location.workspaceID === undefined && session.parentID === undefined && session.fork === undefined, 'root explicit location');
  check(session.model === undefined && session.permissions === undefined && session.metadata === undefined, 'no inherited settings');
  return session;
}
export function validatePilotResponse(path: string, method: string, status: number, text: string) {
  const route = new URL(path, 'http://offline').pathname;
  check(status >= 200 && status < 300, 'HTTP '+status);
  if (route === '/api/plugin/await-activation' || (route === '/api/debug/location' && method === 'DELETE')) {
    check(status === 204 && text === '', '204 no content '+route); return;
  }
  const body = JSON.parse(text);
  check(!body?._tag && !body?.error, 'error is not success data');
  if (route === '/api/health') check(body.healthy === true && body.version === '2.0.3' && Number.isInteger(body.pid), 'health');
  else if (route === '/api/config') check(Array.isArray(body) && body.every((entry: any) => typeof entry.type === 'string'), 'config bare entries');
  else if (route === '/api/project/current') check(object(body) && ['id','directory','canonical'].every(key=>typeof body[key]==='string'), 'project bare identity');
  else if (route === '/api/debug/location') check(Array.isArray(body) && body.every((ref:any)=>typeof ref.directory === 'string'), 'location bare refs');
  else if (route === '/api/session/active') check(object(body.data) && Object.values(body.data).every((active:any)=>active.type === 'running'), 'active data record');
  else if (/^\/api\/session\/[^/]+\/interrupt$/.test(route)) check(typeof body.interrupted === 'boolean', 'interrupt bare result');
  else if ((route === '/api/session' && method === 'POST') || /^\/api\/session\/[^/]+$/.test(route)) pilotSession(body);
  else if ((route === '/api/session' && method === 'GET') || /\/message$/.test(route)) check(Array.isArray(body.data) && object(body.cursor) && ['next','previous'].every(key=>body.cursor[key] === undefined || body.cursor[key] === null || typeof body.cursor[key] === 'string'), 'paged data/cursor');
  else if (/\/(permission|form)$/.test(route)) check(Array.isArray(body.data), 'request data array');
  else if (route === '/api/plugin' || route === '/api/model') check(Array.isArray(body.data) && object(body.location) && typeof body.location.directory === 'string', 'location/data envelope');
  else throw Error('Pilot contract: unreviewed route '+method+' '+route);
  return body;
}
