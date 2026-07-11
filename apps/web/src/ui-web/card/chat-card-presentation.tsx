/**
 * 卡片/聊天共用的展示原语 —— 从 proactive-ai-frontend 的 ChatDetailView 抽出
 * （那边保留 re-export，旧 import 路径不变）：品牌图标、工具图标启发式、
 * artifact 渲染、ChatCard 视觉契约类型。CardDrawerBody（双端 detail 面板
 * 内容）与 ChatDetailView（移动端卡聊天壳）共同消费。
 */
import { useState, type JSX } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check, ChevronUp, Sparkles, Globe, FileSearch, Settings, Hand, Database,
  Bell, DollarSign, Users, Search, Brain, Lock,
  type LucideIcon,
} from "lucide-react";
import type { SideEffect } from "@pin-ai/core";
import { Text } from "../primitives/Text";

/* --------- Tool icon registry: brand logos when available, else mono icons --------- */
export type ToolIcon =
  | { kind: "brand"; name: "gmail" | "gcal" | "gdrive" | "gdocs" | "gsheets" | "slack" | "notion" | "linear" }
  | { kind: "mono"; Icon: LucideIcon };

export function brandSvg(name: string): JSX.Element | null {
  switch (name) {
    case "gmail":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <path fill="#4285f4" d="M44 11.11v25.78c0 .98-.8 1.78-1.78 1.78H38V17.5L24 28 10 17.5V38.67H5.78C4.8 38.67 4 37.87 4 36.89V11.11c0-.98.8-1.78 1.78-1.78H7L24 22l17-12.67h1.22c.98 0 1.78.8 1.78 1.78z"/>
          <path fill="#34a853" d="M10 38.67V17.5l14 10.5z"/>
          <path fill="#fbbc04" d="M38 17.5v21.17h4.22c.98 0 1.78-.8 1.78-1.78V11.11z"/>
          <path fill="#ea4335" d="M38 17.5L24 28 10 17.5V11.11L24 21.5l14-10.39z"/>
          <path fill="#c5221f" d="M10 11.11V17.5l-6-4.5v-1.89c0-.98.8-1.78 1.78-1.78H7z"/>
        </svg>
      );
    case "gcal":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <rect x="6" y="8" width="36" height="34" rx="3" fill="#fff" stroke="#dadce0"/>
          <rect x="6" y="8" width="36" height="8" rx="3" fill="#1a73e8"/>
          <text x="24" y="33" textAnchor="middle" fontSize="14" fontWeight="700" fill="#1a73e8" fontFamily="system-ui">31</text>
        </svg>
      );
    case "gdrive":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <path fill="#0066da" d="M8 36l4 7h24l-4-7z"/>
          <path fill="#00ac47" d="M20 5L8 26l4 7 12-21z"/>
          <path fill="#ea4335" d="M28 5l12 21-4 7L24 12z"/>
          <path fill="#ffba00" d="M20 5h8l12 21H16z"/>
        </svg>
      );
    case "gdocs":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <rect x="10" y="6" width="28" height="36" rx="2" fill="#4285f4"/>
          <rect x="15" y="16" width="18" height="2" fill="#fff"/>
          <rect x="15" y="21" width="18" height="2" fill="#fff"/>
          <rect x="15" y="26" width="18" height="2" fill="#fff"/>
          <rect x="15" y="31" width="12" height="2" fill="#fff"/>
        </svg>
      );
    case "gsheets":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <rect x="10" y="6" width="28" height="36" rx="2" fill="#0f9d58"/>
          <rect x="15" y="16" width="18" height="20" fill="#fff"/>
          <path d="M15 22h18M15 28h18M22 16v20M29 16v20" stroke="#0f9d58" strokeWidth="1"/>
        </svg>
      );
    case "slack":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <path fill="#36c5f0" d="M14 28a4 4 0 100 8 4 4 0 000-8zm0-2h4v-8h-4a4 4 0 100 8z"/>
          <path fill="#2eb67d" d="M20 14a4 4 0 108 0 4 4 0 00-8 0zm2 0v4h8v-4a4 4 0 10-8 0z" transform="translate(-2 0)"/>
          <path fill="#ecb22e" d="M34 20a4 4 0 100 8 4 4 0 000-8zm-2 0h-4v8h4a4 4 0 100-8z"/>
          <path fill="#e01e5a" d="M28 34a4 4 0 10-8 0 4 4 0 008 0zm-2 0v-4h-8v4a4 4 0 108 0z"/>
        </svg>
      );
    case "notion":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <rect x="8" y="6" width="32" height="36" rx="3" fill="#fff" stroke="#000" strokeWidth="1.5"/>
          <path d="M16 14v20M32 14l-12 16V14" stroke="#000" strokeWidth="2.2" fill="none" strokeLinecap="round"/>
        </svg>
      );
    case "linear":
      return (
        <svg viewBox="0 0 48 48" className="w-full h-full">
          <circle cx="24" cy="24" r="18" fill="#5e6ad2"/>
        </svg>
      );
  }
  return null;
}

