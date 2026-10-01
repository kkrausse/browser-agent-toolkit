// Manual Phase-1 qualification surface. No inference, automatic boot or acceptance claim.
import { WorkspaceController } from '@kev-browser-agent-kit/workspace/react';
import { diagnoseWorkspace } from '@kev-browser-agent-kit/workspace';

const owner = new WorkspaceController({ captureProcessOutput: true });
const events: unknown[] = [];
const record = (event: unknown) => { events.push(event); document.querySelector('pre')!.textContent = JSON.stringify(events, null, 2); };
let launching: Promise<unknown> | undefined;
const distribution = await fetch('/runtime/distribution.json').then(r => r.json());
const delivery = { name: 'vivari', version: distribution.version, assetBaseUrl: '/runtime/' };
// Native page controls stay same-origin; host.vivari.internal is the guest-only
// public escape alias used by the preserved full-app fetched-body probe.
const host = location.origin;
function button(name: string, action: () => Promise<unknown>) {
  const element = document.createElement('button'); element.textContent = name;
  element.onclick = () => { void action().then(result => record({ name, result }), error => record({ name, error: String(error) })); };
  document.querySelector('nav')!.append(element);
}
button('Boot real kernel', async () => {
  await owner.open(delivery); await owner.startRuntime({});
  return diagnoseWorkspace(owner.workspace!);
});
button('Load tsgo (real guest)', async () => {
  if (launching) throw Error('One loader cohort only; use a fresh origin for another');
  if (!owner.runtime) throw Error('Boot first');
  await owner.workspace!.fs.writeFile('/effect-loader-pilot.cjs', "const {spawn}=require('child_process'); const child=spawn('tsc',['--version'],{stdio:'inherit'}); child.on('error',error=>{console.error(error);process.exitCode=1;}); child.on('exit',code=>{console.log('tsgo-exit',code);process.exitCode=code;});");
  launching = (async () => {
    const execution = await owner.runtime!.node({ entry: '/workspace/effect-loader-pilot.cjs', cwd: '/workspace' });
    execution.closeStdin();
    const drain = async (stream: AsyncIterable<Uint8Array>, channel: string) => {
      const decoder = new TextDecoder(); let bytes = 0;
      for await (const chunk of stream) { bytes += chunk.length; if (bytes > 65536) throw Error('Pilot output bound'); record({ channel, text: decoder.decode(chunk, { stream: true }) }); }
    };
    const [exit] = await Promise.all([execution.exited, drain(execution.stdout, 'stdout'), drain(execution.stderr, 'stderr')]);
    return { exit, diagnostics: await diagnoseWorkspace(owner.workspace!) };
  })();
  return launching;
});
button('Stop runtime (joined receipt)', async () => { await owner.runtime!.stop(); return diagnoseWorkspace(owner.workspace!); });
button('Inspect loader', async () => diagnoseWorkspace(owner.workspace!));
button('Hold vendor headers', async () => fetch(host + '/pilot/hold', { method: 'POST' }).then(r => r.json()));
button('Release vendor', async () => fetch(host + '/pilot/release', { method: 'POST' }).then(r => r.json()));
record({ prepared: true, executed: false, inferenceAllowed: false, scope: 'Phase-1 loader only', runtimeVersion: distribution.version });
