import { $ } from "bun";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Deliberately outside the source tree: no workspace dependencies or TS path aliases.
const root = resolve(import.meta.dir, "..");
const tempBase = join(process.env.TMPDIR || tmpdir(), "opencode");
await mkdir(tempBase, { recursive: true });
const temp = await mkdtemp(join(tempBase, "opencode-chat-consumer-"));
await $`bun pm pack --destination ${temp}`.cwd(root).quiet();
const tarball = join(temp, "kev-browser-agent-kit-opencode-chat-0.1.0.tgz");
const headless = join(temp, "headless"),
  react = join(temp, "react");
await Promise.all([mkdir(headless), mkdir(react)]);
await writeFile(
  join(headless, "package.json"),
  JSON.stringify({
    type: "module",
    dependencies: {
      "@kev-browser-agent-kit/opencode-chat": `file:${tarball}`,
      typescript: "5.9.3",
    },
  }),
);
await $`bun install`.cwd(headless).quiet();
await Promise.all(["LICENSE.upstream","LICENSE.marked"].map(name=>access(join(headless,"node_modules/@kev-browser-agent-kit/opencode-chat",name))));
try {
  await access(join(headless, "node_modules/react"));
  throw new Error("Headless consumer unexpectedly installed React");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
await writeFile(
  join(headless, "consumer.ts"),
  `import {createChatController, type ChatEndpoint, type ChatController} from '@kev-browser-agent-kit/opencode-chat';
const endpoint:ChatEndpoint={url:'https://example.invalid',fetch:async (_input:string,_init?:RequestInit)=>new Response()};
const make: (options:{endpoint:ChatEndpoint;directory:string})=>ChatController=createChatController;
if(typeof make!=='function')throw new Error('Headless export missing');
console.log('headless import passed');`,
);
await $`bunx tsc --noEmit --strict --moduleResolution bundler --module esnext --target es2023 --lib es2023,dom consumer.ts`
  .cwd(headless)
  .quiet();
await $`bun consumer.ts`.cwd(headless);
await writeFile(
  join(react, "package.json"),
  JSON.stringify({
    type: "module",
    dependencies: {
      "@kev-browser-agent-kit/opencode-chat": `file:${tarball}`,
      react: "19.2.4",
      "react-dom": "19.2.4",
      "@types/react": "19.2.14",
      "@types/react-dom": "19.2.3",
      typescript: "5.9.3",
    },
  }),
);
await writeFile(
  join(react, "consumer.tsx"),
  `import {ChatView, Markdown} from '@kev-browser-agent-kit/opencode-chat/react';
import type {ChatController} from '@kev-browser-agent-kit/opencode-chat';
import '@kev-browser-agent-kit/opencode-chat/styles.css';
export const render=(controller:ChatController)=><ChatView controller={controller} showModels showSessions onOpenFile={path=>console.log(path)}/>;
export const markdown=<Markdown text={'**Packed React consumer**'}/>;`,
);
await writeFile(
  join(react, "ssr.tsx"),
  `import {renderToStaticMarkup} from 'react-dom/server';
import {Markdown} from '@kev-browser-agent-kit/opencode-chat/react';
const html=renderToStaticMarkup(<Markdown text="**Packed consumer**"/>);
if(!html.includes('<strong>Packed consumer</strong>'))throw new Error(html);
console.log('packed React SSR passed');`,
);
await $`bun install`.cwd(react).quiet();
await $`bunx tsc --noEmit --strict --skipLibCheck --jsx react-jsx --moduleResolution bundler --module esnext --target es2023 --lib es2023,dom consumer.tsx`
  .cwd(react)
  .quiet();
await $`bun build consumer.tsx --outdir build --target browser`
  .cwd(react)
  .quiet();
await $`bun ssr.tsx`.cwd(react);
await $`NODE_ENV=production bun ssr.tsx`.cwd(react);
console.log(`Packed consumers passed: ${temp}`);
