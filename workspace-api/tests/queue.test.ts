import { expect, test } from "bun:test";
import { ByteQueue } from "../src/execution";
import { workspacePath } from "../src/workspace";

test("byte queue preserves arbitrary chunks and drains final bytes before EOF", async () => {
  const queue = new ByteQueue(() => { throw new Error("unexpected overflow"); });
  queue.push(Uint8Array.of(0, 255, 0xc3));
  queue.push(Uint8Array.of(0xa9));
  queue.end();
  const bytes: number[] = [];
  for await (const chunk of queue) bytes.push(...chunk);
  expect(bytes).toEqual([0, 255, 0xc3, 0xa9]);
  await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow("one reader");
});
test("overflow is retained after process exit and terminates once", async () => {
  let stopped = 0;
  const queue = new ByteQueue(() => { stopped++; }, 3);
  queue.push(Uint8Array.of(1, 2)); queue.push(Uint8Array.of(3, 4));
  queue.push(Uint8Array.of(5)); queue.end();
  expect(stopped).toBe(1);
  await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow("exceeded");
});
test("workspace paths cannot escape into runtime-owned files", () => {
  expect(workspacePath("/")).toBe("/workspace");
  expect(workspacePath("/src/a.ts")).toBe("/workspace/src/a.ts");
  for (const path of ["/../bin/node.js", "relative", "/x/../../tmp", "/x\0y"]) expect(() => workspacePath(path)).toThrow();
});
