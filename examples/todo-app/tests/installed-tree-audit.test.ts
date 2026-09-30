import {test, expect} from 'bun:test'
import {mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, readFileSync, unlinkSync, rmdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runInNewContext} from 'node:vm'
import {installedTreeAuditScript, installedTreeAuditTool} from './installed-tree-audit'
import {auditFence} from './matched-qualification'
import type {ManagedEntry} from '@kev-browser-agent-kit/workspace/delivery'

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'phase9-audit-'))
  mkdirSync(root+'/workspace/node_modules/pkg',{recursive:true}); mkdirSync(root+'/workspace/.browser-editor-cache',{recursive:true})
  const directories=['/workspace/node_modules','/workspace/node_modules/pkg']
  for(const path of directories) chmodSync(root+path,0o755)
  writeFileSync(root+'/workspace/node_modules/pkg/index.js','immutable'); chmodSync(root+'/workspace/node_modules/pkg/index.js',0o644)
  const entries:ManagedEntry[]=[...directories.map(destination=>({kind:'directory' as const,destination,mode:0o755})),{kind:'file',destination:'/workspace/node_modules/pkg/index.js',mode:0o644,bytes:9,sha256:createHash('sha256').update('immutable').digest('hex'),file:'unused'}]
  const run=(hashMode: 'stream' | 'direct' = 'stream', profile = false, injectedRequire = require)=>{
    let result:any
    const script=installedTreeAuditScript(entries,{hashMode,profile}).replaceAll('/workspace',root+'/workspace').replaceAll('/opencode-v2',root+'/opencode-v2').replaceAll("'/app'",JSON.stringify(root+'/app'))
    runInNewContext(script,{require:injectedRequire,performance,console:{log:(text:string)=>{result=JSON.parse(text)}}})
    return result
  }
  return {root,run,entries}
}
test('full hashes and cache inventory preserve bytes without cleanup',()=>{
  const f=fixture(); mkdirSync(f.root+'/workspace/node_modules/.vite-temp'); writeFileSync(f.root+'/workspace/node_modules/.vite-temp/config.js','mutable')
  const first=f.run(); expect(first.valid).toBe(true); expect(first.checked).toBe(3); expect(first.inventory).toHaveLength(2)
  expect(readFileSync(f.root+'/workspace/node_modules/.vite-temp/config.js','utf8')).toBe('mutable')
  writeFileSync(f.root+'/workspace/node_modules/.vite-temp/config.js','changed'); const second=f.run(); expect(second.valid).toBe(true); expect(second.cacheDigest).not.toBe(first.cacheDigest)
})

test('direct hash differential full-tree rejection and cache policy controls', () => {
  const scenarios: Array<(f: ReturnType<typeof fixture>) => void> = [
    () => {},
    f => writeFileSync(f.root+'/workspace/node_modules/pkg/index.js','malicious'),
    f => writeFileSync(f.root+'/workspace/node_modules/pkg/index.js','short'),
    f => unlinkSync(f.root+'/workspace/node_modules/pkg/index.js'),
    f => writeFileSync(f.root+'/workspace/node_modules/pkg/extra.js','extra'),
    f => chmodSync(f.root+'/workspace/node_modules/pkg/index.js',0o600),
    f => chmodSync(f.root+'/workspace/node_modules/pkg',0o700),
    f => {unlinkSync(f.root+'/workspace/node_modules/pkg/index.js'); mkdirSync(f.root+'/workspace/node_modules/pkg/index.js')},
    f => {unlinkSync(f.root+'/workspace/node_modules/pkg/index.js'); symlinkSync('absent',f.root+'/workspace/node_modules/pkg/index.js')},
    f => mkdirSync(f.root+'/workspace/node_modules/.unknown-cache'),
    f => symlinkSync('pkg',f.root+'/workspace/node_modules/.vite'),
    f => {mkdirSync(f.root+'/workspace/node_modules/.vite'); writeFileSync(f.root+'/workspace/node_modules/.vite/cache','bytes')},
    f => {unlinkSync(f.root+'/workspace/node_modules/pkg/index.js'); symlinkSync('missing',f.root+'/workspace/node_modules/pkg/index.js'); f.entries[2]={kind:'symlink',destination:'/workspace/node_modules/pkg/index.js',target:'expected'}},
    f => {symlinkSync('index.js',f.root+'/workspace/node_modules/pkg/link'); f.entries.push({kind:'symlink',destination:'/workspace/node_modules/pkg/link',target:'index.js'})},
    f => {mkdirSync(f.root+'/app'); writeFileSync(f.root+'/app/unknown','x')},
    f => {rmdirSync(f.root+'/workspace/.browser-editor-cache'); symlinkSync('node_modules/pkg',f.root+'/workspace/.browser-editor-cache')},
    f => {mkdirSync(f.root+'/workspace/.browser-editor-cache/vite'); symlinkSync('../../node_modules/pkg',f.root+'/workspace/.browser-editor-cache/vite/link')},
  ]
  for (const mutate of scenarios) {
    const f=fixture(); mutate(f)
    const baseline=f.run(), direct=f.run('direct')
    expect(direct).toEqual(baseline)
    for (const mode of ['stream','direct'] as const) {
      const profiled=f.run(mode,true), {profile,...result}=profiled
      expect(result).toEqual(baseline)
      expect(profile.metrics.guestTotal).toBeGreaterThanOrEqual(0)
    }
  }
})

