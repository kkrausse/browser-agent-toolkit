// A small JavaScript guest: the node-style shim (runtime.ts) with nothing on
// top of it. It is the reference for writing one, and what web/verify uses to
// check the shim without a real application. Written against plain Node APIs
// on purpose: `process`, `node:fs`, `node:os`.
//
// Served by the dev page as ?guest=js-demo.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { JsGuestContext } from "./runtime";

export async function main(context: JsGuestContext): Promise<number> {
  const { stdin, stdout } = process;
  const visits = `${homedir()}/js-demo-visits`;
  appendFileSync(visits, `${new Date().toISOString()}\n`);
  stdout.write(`js-demo: stdin isTTY=${stdin.isTTY}, ${stdout.columns}x${stdout.rows}, visit ${readFileSync(visits, "utf8").split("\n").length - 1}\n`);
  stdout.write(`argv ${JSON.stringify(process.argv)}  HOME=${process.env.HOME}  exists(/dev/tty)=${existsSync("/dev/tty")}\n`);
  stdout.write("Cooked mode: lines are echoed and edited by the tty. Commands: raw, flood <MiB>, copy <text>, paste, exit\n> ");

  process.on("SIGINT", () => stdout.write("\n[SIGINT caught]\n> "));
  stdout.on("resize", () => stdout.write(`\n[resize: now ${stdout.columns}x${stdout.rows}]\n> `));

  return new Promise<number>(resolve => {
    let raw = false;
    stdin.on("end", () => {
      stdout.write("[EOF]\n");
      resolve(0);
    });
    stdin.on("data", async (chunk: Buffer) => {
      if (raw) {
        // Raw mode: every byte the terminal sent, as it arrived.
        const shown = [...chunk].map(byte => (byte === 0x1b ? "\\e" : byte < 0x20 || byte > 0x7e ? `\\x${byte.toString(16).padStart(2, "0")}` : String.fromCharCode(byte))).join("");
        stdout.write(`read ${chunk.length}: ${shown}\n`);
        if (chunk.length === 1 && chunk[0] === 0x71) {
          stdin.setRawMode(false);
          raw = false;
          stdout.write("cooked again\n> ");
        }
        return;
      }
      const [command, ...rest] = chunk.toString("utf8").trim().split(/\s+/);
      const argument = rest.join(" ");
      if (command === "exit") return resolve(Number(argument) || 0);
      if (command === "raw") {
        stdin.setRawMode(true);
        raw = true;
        stdout.write("raw mode: bytes are shown as read, q leaves\n");
        return;
      } else if (command === "flood") {
        // Far more output than the page takes at once: process.stdout.write
        // must pause this program (output flow control) instead of queueing it.
        const line = `${"flood ".repeat(170)}\n`; // 1021 bytes
        const count = Math.round((Number(argument) || 4) * 1024 * 1024 / line.length);
        const before = context.machine.outputStats();
        for (let i = 0; i < count; i++) stdout.write(line);
        const after = context.machine.outputStats();
        stdout.write(`flood done: ${after.bytes - before.bytes} bytes, paused ${after.waits - before.waits} times for the page\n`);
      } else if (command === "copy") {
        await context.clipboard.writeText(argument);
        stdout.write("copied\n");
      } else if (command === "paste") {
        stdout.write(await context.clipboard.readText().then(value => `clipboard: ${JSON.stringify(value)}\n`, error => `clipboard refused: ${error.message}\n`));
      } else if (command) stdout.write(`unknown command: ${command}\n`);
      stdout.write("> ");
    });
  });
}
