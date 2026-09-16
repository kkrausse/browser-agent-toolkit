import { $ } from "bun";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postcss from "postcss";
import { readQualifiedOpenCodeApplication } from '../src/opencode-application';

const tempRoot = join(tmpdir(), "opencode");
await mkdir(tempRoot, { recursive: true });
const directory = await mkdtemp(join(tempRoot, "chat-consumer-"));
try {
  await $`bun pm pack --destination ${directory}`;
  const tarball = [...new Bun.Glob("*.tgz").scanSync(directory)][0]!;
  const dependencies: Record<string, string> = { "@kev-browser-agent-kit/opencode-chat": `file:${join(directory, tarball)}` };
  const manifest = () => Bun.write(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }));
  await manifest();
  await $`bun install --ignore-scripts`.cwd(directory);
  if (await Bun.file(join(directory, "node_modules/react/package.json")).exists()) throw Error("Headless consumer unexpectedly installed React");
  if (await Bun.file(join(directory, "node_modules/@kev-browser-agent-kit/workspace/package.json")).exists()) throw Error("Headless consumer unexpectedly installed workspace");
  await $`bun -e ${'import { createChatController } from "@kev-browser-agent-kit/opencode-chat"; if (typeof createChatController !== "function") throw Error("Missing headless export");'}`.cwd(directory);

  Object.assign(dependencies, { react: "19.2.4", "react-dom": "19.2.4", "@types/react": "19.2.14", "@types/react-dom": "19.2.3", typescript: "5.9.3" });
  await manifest(); await $`bun install --ignore-scripts`.cwd(directory);
  await Bun.write(join(directory, "standalone.tsx"), `
    import { ChatView, type ChatViewProps } from "@kev-browser-agent-kit/opencode-chat/react";
    export const chat = (props: ChatViewProps) => <ChatView {...props} />;
  `);
  await $`bunx tsc --noEmit --jsx react-jsx --target es2023 --module esnext --moduleResolution bundler standalone.tsx`.cwd(directory);
  // The editor entrypoint requires the optional workspace peer. Keep its install
  // after the standalone checks so those still prove headless/chat isolation.
  await $`bun pm pack --destination ${directory}`.cwd(join(import.meta.dir, "../../workspace-api/dist/lib"));
  const workspaceTarball = [...new Bun.Glob("kev-browser-agent-kit-workspace-*.tgz").scanSync(directory)][0]!;
  dependencies["@kev-browser-agent-kit/workspace"] = `file:${join(directory, workspaceTarball)}`;
  await manifest(); await $`bun install --ignore-scripts`.cwd(directory);
  // Resolve through the installed export from a consumer outside this repository.
  const applicationRoot = (await $`bun -e ${'import { packagedOpenCodeDirectory } from "@kev-browser-agent-kit/opencode-chat/prepare"; console.log(packagedOpenCodeDirectory)'}`.cwd(directory).text()).trim();
  if (!(await realpath(applicationRoot)).startsWith(await realpath(join(directory, 'node_modules')) + '/')) throw Error('Application resolved outside installed package');
  await readQualifiedOpenCodeApplication(applicationRoot);
  await Bun.write(join(directory, "consumer.tsx"), `
    import { renderToStaticMarkup } from "react-dom/server";
    import { ChatView, type ChatViewProps } from "@kev-browser-agent-kit/opencode-chat/react";
    import { BrowserEditor, type BrowserEditorProps } from "@kev-browser-agent-kit/opencode-chat/editor";
    import { WorkspaceController } from "@kev-browser-agent-kit/workspace/react";
    const controller: BrowserEditorProps["controller"] = new WorkspaceController();
    const markup = renderToStaticMarkup(<BrowserEditor controller={controller} onExit={() => {}} />);
    if (!markup.includes('data-slot="button"')) throw Error("Missing bundled Base UI button");
    export const chat = (props: ChatViewProps) => <ChatView {...props} />;
  `);
  await $`bun consumer.tsx`.cwd(directory);
  await $`bunx tsc --noEmit --skipLibCheck --jsx react-jsx --target es2023 --module esnext --moduleResolution bundler consumer.tsx`.cwd(directory);
  await Bun.write(join(directory, "browser.ts"), `
    export { ChatView } from "@kev-browser-agent-kit/opencode-chat/react";
    export { BrowserEditor } from "@kev-browser-agent-kit/opencode-chat/editor";
    import "@kev-browser-agent-kit/opencode-chat/editor.css";
  `);
  await $`bun build browser.ts --target browser --outdir out`.cwd(directory);
  const css = await Bun.file(join(directory, "node_modules/@kev-browser-agent-kit/opencode-chat/dist/editor.css")).text();
  if (!css.includes(".ocui\\:inline-flex") || !css.includes(".oc-editor-panel")) throw Error("Packed component CSS missing");
  if (css.includes("--tw-") || css.includes(":root") || css.includes("-webkit-text-size-adjust")) throw Error("Host-global Tailwind CSS leaked");
  postcss.parse(css).walkRules(rule => {
    if (rule.selectors.some(selector => /^\s*(\*|:before|:after|::backdrop)/.test(selector))) throw Error(`Unscoped CSS: ${rule.selector}`);
  });
  console.log("Packed smoke passed: headless without React/workspace; bundled React UI, declarations and precompiled isolated CSS.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
