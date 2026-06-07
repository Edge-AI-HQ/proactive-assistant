import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Zap, FileText, AlertTriangle, Loader2 } from "lucide-react";
import { brandSvg, detectToolIcon, ArtifactItem, matchSideEffect, type Artifact } from "@/components/chat/ChatDetailView";
import type {
  DangerousAction,
  ExecuteArtifact,
  ExecutionStep,
  LastMessagePayload,
  RunSnapshot,
  SideEffect,
  SSEEvent,
} from "@/hooks/useCardExecutionRun";

/* ── Shared types (mirrored across AppLayout / ChatDetailView) ── */
export interface DrawerDetailCard {
  tag?: string;
  line2: string;
  locked?: boolean;
  /** Generator-side rationale for why this card surfaced now. Optional
   *  because the legacy Lovable mock cards don't carry it. */
  whyNow?: string;
  detail?: {
    executionPlan: { text: string; tool: string }[];
    artifacts?: Artifact[];
  };
}

/* ── Source label → brand icon mapping ── */
function sourceToIcon(label: string) {
  const l = label.toLowerCase();
  if (l.includes("gmail") || l.includes("email")) return { brand: "gmail" as const, label: "Gmail" };
  if (l.includes("calendar") || l.includes("gcal")) return { brand: "gcal" as const, label: "Calendar" };
  if (l.includes("slack")) return { brand: "slack" as const, label: "Slack" };
  if (l.includes("notion")) return { brand: "notion" as const, label: "Notion" };
  if (l.includes("drive")) return { brand: "gdrive" as const, label: "Drive" };
  if (l.includes("doc")) return { brand: "gdocs" as const, label: "Docs" };
  if (l.includes("sheet")) return { brand: "gsheets" as const, label: "Sheets" };
  if (l.includes("linear")) return { brand: "linear" as const, label: "Linear" };
  if (l.includes("brex")) return { brand: null, label: "Brex" };
  if (l.includes("whoop")) return { brand: null, label: "Whoop" };
  if (l.includes("apple health")) return { brand: null, label: "Apple Health" };
  if (l.includes("web")) return { brand: null, label: "Web" };
  return { brand: null, label: label.split("·")[0].trim().split("—")[0].trim() };
}

export function parseSources(line2: string): string[] {
  const cleaned = line2.replace(/^sources:\s*/i, "");
  return Array.from(new Set(cleaned.split(/[·,]/).map((s) => s.trim()).filter(Boolean)));
}

/* "How generated" — short reasoning chips */
function howGenerated(card: DrawerDetailCard): string[] {
  const sources = parseSources(card.line2);
  const reasons: string[] = [];
  if (card.tag === "Urgent") reasons.push("Urgent flag");
  if (card.tag === "Alert") reasons.push("Time-sensitive");
  if (sources.some((s) => /gmail|email/i.test(s))) reasons.push("Email signal");
  if (sources.some((s) => /slack/i.test(s))) reasons.push("Slack mention");
  if (sources.some((s) => /calendar|gcal/i.test(s))) reasons.push("Upcoming event");
  if (sources.some((s) => /notion/i.test(s))) reasons.push("Notion context");
  if (sources.some((s) => /web/i.test(s))) reasons.push("Web trend");
  if (sources.some((s) => /whoop|apple health/i.test(s))) reasons.push("Health data");
  if (card.tag?.includes("Signal")) reasons.push("Pattern match");
  return Array.from(new Set(reasons)).slice(0, 4);
}

function SourcePill({ source }: { source: string }) {
  const info = sourceToIcon(source);
  return (
    <div className="inline-flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full bg-foreground/[0.05] border border-foreground/[0.06]">
      <span className="w-5 h-5 rounded-md bg-white flex items-center justify-center overflow-hidden shrink-0">
        {info.brand ? (
          <span className="w-3.5 h-3.5">{brandSvg(info.brand)}</span>
        ) : (
          <span className="text-[9px] font-bold text-foreground/70">{info.label.slice(0, 1)}</span>
        )}
      </span>
      <span className="text-[12px] font-medium text-foreground/70">{info.label}</span>
    </div>
  );
}

