import { $ } from 'bun';
import { buildUIStyles } from './scripts/build-ui-styles';

await $`rm -rf dist`;
await $`bunx tsc`;
const external = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/*', '@base-ui/react/*', 'lucide-react', 'marked', 'clsx', 'class-variance-authority', 'tailwind-merge'];
// Browser entries share chunks, so one page never holds two copies of the chat code.
for (const [target, entrypoints] of [
  ['browser', ['src/browser.ts', 'src/react.tsx', 'src/fake/browser.ts']],
  ['bun', ['src/server.ts', 'src/prepare.ts', 'src/fake/server.ts']],
  ['node', ['src/vite.ts']],
] as const) {
  const result = await Bun.build({
    entrypoints: [...entrypoints], root: 'src', outdir: 'dist', target, format: 'esm', splitting: target === 'browser',
    jsx: { runtime: 'automatic', development: false }, external,
  });
  if (!result.success) throw new AggregateError(result.logs);
}
await buildUIStyles();
