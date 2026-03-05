const insights = [
  {
    icon: "🧠",
    text: "Resolved 3 schedule conflicts automatically"
  },
  {
    icon: "⏱️",
    text: "Saved ~4.5h on routine emails & follow-ups"
  },
  {
    icon: "📅",
    text: "2 meetings tomorrow, 1 deadline Fri — prep ready"
  },
  {
    icon: "📈",
    text: "Task completion rate up 18% vs last week"
  },
];

const AgentInsights = () => {
  return (
    <div className="glass-card rounded-2xl p-5 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
        </svg>
        <h3 className="text-base font-semibold text-foreground">PIN AI's Insights</h3>
      </div>

      <div className="space-y-2.5">
        {insights.map(({ icon, text }, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-lg bg-secondary flex items-center justify-center shrink-0 text-sm">
              {icon}
            </div>
            <p className="text-[13px] leading-snug text-foreground/80">{text}</p>
          </div>
        ))}
      </div>

      <button className="w-full flex items-center justify-center gap-1 text-xs text-foreground font-medium py-2.5 rounded-xl hover:bg-secondary transition-colors">
        View Full Activity Report
        <span className="ml-0.5">→</span>
      </button>
    </div>
  );
};

export default AgentInsights;
