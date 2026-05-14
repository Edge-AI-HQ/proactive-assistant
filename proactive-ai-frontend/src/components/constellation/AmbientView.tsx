import {
  Activity,
  Brain,
  Calendar,
  Cloud,
  Heart,
  MapPin,
  Sparkles,
  Sun,
} from "lucide-react";

/**
 * Hardcoded ambient signals view —后端没接前先展示静态卡。等
 * personal_signals / world_signals / device-ingest 数据真接通了再换成
 * 真数据；视觉契约和真数据 shape 对齐：每张卡片是 (icon, label, value,
 * subtitle, accent)。
 */

interface SignalCard {
  icon: typeof MapPin;
  label: string;
  value: string;
  subtitle: string;
  accent: string;
}

const SIGNALS: SignalCard[] = [
  {
    icon: MapPin,
    label: "Location",
    value: "Home",
    subtitle: "Stable for 2h 14m",
    accent: "215 70% 60%",
  },
  {
    icon: Sun,
    label: "Weather",
    value: "23°C · Rainy",
    subtitle: "Stanford, CA",
    accent: "35 90% 55%",
  },
  {
    icon: Brain,
    label: "Focus",
    value: "Deep work",
    subtitle: "Last 45m, no Slack pings",
    accent: "280 70% 60%",
  },
  {
    icon: Heart,
    label: "HRV",
    value: "62 ms",
    subtitle: "Trending ↓ 8% this week",
    accent: "0 72% 60%",
  },
  {
    icon: Activity,
    label: "Activity",
    value: "Below baseline",
    subtitle: "3.2k steps today",
    accent: "145 60% 50%",
  },
  {
    icon: Calendar,
    label: "Next event",
    value: "Meet Rai · 2:00 PM",
    subtitle: "Coupa Cafe, Stanford",
    accent: "292 78% 63%",
  },
];

export default function AmbientView() {
  return (
    <div className="h-full overflow-y-auto px-5 pt-6 pb-12">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={16} className="text-foreground/55" />
          <span className="text-[11px] font-bold text-foreground/55 uppercase tracking-wider">
            Ambient
          </span>
        </div>
        <h1 className="text-display text-[26px] font-semibold text-foreground mb-1">
          Signals around you
        </h1>
        <p className="text-[13px] text-foreground/60 mb-6">
          Live context the AI is reading. Tap a signal to see what it&apos;s
          informing.
        </p>

        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
          {SIGNALS.map((s) => {
            const Icon = s.icon;
            return (
              <div
                key={s.label}
                className="glass-card-strong p-4 flex items-start gap-3"
              >
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: `hsl(${s.accent} / 0.12)` }}
                >
                  <Icon size={18} strokeWidth={1.8} color={`hsl(${s.accent})`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold text-foreground/50 uppercase tracking-wider mb-0.5">
                    {s.label}
                  </div>
                  <div className="text-[16px] font-semibold text-foreground leading-tight">
                    {s.value}
                  </div>
                  <div className="text-[12px] text-foreground/55 mt-1">
                    {s.subtitle}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="glass-card p-4 mt-6 flex items-start gap-3">
          <Cloud size={16} className="text-foreground/45 mt-0.5 shrink-0" />
          <p className="text-[12.5px] text-foreground/60 leading-relaxed">
            Showing placeholder data — once your devices and connectors are
            wired, this view streams real signals from the personal-signals
            pipeline.
          </p>
        </div>
      </div>
    </div>
  );
}
