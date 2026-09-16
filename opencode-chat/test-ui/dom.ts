import { Window } from "happy-dom";
const window = new Window({ url: "http://localhost" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "DocumentFragment", "MutationObserver", "ResizeObserver", "IntersectionObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
  const value = name === "window" ? window : window[name as keyof Window];
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && /^[a-z]/.test(name) ? value.bind(window) : value });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