export function detectToolIcon(text: string): ToolIcon {
  const t = text.toLowerCase();
  if (/(gmail|email|sending email|searching emails|inbox|reply)/.test(t)) return { kind: "brand", name: "gmail" };
  if (/(calendar|appointment|schedule|meeting|reminder)/.test(t)) return { kind: "brand", name: "gcal" };
  if (/(slack|channel|message)/.test(t)) return { kind: "brand", name: "slack" };
  if (/(notion)/.test(t)) return { kind: "brand", name: "notion" };
  if (/(linear|issue|ticket)/.test(t)) return { kind: "brand", name: "linear" };
  if (/(drive|upload|download|file)/.test(t)) return { kind: "brand", name: "gdrive" };
  if (/(doc|draft|document)/.test(t)) return { kind: "brand", name: "gdocs" };
  if (/(sheet|spreadsheet|table)/.test(t)) return { kind: "brand", name: "gsheets" };
  if (/(web|search.*web|browse|website|http)/.test(t)) return { kind: "mono", Icon: Globe };
  if (/(memor|recall|history)/.test(t)) return { kind: "mono", Icon: FileSearch };
  if (/(approv|waiting|requesting)/.test(t)) return { kind: "mono", Icon: Hand };
  if (/(payment|invoice|cost|budget)/.test(t)) return { kind: "mono", Icon: DollarSign };
  if (/(team|people|contact)/.test(t)) return { kind: "mono", Icon: Users };
  if (/(notif|alert|flag)/.test(t)) return { kind: "mono", Icon: Bell };
  if (/(query|database|sql)/.test(t)) return { kind: "mono", Icon: Database };
  if (/(plan|re-plan|finalizing|preparing|drafting|incorporating|context|setting|configur)/.test(t)) return { kind: "mono", Icon: Settings };
  if (/(search|find|look|cross-check|validating)/.test(t)) return { kind: "mono", Icon: Search };
  if (/(think|reason|analy)/.test(t)) return { kind: "mono", Icon: Brain };
  return { kind: "mono", Icon: Sparkles };
}

export function ToolIconBadge({ icon, isDone }: { icon: ToolIcon; isDone: boolean }) {
  return (
    <div className="relative shrink-0" style={{ width: 36, height: 36 }}>
      <div
        className="w-9 h-9 rounded-[10px] flex items-center justify-center overflow-hidden border border-foreground/10"
        style={{ background: icon.kind === "brand" ? "#fff" : "rgba(255,255,255,0.85)" }}
      >
        {icon.kind === "brand" ? (
          <div className="w-6 h-6">{brandSvg(icon.name)}</div>
        ) : (
          <icon.Icon size={16} strokeWidth={1.8} className="text-foreground/75" />
        )}
      </div>
      {/* status dot */}
      <div
        className="absolute -bottom-0.5 -right-0.5 w-[14px] h-[14px] rounded-full flex items-center justify-center border-2 border-white"
        style={{ background: isDone ? "rgb(34,197,94)" : "rgba(255,255,255,0.95)" }}
      >
        {isDone ? (
          <Check size={8} className="text-white" strokeWidth={4} />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-foreground/30" />
        )}
      </div>
    </div>
  );
}

export interface Artifact {
  kind: "email" | "notes" | "message" | "doc";
  app: "gmail" | "slack" | "notion" | "gdocs";
  title: string;
  meta?: string;
  body: string;
}

export interface ChatCard {
  id: number;
  category: string;
  tag?: string;
  complexity?: "simple"; // marks quick-approve tasks (low risk, few steps)
  /** Explicit card type ("reminder" = acknowledge-only nudge). Rides into
   *  card_context so the agent switches behavior — see lib/reminder-card.ts. */
  cardKind?: string;
  /** Owning pai_scheduled_tasks id (reminder cards) — lets the agent edit
   *  this reminder's schedule via the scheduled_generator_* tools. */
  scheduleTaskId?: string;
  title: string;
  line1: string;
  line2: string;
  /** Generator-side rationale; rendered as a dedicated "WHY NOW" block
   *  in the chat-side drawer mirror (ChatCardDrawerBody). */
  whyNow?: string;
  sourceApps?: string[];
  reasoningSteps?: { label: string; detail: string }[];
  detail?: {
    scores: { label: string; value: number }[];
    willExecute: string;
    executionPlan: { text: string; tool: string }[];
    dataSources: string[];
    impact: string;
    permissions: string;
    result?: string;
    artifacts?: Artifact[];
  };
}

/* ── Artifact panel: shows generated drafts (emails / notes / messages) ── */
const ARTIFACT_KIND_LABEL: Record<Artifact["kind"], string> = {
  email: "Email draft",
  notes: "Notes",
  message: "Message draft",
  doc: "Document",
};

/* Heuristic match: artifact.kind → side_effect.slug prefix. Used in the
 * Result panel to upgrade "Email draft" to "Email · Sent" when the
 * corresponding dangerous_write actually fired. v1 limitation: if an
 * agent emits multiple artifacts of the same kind, all match the first
 * matching side_effect — acceptable since multi-artifact-same-kind is
 * rare for current card patterns. */
