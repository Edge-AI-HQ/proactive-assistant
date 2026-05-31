import { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sprout, Briefcase, TrendingUp, Heart, BookOpen, Sparkles,
  Zap, Pencil, X, ArrowRight, ChevronDown,
  type LucideIcon,
} from "lucide-react";
import AiLanding from "./AiLanding";
import { useAmbientLiveSession } from "@/hooks/useAmbientLiveSession";
import { useUserSettings } from "@/hooks/useUserSettings";
import { getPersistedAmbientEnabled } from "@/services/ambient/enabled-state";
import LiveSessionCard from "./LiveSessionCard";
import type { LiveSession } from "@/services/ambient/live-session";

interface ExecutionStep {
  text: string;
  tool: string;
}

interface DetailData {
  scores: { label: string; value: number }[];
  willExecute: string;
  executionPlan: ExecutionStep[];
  dataSources: string[];
  impact: string;
  permissions: string;
}

interface Intent {
  id: number;
  category: string;
  tag?: string;
  title: string;
  line1: string;
  line2: string;
  detail?: DetailData;
}

const CATEGORIES: Record<string, { icon: LucideIcon; label: string }> = {
  growth:  { icon: Sprout,      label: "Growth" },
  work:    { icon: Briefcase,   label: "Work" },
  finance: { icon: TrendingUp,  label: "Finance" },
  health:  { icon: Heart,       label: "Health" },
  learn:   { icon: BookOpen,    label: "Learn" },
  life:    { icon: Sparkles,    label: "Life" },
};

const INTENTS: Intent[] = [
  {
    id: 7,
    category: "work",
    tag: "Urgent",
    title: "Outstanding Invoice from Alex",
    line1: "Alex Chen from Acme Consulting sent a follow-up asking to settle the outstanding March invoice. This is marked IMPORTANT in Gmail. Timely action needed to maintain good vendor relations.",
    line2: "Sources: Gmail · Google Calendar",
    detail: {
      scores: [
        { label: "Confidence", value: 92 },
        { label: "Importance", value: 85 },
        { label: "Urgency", value: 92 },
        { label: "Risk", value: 10 },
      ],
      willExecute: "Draft payment confirmation to Alex, coordinate with Sarah for March advisory invoice payment, notify finance channel",
      executionPlan: [
        { text: "Reply to Alex confirming payment timeline", tool: "gmail create draft" },
        { text: "Ask Sarah to initiate payment for March advisory invoice", tool: "gmail create draft" },
        { text: "Notify finance channel about pending invoice", tool: "slack send message" },
      ],
      dataSources: [
        "Gmail — Alex Chen: Outstanding March advisory invoice",
        "Calendar context — Finance team availability",
      ],
      impact: "Maintains vendor relationships and ensures timely invoice processing.",
      permissions: "Gmail, Slack, GCal · All operations are reversible.",
    },
  },
  {
    id: 1,
    category: "growth",
    tag: "Cross Signal",
    title: "Anthropic's \"Mythos\" model leaked — step change in AI capabilities",
    line1: "Multiple sources report a leaked model showing dramatic capability gains.",
    line2: "Sources: Web Search · Notion",
  },
  {
    id: 2,
    category: "work",
    title: "Meet Rai TODAY at 2pm — Coupa Cafe, Stanford",
    line1: "Calendar event confirmed with location pin.",
    line2: "Sources: gcal · gmail · notion",
  },
  {
    id: 3,
    category: "finance",
    title: "Brex charged $34,778.08 to TriNet — confirm payroll",
    line1: "Recurring payroll charge detected, matches last month.",
    line2: "Sources: gmail · brex",
  },
  {
    id: 4,
    category: "finance",
    tag: "Alert",
    title: "Jaycie needs cap table shares & % — she's blocked",
    line1: "Urgent request from legal, pending your approval.",
    line2: "Sources: gmail",
  },
  {
    id: 5,
    category: "work",
    title: "Pin AI Team Meeting Monday 4:30 PM — 22 attendees",
    line1: "Agenda includes product roadmap and hiring updates.",
    line2: "Sources: gcal · notion · slack",
  },
  {
    id: 6,
    category: "health",
    title: "Weekly health check — biomarkers updated",
    line1: "HRV trending down 8% this week, sleep score stable.",
    line2: "Sources: whoop · apple health",
  },
  {
    id: 8,
    category: "life",
    tag: "Personal Signal",
    title: "Downtown Mall Appointment Today",
    line1: "You have a tentative appointment at Downtown Mall Store at 11:30 AM today. Currently marked as tentative — confirm or decline.",
    line2: "Sources: Google Calendar",
  },
];

