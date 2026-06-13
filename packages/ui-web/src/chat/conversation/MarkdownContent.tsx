/**
 * Markdown renderer for ConversationView assistant messages.
 *
 * Built on ReactMarkdown with:
 *   - remark-gfm for tables, task lists, strikethrough, autolinks
 *   - rehype-highlight for syntax highlighting (hljs classes)
 *   - custom components: code blocks (header + copy via CodeBlock),
 *     external links (native Capacitor Browser for iOS/Android),
 *     table wrapper with horizontal scroll, task-list checkboxes.
 *
 * Visual style matches the minimalist conversation design — 13px body,
 * compact heading hierarchy, muted list markers, glassy code/table chrome.
 * `muted` flips body text from /85 to /60 for embedded contexts like the
 * collapsed thinking-block expansion.
 */
import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Browser } from "@capacitor/browser";
import { isNative } from "../../auth/platform";
import CodeBlock from "./CodeBlock";
import { ConnectChip } from "../../connect/ConnectChip";

interface MarkdownContentProps {
  text: string;
  muted?: boolean;
  className?: string;
}

function isExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^https?:\/\//i.test(href);
}

async function openLink(href: string) {
  if (isNative) {
    try {
      await Browser.open({ url: href });
      return;
    } catch {
      /* fall through to window.open */
    }
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

function extractLanguage(className: string | undefined): string | null {
  if (!className) return null;
  const match = /language-([\w-]+)/i.exec(className);
  return match ? match[1].toLowerCase() : null;
}

function nodeText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return nodeText(props?.children);
  }
  return "";
}

// Matches the literal `[connect:<slug>]` tag the chat agent emits per the
// <connector_nudges> prompt section in main_chat.py. Slugs are lower-case
// ASCII + underscore (gmail, google_calendar, …).
const CONNECT_TAG_RE = /\[connect:([a-z_]+)\]/g;

/**
 * Replace any literal `[connect:<slug>]` substrings inside ReactMarkdown's
 * string children with an inline <ConnectChip toolkit={slug} />. Recurses
 * into nested elements (<em>, <strong>) so a tag wrapped in emphasis still
 * renders. Strings without "[connect:" pass through untouched (zero cost
 * for normal messages); code/pre bypass this since they don't call it.
 */
function transformChildren(children: ReactNode): ReactNode {
  if (children == null) return children;
  if (Array.isArray(children)) {
    return Children.map(children, (child, i) => (
      <Fragment key={i}>{transformChildren(child)}</Fragment>
    ));
  }
  if (typeof children === "string") {
    if (!children.includes("[connect:")) return children;
    const parts: ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    CONNECT_TAG_RE.lastIndex = 0;
    while ((match = CONNECT_TAG_RE.exec(children)) !== null) {
      if (match.index > lastIndex) parts.push(children.slice(lastIndex, match.index));
      parts.push(<ConnectChip key={`c-${match.index}`} toolkit={match[1]} />);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < children.length) parts.push(children.slice(lastIndex));
    return parts.length === 1 ? parts[0] : <>{parts}</>;
  }
  if (isValidElement(children)) {
    const element = children as ReactElement<{ children?: ReactNode }>;
    const inner = element.props?.children;
    if (inner == null) return children;
    return cloneElement(element, undefined, transformChildren(inner));
  }
  return children;
}

export default function MarkdownContent({
  text,
  muted = false,
  className = "",
}: MarkdownContentProps) {
  const bodyColor = muted ? "text-foreground/60" : "text-foreground/85";

  const components: Components = {
    p: ({ children }) => (
      <p
        className={`text-[13px] leading-relaxed my-2 first:mt-0 last:mb-0 ${bodyColor}`}
      >
        {transformChildren(children)}
      </p>
    ),
    h1: ({ children }) => (
      <h1 className="text-display text-[17px] font-semibold text-foreground tracking-tight mt-3.5 mb-1.5 first:mt-0">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-display text-[15px] font-semibold text-foreground tracking-tight mt-3 mb-1.5 first:mt-0">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-[13.5px] font-semibold text-foreground mt-2.5 mb-1 first:mt-0">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-[11px] font-bold uppercase tracking-[0.12em] text-foreground/55 mt-2.5 mb-1 first:mt-0">
        {children}
      </h4>
    ),
    ul: ({ children }) => (
      <ul className="list-disc pl-5 my-2 space-y-1 marker:text-foreground/30 first:mt-0 last:mb-0">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-5 my-2 space-y-1 marker:text-foreground/45 first:mt-0 last:mb-0">
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className={`text-[13px] leading-relaxed pl-0.5 ${bodyColor}`}>
        {transformChildren(children)}
      </li>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-foreground">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => (
      <del className="text-foreground/45 line-through decoration-foreground/35">
        {children}
      </del>
    ),
    pre({ children }) {
      // CodeBlock is rendered by the `code` handler; pre just passes through.
      return <>{children}</>;
    },
    code(props) {
      const { className: codeClass, children, node, ...rest } = props as {
        className?: string;
        children?: ReactNode;
        node?: { tagName?: string };
        [key: string]: unknown;
      };
      const inline = !codeClass || !/language-/.test(codeClass);
      if (inline) {
        return (
          <code
            className="px-1.5 py-0.5 mx-[1px] rounded-md text-[12px] font-mono bg-foreground/[0.06] text-foreground/85 border border-foreground/[0.05]"
            {...rest}
          >
            {children}
          </code>
        );
      }
      const language = extractLanguage(codeClass);
      const rawText = nodeText(children).replace(/\n$/, "");
      return (
        <CodeBlock language={language} rawText={rawText}>
          <code className={codeClass} {...rest}>
            {children}
          </code>
        </CodeBlock>
      );
    },
    a({ href, children, ...rest }) {
      if (isExternalHref(href)) {
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              if (href) void openLink(href);
            }}
            className="text-foreground font-medium underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground/65 transition-colors"
            {...rest}
          >
            {children}
          </a>
        );
      }
      return (
        <a href={href} {...rest}>
          {children}
        </a>
      );
    },
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-foreground/15 pl-3 my-3 text-foreground/65 italic [&>p]:my-1 first:mt-0 last:mb-0">
        {children}
      </blockquote>
    ),
    table: ({ children }) => (
      <div className="my-3 -mx-0.5 overflow-x-auto first:mt-0 last:mb-0">
        <table className="w-full text-[12.5px] border-collapse">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead>{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => (
      <tr className="border-b border-foreground/[0.06] last:border-b-0">
        {children}
      </tr>
    ),
    th: ({ children }) => (
      <th className="text-left px-2.5 py-1.5 font-semibold text-foreground/85 bg-foreground/[0.04] first:rounded-l-md last:rounded-r-md">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className={`px-2.5 py-1.5 align-top ${bodyColor}`}>{children}</td>
    ),
    hr: () => <hr className="my-4 border-foreground/10" />,
    img: ({ src, alt }) => (
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        className="my-3 rounded-xl border border-foreground/[0.08] max-w-full"
      />
    ),
    // GFM task list checkbox
    input: ({ type, checked, disabled }) =>
      type === "checkbox" ? (
        <input
          type="checkbox"
          checked={!!checked}
          disabled={disabled}
          readOnly
          className="mr-1.5 -ml-5 align-middle accent-foreground/70"
        />
      ) : null,
  };

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