function ExecutionStepRow({ step }: { step: { text: string; tool: string } }) {
  const icon = detectToolIcon(step.text + " " + step.tool);
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <div className="relative shrink-0" style={{ width: 28, height: 28 }}>
        <div
          className="w-7 h-7 rounded-[8px] flex items-center justify-center overflow-hidden border border-foreground/10"
          style={{ background: icon.kind === "brand" ? "#fff" : "rgba(255,255,255,0.85)" }}
        >
          {icon.kind === "brand" ? (
            <div className="w-[18px] h-[18px]">{brandSvg(icon.name)}</div>
          ) : (
            <icon.Icon size={13} strokeWidth={1.8} className="text-foreground/75" />
          )}
        </div>
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="text-[13px] text-foreground/85 leading-snug">{step.text}</div>
        <div className="text-[10px] text-foreground/45 mt-0.5 uppercase tracking-wide font-medium">{step.tool}</div>
      </div>
    </div>
  );
}

/* ── Fallback derivations when propose_action carried no audit data ──
 *
 * Two real failure modes we observed in production card threads:
 *
 *   1. agent went text-only and never called propose_action (e.g. tool
 *      reads returned nothing → agent fell back to writing a plain
 *      markdown reply). `runSnapshot.result.summary` carries that prose;
 *      we wrap it as a single "Agent's note" artifact so the drawer
 *      still has SOMETHING for the user to read.
 *   2. agent paused via propose_action but only filled `message + options`
 *      (e.g. browser_tool takeover loop). The `events` log retains every
 *      `chat:tool:start` the agent emitted; we compress those into
 *      synthetic plan rows so the drawer shows what the agent actually
 *      did before pausing.
 *
 * Both are tolerant: when nothing useful is present, the helpers return
 * empty lists and the drawer's sections stay hidden (per the user's
 * "fallback to anything available, otherwise hide" rule).
 */
function eventsToFallbackPlan(events: SSEEvent[] | undefined): { text: string; tool: string }[] {
  if (!events || events.length === 0) return [];
  const seen = new Set<string>();
  const rows: { text: string; tool: string }[] = [];
  for (const ev of events) {
    if (ev.type !== "chat:tool:start") continue;
    const d = ev.data as { name?: string; argsPreview?: string } | undefined;
    const name = typeof d?.name === "string" ? d.name : "";
    if (!name) continue;
    // propose_action is a UI primitive, not an "execution step" — skip
    // so the fallback plan reads as actions the agent took, not the
    // pause itself.
    if (name === "propose_action") continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const preview = typeof d?.argsPreview === "string" ? d.argsPreview.trim() : "";
    rows.push({
      text: preview && preview.length <= 140 ? preview : `Called ${name}`,
      tool: name,
    });
  }
  return rows;
}

function summaryToFallbackArtifact(summary: string | undefined): Artifact[] {
  const text = (summary ?? "").trim();
  if (!text) return [];
  return [{
    kind: "notes",
    app: "gdocs",
    title: "Agent's note",
    body: text,
  }];
}

/* ── Backend → Lovable artifact shape mapping ──
 *
 * Backend `ExecuteArtifact.kind ∈ {email_draft, message, doc, other}` doesn't
 * carry the brand/app field Lovable's `ArtifactItem` expects. Derive `app`
 * from kind (most likely first-party app per category) and project into
 * the Lovable shape with no logic changes upstream.
 */
export function executeArtifactToLovable(a: ExecuteArtifact): Artifact {
  const app: Artifact["app"] =
    a.kind === "email_draft"
      ? "gmail"
      : a.kind === "message"
        ? "slack"
        : a.kind === "doc"
          ? "gdocs"
          : "gdocs";
  const kind: Artifact["kind"] =
    a.kind === "email_draft"
      ? "email"
      : a.kind === "message"
        ? "message"
        : a.kind === "doc"
          ? "doc"
          : "notes";
  const meta =
    typeof a.meta === "object" && a.meta && typeof (a.meta as Record<string, unknown>).meta === "string"
      ? String((a.meta as Record<string, unknown>).meta)
      : undefined;
  return { kind, app, title: a.title, meta, body: a.body };
}

function backendPlanToLovable(plan: ExecutionStep[]): { text: string; tool: string }[] {
  return plan.map((step) => ({
    text: step.summary,
    tool: step.slug || step.tool,
  }));
}

