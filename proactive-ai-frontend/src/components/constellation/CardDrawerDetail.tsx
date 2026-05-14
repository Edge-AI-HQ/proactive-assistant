import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Zap, FileText } from "lucide-react";
import { brandSvg, detectToolIcon, ArtifactItem, type Artifact } from "./ChatDetailView";

/* ── Shared types (mirrored across ConstellationLayout / ChatDetailView) ── */
export interface DrawerDetailCard {
  tag?: string;
  line2: string;
  locked?: boolean;
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

export function DrawerDetailBody({ card }: { card: DrawerDetailCard }) {
  const detail = card.detail!;
  const [planOpen, setPlanOpen] = useState(true);
  const [draftsOpen, setDraftsOpen] = useState(true);
  const sources = parseSources(card.line2);
  const reasons = howGenerated(card);
  const artifacts = detail.artifacts ?? [];

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

  return (
    <>
      {/* Execution Plan — pink gradient, collapsible with timeline */}
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
            <span className="text-[11px] font-medium text-foreground/45">· {detail.executionPlan.length} steps</span>
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
                  {detail.executionPlan.map((step, i) => (
                    <ExecutionStepRow key={i} step={step} />
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

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
                    <ArtifactItem key={i} artifact={a} index={i} locked={!!card.locked} />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
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