test('direct and stream fail closed on filesystem and hash exceptions', () => {
  for (const method of ['lstatSync','readdirSync','readFileSync','readlinkSync','createHash','hash']) {
    const f=fixture()
    symlinkSync('index.js',f.root+'/workspace/node_modules/pkg/link'); f.entries.push({kind:'symlink',destination:'/workspace/node_modules/pkg/link',target:'index.js'})
    const injected=((name: string) => {
      const original=require(name)
      return new Proxy(original,{get(target,key) { if(key===method) return () => {throw Error('injected failure')}; return target[key] }})
    }) as typeof require
    for(const mode of ['stream','direct'] as const) {
      if(method==='createHash' && mode==='direct' || method==='hash' && mode==='stream') continue
      expect(f.run(mode,false,injected).valid).toBe(false)
      expect(f.run(mode,false,injected).reason).toContain('injected failure')
    }
  }
})

test('both auditors join stop, drains and exit on transport, parse and observer failures', async () => {
  for(const hashMode of ['stream','direct'] as const) for(const failure of ['stdout','stderr','exit','stop','parse','observer']) {
    let release!: () => void
    const pending=new Promise<void>(resolve=>{release=resolve})
    let stopped=false,settled=false
    const drain=(name:string)=>(async function*(){
      if(failure===name) throw Error(name+' failure')
      await pending
      if(name==='stdout') yield new TextEncoder().encode(failure==='parse'?'bad json':'{"valid":true,"checked":0}')
    })()
    const tool=await installedTreeAuditTool([],{hashMode,onTiming:(name)=>{if(failure==='observer' && name==='launch') throw Error('observer failure')}}).bind({
      installFile:async()=>{},node:async()=>({closeStdin(){},stdout:drain('stdout'),stderr:drain('stderr'),
        exited:failure==='exit'?Promise.reject(Error('exit failure')):pending.then(()=>({exitCode:0})),
        stop:async()=>{stopped=true;await pending;if(failure==='stop')throw Error('stop failure')},
      }),
    } as any)
    const task=tool(undefined).then(()=>{settled=true;throw Error('unexpected success')},()=>{settled=true})
    await Bun.sleep(5)
    expect(settled).toBe(false)
    if(['stdout','stderr','exit','observer'].includes(failure)) expect(stopped).toBe(true)
    release();await task
    expect(stopped).toBe(true);expect(settled).toBe(true)
  }
})
test('package mutation and unexpected package path fail closed',()=>{
  const f=fixture(); writeFileSync(f.root+'/workspace/node_modules/pkg/index.js','malicious'); expect(f.run().valid).toBe(false)
  writeFileSync(f.root+'/workspace/node_modules/pkg/index.js','immutable'); writeFileSync(f.root+'/workspace/node_modules/pkg/extra.js','extra'); expect(f.run().reason).toContain('unexpected installed path')
})
test('stopped-tree snapshots cannot certify an active writer between audits',()=>{
  const f=fixture(), path=f.root+'/workspace/node_modules/pkg/index.js'
  const before=f.run()
  // Characterization, not permission to retain a writer: the immutable bytes
  // can be consumed while corrupted, then restored before the next snapshot.
  writeFileSync(path,'malicious')
  const consumed=readFileSync(path,'utf8')
  writeFileSync(path,'immutable')
  const after=f.run()
  expect(consumed).toBe('malicious')
  expect(before.valid).toBe(true)
  expect(after.valid).toBe(true)
  expect(after.checked).toBe(before.checked)
  expect(after.cacheDigest).toBe(before.cacheDigest)
})
test('cache symlinks and cache/manifest overlap rejected',()=>{
  const f=fixture(); symlinkSync('pkg',f.root+'/workspace/node_modules/.vite-temp'); expect(f.run().reason).toContain('cache symlink')
  expect(()=>installedTreeAuditScript([...f.entries,{kind:'directory',destination:'/workspace/node_modules/.vite-temp',mode:0o755}])).toThrow('overlaps')
})

test('audit failure stops promptly and blocks fallback until sibling drain and exit join', async () => {
  let release!: () => void, exit!: () => void
  const sibling = new Promise<void>(resolve => {release = resolve})
  const exited = new Promise<{exitCode:number}>(resolve => {exit = () => resolve({exitCode:0})})
  let stopped = false, fallback = false, settled = false
  const tool = await installedTreeAuditTool([]).bind({
    installFile: async () => {}, node: async () => ({closeStdin() {},
      stdout: (async function* () {throw Error('stdout failed')})(),
      stderr: (async function* () {await sibling; yield new Uint8Array()})(),
      exited, stop: async () => {stopped = true},
    }),
  } as any)
  const task = auditFence('after-replacement', () => tool(undefined), 'retained', async () => {fallback = true; throw Error('fallback')}, () => {}).catch(() => {settled = true})
  await Bun.sleep(10)
  expect(stopped).toBe(true); expect(settled).toBe(false); expect(fallback).toBe(false)
  release(); await Bun.sleep(10)
  expect(settled).toBe(false); expect(fallback).toBe(false)
  exit(); await task
  expect(fallback).toBe(true); expect(settled).toBe(true)
})
