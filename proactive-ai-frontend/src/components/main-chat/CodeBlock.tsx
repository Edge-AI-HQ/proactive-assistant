/**
 * Fenced code block rendering with a header (language + copy button) and
 * syntax-highlighted body. The body is pre-highlighted by rehype-highlight
 * (className looks like "hljs language-ts"); this component just wraps it.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  language: string | null;
  rawText: string;
  children: ReactNode;
}

export default function CodeBlock({ language, rawText, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-foreground/10 bg-foreground/[0.04]">
      <div className="flex items-center justify-between px-3 py-1 border-b border-foreground/10 bg-foreground/[0.03]">
        <span className="text-[11px] font-mono text-foreground/50">
          {language ?? "text"}
        </span>
        <button
          type="button"
          onClick={copy}
          className={cn(
            "flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px]",
            "text-foreground/50 hover:text-foreground/80 hover:bg-foreground/10",
            "transition-colors",
          )}
        >
          {copied ? (
            <>
              <Check size={11} strokeWidth={2} className="text-emerald-500" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy size={11} strokeWidth={1.8} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-[12.5px] leading-relaxed font-mono">
        {children}
      </pre>
    </div>
  );
}
