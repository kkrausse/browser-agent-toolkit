// The scrolling transcript of the selected session.
//
// It follows the stream while the user is at the end, and stops the moment they scroll up
// (a control then jumps back). Following is decided by scrolling alone: selecting text
// neither stops it nor is disturbed by it, because a delta only re-renders the block it
// lands in. Older history is read when the user nears the top, and the view stays on what
// it showed.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { ChatController } from "@kkrausse/browser-agent-toolkit/browser";
import { run, useChatState, type OpenFile } from "./hooks";
import { SessionRows } from "./parts";
import { Button } from "./ui/button";

/** How close to the end still counts as being at it. */
const nearEnd = 48;
/** How close to the start asks for older history. */
const nearStart = 240;

export function Transcript({ controller, onOpenFile }: { controller: ChatController; onOpenFile?: OpenFile }) {
  const sessionID = useChatState(controller, state => state.sessionID);
  const session = useChatState(controller, state => (state.sessionID ? state.sessions[state.sessionID] : undefined));
  const ready = useChatState(controller, state => state.ready);
  const loaded = !!session?.loaded, hasOlder = !!session?.older, loadingOlder = !!session?.loadingOlder;
  const count = session?.order.length ?? 0, first = session?.order[0];
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const toEnd = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);
  const follow = useCallback((value: boolean) => { following.current = value; setAway(!value); }, []);

  // A new session starts at its end.
  useLayoutEffect(() => { follow(true); toEnd(); }, [sessionID, loaded, follow, toEnd]);
  // Whatever grows the content (a delta, an opened tool, an image that loaded) keeps the end
  // in view while following.
  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (following.current) toEnd(); });
    observer.observe(element);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [toEnd]);
  // Older messages arrive above: keep what was on screen where it was. A browser that
  // anchors scrolling has done it already; then the offset is the expected one.
  const before = useRef<{ first?: string; height: number; top: number }>({ height: 0, top: 0 });
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const previous = before.current;
    if (previous.first && first !== previous.first && session?.order.includes(previous.first) && !following.current) {
      const expected = previous.top + (element.scrollHeight - previous.height);
      if (Math.abs(element.scrollTop - expected) > 1) element.scrollTop = expected;
    }
    before.current = { first, height: element.scrollHeight, top: element.scrollTop };
  });
  const loadOlder = useCallback(() => {
    const state = controller.store.get(), current = state.sessionID ? state.sessions[state.sessionID] : undefined;
    if (current?.loaded && current.older && !current.loadingOlder) run(controller.loadOlder());
  }, [controller]);
  // A transcript shorter than the view cannot be scrolled to ask for more.
  useEffect(() => {
    const element = viewport.current;
    if (element && loaded && hasOlder && !loadingOlder && element.scrollHeight <= element.clientHeight + nearStart) loadOlder();
  }, [loaded, hasOlder, loadingOlder, count, loadOlder]);

  // The user's own prompt is always shown: sending one resumes following.
  const lastPrompt = session?.order.findLast(id => session.messages[id]?.type === "user");
  useLayoutEffect(() => { if (lastPrompt) { follow(true); toEnd(); } }, [lastPrompt, follow, toEnd]);

  // Only a gesture of the user stops following. The offset also moves by itself (rows above
  // take their real height when first laid out, the browser keeps an anchor in place), and
  // that must not be taken for scrolling away.
  const gesture = useRef(0);
  const touched = () => { gesture.current = performance.now(); };
  const onScroll = () => {
    const element = viewport.current!;
    const top = element.scrollTop, distance = element.scrollHeight - top - element.clientHeight;
    if (distance <= nearEnd) { if (!following.current) follow(true); }
    else if (following.current && performance.now() - gesture.current < 400) follow(false);
    else if (following.current) toEnd();
    before.current = { ...before.current, top };
    if (top < nearStart) loadOlder();
  };
  return <div className="oc-transcript-wrap">
    <div className="oc-transcript" ref={viewport} role="log" aria-label="Conversation" aria-live="off" tabIndex={0} onScroll={onScroll}
      onWheel={touched} onTouchStart={touched} onTouchMove={touched} onPointerDown={touched} onKeyDown={touched}>
      <div className="oc-transcript-content" ref={content}>
        {sessionID && !loaded && <p className="oc-empty" role="status">Loading conversation…</p>}
        {loaded && hasOlder && <p className="oc-history-status" role="status">
          {loadingOlder ? "Loading earlier messages…" : <button type="button" className="oc-link" onClick={loadOlder}>Load earlier messages</button>}
        </p>}
        {(sessionID ? loaded && !count : ready) && <div className="oc-empty">
          <h3>{sessionID ? "What would you like to build?" : "Start a conversation"}</h3>
          <p>{sessionID ? "Ask a question, explore your code, or describe a change." : "Choose a session or create a new chat above."}</p>
        </div>}
        {sessionID && loaded && <SessionRows controller={controller} sessionID={sessionID} onOpenFile={onOpenFile} />}
      </div>
    </div>
    {away && <Button type="button" className="oc-jump" aria-label="Jump to latest" onClick={() => { follow(true); toEnd(); }}><ArrowDown aria-hidden="true" />Latest</Button>}
  </div>;
}
