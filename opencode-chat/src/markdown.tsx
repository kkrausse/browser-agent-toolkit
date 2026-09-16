import { Fragment, memo, useState, type ReactNode } from "react";
import { Lexer, type Token } from "marked";
import { Button } from "./components/ui/button";

/** HTML is rendered as text; only explicit safe link schemes become anchors. */
export function safeHref(href: string): string | undefined {
  const value = href.trim();
  if (/^(https?:|mailto:)/i.test(value) || /^(#|\/(?!\/)|\.\.?\/)/.test(value))
    return value;
  return undefined;
}
export function CodeBlock({
  text,
  language,
}: {
  text: string;
  language?: string;
}) {
  const [status, setStatus] = useState("");
  return (
    <div className="oc-code">
      <header>
        <span>{language || "Code"}</span>
        <Button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => setStatus("Copied"),
              () => setStatus("Copy failed"),
            );
          }}
        >
          Copy
        </Button>
        <span role="status">{status}</span>
      </header>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
function tokens(items: Token[]): ReactNode {
  return items.map((token, i) => {
    const children =
      "tokens" in token && token.tokens
        ? tokens(token.tokens)
        : "text" in token
          ? String(token.text)
          : token.raw;
    switch (token.type) {
      case "space":
        return null;
      case "text":
        return <Fragment key={i}>{children}</Fragment>;
      case "code":
        return <CodeBlock key={i} text={token.text} language={token.lang} />;
      case "heading":
        return (
          <p className="oc-heading" key={i}>
            {children}
          </p>
        );
      case "paragraph":
        return <p key={i}>{children}</p>;
      case "strong":
        return <strong key={i}>{children}</strong>;
      case "em":
        return <em key={i}>{children}</em>;
      case "del":
        return <del key={i}>{children}</del>;
      case "codespan":
        return <code key={i}>{token.text}</code>;
      case "br":
        return <br key={i} />;
      case "hr":
        return <hr key={i} />;
      case "blockquote":
        return <blockquote key={i}>{children}</blockquote>;
      case "link":
        return safeHref(token.href) ? (
          <a
            key={i}
            href={safeHref(token.href)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        ) : (
          <span key={i}>{children}</span>
        );
      case "image":
        return <span key={i}>[Image: {token.text}]</span>;
      case "list": {
        const Tag = token.ordered ? "ol" : "ul";
        return (
          <Tag key={i}>
            {token.items.map((item: { tokens: Token[] }, j: number) => (
              <li key={j}>{tokens(item.tokens)}</li>
            ))}
          </Tag>
        );
      }
      case "table":
        return (
          <div className="oc-table" key={i}>
            <table>
              <thead>
                <tr>
                  {token.header.map((cell: { tokens: Token[] }, j: number) => (
                    <th key={j}>{tokens(cell.tokens)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {token.rows.map((row: { tokens: Token[] }[], j: number) => (
                  <tr key={j}>
                    {row.map((cell, k) => (
                      <td key={k}>{tokens(cell.tokens)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "html":
        return <span key={i}>{token.raw}</span>;
      default:
        return <span key={i}>{children}</span>;
    }
  });
}
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  try {
    return <div className="oc-markdown">{tokens(Lexer.lex(text))}</div>;
  } catch {
    return <pre>{text}</pre>;
  }
});