export function matchSideEffect(
  artifact: Artifact,
  sideEffects: SideEffect[],
): SideEffect | null {
  if (artifact.kind === "email") {
    return sideEffects.find((s) => s.slug.startsWith("GMAIL_")) ?? null;
  }
  if (artifact.kind === "message") {
    return sideEffects.find((s) => s.slug.startsWith("SLACK_")) ?? null;
  }
  if (artifact.kind === "doc") {
    return (
      sideEffects.find((s) =>
        s.slug.startsWith("NOTION_") ||
        s.slug.startsWith("GDOCS_") ||
        s.slug.startsWith("GDRIVE_"),
      ) ?? null
    );
  }
  return null;
}

/* Verb mapping for the upgraded label (e.g. "Email · Sent"). */
const SIDE_EFFECT_VERB: Record<Artifact["app"], string> = {
  gmail: "Sent",
  slack: "Posted",
  notion: "Created",
  gdocs: "Created",
};

/* Extract a generic URL from opaque output_meta. Returns the first of
 * url / permalink / web_link found as a string; null otherwise. */
function urlFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  for (const key of ["url", "permalink", "web_link"] as const) {
    const v = m[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function ArtifactItem({
  artifact, index, locked = false, sideEffect = null,
}: {
  artifact: Artifact;
  index: number;
  locked?: boolean;
  sideEffect?: SideEffect | null;
}) {
  const [expanded, setExpanded] = useState(index === 0);
  const brand = artifact.app === "gmail" ? "gmail"
    : artifact.app === "slack" ? "slack"
    : artifact.app === "notion" ? "notion"
    : "gdocs";
  return (
    <motion.div
      layout
      transition={{ layout: { duration: 0.28, ease: [0.32, 0.72, 0, 1] } }}
      className="rounded-xl border border-foreground/8 overflow-hidden"
      style={{ background: "rgba(255,255,255,0.65)" }}
    >
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-foreground/[0.02] transition-colors"
      >
        <div className="w-7 h-7 rounded-lg bg-white border border-foreground/10 flex items-center justify-center shrink-0 overflow-hidden">
          <div className="w-5 h-5">{brandSvg(brand)}</div>
        </div>
        <div className="flex-1 min-w-0">
          {(() => {
            // Label upgrade: "Email draft" → "Email · Sent" / "Email · Failed"
            // when a matching side_effect proves the action fired.
            if (!sideEffect) {
              return (
                <Text variant="micro" weight="semibold" className="block uppercase tracking-wider text-foreground/40 leading-none mb-1">
                  {ARTIFACT_KIND_LABEL[artifact.kind]}
                </Text>
              );
            }
            if (sideEffect.is_error) {
              return (
                <Text variant="micro" weight="semibold" className="block uppercase tracking-wider text-red-600 leading-none mb-1">
                  {ARTIFACT_KIND_LABEL[artifact.kind]} · Failed
                </Text>
              );
            }
            return (
              <Text variant="micro" weight="semibold" className="block uppercase tracking-wider text-green-700 leading-none mb-1">
                {ARTIFACT_KIND_LABEL[artifact.kind]} · {SIDE_EFFECT_VERB[artifact.app]}
              </Text>
            );
          })()}
          <Text variant="bodySm" weight="semibold" className="block text-foreground/85 truncate leading-tight">{artifact.title}</Text>
          {artifact.meta && (
            <Text variant="caption" className="block text-foreground/45 mt-0.5 truncate">{artifact.meta}</Text>
          )}
        </div>
        <ChevronUp
          size={14}
          strokeWidth={2}
          className={`text-foreground/35 shrink-0 transition-transform duration-300 ${expanded ? "" : "rotate-180"}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3 pt-0.5 border-t border-foreground/[0.06] relative">
              {locked ? (
                <div className="relative pt-2.5">
                  <Text variant="bodySm" className="block text-foreground/75 leading-relaxed whitespace-pre-line">
                    {artifact.body.slice(0, Math.floor(artifact.body.length / 2))}
                  </Text>
                  <div className="relative mt-1">
                    <p
                      className="text-label text-foreground/75 leading-relaxed whitespace-pre-line select-none pointer-events-none"
                      style={{ filter: "blur(5px)" }}
                      aria-hidden="true"
                    >
                      {artifact.body.slice(Math.floor(artifact.body.length / 2))}
                    </p>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="flex items-center justify-center w-7 h-7 rounded-full bg-foreground/85 text-background shadow-sm">
                        <Lock size={12} strokeWidth={2.5} />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <Text variant="bodySm" className="block text-foreground/75 leading-relaxed whitespace-pre-line pt-2.5">
                  {artifact.body}
                </Text>
              )}
              {sideEffect && !sideEffect.is_error && (() => {
                const url = urlFromMeta(sideEffect.output_meta);
                if (!url) return null;
                return (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-2 text-label font-medium text-foreground/70 hover:text-foreground transition-colors"
                  >
                    Open ↗
                  </a>
                );
              })()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