interface NowFeedProps {
  onExecute: (card: Intent) => void;
  onModify?: (card: Intent) => void;
  onScrollDirectionChange?: (direction: "up" | "down") => void;
  LandingOverride?: React.ComponentType;
  drawerStyle?: React.CSSProperties;
  onOpenLiveFullscreen?: (session: LiveSession) => void;
}

export default function NowFeed({ onExecute, onModify, onScrollDirectionChange, LandingOverride, drawerStyle, onOpenLiveFullscreen }: NowFeedProps) {
  const [cards, setCards] = useState(INTENTS);
  const { settings } = useUserSettings();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollY, setScrollY] = useState(0);
  const lastScrollTop = useRef(0);

  const consentOn = settings
    ? Object.values(settings.ambientSources ?? {}).some((c) => c?.enabled === true)
    : null;
  // per-device gate: live session only when server consent is set AND this
  // device opted in locally. Mirrors useAmbientToggle / App.tsx so a
  // reinstall (localStorage cleared) shows ambient off everywhere instead
  // of spinning up a live session with no sources actually capturing.
  const ambientOn = getPersistedAmbientEnabled() && (consentOn ?? false);
  const { session: liveSession, previewVisibleCount } = useAmbientLiveSession({
    ambientOn,
    enableWebDemo: false,
    dismissible: false,
  });

  const handleScroll = useCallback(() => {
    if (scrollRef.current) {
      const top = scrollRef.current.scrollTop;
      setScrollY(top);
      const delta = top - lastScrollTop.current;
      if (Math.abs(delta) > 3) {
        onScrollDirectionChange?.(delta > 0 ? "up" : "down");
      }
      lastScrollTop.current = top;
    }
  }, [onScrollDirectionChange]);

  const dismiss = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setCards((prev) => prev.filter((c) => c.id !== id));
  };

  const toggle = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  // Landing fades slowly — stays at 20% even when fully scrolled
  const landingOpacity = Math.max(0.2, 1 - scrollY / 600);

  return (
    <div className="relative h-full overflow-hidden">
      {/* Fixed Landing behind */}
      <div
        className="absolute inset-x-0 top-0 z-0"
        style={{
          opacity: landingOpacity,
          willChange: "opacity",
        }}
      >
        {LandingOverride ? <LandingOverride /> : <AiLanding />}
      </div>

      {/* Scrollable sheet that slides over landing */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative z-10 h-full overflow-y-auto"
        style={{ scrollBehavior: "smooth" }}
      >
        {/* Spacer to show landing initially */}
        <div className="pointer-events-none" style={{ height: "60vh" }} />

        {/* Cards sheet — transparent so globe shows through */}
        <div
          className="relative px-4 pb-4"
          style={drawerStyle ?? {
            borderRadius: "1.5rem 1.5rem 0 0",
            background: "linear-gradient(180deg, hsl(0 0% 100% / 0.15) 0%, hsl(0 0% 100% / 0.35) 120px, hsl(0 0% 100% / 0.5) 100%)",
            backdropFilter: "blur(40px)",
            WebkitBackdropFilter: "blur(40px)",
            minHeight: "80vh",
          }}
        >
          {/* Pull indicator */}
          <div className="flex justify-center pt-3 pb-4">
            <div className="w-9 h-1 rounded-full bg-foreground/30" />
          </div>

          <LiveSessionCard
            session={liveSession}
            previewVisibleCount={previewVisibleCount}
            variant="now"
            alwaysVisible
            onFocus={onOpenLiveFullscreen}
          />

          <div className="flex flex-col gap-3">
            <AnimatePresence>
              {cards.map((card, index) => {
                const cat = CATEGORIES[card.category];
                const Icon = cat.icon;
                const isExpanded = expandedId === card.id;
                return (
                  <motion.div
                    key={card.id}
                    layout
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ delay: index * 0.04, duration: 0.3 }}
                  >
                    <div
                      className="glass-card-strong p-4 relative cursor-pointer"
                      onClick={() => toggle(card.id)}
                    >
                      {/* X dismiss — top right */}
                      <button
                        onClick={(e) => dismiss(card.id, e)}
                        className="absolute top-3 right-3 p-1 rounded-full hover:bg-foreground/10 transition-colors text-foreground/25 hover:text-foreground/60 z-10"
                      >
                        <X size={12} strokeWidth={2} />
                      </button>

                      {/* Category row */}
                      <div className="flex items-center gap-1.5 mb-2 pr-6">
                        <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
                        <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">
                          {cat.label}
                        </span>
                        {card.tag && (
                          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
                            {card.tag}
                          </span>
                        )}
                      </div>

                      {/* Title */}
                      <h3 className="text-display text-[15px] leading-snug text-foreground mb-1.5">
                        {card.title}
                      </h3>

                      {/* Description */}
                      <p className="text-[13px] text-foreground/70 leading-relaxed mb-0.5">
                        {card.line1}
                      </p>
                      <div className="flex items-center justify-between mb-3">
                         <p className="text-xs text-foreground/55 leading-relaxed">
                          {card.line2}
                        </p>
                        <ChevronDown
                          size={14}
                          strokeWidth={1.5}
                          className={`text-foreground/25 transition-transform duration-300 shrink-0 ml-2 ${isExpanded ? "rotate-180" : ""}`}
                        />
                      </div>

                      {/* Expanded Detail */}
                      <AnimatePresence>
                        {isExpanded && card.detail && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.3 }}
                            className="overflow-hidden"
                          >
                            {/* Scores */}
                            <div className="grid grid-cols-4 gap-2 mb-3">
                              {card.detail.scores.map((s) => (
                                <div key={s.label} className="rounded-xl bg-foreground/5 py-2 text-center">
                                  <div className={`text-base font-bold ${s.label === "Risk" ? "text-green-600" : "text-foreground/80"}`}>
                                    {s.value}
                                  </div>
                                  <div className="text-[11px] text-foreground/45 mt-0.5">{s.label}</div>
                                </div>
                              ))}
                            </div>

                            {/* Will execute */}
                            <div className="rounded-xl p-3 mb-3 border border-pink-200/40" style={{ background: "linear-gradient(135deg, rgba(225,92,230,0.08) 0%, rgba(225,92,230,0.04) 100%)" }}>
                              <div className="text-xs font-semibold mb-1"><span className="bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">Will execute on confirm</span></div>
                              <p className="text-[13px] text-foreground/80 leading-relaxed">{card.detail.willExecute}</p>
                            </div>

                            {/* Execution Plan */}
                            <div className="mb-3">
                              <div className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-2">Execution Plan</div>
                              <div className="flex flex-col gap-1.5">
                                {card.detail.executionPlan.map((step, i) => (
                                  <div key={i} className="flex items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2">
                                    <ArrowRight size={12} strokeWidth={1.5} className="text-foreground/40 shrink-0" />
                                    <span className="text-[13px] text-foreground/70 flex-1">{step.text}</span>
                                    <span className="text-[11px] text-foreground/35 bg-foreground/5 px-2 py-0.5 rounded-full whitespace-nowrap">{step.tool}</span>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* Data Sources */}
                            <div className="mb-3">
                              <div className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-1.5">Data Sources</div>
                              {card.detail.dataSources.map((ds, i) => (
                                <div key={i} className="flex items-start gap-1.5 mb-1">
                                  <span className="w-1.5 h-1.5 rounded-full bg-foreground/30 mt-1 shrink-0" />
                                  <span className="text-[13px] text-foreground/60">{ds}</span>
                                </div>
                              ))}
                            </div>

                            {/* Impact & Permissions */}
                            <p className="text-[13px] text-foreground/50 mb-1">
                              <span className="font-semibold text-foreground/65">Impact:</span> {card.detail.impact}
                            </p>
                            <p className="text-[13px] text-foreground/50 mb-3">
                              <span className="font-semibold text-foreground/65">Permissions:</span> {card.detail.permissions}
                            </p>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      {/* Actions */}
                      <div className="flex items-center gap-2.5 justify-end">
                        <button
                          onClick={(e) => { e.stopPropagation(); onModify?.(card); }}
                          className="flex items-center justify-center gap-2 px-7 py-2.5 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-sm font-medium text-foreground/50 min-w-[100px]"
                        >
                          <Pencil size={13} strokeWidth={1.5} />
                          Modify
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); onExecute(card); }}
                          className="flex items-center justify-center gap-2 px-7 py-2.5 rounded-xl bg-foreground text-background text-sm font-semibold hover:bg-foreground/85 transition-colors min-w-[100px]"
                        >
                          <Zap size={13} strokeWidth={2} />
                          Confirm
                        </button>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>

          {cards.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="glass-card p-8 text-center breathing"
            >
              <Sparkles size={28} className="mx-auto mb-2 text-foreground/60" />
              <p className="text-display text-foreground">All caught up</p>
              <p className="text-sm text-muted-foreground mt-1">
                Your AI is watching for new intents
              </p>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
