// Run by web/drive.sh, which fills in the URL.
const url = "__URL__";
await page.goto(url);
await page.waitForFunction(() => globalThis.shellProto?.done, null, { timeout: 240000 });
return await page.evaluate(() => ({
  crossOriginIsolated,
  userAgent: navigator.userAgent,
  exit: shellProto.exit,
  workerStarts: shellProto.workerStarts,
  result: shellProto.result,
  tail: shellProto.result ? undefined : shellProto.output.slice(-3000),
}));
