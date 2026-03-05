import { useState, useEffect } from "react";

interface CreateAgentFlowProps {
  open: boolean;
  onClose: () => void;
  onCreateSuccess: () => void;
}

const features = [
  { img: "/tg-subscription-mini/sketch-brain.png", label: "Task Intelligence", desc: "From planning to execution." },
  { img: "/tg-subscription-mini/sketch-bull.png", label: "Autonomous Operations", desc: "Real-world actions, handled by your AI." },
  { img: "/tg-subscription-mini/sketch-flower.png", label: "24/7 Active", desc: "Always available. Always improving." },
];

const CreateAgentFlow = ({ open, onClose, onCreateSuccess }: CreateAgentFlowProps) => {
  const [step, setStep] = useState(1);
  const [deploying, setDeploying] = useState(false);
  const [deployed, setDeployed] = useState(false);

  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setStep(1);
        setDeploying(false);
        setDeployed(false);
      }, 300);
    }
  }, [open]);

  const handleDeploy = async () => {
    setDeploying(true);
    try {
      const response = await fetch("/api/mini/create-assistant", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        throw new Error("Failed to create assistant");
      }

      setDeploying(false);
      setDeployed(true);
      
      setTimeout(() => {
        onCreateSuccess();
        onClose();
      }, 2000);
    } catch (error) {
      setDeploying(false);
      alert(`Creation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-pin-gradient animate-slide-up overflow-hidden">
      <div className="max-w-md mx-auto h-full flex flex-col overflow-y-auto">
        {/* Header */}
        {step === 1 && (
          <div className="flex items-center justify-between px-5 pt-5 pb-3">
            <button onClick={onClose} className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center btn-press">
              <svg className="w-5 h-5 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h2 className="text-sm font-semibold text-foreground">Create Your AI Agent</h2>
            <div className="w-9" />
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 pb-32">
          {/* Step 1: Features overview */}
          {step === 1 && (
            <div className="flex flex-col items-center pt-4 animate-fade-in">
              {/* Large icon circle */}
              <div className="relative mb-6">
                <div className="w-32 h-32 rounded-full bg-primary/10 flex items-center justify-center animate-pulse-soft">
                  <svg className="w-20 h-20 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
              </div>

              {/* Title and subtitle */}
              <h1 className="text-2xl font-bold text-foreground text-center mb-2">
                Create Your AI Agent
              </h1>
              <p className="text-sm text-muted-foreground text-center max-w-[280px] mb-8">
                Your personal all-in-one AI assistant. Deploy in 60 seconds, runs 24/7.
              </p>

              {/* Feature cards */}
              <div className="w-full space-y-3">
                {features.map(({ img, label, desc }) => (
                  <div
                    key={label}
                    className="flex items-center gap-4 bg-white rounded-2xl p-4 border border-border/20 shadow-sm animate-fade-in"
                  >
                    <div className="w-14 h-14 rounded-xl flex items-center justify-center shrink-0">
                      <img src={img} alt={label} className="w-12 h-12 object-contain" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">{label}</h3>
                      <p className="text-xs text-muted-foreground">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 2: Deploy */}
          {step === 2 && (
            <div className="flex flex-col items-center justify-center min-h-[60vh] animate-fade-in">
              {deploying && (
                <div className="text-center">
                  <div className="w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6 deploy-glow animate-deploy-pulse">
                    <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center animate-deploy-pulse" style={{ animationDelay: "0.3s" }}>
                      <div className="w-8 h-8 rounded-full bg-primary" />
                    </div>
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">Deploying your AI…</h3>
                  <p className="text-sm text-muted-foreground">Setting up neural pathways</p>
                </div>
              )}
              {deployed && (
                <div className="text-center animate-scale-in">
                  <div className="relative mb-6">
                    {/* Confetti */}
                    {[
                      { shape: 'circle', size: 'w-2 h-2', color: 'bg-primary/40', left: '10%', delay: '0s' },
                      { shape: 'circle', size: 'w-1.5 h-1.5', color: 'bg-primary/25', left: '25%', delay: '0.15s' },
                      { shape: 'rect', size: 'w-1 h-3', color: 'bg-primary/30', left: '40%', delay: '0.3s' },
                      { shape: 'circle', size: 'w-2.5 h-2.5', color: 'bg-pin-lavender/50', left: '55%', delay: '0.1s' },
                      { shape: 'rect', size: 'w-1 h-2.5', color: 'bg-pin-lavender/35', left: '70%', delay: '0.25s' },
                      { shape: 'circle', size: 'w-1.5 h-1.5', color: 'bg-primary/20', left: '82%', delay: '0.4s' },
                    ].map((p, i) => (
                      <span
                        key={i}
                        className={`absolute ${p.size} ${p.color} ${p.shape === 'circle' ? 'rounded-full' : 'rounded-sm'} animate-confetti-fall`}
                        style={{
                          left: p.left,
                          animationDelay: p.delay,
                          top: -10,
                        }}
                      />
                    ))}
                    <div className="w-20 h-20 rounded-full bg-pin-mint/20 flex items-center justify-center mx-auto">
                      <svg className="w-10 h-10 text-pin-mint" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  </div>
                  <h3 className="text-xl font-bold text-foreground mb-1">Your Agent is Live!</h3>
                  <p className="text-sm text-muted-foreground mb-8">Returning to home...</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom button */}
        {step === 1 && (
          <div className="fixed bottom-0 left-0 right-0 bg-background/90 backdrop-blur-lg border-t border-border/30 p-5">
            <div className="max-w-md mx-auto">
              <button
                onClick={() => {
                  setStep(2);
                  handleDeploy();
                }}
                className="w-full bg-foreground text-background rounded-2xl py-4 text-base font-semibold btn-press shadow-md flex items-center justify-center gap-2"
              >
                Continue
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CreateAgentFlow;
