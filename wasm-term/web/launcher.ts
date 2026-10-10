// The page with no `guest` in its URL: one entry per program, with a small
// form for programs that need settings (which server, which directory).
// Submitting is plain navigation to /?guest=<name>&<param>=..., so every
// launch is a link that can be bookmarked or scripted.

import { openPersistStore } from "../host/persist-store";
import type { GuestInfo } from "./guests";

const STYLE = `
  #launcher { position: fixed; inset: 0; overflow: auto; padding: 24px 16px; color: #dcd7ba; font: 15px/1.5 system-ui, sans-serif; }
  #launcher main { max-width: 640px; margin: 0 auto; }
  #launcher h1 { font-size: 20px; margin: 0 0 4px; }
  #launcher p { margin: 0 0 16px; color: #a6a69c; }
  #launcher section { border: 1px solid #2a2a37; border-radius: 8px; padding: 14px 16px; margin: 0 0 12px; background: #1f1f28; }
  #launcher h2 { font: 600 15px/1.4 ui-monospace, monospace; margin: 0; }
  #launcher label { display: block; margin: 10px 0 0; font-size: 13px; color: #a6a69c; }
  #launcher input { display: block; width: 100%; box-sizing: border-box; margin-top: 3px; padding: 7px 9px; border: 1px solid #363646; border-radius: 6px; background: #16161d; color: #dcd7ba; font: 14px ui-monospace, monospace; }
  #launcher small { display: block; color: #727169; margin-top: 2px; }
  #launcher .row { display: flex; gap: 10px; align-items: center; margin-top: 12px; }
  #launcher button { padding: 7px 14px; border: 1px solid #363646; border-radius: 6px; background: #2d4f67; color: #dcd7ba; font: inherit; cursor: pointer; }
  #launcher button.quiet { background: transparent; color: #a6a69c; }
`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, properties: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
}

export function showLauncher(guests: GuestInfo[]): void {
  document.querySelector("#terminal")?.remove();
  document.head.append(element("style", { textContent: STYLE }));
  const main = element("main", {}, [
    element("h1", { textContent: "wasm-term" }),
    element("p", { textContent: "Terminal programs running in this browser tab, on an emulated machine. Pick one." }),
  ]);

  // Programs with settings first: they are the ones a person comes here for.
  for (const guest of [...guests].sort((a, b) => (b.params?.length ?? 0) - (a.params?.length ?? 0))) {
    const form = element("form", { method: "get", action: "/" }, [element("input", { type: "hidden", name: "guest", value: guest.name })]);
    for (const param of guest.params ?? []) {
      const input = element("input", { name: param.query, value: param.default, type: param.secret ? "password" : "text", autocomplete: "off", spellcheck: false });
      form.append(element("label", {}, [param.label, input, ...(param.hint ? [element("small", { textContent: param.hint })] : [])]));
    }
    const forget = element("button", { type: "button", className: "quiet", textContent: "Forget saved state" });
    forget.addEventListener("click", async () => {
      await openPersistStore(guest.name).clear();
      forget.textContent = "Forgotten";
    });
    form.append(element("div", { className: "row" }, [element("button", { type: "submit", textContent: `Run ${guest.name}` }), forget]));
    main.append(element("section", {}, [
      element("h2", { textContent: guest.name }),
      ...(guest.description ? [element("small", { textContent: guest.description })] : []),
      form,
    ]));
  }
  document.body.append(element("div", { id: "launcher" }, [main]));
  document.title = "wasm-term";
}
