import {join, resolve} from 'node:path';
import {writeFile, readdir} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';

// Independent, offline QA of this known failed-protocol repair. Never launches a host.
const output = resolve(process.argv[2]!);
const phase = process.argv[3];
const stage = await Bun.file(join(output, 'stage.json')).json();
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const fileHash = async (path: string) => hash(new Uint8Array(await Bun.file(path).arrayBuffer()));
if (phase === 'preflight' || phase === 'postflight') {
  if (phase === 'preflight' && await Bun.file(join(output, 'owned-origin.json')).exists()) throw Error('Stage no longer runnable; origin already owned');
  if (stage.sourceRevision !== '6f88410877d1027bb5fb7bbd9851a82de431356b') throw Error('Wrong source');
  if (Object.keys(stage.stageHashes).length !== 66 || Object.keys(stage.frozenHashes).length !== 9588) throw Error('Wrong frozen counts');
  for (const [file, expected] of Object.entries(stage.stageHashes)) if (await fileHash(join(output, file)) !== expected) throw Error('Stage changed: ' + file);
  for (const [file, expected] of Object.entries(stage.frozenHashes)) if (await fileHash(join(stage.frozen, file)) !== expected) throw Error('Frozen changed: ' + file);
  if (await fileHash(join(stage.frozen, 'receipt.json')) !== stage.frozenReceiptSha256) throw Error('Receipt changed');
  const child = Bun.spawn(['git', 'archive', stage.sourceRevision, 'workspace-api', 'opencode-chat', 'examples/todo-app/tests'], {stdout:'pipe', stderr:'pipe'});
  const [archive, stderr, exit] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (exit || stderr || hash(new Uint8Array(archive)) !== stage.sourceArchiveSha256) throw Error('Archive parity failed');
  const manifest = await Bun.file(join(stage.frozen, 'prepared/manifest.json')).json();
  for (const asset of [...manifest.assets.filter((asset: {kind:string}) => asset.kind === 'file'), manifest.image, manifest.bundle]) {
    const bytes = new Uint8Array(await Bun.file(join(stage.frozen, 'prepared', asset.file)).arrayBuffer());
    if (hash(bytes) !== asset.sha256 || bytes.length !== asset.bytes) throw Error('Manifest asset changed');
  }
  const receipt = {phase, source:stage.sourceRevision, stageEntries:66, frozenInputs:9588, archiveSha256:stage.sourceArchiveSha256, serverSha256:stage.serverSha256, clientSha256:stage.stageHashes['client/sk-opencode-live-client.js'], verified:true};
  await writeFile(join(output, 'qa-' + phase + '.json'), JSON.stringify(receipt), {flag:'wx'});
  console.log(receipt);
} else if (phase === 'parity') {
  const results = [];
  const files = (await readdir(output)).filter(file => /^codec-\d+\.json$/.test(file)).sort((a,b)=>Number(a.match(/\d+/)![0])-Number(b.match(/\d+/)![0]));
  for (const file of files) {
    const original = await Bun.file(join(output,file)).json();
    if (hash(Buffer.from(original.record.bodyBase64,'base64')) !== original.record.sha256) throw Error('Record hash mismatch');
    const child = Bun.spawn(['node',join(output,'sk-opencode-live-codec.mjs')],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
    child.stdin.write(JSON.stringify(original.record)); child.stdin.end();
    const [stdout,stderr,exit] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    results.push({file,exit,stdout,stderr,stdoutJoined:true,stderrJoined:true,originalExit:original.exit});
    await writeFile(join(output,'qa-independent-codec-recheck.json'),JSON.stringify(results));
    if (exit !== original.exit || exit || !isDeepStrictEqual(JSON.parse(stdout), JSON.parse(original.stdout))) throw Error('Independent actual codec parity failed');
  }
  console.log({records:results.length,requests:results.filter(r=>r.stdout.includes('root-request-schema')).length,allJoined:true});
} else throw Error('Expected preflight, postflight or parity');
