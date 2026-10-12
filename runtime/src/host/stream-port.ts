// A body between two threads where a ReadableStream cannot be transferred.
//
// The preview bridge sends bodies of unknown or large size as transferred streams. Safari on
// iOS 18 cannot transfer a ReadableStream (`postMessage` throws DataCloneError; Playwright's
// WebKit 27.2 can, which is why nothing showed there): every preview response over 256 KB
// was then never delivered, the frame's module graph waited for ever and the app stayed
// blank (docs/experiments/2026-10-11-webkit-try.md, section 7). Where transfer is missing
// the body crosses a MessagePort instead, which every engine can transfer: the reading side
// asks for a chunk at a time, so backpressure and cancellation still reach the source.

let transferable: boolean | undefined
let forced = false
/** For a check in an engine that can transfer streams: behave as one that cannot. */
export function withoutStreamTransfer(): void {
  forced = true
}
/** Whether this thread can transfer a ReadableStream. */
export function canTransferStreams(): boolean {
  if (forced) return false
  if (transferable !== undefined) return transferable
  try {
    const { port1, port2 } = new MessageChannel()
    const probe = new ReadableStream()
    port1.postMessage(probe, [probe as unknown as Transferable])
    port1.close()
    port2.close()
    transferable = true
  } catch {
    transferable = false
  }
  return transferable
}

type FromSource = { t: 'chunk'; data: Uint8Array } | { t: 'end' } | { t: 'error'; message: string }

/** The far end of `stream`: transfer the returned port and give it to `portToStream` there. */
export function streamToPort(stream: ReadableStream<Uint8Array>): MessagePort {
  const { port1, port2 } = new MessageChannel()
  const reader = stream.getReader()
  const say = (message: FromSource, transfer: Transferable[] = []) => port1.postMessage(message, transfer)
  port1.onmessage = async (e: MessageEvent<'pull' | 'cancel'>) => {
    if (e.data === 'cancel') {
      void reader.cancel().catch(() => {})
      return port1.close()
    }
    try {
      const { done, value } = await reader.read()
      if (done) {
        say({ t: 'end' })
        return port1.close()
      }
      // A copy: the chunk may be a view of memory that is shared or used again.
      const data = value.slice()
      say({ t: 'chunk', data }, [data.buffer])
    } catch (error) {
      say({ t: 'error', message: String((error as Error)?.message ?? error) })
      port1.close()
    }
  }
  return port2
}

export function portToStream(port: MessagePort): ReadableStream<Uint8Array> {
  let answered: (() => void) | undefined
  return new ReadableStream<Uint8Array>({
    start(controller) {
      port.onmessage = (e: MessageEvent<FromSource>) => {
        const said = e.data
        if (said.t === 'chunk') controller.enqueue(said.data)
        else {
          if (said.t === 'end') controller.close()
          else controller.error(new Error(said.message))
          port.close()
        }
        answered?.()
      }
    },
    pull() {
      port.postMessage('pull')
      return new Promise<void>((resolve) => {
        answered = resolve
      })
    },
    cancel() {
      port.postMessage('cancel')
      port.close()
    },
  })
}
