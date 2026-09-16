import type { Execution } from './types.js';

/** EOF is application-owned shutdown; forced stop is only the bounded fallback. */
export async function shutdownAtEOF(execution: Execution, drained: Promise<void>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    execution.closeStdin();
    const [result] = await Promise.race([
      Promise.all([execution.exited, drained]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Service EOF shutdown timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
    if (result.exitCode !== 0 || result.forced || result.signal !== null) throw Error(`Service EOF shutdown failed: ${JSON.stringify(result)}`);
  } catch (error) {
    await execution.stop();
    await drained;
    throw error;
  } finally { clearTimeout(timer); }
}
