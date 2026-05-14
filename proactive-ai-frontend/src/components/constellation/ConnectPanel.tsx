import {
  ArrowRight,
  CalendarDays,
  FileText,
  Mail,
  MessageSquare,
  Plug,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Static connector showcase — visuals only. The real Composio integration
 * status / OAuth init lives in `<ControlPanel />`; clicking Manage routes
 * the user there.
 */

interface ConnectorTile {
  id: string;
  label: string;
  icon: LucideIcon;
  accent: string;
  description: string;
  connected?: boolean;
}

const CONNECTORS: ConnectorTile[] = [
  {
    id: "gmail",
    label: "Gmail",
    icon: Mail,
    accent: "0 72% 60%",
    description: "Read threads, draft replies",
    connected: true,
  },
  {
    id: "gcal",
    label: "Calendar",
    icon: CalendarDays,
    accent: "215 70% 60%",
    description: "Track events and travel time",
    connected: true,
  },
  {
    id: "slack",
    label: "Slack",
    icon: MessageSquare,
    accent: "292 78% 63%",
    description: "Post messages, watch mentions",
  },
  {
    id: "notion",
    label: "Notion",
    icon: FileText,
    accent: "35 90% 55%",
    description: "Read pages, append notes",
  },
  {
    id: "brex",
    label: "Brex",
    icon: TrendingUp,
    accent: "145 60% 50%",
    description: "Reconcile expenses",
  },
];

interface ConnectPanelProps {
  onManage: () => void;
}

export default function ConnectPanel({ onManage }: ConnectPanelProps) {
  return (
    <div className="h-full overflow-y-auto px-5 pt-6 pb-12">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <Plug size={16} className="text-foreground/55" />
          <span className="text-[11px] font-bold text-foreground/55 uppercase tracking-wider">
            Connect
          </span>
        </div>
        <h1 className="text-display text-[26px] font-semibold text-foreground mb-1">
          Data sources
        </h1>
        <p className="text-[13px] text-foreground/60 mb-6">
          What the AI can read and act on. Tap Manage to open the real
          Composio settings.
        </p>

        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 mb-6">
          {CONNECTORS.map((c) => {
            const Icon = c.icon;
            return (
              <div key={c.id} className="glass-card-strong p-4 flex items-start gap-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: `hsl(${c.accent} / 0.12)` }}
                >
                  <Icon size={18} strokeWidth={1.8} color={`hsl(${c.accent})`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-[15px] font-semibold text-foreground">{c.label}</div>
                    {c.connected && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-green-500/12 text-green-700">
                        Connected
                      </span>
                    )}
                  </div>
                  <div className="text-[12.5px] text-foreground/60 mt-0.5">{c.description}</div>
                </div>
              </div>
            );
          })}
        </div>

        <button
          onClick={onManage}
          className="w-full h-11 rounded-xl bg-foreground text-background text-[14px] font-semibold hover:bg-foreground/85 transition-colors flex items-center justify-center gap-2"
        >
          Manage connections
          <ArrowRight size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
