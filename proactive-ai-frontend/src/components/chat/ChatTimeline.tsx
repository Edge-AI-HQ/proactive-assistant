import { motion } from "framer-motion";
import { Sprout, Briefcase, TrendingUp, Heart, BookOpen, Sparkles, CheckCircle2, Loader2, type LucideIcon } from "lucide-react";
import type { ChatCard } from "@/components/chat/ChatDetailView";

const CATEGORIES: Record<string, { icon: LucideIcon; label: string }> = {
  growth: { icon: Sprout, label: "Growth" },
  work: { icon: Briefcase, label: "Work" },
  finance: { icon: TrendingUp, label: "Finance" },
  health: { icon: Heart, label: "Health" },
  learn: { icon: BookOpen, label: "Learn" },
  life: { icon: Sparkles, label: "Life" },
};

/* ── All cards from the INTENTS library, with chat-ready data ── */
const ALL_CHAT_CARDS: ChatCard[] = [
  {
    id: 7, category: "work", tag: "Urgent",
    title: "Outstanding Invoice from Alex",
    line1: "Alex Chen from Acme Consulting sent a follow-up asking to settle the outstanding March invoice.",
    line2: "Sources: Gmail · Google Calendar",
    detail: {
      scores: [
        { label: "Confidence", value: 92 }, { label: "Importance", value: 85 },
        { label: "Urgency", value: 92 }, { label: "Risk", value: 10 },
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
    id: 1, category: "growth", tag: "Cross Signal",
    title: "Anthropic's \"Mythos\" model leaked",
    line1: "Multiple sources report a leaked model showing dramatic capability gains.",
    line2: "Sources: Web Search · Notion",
    detail: {
      scores: [
        { label: "Confidence", value: 68 }, { label: "Importance", value: 88 },
        { label: "Urgency", value: 60 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Compile leaked details, assess competitive implications for DemoAI, share analysis with team",
      executionPlan: [
        { text: "Search for Anthropic Mythos model leak details", tool: "web search" },
        { text: "Cross-reference with existing Notion AI landscape notes", tool: "notion search" },
        { text: "Share competitive analysis summary in #strategy channel", tool: "slack send message" },
      ],
      dataSources: ["Web — Multiple reports on Anthropic Mythos model leak", "Notion — AI competitive landscape tracker"],
      impact: "Major competitive signal — potential shift in model capabilities landscape affecting DemoAI strategy.",
      permissions: "Web, Notion, Slack · Pure information gathering.",
    },
  },
  {
    id: 2, category: "work",
    title: "Meet Rai TODAY at 2pm",
    line1: "Calendar event confirmed with location pin.",
    line2: "Sources: gcal · gmail · notion",
    detail: {
      scores: [
        { label: "Confidence", value: 95 }, { label: "Importance", value: 80 },
        { label: "Urgency", value: 90 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Prepare meeting brief, pull relevant notes from Notion, set travel reminder",
      executionPlan: [
        { text: "Pull last conversation context with Rai from Gmail", tool: "gmail search" },
        { text: "Compile meeting prep notes from Notion", tool: "notion search" },
        { text: "Set 30-min travel reminder", tool: "gcal update event" },
      ],
      dataSources: ["Google Calendar — Meeting with Rai, 2:00 PM today", "Gmail — Last email thread with Rai", "Notion — Rai partnership notes"],
      impact: "Ensures you're prepared and on time for an important in-person meeting.",
      permissions: "GCal, Gmail, Notion · All operations are reversible.",
    },
  },
  {
    id: 3, category: "finance", complexity: "simple",
    title: "Brex charged $34,778 to TriNet",
    line1: "Recurring payroll charge detected, matches last month.",
    line2: "Sources: gmail · brex",
    detail: {
      scores: [
        { label: "Confidence", value: 96 }, { label: "Importance", value: 70 },
        { label: "Urgency", value: 50 }, { label: "Risk", value: 8 },
      ],
      willExecute: "Verify charge matches expected payroll amount, flag any discrepancies, log in finance tracker",
      executionPlan: [
        { text: "Compare with last month's TriNet charge", tool: "gmail search" },
        { text: "Verify headcount hasn't changed unexpectedly", tool: "notion search" },
        { text: "Log payroll confirmation in #finance channel", tool: "slack send message" },
      ],
      dataSources: ["Gmail — Brex transaction alert: $34,778 to TriNet", "Brex — Transaction history, recurring payroll"],
      impact: "Confirms payroll processed correctly. Flags anomalies early if headcount or amounts shift.",
      permissions: "Gmail, Notion, Slack · Read-only verification.",
    },
  },
  {
    id: 4, category: "finance", tag: "Alert", complexity: "simple",
    title: "Jaycie needs cap table shares",
    line1: "Urgent request from legal, pending your approval.",
    line2: "Sources: gmail",
    detail: {
      scores: [
        { label: "Confidence", value: 88 }, { label: "Importance", value: 90 },
        { label: "Urgency", value: 85 }, { label: "Risk", value: 15 },
      ],
      willExecute: "Review cap table request details, verify with legal team, prepare approval or follow-up questions",
      executionPlan: [
        { text: "Pull Jaycie's equity grant details from Gmail thread", tool: "gmail search" },
        { text: "Cross-reference with current cap table in Notion", tool: "notion search" },
        { text: "Draft approval reply or request clarification from legal", tool: "gmail create draft" },
      ],
      dataSources: ["Gmail — Jaycie cap table shares request from legal", "Notion — Cap table and equity allocation records"],
      impact: "Time-sensitive legal/equity action. Delayed response could block Jaycie's onboarding or vesting.",
      permissions: "Gmail, Notion · Draft only, requires your send confirmation.",
    },
  },
  {
    id: 5, category: "work",
    title: "Team Meeting Monday 4:30 PM",
    line1: "Agenda includes product roadmap and hiring updates.",
    line2: "Sources: gcal · notion · slack",
    detail: {
      scores: [
        { label: "Confidence", value: 90 }, { label: "Importance", value: 75 },
        { label: "Urgency", value: 65 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Pull agenda from Notion, gather recent Slack updates, prepare talking points",
      executionPlan: [
        { text: "Fetch meeting agenda from Notion", tool: "notion search" },
        { text: "Summarize key Slack threads from this week", tool: "slack search" },
        { text: "Add talking points to calendar event notes", tool: "gcal update event" },
      ],
      dataSources: ["Google Calendar — Team Meeting, Monday 4:30 PM", "Notion — Weekly meeting agenda template", "Slack — #product and #hiring channels"],
      impact: "Arrive prepared with context. Saves 15-20 minutes of pre-meeting scrambling.",
      permissions: "GCal, Notion, Slack · All operations are reversible.",
    },
  },
  {
    id: 6, category: "health",
    title: "Weekly health check — biomarkers",
    line1: "HRV trending down 8% this week, sleep score stable.",
    line2: "Sources: whoop · apple health",
    detail: {
      scores: [
        { label: "Confidence", value: 85 }, { label: "Importance", value: 65 },
        { label: "Urgency", value: 40 }, { label: "Risk", value: 10 },
      ],
      willExecute: "Analyze weekly trends, compare with activity log, suggest recovery adjustments",
      executionPlan: [
        { text: "Pull 7-day HRV and sleep trend from Whoop", tool: "whoop api" },
        { text: "Cross-reference with this week's workout intensity", tool: "apple health sync" },
        { text: "Generate weekly health summary with recommendations", tool: "notion create page" },
      ],
      dataSources: ["Whoop — HRV down 8%, recovery score 62%", "Apple Health — Sleep 7.1h avg, resting HR 52bpm"],
      impact: "Early warning on recovery trend. Suggests lighter training or earlier bedtime.",
      permissions: "Whoop, Apple Health, Notion · Read and create only.",
    },
  },
  {
    id: 8, category: "life", tag: "Personal Signal", complexity: "simple",
    title: "Downtown Mall Appointment Today",
    line1: "You have a tentative appointment at Downtown Mall Store at 11:30 AM today.",
    line2: "Sources: Google Calendar",
    detail: {
      scores: [
        { label: "Confidence", value: 80 }, { label: "Importance", value: 60 },
        { label: "Urgency", value: 80 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Confirm or decline appointment, check directions, adjust calendar",
      executionPlan: [
        { text: "Confirm or decline Downtown Mall appointment", tool: "gcal update event" },
        { text: "Check directions to Downtown Mall", tool: "web search" },
      ],
      dataSources: ["Calendar — Downtown Mall Store, 11:30 AM today (tentative)"],
      impact: "Clarifies schedule availability for today.",
      permissions: "GCal, Web · Reversible.",
    },
  },
  {
    id: 9, category: "work", tag: "World Signal",
    title: "OpenRouter Hits $1.3B — Multi-Model AI Signal",
    line1: "The Information reports OpenRouter is nearing a $1.3B valuation.",
    line2: "Sources: Gmail · Web Search · Slack",
    detail: {
      scores: [
        { label: "Confidence", value: 78 }, { label: "Importance", value: 75 },
        { label: "Urgency", value: 78 }, { label: "Risk", value: 10 },
      ],
      willExecute: "Read full article, share with team in Slack, discuss implications for DemoAI",
      executionPlan: [
        { text: "Search for OpenRouter $1.3B valuation news", tool: "web search" },
        { text: "Share OpenRouter news with team", tool: "slack send message" },
      ],
      dataSources: ["Gmail — The Information: OpenRouter $1.3B valuation", "Web — OpenRouter multi-model routing platform"],
      impact: "Market validation of multi-model routing approach. Strategic signal for DemoAI positioning.",
      permissions: "Web, Gmail, Slack · Pure information.",
    },
  },
  {
    id: 10, category: "work", tag: "Personal Signal", complexity: "simple",
    title: "Team Wants Claude Team Plan Access",
    line1: "Team Member A asked to be added to the Claude team plan.",
    line2: "Sources: Slack",
    detail: {
      scores: [
        { label: "Confidence", value: 70 }, { label: "Importance", value: 65 },
        { label: "Urgency", value: 70 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Check team plan seats, approve Team Member A, review DataConnector.dev spreadsheet",
      executionPlan: [
        { text: "Check Claude team plan seats with Team Lead", tool: "slack send message" },
        { text: "Research DataConnector.dev capabilities", tool: "web search" },
      ],
      dataSources: ["Slack #dev — Team Member A requesting Claude team plan access", "Slack #dev — DataConnector.dev evaluation spreadsheet"],
      impact: "Unblocks team access to Claude APIs. Advances app connector evaluation.",
      permissions: "Slack, Web · Reversible.",
    },
  },
  {
    id: 11, category: "work", tag: "Urgent",
    title: "Midweek Update Due in 2 Hours",
    line1: "DemoAI Team Midweek Update meeting is at 5:00 PM today (19 attendees).",
    line2: "Sources: Google Calendar · Notion · Slack",
    detail: {
      scores: [
        { label: "Confidence", value: 95 }, { label: "Importance", value: 90 },
        { label: "Urgency", value: 95 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Open Notion Team Meetings page, update action items, post update in DemoAI Core channel",
      executionPlan: [
        { text: "Update Team Meetings action items", tool: "notion update page" },
        { text: "Post midweek update in DemoAI Core channel", tool: "slack send message" },
      ],
      dataSources: ["Calendar — DemoAI Team Midweek Update 5:00 PM today", "Notion — Team Meetings action items page"],
      impact: "Ensures team alignment heading into second half of week.",
      permissions: "Notion, Slack, GCal · All operations are reversible.",
    },
  },
  {
    id: 12, category: "finance", tag: "World Signal",
    title: "Bitcoin Quantum Threat Escalating",
    line1: "Quantum computing threat to Bitcoin has moved closer.",
    line2: "Sources: Gmail · Web Search",
    detail: {
      scores: [
        { label: "Confidence", value: 72 }, { label: "Importance", value: 70 },
        { label: "Urgency", value: 72 }, { label: "Risk", value: 25 },
      ],
      willExecute: "Read analysis, discuss with Co-Founder on implications, review Demo token security",
      executionPlan: [
        { text: "Search quantum computing threat to Bitcoin", tool: "web search" },
        { text: "Draft discussion note for Co-Founder", tool: "gmail create draft" },
      ],
      dataSources: ["Gmail — Cryptopolitan: Bitcoin quantum computing threat timeline", "Web — Quantum computing threat to cryptocurrency"],
      impact: "Potential security and strategic implications for DemoAI's Web3/crypto positioning.",
      permissions: "Web, Gmail · Pure information.",
    },
  },
];

const TIMES = [
  "Apr 2 · 2:15 PM", "Apr 2 · 2:02 PM", "Apr 2 · 1:45 PM",
  "Apr 2 · 11:30 AM", "Apr 2 · 10:15 AM", "Apr 1 · 6:00 PM",
  "Apr 1 · 3:20 PM", "Apr 1 · 2:45 PM", "Apr 1 · 11:00 AM",
  "Apr 1 · 9:30 AM", "Mar 31 · 5:00 PM", "Mar 31 · 2:30 PM",
];

/* Chat status per card id: done | processing | action (needs user input) */
type ChatStatus = "done" | "processing" | "action";
/* For "action" cards, the pink badge shows actionCount = how many input
   questions the user must answer (1–3). Derived deterministically from card id
   via getActionCount() so this stays in sync with ChatDetailView's question flow. */
export function getActionCount(cardId: number): number {
  // Deterministic 1–3 based on a small hash of the card id.
  return ((cardId * 7 + 2) % 3) + 1;
}
const CHAT_STATUS: Record<number, { status: ChatStatus; actionCount?: number }> = {
  7: { status: "action", actionCount: getActionCount(7) },
  1: { status: "processing" },
  2: { status: "action", actionCount: getActionCount(2) },
  3: { status: "done" },
  4: { status: "action", actionCount: getActionCount(4) },
  5: { status: "done" },
  6: { status: "done" },
  8: { status: "action", actionCount: getActionCount(8) },
  9: { status: "processing" },
  10: { status: "done" },
  11: { status: "processing" },
  12: { status: "done" },
};

interface ChatTimelineProps {
  cardChats?: ChatCard[];
  onOpenChat?: (card: ChatCard, chatStatus: ChatStatus) => void;
}

export default function ChatTimeline({ onOpenChat }: ChatTimelineProps) {
  // Group into Today / Yesterday / Earlier
  const today = ALL_CHAT_CARDS.slice(0, 4);
  const yesterday = ALL_CHAT_CARDS.slice(4, 8);
  const earlier = ALL_CHAT_CARDS.slice(8);

  const sections = [
    { label: "Today", items: today, timeOffset: 0 },
    { label: "Yesterday", items: yesterday, timeOffset: 4 },
    { label: "Earlier", items: earlier, timeOffset: 8 },
  ];

  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      <h1 className="text-display text-2xl text-foreground mb-1">Tasks</h1>
      <p className="text-sm text-muted-foreground mb-6">AI is running these for you</p>

      {sections.map((section) => (
        <div key={section.label} className="mb-5">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 block">
            {section.label}
          </span>
          <div className="space-y-2">
            {section.items.map((card, i) => {
              const cat = CATEGORIES[card.category];
              const CatIcon = cat?.icon || Briefcase;
              const time = TIMES[section.timeOffset + i] || "";
              const chatStatus = CHAT_STATUS[card.id] || { status: "done" };
              const planSteps = card.detail?.executionPlan.length || 0;
              const previewText = chatStatus.status === "processing"
                ? `Processing ${planSteps} operations...`
                : chatStatus.status === "action"
                ? `${chatStatus.actionCount} action${(chatStatus.actionCount || 1) > 1 ? "s" : ""} need your input`
                : card.detail
                ? `${planSteps} operations completed · ${card.detail.willExecute.split(",")[0].trim()}`
                : card.line1;

              return (
                <motion.button
                  key={card.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="glass-card px-3.5 py-3 w-full text-left cursor-pointer active:scale-[0.98] transition-transform"
                  onClick={() => onOpenChat?.(card, chatStatus.status)}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-foreground/50 shrink-0">
                      <CatIcon size={14} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-[13px] font-medium text-foreground leading-tight truncate flex-1">
                          {card.title}
                        </p>
                        {card.complexity === "simple" && chatStatus.status !== "done" && (
                          <span
                            className="shrink-0 inline-flex items-center gap-1 text-[9.5px] font-bold px-1.5 py-[2px] rounded-full leading-none uppercase tracking-wide"
                            style={{ background: "rgba(225,92,230,0.12)", color: "#E15CE6" }}
                            title="Quick approve — low-risk task"
                          >
                            <span className="w-1 h-1 rounded-full" style={{ background: "#E15CE6" }} />
                            Quick
                          </span>
                        )}
                        <span className="shrink-0 w-[16px] h-[16px] inline-flex items-center justify-center">
                          {chatStatus.status === "done" && (
                            <CheckCircle2 size={14} className="text-green-500/60" />
                          )}
                          {chatStatus.status === "processing" && (
                            <Loader2 size={14} className="text-amber-500 animate-spin" />
                          )}
                          {chatStatus.status === "action" && (
                            <span className="inline-flex items-center justify-center w-[16px] h-[16px] rounded-full text-white text-[9px] font-bold leading-none" style={{ background: "#E15CE6" }}>
                              {chatStatus.actionCount || 1}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 mt-1">
                        <p className="text-[11px] text-foreground/35 truncate flex-1">
                          {previewText}
                        </p>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {time}
                        </span>
                      </div>
                    </div>
                  </div>
                </motion.button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
