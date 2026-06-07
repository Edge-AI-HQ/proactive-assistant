import {
  Sprout,
  Briefcase,
  TrendingUp,
  Heart,
  BookOpen,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { GoalBasket, IntentCard } from "@/types/intent-card";
import type { ChatCard } from "@/components/chat/ChatDetailView";

/** Stable string→number hash so real card.id (string) gets a numeric id for
 *  Lovable's sphere components without losing the original. */
export function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return Math.abs(h | 0);
}

export function basketToLovableCategory(basket: GoalBasket): string {
  switch (basket) {
    case "wealth": return "finance";
    case "family": return "life";
    default: return basket;
  }
}

/* ── Card data (reused from NowFeed) ── */

export interface ExecutionStep { text: string; tool: string; }
export interface Artifact {
  kind: "email" | "notes" | "message" | "doc";
  app: "gmail" | "slack" | "notion" | "gdocs";
  title: string;        // e.g. subject, channel, page name
  meta?: string;        // e.g. "To: alex@acme.com · Draft", "#finance · DM"
  body: string;         // multi-line content; \n preserved
}
export interface DetailData {
  scores: { label: string; value: number }[];
  willExecute: string;
  executionPlan: ExecutionStep[];
  dataSources: string[];
  impact: string;
  permissions: string;
  result?: string;
  artifacts?: Artifact[];
}
export type CardStatus = "normal" | "new" | "processing" | "done";
export interface Intent {
  id: number;
  category: string;
  tag?: string;
  complexity?: "simple"; // marks quick-approve tasks (low risk, few steps)
  locked?: boolean; // requires Pro to approve
  title: string;
  line1: string;
  line2: string;
  /** Generator-side rationale; rendered as a dedicated "WHY NOW" block
   *  in CardDrawerContent → DrawerDetailBody. Optional because legacy
   *  Lovable mock entries don't carry it. */
  whyNow?: string;
  detail?: DetailData;
  status: CardStatus;
  statusTimestamp?: number; // when status was set
  /** Set when the card came from real /api/cards (string id). handleExecute
   *  uses it to look up the real IntentCard and feed our MainChatView runtime. */
  originalId?: string;
}

/** Real IntentCard (from /api/cards) → ChatDetailView's ChatCard shape
 *  (Lovable-era visual contract: numeric ids + the same `detail` envelope).
 *  Only the fields ChatDetailView actually reads are populated; the real
 *  EXECUTION PLAN / drafts / dangerous_actions / risks come from the cached
 *  propose_action args via the hook, not from this static projection. The
 *  original string id rides separately via the `runId` prop so the hook can
 *  derive the chat-stream session_key. */
export function realIntentToChatCard(card: IntentCard): ChatCard {
  return {
    id: djb2(card.id),
    category: basketToLovableCategory(card.goalBasket),
    tag: card.urgency >= 0.85 ? "Urgent" : undefined,
    title: card.title,
    line1: card.whyNow || card.summary,
    line2: card.sources.length > 0 ? `Sources: ${card.sources.join(" · ")}` : "",
    whyNow:
      card.whyNow && card.whyNow.trim() && card.whyNow !== card.summary
        ? card.whyNow
        : undefined,
    detail: {
      scores: [
        { label: "Confidence", value: Math.round(card.confidence * 100) },
        { label: "Importance", value: Math.round(card.importance * 100) },
        { label: "Urgency", value: Math.round(card.urgency * 100) },
      ],
      willExecute: card.primaryAction?.label ?? "",
      executionPlan: [],
      dataSources: card.sources,
      impact: "",
      permissions: "",
    },
  };
}

/** Real IntentCard → Lovable Intent (visual). Carries originalId so
 *  handleExecute can recover the IntentCard for the chat runtime. */
export function realCardToLovableIntent(card: IntentCard, status: CardStatus): Intent {
  return {
    id: djb2(card.id),
    originalId: card.id,
    category: basketToLovableCategory(card.goalBasket),
    tag: card.urgency >= 0.85 ? "Urgent" : undefined,
    title: card.title,
    line1: card.whyNow || card.summary,
    line2: card.sources.length > 0 ? `Sources: ${card.sources.join(" · ")}` : "",
    // Preserved separately from line1 (which collapses whyNow / summary
    // into a single headline) so the drawer can render a dedicated
    // "WHY NOW" block — only fill when both fields exist AND differ, so
    // we don't duplicate the headline below it.
    whyNow:
      card.whyNow && card.whyNow.trim() && card.whyNow !== card.summary
        ? card.whyNow
        : undefined,
    detail: {
      scores: [
        { label: "Confidence", value: Math.round(card.confidence * 100) },
        { label: "Importance", value: Math.round(card.importance * 100) },
        { label: "Urgency", value: Math.round(card.urgency * 100) },
      ],
      willExecute: card.primaryAction.label,
      executionPlan: [],
      dataSources: card.sources,
      impact: "",
      permissions: "",
    },
    status,
    statusTimestamp: Date.now(),
  };
}

export const CATEGORIES: Record<string, { icon: LucideIcon; label: string }> = {
  growth:  { icon: Sprout,      label: "Growth" },
  work:    { icon: Briefcase,   label: "Work" },
  finance: { icon: TrendingUp,  label: "Finance" },
  health:  { icon: Heart,       label: "Health" },
  learn:   { icon: BookOpen,    label: "Learn" },
  life:    { icon: Sparkles,    label: "Life" },
};
