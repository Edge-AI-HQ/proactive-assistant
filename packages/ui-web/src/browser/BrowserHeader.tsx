import { Globe, ChevronUp, CircleAlert } from "lucide-react";

interface BrowserHeaderProps {
  currentUrl: string;
  /** AI asked for help (request_takeover) — render the attention state so
   *  the user notices even though the panel is closed. Driven solely by the
   *  backend takeover signal; cleared when control returns to AI. */
  attention: boolean;
  attentionReason?: string | null;
  onOpen: () => void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The bar that sits on the top edge of the composer when a browser session
 * exists for this thread but its panel is closed. Click to open the panel.
 *
 * Two states: ambient (AI is browsing in the background — low-key) and
 * attention (AI hit a captcha / login / confirm and called request_takeover
 * — amber, since the panel is closed the user would otherwise miss it).
 */
export default function BrowserHeader({
  currentUrl,
  attention,
  attentionReason,
  onOpen,
}: BrowserHeaderProps) {
  const host = hostOf(currentUrl);

  if (attention) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2 rounded-2xl border border-amber-400/40 bg-amber-400/15 px-3.5 py-2.5 text-left transition-colors hover:bg-amber-400/25"
      >
        <CircleAlert size={15} className="shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1">
          <span className="block text-bodySm font-medium text-foreground">
            Browser needs you
          </span>
          {attentionReason ? (
            <span className="block truncate text-caption text-foreground/55">
              {attentionReason}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-caption font-semibold text-white">
          Open
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-2xl border border-foreground/[0.08] bg-foreground/[0.04] px-3.5 py-2 text-left transition-colors hover:bg-foreground/[0.07]"
    >
      <span className="relative flex shrink-0 items-center justify-center">
        <Globe size={15} className="text-foreground/55" />
        <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
      </span>
      <span className="min-w-0 flex-1 truncate text-bodySm text-foreground/70">
        {host ? (
          <>
            Browsing <span className="text-foreground/90">{host}</span>
          </>
        ) : (
          "Browser ready"
        )}
      </span>
      <ChevronUp size={15} className="shrink-0 text-foreground/40" />
    </button>
  );
}
