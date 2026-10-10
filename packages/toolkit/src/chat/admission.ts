import type { ChatSnapshot } from "./types";

/** The one send-admission predicate. The controller enforces it and the UI
 * renders from it; do not restate these conditions at a call site. */
export function canSend(state: ChatSnapshot): boolean {
  return !!state.sessionID && state.connection === "connected" && !state.loading && !state.sending &&
    !state.sessionOperationPending && !state.held && state.execution === "idle";
}

/** A session is being created, selected or re-modelled and send admission is expected
 * to follow by itself. The footer shows "Preparing chat…" and the composer may park a
 * send for exactly this state, never for one that needs the user (held, disconnected). */
export function isPreparing(state: ChatSnapshot): boolean {
  return state.connection === "connected" && !state.held && (state.loading || !!state.sessionOperationPending);
}

/** Why an exclusive hold cannot be acquired; undefined when the chat is quiescent.
 * Stricter than canSend: pending requests and history drains also block a hold. */
export function holdBlocker(state: ChatSnapshot): string | undefined {
  if (state.held) return `already held (${state.held})`;
  if (state.connection !== "connected") return `chat is ${state.connection}`;
  if (state.loading || state.loadingOlder) return "history is loading";
  if (state.sessionOperationPending) return "a session operation is pending";
  if (state.sending) return "a message is being sent";
  if (state.execution !== "idle") return `execution is ${state.execution}`;
  if (state.interruptRequested) return "an interrupt is pending";
  if (state.permissions.length) return "a permission request is pending";
  if (state.questions.length || state.unsupportedForms.length) return "a question is pending";
  return undefined;
}
