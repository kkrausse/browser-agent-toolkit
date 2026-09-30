import {test, expect} from 'bun:test'
import {mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runInNewContext} from 'node:vm'
import {installedTreeAuditScript} from './installed-tree-audit'
import type {ManagedEntry} from '@kev-browser-agent-kit/workspace/delivery'

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'phase9-audit-'))
  mkdirSync(root+'/workspace/node_modules/pkg',{recursive:true}); mkdirSync(root+'/workspace/.browser-editor-cache',{recursive:true})
  const directories=['/workspace/node_modules','/workspace/node_modules/pkg']
  for(const path of directories) chmodSync(root+path,0o755)
  writeFileSync(root+'/workspace/node_modules/pkg/index.js','immutable'); chmodSync(root+'/workspace/node_modules/pkg/index.js',0o644)
  const entries:ManagedEntry[]=[...directories.map(destination=>({kind:'directory' as const,destination,mode:0o755})),{kind:'file',destination:'/workspace/node_modules/pkg/index.js',mode:0o644,bytes:9,sha256:createHash('sha256').update('immutable').digest('hex'),file:'unused'}]
  const run=()=>{
    let result:any
    const script=installedTreeAuditScript(entries).replaceAll('/workspace',root+'/workspace').replaceAll('/opencode-v2',root+'/opencode-v2').replaceAll("'/app'",JSON.stringify(root+'/app'))
    runInNewContext(script,{require,console:{log:(text:string)=>{result=JSON.parse(text)}}})
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
test('package mutation and unexpected package path fail closed',()=>{
  const f=fixture(); writeFileSync(f.root+'/workspace/node_modules/pkg/index.js','malicious'); expect(f.run().valid).toBe(false)
  writeFileSync(f.root+'/workspace/node_modules/pkg/index.js','immutable'); writeFileSync(f.root+'/workspace/node_modules/pkg/extra.js','extra'); expect(f.run().reason).toContain('unexpected installed path')
})
test('cache symlinks and cache/manifest overlap rejected',()=>{
  const f=fixture(); symlinkSync('pkg',f.root+'/workspace/node_modules/.vite-temp'); expect(f.run().reason).toContain('cache symlink')
  expect(()=>installedTreeAuditScript([...f.entries,{kind:'directory',destination:'/workspace/node_modules/.vite-temp',mode:0o755}])).toThrow('overlaps')
})
