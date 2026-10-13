import { createContext, useContext, useEffect, useState, type RefObject } from "react";

/** The scheme the chat is drawn in, for what is rendered outside its element (popups)
 * and for parts that cannot read CSS tokens (the diff view). */
export type ChatScheme = "light" | "dark";
const ThemeContext = createContext<ChatScheme>("light");
export const ChatThemeProvider = ThemeContext.Provider;
export const useChatTheme = () => useContext(ThemeContext);

/** Reads the scheme CSS resolved on the chat's root (styles.css sets `--oc-scheme` with
 * `light-dark()`), again whenever the system preference or a theme attribute or class on
 * the root or an ancestor changes. */
export function useResolvedScheme(root: RefObject<HTMLElement | null>): ChatScheme {
  const [scheme, setScheme] = useState<ChatScheme>("light");
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const read = () => {
      const declared = getComputedStyle(element).colorScheme;
      const dark = declared === "dark" || (declared !== "light" && matchMedia("(prefers-color-scheme: dark)").matches && declared.includes("dark"));
      setScheme(dark ? "dark" : "light");
    };
    read();
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", read);
    const observer = new MutationObserver(read);
    for (let node: HTMLElement | null = element; node; node = node.parentElement)
      observer.observe(node, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    return () => { media.removeEventListener("change", read); observer.disconnect(); };
  }, [root]);
  return scheme;
}
