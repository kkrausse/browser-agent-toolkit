import { useRef, useSyncExternalStore } from "react";
import type { ChatController, ChatState } from "@kkrausse/browser-agent-toolkit/browser";

/** The flat snapshot: a new object on every change of the chat. For the parts of the view
 * that show its scalars; the transcript reads the store per session instead. */
export const useChatSnapshot = (controller: ChatController) =>
  useSyncExternalStore(controller.store.subscribe, controller.getSnapshot, controller.getSnapshot);

/** One value of the chat's state: the component renders again only when it changes
 * (`Object.is`, or `equal` for a value the selector builds). */
export function useChatState<A>(controller: ChatController, selector: (state: ChatState) => A, equal: (a: A, b: A) => boolean = Object.is): A {
  const last = useRef<{ value: A }>(undefined);
  const get = () => {
    const next = selector(controller.store.get());
    if (last.current && equal(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  };
  return useSyncExternalStore(controller.store.subscribe, get, get);
}

/** A request whose failure the controller already reports in the snapshot. */
export const run = (promise: Promise<unknown>) => { void promise.catch(() => {}); };

export const sameItems = <A,>(a: readonly A[], b: readonly A[]) => a.length === b.length && a.every((item, index) => item === b[index]);

export type OpenFile = (path: string, selection?: { startLine: number; endLine: number }) => void;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/** A moment, as the clock shows it: never a duration or a countdown. */
export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
