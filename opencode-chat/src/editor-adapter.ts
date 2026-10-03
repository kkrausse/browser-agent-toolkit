import { createChatController } from "./controller";
import { Effect } from "effect";
import { spanTracer } from "./span-diagnostics";
import type { ChatController } from "./types";
import type { Service, WorkspaceController } from "@kev-browser-agent-kit/workspace/react";

export interface WorkspaceChatOptions { serviceName?: string; directory?: string; startNewSession?: boolean }
const chats = new WeakMap<Service, ChatController>();
export function chatFor(service: Service) { return chats.get(service); }
/** Dispose the service's chat client and forget it while the service keeps running;
 * the next attachChat mounts a fresh controller on the same service. Resolves once
 * the client's streams and requests have been joined. */
export async function detachChat(service: Service): Promise<void> {
  const chat = chats.get(service);
  if (!chat) return;
  chats.delete(service);
  await chat.dispose();
}
/** Attach once per service lifetime, or once per detachChat. The workspace stops
 * clients before servers. */
const attachChatEffect = Effect.fn("Workspace.attachChat")(function*(owner: WorkspaceController, service: Service, options: WorkspaceChatOptions) {
  const name = options.serviceName ?? "chat";
  const signal = owner.signal;
  signal.throwIfAborted();
  // Timing only. Tolerates an owner from an older workspace build or a failing sink.
  const diagnostic = (event: string, data?: Record<string, unknown>) => { try { owner.diagnostic?.(event, { name, ...data }); } catch { /* observation only */ } };
  let chat = chats.get(service);
  if (!chat) {
    chat = createChatController({
      endpoint: { url: service.connection.url, fetch: (input, init) => service.connection.fetch(input, init) },
      directory: options.directory ?? "/workspace",
      // A workspace with no session yet opens on a new one, so the prompt box works
      // at once instead of waiting for "New session" in the session menu.
      autoCreateSession: true, startNewSession: options.startNewSession,
      onDiagnostic: diagnostic,
    });
    chats.set(service, chat);
    const current = chat;
    const release = owner.registerAttachment(name, () => {
      signal.removeEventListener("abort", aborted);
      // A controller attached after detachChat owns the entry by then; leave it.
      if (chats.get(service) === current) chats.delete(service);
      current.dispose();
    });
    function aborted() { release(); }
    signal.addEventListener("abort", aborted, { once: true });
  }
  const current = chat;
  const started = performance.now(), elapsedMs = () => Math.round(performance.now() - started);
  diagnostic("chat.attach.start");
  yield* Effect.tryPromise({ try: () => current.ready, catch: (error: unknown) => error }).pipe(
    Effect.tapError(error => Effect.sync(() => {
      diagnostic("chat.attach.failed", { elapsedMs: elapsedMs(), error });
      if (chats.get(service) === current) owner.clientFailed(name, error);
    })),
  );
  diagnostic("chat.attach.ready", { elapsedMs: elapsedMs() });
  if (chats.get(service) === current) owner.clientReady(name);
  return current;
});

// These effects run outside the chat runtime; their spans go to the same workspace sink.
const traced = <A, E>(effect: Effect.Effect<A, E>, owner: WorkspaceController) =>
  Effect.withTracer(effect, spanTracer((event, data) => owner.diagnostic?.(event, data)));

export function attachChat(owner: WorkspaceController, service: Service, options: WorkspaceChatOptions = {}) {
  return Effect.runPromise(traced(attachChatEffect(owner, service, options), owner), { signal: owner.signal });
}

/** StrictMode-safe admission and serialized close/start on a reusable controller. */
const closing = new WeakMap<WorkspaceController, Promise<void>>();
const lifecycleTask = (task: () => Promise<void>) => Effect.tryPromise({
  try: task,
  catch: (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause)),
});
const startWorkspace = Effect.fn("Workspace.start")(function*(controller: WorkspaceController, start: (controller: WorkspaceController) => Promise<void>) {
  yield* lifecycleTask(() => closing.get(controller) ?? Promise.resolve());
  yield* lifecycleTask(() => controller.cancelAndClose());
  yield* lifecycleTask(() => controller.run("Start editing", () => start(controller)));
});
const closeWorkspace = Effect.fn("Workspace.close")(function*(controller: WorkspaceController, beforeClose: () => Promise<void>) {
  yield* lifecycleTask(beforeClose).pipe(Effect.catch(error => Effect.sync(() => controller.reportError(error))));
  yield* lifecycleTask(() => controller.cancelAndClose());
});
export function editorLifecycle(controller: WorkspaceController, start: (controller: WorkspaceController) => Promise<void>, beforeClose: () => Promise<void> = async () => {}) {
  const mount = new AbortController();
  let admitted = false;
  queueMicrotask(() => {
    if (mount.signal.aborted) return;
    admitted = true;
    void Effect.runPromise(traced(startWorkspace(controller, start), controller), { signal: mount.signal }).catch(error => {
      if (!mount.signal.aborted) controller.reportError(error);
    });
  });
  return () => {
    if (mount.signal.aborted) return;
    mount.abort();
    if (admitted) {
      // Cleanup has its own lifetime: a remount must await it even after the
      // previous startup fiber has been interrupted. The controller cancels the
      // underlying workspace operations through cancelAndClose.
      const task = Effect.runPromise(traced(closeWorkspace(controller, beforeClose), controller));
      closing.set(controller, task);
      void task.catch(error => controller.reportError(error));
    }
  };
}
