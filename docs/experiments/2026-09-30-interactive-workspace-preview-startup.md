# Interactive workspace preview startup ordering

Parent-owned browser acceptance on the existing `127.0.0.1:54770` origin
(PID 88406, no host restart) found an interrupted switch to manifest-seeded
Smoke A. Chat completed startup while Vite emitted no stdout/stderr and exhausted
the existing 30-second listen budget. One retry behaved identically. Recovery
of outgoing Current workspace succeeded, preserving saved source/native chats.

Offline inspection found that the interactive app launches Vite and OpenCode
concurrently, whereas the qualified single-kernel correctness driver explicitly
starts and qualifies Vite before OpenCode to avoid competing guest starts.
The prepared manifest still uses the upstream Vite CLI entrypoint, native config
loader, fixed port 5173, and the same managed dependency image. No new recipe or
dependency generation is needed to change application-owned startup order.

The app now awaits preview service and client readiness before starting chat.
Per-service readiness budgets, runtime ownership/cleanup, source delivery, saved
catalog, pending journal, and outgoing recovery are unchanged. This is a bounded
ordering repair and discriminating browser candidate, **not proof of the precise
guest scheduling cause or completed browser acceptance**. Source/config
comparison with the parent's restored Current workspace remains useful.

Actual recipe boundary tests prove chat is not started while preview startup is
pending, verify restoration/connect ordering, and ensure preview listen/HTTP/
client or chat failures cannot publish Ready. Startup and workspace switch/native
session tests: **21 pass, 0 fail**. These are offline boundary controls; only the
parent's Smoke A / Current round trip can establish UI acceptance.

No browser commands, source mutations, catalog deletes, snapshot replacement,
generated runtime edits, dependency builds, or host restarts were performed.