/* ── Dangerous-action pill row ── */
function DangerousActionRow({ action }: { action: DangerousAction }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <div className="relative shrink-0" style={{ width: 28, height: 28 }}>
        <div
          className="w-7 h-7 rounded-[8px] flex items-center justify-center overflow-hidden border border-amber-500/30"
          style={{ background: "rgba(245, 158, 11, 0.08)" }}
        >
          <AlertTriangle size={13} strokeWidth={1.8} className="text-amber-600" />
        </div>
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="text-[13px] text-foreground/85 leading-snug font-medium">
          {action.risk_label}
        </div>
        <div className="text-[10px] text-foreground/45 mt-0.5 uppercase tracking-wide font-medium">
          {action.slug}
        </div>
      </div>
    </div>
  );
}

/* ── DrawerDetailBody — Lovable visual contract preserved ──
 *
 * Accepts an optional `runSnapshot`, the hook's cached
 * `lastMessagePayload`, and the run's `sideEffects` (post-execution).
 *
 * Data-source priority for plan / drafts / dangerous_actions / risks:
 *   1. `lastMessagePayload` — cached send_message snapshot, survives
 *      transitions out of needs_input so pending_done / done states still
 *      have something to show. Live source while in needs_input too.
 *      The hook merges audit fields (plan / dangerous_actions / risks)
 *      forward from the first message so a follow-up message that
 *      omits them doesn't blank this view.
 *   2. `card.detail` — static fallback for cards that haven't been
 *      fanned out yet (rare).
 *
 * Generated drafts also receive side_effects matching so labels upgrade
 * from "Email draft" → "Email · Sent" once the dangerous_write actually
 * fired.
 */
