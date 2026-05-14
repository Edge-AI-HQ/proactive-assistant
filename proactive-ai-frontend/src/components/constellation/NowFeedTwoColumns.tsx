import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sprout, Briefcase, TrendingUp, Heart, BookOpen, Sparkles,
  Zap, Pencil, X,
  type LucideIcon,
} from "lucide-react";

interface Intent {
  id: number;
  category: string;
  tag?: string;
  title: string;
  line1: string;
  line2: string;
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
    id: 7,
    category: "work",
    tag: "Urgent",
    title: "Outstanding Invoice from Alex",
    line1: "Alex Chen from Acme Consulting sent a follow-up asking to settle the outstanding March invoice. Marked IMPORTANT.",
    line2: "Sources: Gmail · Google Calendar",
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
  onExecute: (title: string) => void;
}

export default function NowFeedTwoColumns({ onExecute }: NowFeedProps) {
  const [cards, setCards] = useState(INTENTS);

  const dismiss = (id: number) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
  };

  return (
    <div className="flex flex-col h-full px-4 pt-14 overflow-y-auto pb-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-5">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-foreground/40 animate-ping opacity-50" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-foreground/60" />
        </span>
        <span className="text-sm font-medium text-foreground/80">
          {cards.length} Intents pending
        </span>
      </div>

      {/* Masonry Cards */}
      <div className="columns-2 gap-3 space-y-3">
        <AnimatePresence>
          {cards.map((card, index) => {
            const cat = CATEGORIES[card.category];
            const Icon = cat.icon;
            return (
              <motion.div
                key={card.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ delay: index * 0.05, duration: 0.3 }}
                className="break-inside-avoid"
              >
                <div className="glass-card-strong p-4 relative">
                  {/* X dismiss — top right */}
                  <button
                    onClick={() => dismiss(card.id)}
                    className="absolute top-3 right-3 p-1 rounded-full hover:bg-foreground/10 transition-colors text-foreground/25 hover:text-foreground/60"
                  >
                    <X size={12} strokeWidth={2} />
                  </button>

                  {/* Category row */}
                  <div className="flex items-center gap-1.5 mb-2 pr-6">
                    <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
                    <span className="text-[10px] font-semibold tracking-wide text-foreground/50 uppercase">
                      {cat.label}
                    </span>
                    {card.tag && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
                        {card.tag}
                      </span>
                    )}
                  </div>

                  {/* Title */}
                  <h3 className="text-display text-sm leading-snug text-foreground mb-1.5">
                    {card.title}
                  </h3>

                  {/* Two description lines */}
                  <p className="text-[11px] text-foreground/70 leading-relaxed mb-0.5">
                    {card.line1}
                  </p>
                  <p className="text-[10px] text-foreground/55 leading-relaxed mb-3">
                    {card.line2}
                  </p>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5">
                    <button
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-foreground/5 hover:bg-foreground/10 transition-colors text-[10px] font-medium text-foreground/50"
                    >
                      <Pencil size={10} strokeWidth={1.5} />
                      Modify
                    </button>
                    <button
                      onClick={() => onExecute(card.title)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-foreground text-background text-[10px] font-semibold hover:bg-foreground/85 transition-colors"
                    >
                      <Zap size={11} strokeWidth={2} />
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
  );
}
