import { FitAddon, init, Terminal } from "../src/index";

declare global {
  interface Window { terminal: Terminal }
}

const status = document.querySelector<HTMLParagraphElement>("#status")!;
const container = document.querySelector<HTMLDivElement>("#terminal")!;

try {
  await init();
  const terminal = new Terminal({ rendererType: "webgl", copyOnSelect: false, scrollback: 1_000 });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  await terminal.open(container);
  window.terminal = terminal; // Explicit inspection hook for this development demo.
  fit.fit();
  new ResizeObserver(() => fit.fit()).observe(container);
  status.textContent = `${terminal.renderer?.constructor.name} · ${terminal.cols}×${terminal.rows}`;
  terminal.onResize(({ cols, rows }) => { status.textContent = `${terminal.renderer?.constructor.name} · ${cols}×${rows}`; });
  terminal.onData(data => {
    document.querySelector<HTMLOutputElement>("#input")!.textContent = `Last encoded input: ${JSON.stringify(data)}`;
    if (data === "\r") terminal.write("\r\n");
    else if (data === "\x7f") terminal.write("\b \b");
    else if (!data.includes("\x1b")) terminal.write(data);
  });
  function sample() {
    terminal.write("\x1b[1mOfficial Ghostty WASM\x1b[0m\r\n");
    terminal.write("\x1b[31mRed\x1b[0m · \x1b[32mGreen\x1b[0m · \x1b[38;2;100;170;255mTruecolor\x1b[0m\r\n");
    terminal.write("Wide: 日本語 · Combining: e\u0301 · Emoji: 👩‍💻\r\n");
    terminal.write("\x1b[3mItalic\x1b[0m · \x1b[4mUnderline\x1b[0m · \x1b[9mStrike\x1b[0m\r\n");
    terminal.write("\x1b]8;;https://ghostty.org\x1b\\Ghostty website\x1b]8;;\x1b\\\r\n");
  }
  document.querySelector("#sample")!.addEventListener("click", sample);
  document.querySelector("#history")!.addEventListener("click", () => {
    terminal.write(Array.from({ length: 200 }, (_, i) => `History line ${i + 1}\r\n`).join(""));
  });
  document.querySelector("#clear")!.addEventListener("click", () => {
    terminal.write("\x1bc");
    terminal.scrollToBottom();
    terminal.focus();
  });
  sample();
  terminal.focus();
} catch (error) {
  status.textContent = error instanceof Error ? error.message : String(error);
  throw error;
}