export function DrawerDetailBody({
  card,
  runSnapshot,
  lastMessagePayload = null,
  sideEffects = [],
}: {
  card: DrawerDetailCard;
  runSnapshot?: RunSnapshot | null;
  lastMessagePayload?: LastMessagePayload | null;
  sideEffects?: SideEffect[];
}) {
  // Source-of-truth selection. Priority for plan / artifacts:
  //   (a) cached lastMessagePayload — the hook merges audit fields
  //       forward across propose_action turns. Best signal.
  //   (b) card.detail static fallback — generator-side mock; usually
  //       empty for real cards.
  //   (c) derived fallback — when the agent went text-only or paused
  //       with no audit data, surface result.summary as an "Agent's
  //       note" artifact and compress the tool-call log into a plan.
  //       Without this, drawer shows nothing for these (real) cases.
  //
  // dangerous_actions / risks have no static or derived fallback (they
  // require semantic data the agent has to emit explicitly); they only
  // render when the cached payload supplies them.
  const cached = lastMessagePayload;

  const cachedPlan = cached ? backendPlanToLovable(cached.plan) : [];
  const staticPlan = card.detail?.executionPlan ?? [];
  const eventsPlan = eventsToFallbackPlan(runSnapshot?.events);
  const plan: { text: string; tool: string }[] =
    cachedPlan.length > 0
      ? cachedPlan
      : staticPlan.length > 0
        ? staticPlan
        : eventsPlan;

  const cachedArtifacts = cached
    ? cached.drafts.map(executeArtifactToLovable)
    : [];
  const staticArtifacts = card.detail?.artifacts ?? [];
  const summaryArtifacts = summaryToFallbackArtifact(
    runSnapshot?.result?.summary,
  );
  const artifacts: Artifact[] =
    cachedArtifacts.length > 0
      ? cachedArtifacts
      : staticArtifacts.length > 0
        ? staticArtifacts
        : summaryArtifacts;

  const dangerousActions: DangerousAction[] = cached
    ? cached.dangerous_actions
    : [];

  const risks: string[] = cached ? cached.risks : [];

  const [planOpen, setPlanOpen] = useState(true);
  const [draftsOpen, setDraftsOpen] = useState(true);
  const [dangerousOpen, setDangerousOpen] = useState(true);
  const sources = parseSources(card.line2);
  const reasons = howGenerated(card);

  // Status banner — surface preparing / resuming / error / cancelled so the
  // user understands why the buttons may not match the prior shape.
  const statusBanner = renderStatusBanner(runSnapshot ?? null, !!cached);

  // Join reasons into a single sentence
  const reasonSentence = (() => {
    if (reasons.length === 0) return null;
    const lower = reasons.map((r) => r.toLowerCase());
    let body: string;
    if (lower.length === 1) body = lower[0];
    else if (lower.length === 2) body = `${lower[0]} and ${lower[1]}`;
    else body = `${lower.slice(0, -1).join(", ")}, and ${lower[lower.length - 1]}`;
    return `Generated from ${body}.`;
  })();

  const whyNowText = card.whyNow?.trim();

  return (
    <>
      {statusBanner}

      {/* Why now — generator's rationale for surfacing this card. Sits
          ABOVE the execution plan because it explains the WHY before
          the WHAT/HOW. Matches the visual treatment of the legacy
          the legacy card detail body so users moving between the two views see the
          same context. */}
      {whyNowText && (
        <div
          className="mb-3 rounded-2xl px-3.5 py-2.5 border"
          style={{
            background: "rgba(34, 197, 94, 0.06)",
            borderColor: "rgba(34, 197, 94, 0.22)",
          }}
        >
          <div className="text-[11px] font-bold uppercase tracking-wider text-green-700/80 mb-1">
            Why now
          </div>
          <p className="text-[12.5px] text-foreground/75 leading-snug">{whyNowText}</p>
        </div>
      )}

      {/* Execution Plan — pink gradient, collapsible with timeline */}
      {plan.length > 0 && (
        <div
          className="mb-3 rounded-2xl overflow-hidden border"
          style={{
            background: "linear-gradient(135deg, rgba(225,92,230,0.10) 0%, rgba(225,92,230,0.04) 100%)",
            borderColor: "hsl(292 78% 63% / 0.22)",
          }}
        >
          <button
            onClick={() => setPlanOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3.5 py-2.5"
          >
            <div className="flex items-center gap-1.5">
              <Zap size={13} strokeWidth={2.5} color="hsl(292,78%,63%)" />
              <span className="text-[11px] font-bold uppercase tracking-wider bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
                Execution Plan
              </span>
              <span className="text-[11px] font-medium text-foreground/45">· {plan.length} steps</span>
            </div>
            <ChevronDown
              size={16}
              className={`text-[hsl(292,78%,63%)]/70 transition-transform ${planOpen ? "rotate-180" : ""}`}
            />
          </button>
          <AnimatePresence initial={false}>
            {planOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="px-3.5 pb-2.5 relative">
                  {/* timeline rail */}
                  <div className="absolute left-[27px] top-1.5 bottom-2 w-px bg-[hsl(292,78%,63%)]/20" />
                  <div className="relative">
                    {plan.map((step, i) => (
                      <ExecutionStepRow key={i} step={step} />
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Generated drafts — collapsible preview of final email/notes */}
      {artifacts.length > 0 && (
        <div
          className="mb-3 rounded-2xl overflow-hidden border border-foreground/10"
          style={{ background: "rgba(255,255,255,0.55)" }}
        >
          <button
            onClick={() => setDraftsOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3.5 py-2.5"
          >
            <div className="flex items-center gap-1.5">
              <FileText size={13} strokeWidth={2.5} className="text-foreground/60" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-foreground/60">
                {artifacts.length === 1 ? "Generated draft" : "Generated drafts"}
              </span>
              <span className="text-[11px] font-medium text-foreground/45">· {artifacts.length}</span>
            </div>
            <ChevronDown
              size={16}
              className={`text-foreground/40 transition-transform ${draftsOpen ? "rotate-180" : ""}`}
            />
          </button>
          <AnimatePresence initial={false}>
            {draftsOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22 }}
                className="overflow-hidden"
              >
                <div className="px-3 pb-3 pt-0.5 flex flex-col gap-2">
                  {artifacts.map((a, i) => (
                    <ArtifactItem
                      key={i}
                      artifact={a}
                      index={i}
                      locked={!!card.locked}
                      sideEffect={matchSideEffect(a, sideEffects)}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Dangerous actions — only when the latest send_message payload has any */}
      {dangerousActions.length > 0 && (
        <div
          className="mb-3 rounded-2xl overflow-hidden border"
          style={{
            background: "rgba(245, 158, 11, 0.04)",
            borderColor: "rgba(245, 158, 11, 0.22)",
          }}
        >
          <button
            onClick={() => setDangerousOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3.5 py-2.5"
          >
            <div className="flex items-center gap-1.5">
              <AlertTriangle size={13} strokeWidth={2.5} className="text-amber-600" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700">
                Approving will let agent:
              </span>
              <span className="text-[11px] font-medium text-foreground/45">· {dangerousActions.length}</span>
            </div>
            <ChevronDown
              size={16}
              className={`text-amber-600/70 transition-transform ${dangerousOpen ? "rotate-180" : ""}`}
            />
          </button>
          <AnimatePresence initial={false}>
            {dangerousOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="px-3.5 pb-2.5">
                  {dangerousActions.map((a, i) => (
                    <DangerousActionRow key={`${a.slug}-${i}`} action={a} />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Risks — one-liner bullets from the agent's plan */}
      {risks.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] font-bold text-foreground/55 uppercase tracking-wider mb-1.5">Risks to consider</div>
          <ul className="space-y-1">
            {risks.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-[12.5px] text-foreground/65 leading-snug">
                <span className="mt-1.5 w-1 h-1 rounded-full bg-foreground/40 shrink-0" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Sources — second to last */}
      {sources.length > 0 && (
        <div className="mb-3">
          <div className="text-[11px] font-bold text-foreground/55 uppercase tracking-wider mb-1.5">Sources</div>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s, i) => <SourcePill key={i} source={s} />)}
          </div>
        </div>
      )}

      {/* How generated — last */}
      {reasonSentence && (
        <div className="mb-1">
          <div className="text-[11px] font-bold text-foreground/55 uppercase tracking-wider mb-1">How generated</div>
          <p className="text-[12.5px] text-foreground/65 leading-snug">{reasonSentence}</p>
        </div>
      )}
    </>
  );
}

/* Status banner — only renders for non-needs_input states so the
 * Approve UI doesn't get a competing banner. */
function renderStatusBanner(
  snapshot: RunSnapshot | null,
  hasLiveApproval: boolean,
): JSX.Element | null {
  if (!snapshot) return null;
  if (hasLiveApproval) return null;
  switch (snapshot.status) {
    case "running":
    case "resuming":
      return (
        <div
          className="mb-3 px-3.5 py-2.5 rounded-2xl flex items-center gap-2 border border-foreground/10"
          style={{ background: "rgba(255,255,255,0.55)" }}
        >
          <Loader2 size={13} className="text-foreground/55 animate-spin" />
          <span className="text-[12px] text-foreground/70 font-medium">
            {snapshot.status === "running"
              ? "Agent is preparing the plan — give it a moment."
              : "Resuming…"}
          </span>
        </div>
      );
    case "done":
      return (
        <div
          className="mb-3 px-3.5 py-2.5 rounded-2xl border"
          style={{
            background: "linear-gradient(135deg, rgba(225,92,230,0.08) 0%, rgba(225,92,230,0.03) 100%)",
            borderColor: "rgba(225,92,230,0.2)",
          }}
        >
          <div className="text-[11px] font-bold uppercase tracking-wider mb-1 bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
            Result
          </div>
          <p className="text-[13px] text-foreground/80 leading-relaxed">
            {snapshot.result?.summary || "Done."}
          </p>
        </div>
      );
    case "error":
      return (
        <div className="mb-3 px-3.5 py-2.5 rounded-2xl border border-red-500/30 bg-red-500/[0.04]">
          <div className="text-[11px] font-bold uppercase tracking-wider text-red-600 mb-1">
            Failed
          </div>
          <p className="text-[12.5px] text-foreground/75 leading-snug">
            {snapshot.errorMessage || "Run failed."}
          </p>
        </div>
      );
    case "cancelled":
      return (
        <div className="mb-3 px-3.5 py-2.5 rounded-2xl border border-foreground/10 bg-foreground/[0.03]">
          <p className="text-[12.5px] text-foreground/60 leading-snug">
            Cancelled. Tap Retry to start a fresh run.
          </p>
        </div>
      );
    default:
      return null;
  }
}
