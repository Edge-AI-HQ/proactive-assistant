interface AgentCardProps {
  username: string | null;
  status: string;
  planId: string | null;
  active: boolean;
}

const AgentCard = ({ username, status, planId, active }: AgentCardProps) => {
  return (
    <div className={`rounded-2xl p-5 transition-all animate-fade-in ${active ? "bg-white/45 backdrop-blur-xl border border-white/60 shadow-[inset_0_1px_1px_hsl(0_0%_100%/0.5),0_4px_24px_-4px_hsl(270_30%_60%/0.1)]" : "bg-card shadow-sm"}`}>
      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          <div className="avatar-ring-glow" style={{ width: 56, height: 56 }}>
            <div className="w-[52px] h-[52px] rounded-full bg-gradient-to-br from-primary to-pin-lavender flex items-center justify-center shadow-md">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="text-base font-semibold text-foreground">PIN AI</h3>
            {active && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full status-active-dot animate-pulse-soft" />
                <span className="text-[10px] status-active-text font-medium">Active 24/7</span>
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mb-1">All-in-One AI Assistant</p>
          {username && (
            <p className="text-xs text-foreground/70 font-medium">@{username}</p>
          )}
        </div>
        {/* Plan Badge */}
        <div className="shrink-0 rounded-xl bg-secondary px-3 py-1.5 text-center">
          <p className="text-[10px] text-muted-foreground font-medium">Plan</p>
          <p className="text-xs font-semibold text-foreground">{planId || "Free"}</p>
        </div>
      </div>

      {/* Status */}
      <div className="mt-4 mb-4 glass-stat-box rounded-xl px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Status</span>
          <span className={`text-xs font-semibold flex items-center gap-1 ${
            status === 'running' ? 'text-pin-mint' : 
            status === 'missing' ? 'text-amber-600' : 
            'text-muted-foreground'
          }`}>
            {status === 'missing' && (
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            )}
            {status === 'missing' ? 'Starting...' : status || "unknown"}
          </span>
        </div>
        {status === 'missing' && (
          <div className="mt-2 text-xs text-amber-600/80">
            Container is being created. This may take 1-2 minutes.
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2.5">
        <button 
          onClick={() => window.open(`https://t.me/${username}`, '_blank')}
          className="flex-1 flex items-center justify-center gap-1.5 bg-foreground text-background rounded-xl py-2.5 text-sm font-medium btn-press"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          Start Chat
        </button>
      </div>
    </div>
  );
};

export default AgentCard;
