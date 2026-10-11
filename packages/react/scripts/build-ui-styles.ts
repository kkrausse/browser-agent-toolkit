import { $ } from "bun";
import postcss from "postcss";

/** The same precompiled, isolated stylesheet for package builds and source consumers. */
export async function buildUIStyles(output = new URL("../dist/", import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const compiled = await $`bunx @tailwindcss/cli -i src/chat/tailwind.css --minify`.cwd(root.pathname).text();
  // Tailwind's internal property names and layers are not covered by its utility prefix.
  const css = postcss.parse(compiled.replaceAll("--tw-", "--ocui-tw-"));
  css.walkAtRules("layer", rule => { rule.params = rule.params.split(",").map(name => `ocui-${name.trim()}`).join(","); });
  css.walkRules(rule => {
    if (rule.selector === "*,:before,:after,::backdrop") {
      rule.selector = ".oc-ui,.oc-ui *,.oc-ui::before,.oc-ui::after,.oc-ui *::before,.oc-ui *::after,.oc-ui::backdrop";
    }
  });
  const ui = css.toString();
  const styles = `${ui}\n${await Bun.file(new URL("src/chat/styles.css", root)).text()}`;

  await Bun.write(new URL("styles.css", output), styles);
  
}

if (import.meta.main) await buildUIStyles();
