// The page with no `guest` in its URL: one entry per program, with a small
// form for programs that need settings (which server, which directory).
// Submitting is plain navigation to /?guest=<name>&<param>=..., so every
// launch is a link that can be bookmarked or scripted.

import { openPersistStore } from "../host/persist-store";
import type { GuestInfo } from "./guests";
import { filesFromFolder, filesFromZip, type ImportedFile, importIntoGuest } from "./import";

const STYLE = `
  #launcher { position: fixed; inset: 0; overflow: auto; padding: 24px 16px; color: #dcd7ba; font: 15px/1.5 system-ui, sans-serif; }
  #launcher main { max-width: 640px; margin: 0 auto; }
  #launcher h1 { font-size: 20px; margin: 0 0 4px; }
  #launcher p { margin: 0 0 16px; color: #a6a69c; }
  #launcher p.note { padding: 10px 12px; border: 1px solid #363646; border-radius: 8px; color: #dcd7ba; font-size: 14px; }
  #launcher section { border: 1px solid #2a2a37; border-radius: 8px; padding: 14px 16px; margin: 0 0 12px; background: #1f1f28; }
  #launcher h2 { font: 600 15px/1.4 ui-monospace, monospace; margin: 0; }
  #launcher label { display: block; margin: 10px 0 0; font-size: 13px; color: #a6a69c; }
  #launcher input { display: block; width: 100%; box-sizing: border-box; margin-top: 3px; padding: 7px 9px; border: 1px solid #363646; border-radius: 6px; background: #16161d; color: #dcd7ba; font: 14px ui-monospace, monospace; }
  #launcher small { display: block; color: #727169; margin-top: 2px; }
  #launcher .row { display: flex; gap: 10px; align-items: center; margin-top: 12px; }
  #launcher button { padding: 7px 14px; border: 1px solid #363646; border-radius: 6px; background: #2d4f67; color: #dcd7ba; font: inherit; cursor: pointer; }
  #launcher button.quiet { background: transparent; color: #a6a69c; }
  #launcher .row { flex-wrap: wrap; }
  #launcher .import { margin-top: 12px; padding-top: 10px; border-top: 1px solid #2a2a37; font-size: 13px; color: #a6a69c; }
  #launcher .import label { display: inline-flex; gap: 6px; align-items: center; margin: 0; }
  #launcher .import input[type=checkbox] { display: inline; width: auto; margin: 0; }
  #launcher .import input[type=file] { display: none; }
  #launcher .import output { display: block; margin-top: 6px; color: #98bb6c; white-space: pre-wrap; }
`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, properties: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
}

/** "Import folder" / "Import .zip": the user's own files into the guest's persistent directory, before it runs. */
function importControls(namespace: string, directory: string): HTMLElement {
  const status = element("output", { className: "import-status" });
  const replace = element("input", { type: "checkbox", className: "import-replace" });
  async function run(read: () => Promise<ImportedFile[]>): Promise<void> {
    status.textContent = "Importing...";
    try {
      const result = await importIntoGuest(namespace, directory, await read(), replace.checked);
      const skipped = result.skipped.length ? `; left out ${result.skipped.length} (${result.skipped.slice(0, 3).join(", ")}${result.skipped.length > 3 ? ", ..." : ""})` : "";
      status.textContent = `Imported ${result.files} files (${(result.bytes / 1024).toFixed(0)} kB) into ${directory}${skipped}`;
    } catch (error) {
      status.textContent = `Import failed: ${(error as Error).message}`;
    }
  }
  const folder = element("input", { type: "file", multiple: true, className: "import-folder" });
  folder.setAttribute("webkitdirectory", "");
  folder.addEventListener("change", () => folder.files?.length && run(() => filesFromFolder(folder.files!)).then(() => (folder.value = "")));
  const zip = element("input", { type: "file", accept: ".zip,application/zip", className: "import-zip" });
  zip.addEventListener("change", () => zip.files?.[0] && run(async () => filesFromZip(new Uint8Array(await zip.files![0]!.arrayBuffer()))).then(() => (zip.value = "")));
  const pick = (label: string, input: HTMLInputElement) => {
    const button = element("button", { type: "button", className: "quiet", textContent: label });
    button.addEventListener("click", () => input.click());
    return button;
  };
  return element("div", { className: "import" }, [
    `Your own files, into ${directory} (stays in this browser):`,
    element("div", { className: "row" }, [pick("Import folder", folder), pick("Import .zip", zip), element("label", {}, [replace, "replace what is there"]), folder, zip]),
    status,
  ]);
}

/** What a page that is not the dev page says about itself above the programs. */
export interface LauncherText {
  title: string;
  intro: string;
  notes?: string[];
}

export function showLauncher(guests: GuestInfo[], text: LauncherText = { title: "wasm-term", intro: "Terminal programs running in this browser tab, on an emulated machine. Pick one." }): void {
  document.querySelector("#terminal")?.remove();
  document.head.append(element("style", { textContent: STYLE }));
  const main = element("main", {}, [
    element("h1", { textContent: text.title }),
    element("p", { textContent: text.intro }),
    ...(text.notes ?? []).map(note => element("p", { className: "note", textContent: note })),
  ]);

  // Programs with settings first: they are the ones a person comes here for.
  for (const guest of [...guests].sort((a, b) => (b.params?.length ?? 0) - (a.params?.length ?? 0))) {
    // The page's own path: the directory may be served anywhere.
    const form = element("form", { method: "get", action: location.pathname }, [element("input", { type: "hidden", name: "guest", value: guest.name })]);
    for (const param of guest.params ?? []) {
      if (param.hidden) continue;
      const input = element("input", { name: param.query, value: param.default, type: param.secret ? "password" : "text", autocomplete: "off", spellcheck: false });
      form.append(element("label", {}, [param.label, input, ...(param.hint ? [element("small", { textContent: param.hint })] : [])]));
    }
    const forget = element("button", { type: "button", className: "quiet", textContent: "Forget saved state" });
    forget.addEventListener("click", async () => {
      await openPersistStore(guest.name).clear();
      forget.textContent = "Forgotten";
    });
    const row = element("div", { className: "row" }, [element("button", { type: "submit", textContent: `Run ${guest.name}` }), forget]);
    if (guest.credentials?.length) {
      const signOut = element("button", { type: "button", className: "quiet", textContent: "Clear stored credentials" });
      signOut.addEventListener("click", async () => {
        const store = openPersistStore(guest.name);
        for (const path of guest.credentials ?? []) store.save(path, null);
        await store.flush();
        signOut.textContent = "Credentials cleared";
      });
      row.append(signOut);
    }
    form.append(row);
    if (guest.importDir) form.append(importControls(guest.name, guest.importDir));
    main.append(element("section", {}, [
      element("h2", { textContent: guest.name }),
      ...(guest.description ? [element("small", { textContent: guest.description })] : []),
      form,
    ]));
  }
  document.body.append(element("div", { id: "launcher" }, [main]));
  document.title = text.title;
}
