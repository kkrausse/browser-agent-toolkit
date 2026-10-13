import { $ } from 'bun';
import { buildUIStyles } from './scripts/build-ui-styles';

// The declarations come from the toolkit's: build `packages/toolkit` first.
await $`rm -rf dist`;
await $`bunx tsc`;
// The toolkit stays an import, so a page holds one copy of the chat code however many
// packages reach it.
const external = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/*', '@kkrausse/browser-agent-toolkit/*', '@base-ui/react/*', 'lucide-react', 'marked', 'remend', '@pierre/diffs', '@pierre/diffs/*', 'clsx', 'class-variance-authority', 'tailwind-merge'];
const result = await Bun.build({
  entrypoints: ['src/index.tsx'], root: 'src', outdir: 'dist', target: 'browser', format: 'esm',
  jsx: { runtime: 'automatic', development: false }, external,
});
if (!result.success) throw new AggregateError(result.logs);
await buildUIStyles();
