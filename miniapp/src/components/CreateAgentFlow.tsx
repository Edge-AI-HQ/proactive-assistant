import { useState, useEffect, useCallback } from "react";

interface CreateAgentFlowProps {
  open: boolean;
  onClose: () => void;
  onCreateSuccess: () => void;
}

const CreateAgentFlow = ({ open, onClose, onCreateSuccess }: CreateAgentFlowProps) => {
  const [step, setStep] = useState(0);
  const [deploying, setDeploying] = useState(false);
  const [deployed, setDeployed] = useState(false);

  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setStep(0);
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
      
      // Wait a bit before calling success callback
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

  const stepTitles = ["准备创建", ""];

  return (
    <div className="fixed inset-0 z-50 bg-background animate-slide-up">
      <div className="max-w-md mx-auto h-full flex flex-col">
        {/* Header */}
        {step === 0 && (
          <div className="flex items-center justify-between px-5 pt-5 pb-3">
            <button onClick={onClose} className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center btn-press">
              <svg className="w-5 h-5 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <h2 className="text-sm font-semibold text-foreground">Ready to Create</h2>
            <div className="w-9" />
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 pb-32">
          {/* Step 0: Ready to Create */}
          {step === 0 && (
            <div className="animate-fade-in space-y-6 mt-8">
              <div className="text-center">
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary to-pin-lavender flex items-center justify-center mx-auto mb-4">
                  <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <h1 className="font-heading text-2xl font-bold text-foreground mb-2">
                  Create Your AI Assistant
                </h1>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  Click below to create your personal AI assistant. Once created, you can chat with it on Telegram.
                </p>
              </div>

              {/* Features Preview */}
              <div className="glass-card rounded-2xl p-5 space-y-3">
                <h3 className="text-sm font-semibold text-foreground mb-3">You'll get:</h3>
                <div className="space-y-2.5">
                  {[
                    { icon: "🤖", text: "Dedicated AI Assistant" },
                    { icon: "💬", text: "24/7 Online Service" },
                    { icon: "⚡", text: "Fast Response" },
                    { icon: "🔒", text: "Secure & Private" },
                  ].map((item, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <span className="text-xl">{item.icon}</span>
                      <p className="text-sm text-foreground/80">{item.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Deploy */}
          {step === 1 && (
            <div className="flex flex-col items-center justify-center min-h-[60vh] animate-fade-in">
              {deploying && (
                <div className="text-center">
                  <div className="w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6 deploy-glow animate-deploy-pulse">
                    <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center animate-deploy-pulse" style={{ animationDelay: "0.3s" }}>
                      <div className="w-8 h-8 rounded-full bg-primary" />
                    </div>
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">Deploying your AI...</h3>
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
                      { shape: 'rect', size: 'w-0.5 h-2', color: 'bg-primary/30', left: '18%', delay: '0.35s' },
                      { shape: 'circle', size: 'w-1 h-1', color: 'bg-pin-lavender/40', left: '90%', delay: '0.2s' },
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

        {/* Bottom Button */}
        {step === 0 && (
          <div className="fixed bottom-0 left-0 right-0 bg-background/90 backdrop-blur-lg border-t border-border/30 p-5">
            <div className="max-w-md mx-auto">
              <button
                onClick={() => {
                  setStep(1);
                  handleDeploy();
                }}
                className="w-full bg-foreground text-background rounded-xl py-3.5 text-sm font-semibold btn-press shadow-md flex items-center justify-center gap-2"
              >
                Create Agent
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
