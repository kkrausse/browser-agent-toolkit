import { createChatController } from "./controller";
import { Effect } from "effect";
import type { ChatController } from "./types";
import type { Service, WorkspaceController } from "@kev-browser-agent-kit/workspace/react";

export interface WorkspaceChatOptions { serviceName?: string; directory?: string }
const chats = new WeakMap<Service, ChatController>();
export function chatFor(service: Service) { return chats.get(service); }
/** Attach once per service lifetime. The workspace stops clients before servers. */
const attachChatEffect = Effect.fn("Workspace.attachChat")(function*(owner: WorkspaceController, service: Service, options: WorkspaceChatOptions) {
  const name = options.serviceName ?? "chat";
  const signal = owner.signal;
  signal.throwIfAborted();
  let chat = chats.get(service);
  if (!chat) {
    chat = createChatController({
      endpoint: { url: service.connection.url, fetch: (input, init) => service.connection.fetch(input, init) },
      directory: options.directory ?? "/workspace", autoCreateSession: false,
    });
    chats.set(service, chat);
    const current = chat;
    const release = owner.registerAttachment(name, () => {
      signal.removeEventListener("abort", aborted);
      chats.delete(service); current.dispose();
    });
    function aborted() { release(); }
    signal.addEventListener("abort", aborted, { once: true });
  }
  const current = chat;
  yield* Effect.tryPromise({ try: () => current.ready, catch: (error: unknown) => error }).pipe(
    Effect.tapError(error => Effect.sync(() => {
      if (chats.get(service) === current) owner.clientFailed(name, error);
    })),
  );
  if (chats.get(service) === current) owner.clientReady(name);
  return current;
});

export function attachChat(owner: WorkspaceController, service: Service, options: WorkspaceChatOptions = {}) {
  return Effect.runPromise(attachChatEffect(owner, service, options), { signal: owner.signal });
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
    void Effect.runPromise(startWorkspace(controller, start), { signal: mount.signal }).catch(error => {
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
      const task = Effect.runPromise(closeWorkspace(controller, beforeClose));
      closing.set(controller, task);
      void task.catch(error => controller.reportError(error));
    }
  };
}
