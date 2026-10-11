// Smallest OpenTUI program on the wasm core: proves the Zig
// renderer, Yoga layout and text buffers work compiled to wasm, emitting real
// escape sequences on stdout.
import { createCliRenderer, BoxRenderable, TextRenderable } from "@opentui/core"

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 })
const box = new BoxRenderable(renderer, {
  id: "box",
  border: true,
  borderStyle: "rounded",
  title: " opentui on wasm32-wasi ",
  padding: 1,
  flexDirection: "column",
  width: 46,
  height: 7,
  backgroundColor: "#1e1e2e",
  borderColor: "#89b4fa",
})
const text = new TextRenderable(renderer, { id: "t", content: "hello from the Zig core in wasm", fg: "#a6e3a1" })
const counter = new TextRenderable(renderer, { id: "c", content: "frame 0", fg: "#f9e2af" })
box.add(text)
box.add(counter)
renderer.root.add(box)

let frames = 0
const timer = setInterval(() => {
  counter.content = `tick ${++frames}`
}, 250)
renderer.keyInput.on("keypress", (key: { name: string }) => {
  if (key.name === "q") {
    clearInterval(timer)
    renderer.destroy()
  }
})
renderer.on("destroy", () => clearInterval(timer))
const seconds = Number(process.env.DEMO_SECONDS ?? 0)
if (seconds > 0) setTimeout(() => renderer.destroy(), seconds * 1000)
