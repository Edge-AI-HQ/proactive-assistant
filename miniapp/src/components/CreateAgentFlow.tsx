interface CreateAgentFlowProps {
  onContinue: () => void;
  onBack?: () => void;
}

const features = [
  { img: "/mini/sketch-brain.png", label: "Task Intelligence", desc: "From planning to execution." },
  { img: "/mini/sketch-bull.png", label: "Autonomous Operations", desc: "Real-world actions, handled by your AI." },
  { img: "/mini/sketch-flower.png", label: "24/7 Active", desc: "Always available. Always improving." },
];

const CreateAgentFlow = ({ onContinue, onBack }: CreateAgentFlowProps) => {
  return (
    <div className="fixed inset-0 z-[9999] bg-pin-gradient animate-slide-up">
      <div
        className="max-w-md mx-auto h-full flex flex-col"
        style={{
          paddingTop: "calc(var(--safe-top) + 0.75rem)",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)",
        }}
      >
        <div className="relative flex items-center justify-center px-5 py-3 shrink-0">
          {onBack && (
            <button onClick={onBack} className="absolute left-4 w-8 h-8 flex items-center justify-center rounded-xl hover:bg-black/5 transition-colors">
              <svg className="w-5 h-5 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <h2 className="text-sm font-semibold text-foreground">Create Your AI Agent</h2>
        </div>

        {/* Content — fills remaining space, centered vertically */}
        <div className="flex-1 flex flex-col items-center justify-center px-6 min-h-0">
          <div className="relative mb-5">
            <div className="w-28 h-28 rounded-full bg-primary/10 flex items-center justify-center animate-pulse-soft">
              <img
                src="/mini/avatar-pinai.png"
                alt="PIN AI"
                className="w-20 h-20 object-contain"
              />
            </div>
          </div>

          <h1 className="text-2xl font-bold text-foreground text-center mb-1.5">
            Create Your AI Agent
          </h1>
          <p className="text-sm text-muted-foreground text-center max-w-[280px] mb-6">
            Your personal all-in-one AI assistant. Deploy in 60 seconds, runs 24/7.
          </p>

          <div className="w-full space-y-2.5">
            {features.map(({ img, label, desc }) => (
              <div
                key={label}
                className="flex items-center gap-4 bg-white rounded-2xl p-3.5 border border-border/20 shadow-sm animate-fade-in"
              >
                <div className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0">
                  <img src={img} alt={label} className="w-10 h-10 object-contain" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{label}</h3>
                  <p className="text-xs text-muted-foreground">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom button — always visible, no fixed positioning */}
        <div className="shrink-0 px-5 pt-3">
          <button
            onClick={onContinue}
            className="w-full bg-foreground text-background rounded-2xl py-3.5 text-base font-semibold btn-press shadow-md flex items-center justify-center gap-2"
          >
            Continue
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateAgentFlow;
