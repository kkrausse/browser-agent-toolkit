import { prepare } from '@kkrausse/browser-agent-toolkit/prepare'

// What the agent may edit. Everything else the guest sees comes from the dependency image.
const source = ['src', 'vite.config.ts', 'react-router.config.ts', 'tsconfig.json', 'package.json']

const manifest = await prepare({
  appRoot: import.meta.dirname,
  outDir: '.editor/prepared',
  source,
  // EDITOR_FAKE_HOST=1: no image; the programs run natively behind the dev fake host.
  manifestOnly: process.env.EDITOR_FAKE_HOST === '1',
})
console.log(`Prepared ${Object.keys(manifest.project).length} project files${manifest.image ? ` and image ${manifest.image.file}` : ' (manifest only, for the fake host)'}`)
