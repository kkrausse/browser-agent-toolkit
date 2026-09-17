import { assert, browserCase, capture, equalBytes, mount, type BrowserTest } from "./harness.js";
import { httpTests } from "./http-cases.js";
import { processTests } from "./process-cases.js";
import { storageTests } from "./storage-cases.js";

const encoder = new TextEncoder();
export const tests: BrowserTest[] = [
  ...httpTests,
  ...processTests,
  ...storageTests,
  {
    name: "failed case releases workspace and running process",
    steps: [async () => {
      const failure = new Error("intentional case failure");
      let caught = false;
      try {
        await browserCase(async ({ workspace, runtime }) => {
          await mount(workspace, { "/waiting.cjs": "setInterval(() => {}, 1000);" });
          await runtime.node({ entry: "/workspace/waiting.cjs" });
          throw failure;
        });
      } catch (error) {
        assert(error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === failure,
          `Unexpected case/cleanup failure: ${String(error)}`);
        caught = true;
      }
      assert(caught, "Expected callback failure to propagate");
      await browserCase(async ({ workspace }) => {
        assert(workspace.persistence.status === "durable", "Failed case leaked its storage lease");
      });
    }],
  },
  {
    name: "binary stdin/stdout and natural exit",
    steps: [() => browserCase(async ({ workspace, runtime }) => {
      await mount(workspace, { "/echo.cjs": `
        process.stdin.on('data', chunk => process.stdout.write(chunk));
        process.stdin.on('end', () => process.stderr.write('EOF\\n'));
      ` });
      const execution = await runtime.node({ entry: "/workspace/echo.cjs" });
      const result = capture(execution);
      const bytes = new Uint8Array([0, 255, 128, 10, 65]);
      execution.writeStdin(bytes);
      execution.closeStdin();
      const { stdout, stderr, exit } = await result;
      equalBytes(stdout, bytes);
      equalBytes(stderr, encoder.encode("EOF\n"));
      assert(exit.exitCode === 0 && exit.signal === null && !exit.forced, "Expected natural exit 0");
    })],
  },
  {
    name: "endpoint binary response and orderly server exit",
    steps: [() => browserCase(async ({ workspace, runtime }) => {
      await mount(workspace, { "/server.cjs": `
        const server = require('node:http').createServer((req, res) => {
          res.writeHead(201, {'content-type': 'application/octet-stream'});
          res.end(Buffer.from([0, 255, 128, 65]));
        }).listen(3210);
        process.stdin.resume();
        process.stdin.on('end', () => server.close());
      ` });
      const execution = await runtime.node({ entry: "/workspace/server.cjs" });
      const result = capture(execution);
      const endpoint = await runtime.expose(3210, { signal: AbortSignal.timeout(15_000) });
      const response = await endpoint.fetch("/bytes");
      assert(response.status === 201, `Unexpected status ${response.status}`);
      equalBytes(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 255, 128, 65]));
      execution.closeStdin();
      const { exit } = await result;
      assert(exit.exitCode === 0 && !exit.forced, "Server did not exit naturally");
      await endpoint.closed;
    })],
  },
  {
    name: "acknowledged bytes survive browser reload",
    steps: [
      () => browserCase(async ({ workspace }) => {
        await workspace.fs.writeFile("/retained.bin", new Uint8Array([0, 128, 255, 42]));
        await workspace.flush();
        assert(workspace.persistence.status === "durable", "Flush did not leave durable storage");
      }),
      () => browserCase(async ({ workspace }) => {
        equalBytes(await workspace.fs.readFile("/retained.bin"), new Uint8Array([0, 128, 255, 42]));
        assert(workspace.persistence.status === "durable", "Reload did not restore durable storage");
      }),
    ],
  },
];
