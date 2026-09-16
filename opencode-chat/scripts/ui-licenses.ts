import { dirname, join } from "node:path";

/** Runtime and UI implementation dependencies are bundled into the distribution. */
export async function uiLicenses() {
  const visited = new Set<string>();
  const sections: string[] = [];
  async function collect(name: string, from: string) {
    if (visited.has(name)) return;
    visited.add(name);
    const packagePath = Bun.resolveSync(`${name}/package.json`, from);
    const root = dirname(packagePath);
    const manifest = await Bun.file(packagePath).json();
    const files = [...new Bun.Glob("*").scanSync(root)].filter(file => /^(licen[cs]e|notice)(\.|$)/i.test(file));
    // The published 2.0.3 client/protocol/schema omit their monorepo LICENSE.
    // LICENSE.upstream matches the release tag d44b52c's root MIT notice.
    const upstream = ["@opencode/client", "@opencode/protocol", "@opencode/schema"].includes(name) && manifest.version === "2.0.3";
    if (!files.length && !upstream) throw Error(`Missing bundled dependency license: ${name}`);
    const notices = files.length
      ? await Promise.all(files.map(file => Bun.file(join(root, file)).text()))
      : [await Bun.file(join(import.meta.dir, "../LICENSE.upstream")).text()];
    sections.push(`${name} ${manifest.version}\n${notices.join("\n")}`);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) await collect(dependency, root);
  }
  for (const name of ["@opencode/client", "effect", "@base-ui/react", "lucide-react", "class-variance-authority", "clsx", "tailwind-merge"]) await collect(name, import.meta.dir);
  return sections.join("\n\n---\n\n");
}
