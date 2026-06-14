/**
 * Inline pill rendered when assistant chat text contains a literal
 * `[connect:<slug>]` tag. Click → kicks off the same OAuth popup flow
 * the settings page uses.
 *
 * The tag→chip substitution lives in `main-chat/MarkdownContent.tsx`;
 * this component just renders one chip given a slug. Unknown slugs
 * fall back to literal text so a typo in the LLM output never breaks
 * the message render.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";

import { useComposio } from "@pin-ai/state";
import { triggerConnectorOAuth } from "./connector-card";
import { getToolkit } from "./toolkit-icons";
import { cn } from "../lib/utils";

interface ConnectChipProps {
  toolkit: string;
}

export function ConnectChip({ toolkit }: ConnectChipProps) {
  // Each chip instantiates its own useComposio (one /composio/status +
  // /composio/connections GET on mount). A long chat history with many
  // chips multiplies that. Acceptable in practice — the LLM emits at
  // most one nudge per turn, and the same chip rarely renders >1x per
  // session. If it becomes a hot path, lift composio into a context
  // provider and consume here. Drilling it through MarkdownContent's
  // four call sites + assistant-ui parts would be uglier than that.
  const composio = useComposio();
  const [busy, setBusy] = useState(false);
  const meta = getToolkit(toolkit);

  // Unknown slug → degrade to literal text. Prevents broken UI when
  // the LLM writes a slug we don't recognize.
  if (!meta) {
    return <span>[connect:{toolkit}]</span>;
  }

  const alreadyConnected = composio.isToolkitConnected(meta.canonicalSlug);
  const Icon = meta.icon;

  const handleClick = async () => {
    if (busy || alreadyConnected) return;
    setBusy(true);
    try {
      await triggerConnectorOAuth(meta.canonicalSlug, composio);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || alreadyConnected}
      title={alreadyConnected ? `${meta.label} already connected` : `Connect ${meta.label}`}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 rounded-full",
        "text-label leading-none align-baseline",
        "border border-foreground/15 bg-foreground/[0.04]",
        "hover:bg-foreground/[0.08] hover:border-foreground/25",
        "disabled:opacity-50 disabled:cursor-default",
        "transition-colors",
      )}
    >
      {busy ? (
        <Loader2 size={11} className="animate-spin" />
      ) : (
        <Icon size={11} />
      )}
      <span>{alreadyConnected ? `${meta.label} connected` : `Connect ${meta.label}`}</span>
    </button>
  );
}
