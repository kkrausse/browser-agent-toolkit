import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import postcss from "postcss";
import { buildUIStyles } from "../scripts/build-ui-styles";

test("both consumer stylesheets include isolated, interactive portaled select utilities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-chat-ui-styles-"));
  try {
    await buildUIStyles(pathToFileURL(directory + "/"));
    for (const file of ["styles.css", "editor.css"]) {
      const css = await Bun.file(join(directory, file)).text();
      const declarations = new Map<string, Record<string, string>>();
      postcss.parse(css).walkRules(rule => {
        const values: Record<string, string> = {};
        rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
        declarations.set(rule.selector, values);
        expect(rule.selectors.some(selector => /^\s*(\*|:before|:after|::backdrop)/.test(selector))).toBe(false);
      });
      expect(declarations.get(".ocui\\:z-50")).toMatchObject({ "z-index": "50" });
      expect(declarations.get(".ocui\\:relative")).toMatchObject({ position: "relative" });
      expect(declarations.get(".ocui\\:flex")).toMatchObject({ display: "flex" });
      expect(declarations.get(".ocui\\:bg-white")).toMatchObject({ "background-color": "#fff" });
      expect(css).toContain(".ocui\\:overflow-y-auto");
      expect(css).not.toContain("--tw-");
      expect(css).not.toContain(":root");
      expect(css).toContain(".oc-chat");
      if (file === "editor.css") expect(css).toContain(".oc-editor-panel");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
