import { Cause, Exit, Option, Tracer } from "effect";

export type SpanReport = (event: "span", data: Record<string, unknown>) => void;

// Error tags down the cause chain. Never messages: a decode error quotes the value it rejected.
function errorLabel(error: unknown): string {
  const tags: string[] = [];
  for (let current = error; tags.length < 4 && current && typeof current === "object";) {
    const value = current as { _tag?: unknown; name?: unknown; cause?: unknown };
    tags.push(String(value._tag ?? value.name ?? "Error").slice(0, 60));
    current = value.cause;
  }
  return tags.join(" < ") || typeof error;
}

/** The native tracer, reporting every span as it ends: name, duration, outcome and
 * parent name. Attributes are never reported. A throwing observer is ignored. */
export function spanTracer(report: SpanReport): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end;
      span.end = (endTime, exit) => {
        end.call(span, endTime, exit);
        try {
          const parent = Option.getOrUndefined(options.parent);
          report("span", {
            name: options.name,
            durationMs: Math.round(Number(endTime - options.startTime) / 1e4) / 100,
            ok: Exit.isSuccess(exit),
            ...(parent?._tag === "Span" ? { parent: parent.name } : {}),
            ...(Exit.isSuccess(exit) ? {}
              : Cause.hasInterrupts(exit.cause) ? { interrupted: true }
              : { error: errorLabel(Cause.squash(exit.cause)) }),
          });
        } catch { /* observer failure */ }
      };
      return span;
    },
  });
}
