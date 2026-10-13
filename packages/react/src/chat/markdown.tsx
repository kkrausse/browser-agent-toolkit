// Markdown as React elements (no HTML strings: model output is never parsed as HTML).
//
// A streaming text is cut into its top-level blocks. Every block but the last is finished:
// it is rendered once and memoised by its source, so a delta re-parses and re-renders only
// the last block. The cut itself is incremental as well (the text only grows: lexing
// resumes at the start of the last block). The unfinished tail is completed with `remend`
// (an open `**`, a half-written link) so it does not flicker between plain and formatted.
// The splitting follows OpenCode 2.0.26's `session-ui/src/components/markdown-stream.ts`
// (MIT, see ../../NOTICES.md).
import { Fragment, memo, useRef, useState, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";
import remend from "remend";
import { Check, Copy } from "lucide-react";
import { Button } from "./ui/button";

/** HTML is rendered as text; only explicit safe link schemes become anchors. */
export function safeHref(href: string): string | undefined {
  const value = href.trim();
  if (/^(https?:|mailto:)/i.test(value) || /^(#|\/(?!\/)|\.\.?\/)/.test(value)) return value;
  return undefined;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <Button type="button" variant="ghost" size="icon-sm" aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label}
    onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {}); }}>
    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
  </Button>;
}
export function CodeBlock({ text, language }: { text: string; language?: string }) {
  return <div className="oc-code">
    <header><span>{language || "code"}</span><CopyButton text={text} label="Copy code" /></header>
    <pre className="oc-pre"><code>{text}</code></pre>
  </div>;
}

function inline(items: Token[]): ReactNode {
  return items.map((token, i) => {
    const children = "tokens" in token && token.tokens ? inline(token.tokens) : "text" in token ? String(token.text) : token.raw;
    switch (token.type) {
      case "space": return null;
      case "text": case "escape": return <Fragment key={i}>{children}</Fragment>;
      case "code": return <CodeBlock key={i} text={token.text} language={(token as Tokens.Code).lang?.trim().split(/\s+/, 1)[0]} />;
      case "heading": {
        const Tag = `h${Math.min(6, Math.max(1, (token as Tokens.Heading).depth))}` as "h1";
        return <Tag className="oc-h" key={i}>{children}</Tag>;
      }
      case "paragraph": return <p key={i}>{children}</p>;
      case "strong": return <strong key={i}>{children}</strong>;
      case "em": return <em key={i}>{children}</em>;
      case "del": return <del key={i}>{children}</del>;
      case "codespan": return <code key={i}>{token.text}</code>;
      case "br": return <br key={i} />;
      case "hr": return <hr key={i} />;
      case "blockquote": return <blockquote key={i}>{children}</blockquote>;
      case "link": {
        const href = safeHref(token.href);
        return href ? <a key={i} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span key={i}>{children}</span>;
      }
      case "image": return <span key={i}>[Image: {token.text}]</span>;
      case "list": {
        const list = token as Tokens.List, Tag = list.ordered ? "ol" : "ul";
        return <Tag key={i} start={list.ordered && typeof list.start === "number" && list.start !== 1 ? list.start : undefined}>
          {list.items.map((item, j) => <li key={j}>{item.task && <input type="checkbox" checked={!!item.checked} readOnly disabled />}{inline(item.tokens)}</li>)}
        </Tag>;
      }
      case "table": {
        const table = token as Tokens.Table;
        return <div className="oc-table" key={i}><table>
          <thead><tr>{table.header.map((cell, j) => <th key={j}>{inline(cell.tokens)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, j) => <tr key={j}>{row.map((cell, k) => <td key={k}>{inline(cell.tokens)}</td>)}</tr>)}</tbody>
        </table></div>;
      }
      case "html": return <span key={i}>{token.raw}</span>;
      default: return <span key={i}>{children}</span>;
    }
  });
}

/** One top-level block, rendered from its source. A finished block's source never changes. */
const Block = memo(function Block({ source }: { source: string }) {
  try { return <>{inline(Lexer.lex(source))}</>; }
  catch { return <p>{source}</p>; }
});

interface Cut { text: string; blocks: string[] }
// Link reference definitions give meaning to text anywhere above them: no cutting then.
const hasReferences = (text: string) => text.includes("]:") && /^[ \t]{0,3}\[[^\]]+\]:[ \t]*\S/m.test(text);
function blocksOf(text: string): string[] {
  const blocks: string[] = [];
  for (const token of Lexer.lex(text)) {
    // Blank lines belong to the block before them, so the blocks join back into the text.
    if (token.type === "space" && blocks.length) blocks[blocks.length - 1] += token.raw;
    else blocks.push(token.raw);
  }
  return blocks;
}
/** The text's blocks, lexing only from the last block of the previous cut when the text grew. */
export function cut(previous: Cut | undefined, text: string): Cut {
  if (previous?.text === text) return previous;
  if (hasReferences(text)) return { text, blocks: [text] };
  if (!previous || previous.blocks.length < 2 || !text.startsWith(previous.text)) return { text, blocks: blocksOf(text) };
  const kept = previous.blocks.slice(0, -1);
  let offset = 0;
  for (const block of kept) offset += block.length;
  return { text, blocks: [...kept, ...blocksOf(text.slice(offset))] };
}

/** `live`: the text is still streaming. */
export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  const last = useRef<Cut>(undefined);
  let blocks: string[];
  try { blocks = (last.current = cut(last.current, text)).blocks; }
  catch { return <pre className="oc-pre">{text}</pre>; }
  return <div className="oc-markdown">
    {blocks.map((block, index) => <Block key={index} source={live && index === blocks.length - 1 ? heal(block) : block} />)}
  </div>;
});
function heal(source: string): string {
  try { return remend(source, { linkMode: "text-only" }); }
  catch { return source; }
}
