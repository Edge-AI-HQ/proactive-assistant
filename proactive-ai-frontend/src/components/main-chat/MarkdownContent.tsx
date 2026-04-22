/**
 * Markdown renderer for MainChatView assistant messages.
 *
 * Built on ReactMarkdown with:
 *   - remark-gfm for tables, task lists, strikethrough, autolinks
 *   - rehype-highlight for syntax highlighting (hljs classes)
 *   - custom components: code blocks (header + copy), external links (native
 *     Capacitor Browser for iOS/Android), table wrapper with horizontal scroll
 */
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Browser } from "@capacitor/browser";
import { isNative } from "@/lib/platform";
import CodeBlock from "./CodeBlock";

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

const components: Components = {
  pre({ children }) {
    // CodeBlock is rendered by the `code` handler; pre just passes through.
    return <>{children}</>;
  },
  code(props) {
    const { className, children, node, ...rest } = props as {
      className?: string;
      children?: ReactNode;
      node?: { tagName?: string };
      [key: string]: unknown;
    };
    const inline = !className || !/language-/.test(className);
    if (inline) {
      return (
        <code
          className="px-1 py-0.5 rounded bg-foreground/[0.06] text-[13px] font-mono text-foreground/85"
          {...rest}
        >
          {children}
        </code>
      );
    }
    const language = extractLanguage(className);
    const rawText = nodeText(children).replace(/\n$/, "");
    return (
      <CodeBlock language={language} rawText={rawText}>
        <code className={className} {...rest}>
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
          className="text-blue-600 hover:text-blue-700 underline decoration-blue-600/30 underline-offset-2"
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
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto rounded-lg border border-foreground/10">
        <table className="w-full text-[13px]">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="px-2 py-1.5 text-left font-medium text-foreground/70 border-b border-foreground/10 bg-foreground/[0.03]">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="px-2 py-1.5 text-foreground/80 border-b border-foreground/5">
        {children}
      </td>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 pl-3 border-l-2 border-foreground/20 text-foreground/60 italic">
        {children}
      </blockquote>
    );
  },
  img({ src, alt }) {
    return (
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        className="my-2 max-w-full rounded-lg"
      />
    );
  },
  hr() {
    return <hr className="my-3 border-foreground/10" />;
  },
};

export default function MarkdownContent({ text }: { text: string; [key: string]: unknown }) {
  return (
    <div className="prose max-w-none text-[17px] leading-[1.55] prose-p:my-2 prose-p:text-[17px] prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-li:text-[17px] prose-headings:my-2.5">
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
