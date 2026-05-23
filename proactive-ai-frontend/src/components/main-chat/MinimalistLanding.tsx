import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, Send } from "lucide-react";
import bgGradient from "@/assets/bg-gradient.jpg";
import AiSphere from "@/components/constellation/AiSphere";
import { VoiceButton } from "@/components/voice";

interface Suggestion {
  label: string;
  prompt: string;
}

const SUGGESTIONS: Suggestion[] = [
  { label: "What should I focus on today?", prompt: "What should I focus on today?" },
  { label: "Summarize my week so far", prompt: "Summarize my week so far" },
  { label: "What's on my mind lately?", prompt: "What's on my mind lately?" },
];

interface MinimalistLandingProps {
  /** Return to the Constellation. */
  onBack: () => void;
  /** Submit a user message into the singleton main thread. The parent
   *  (MainChat) appends it to the runtime and switches view to the
   *  conversation transcript. */
  onSubmit: (text: string) => void;
  /** While the parent is still loading the user's main thread (and the
   *  runtime isn't ready to accept appends), keep the composer + chips
   *  disabled. Visual is unchanged; only interactions are gated. */
  disabled?: boolean;
}

/**
 * Landing page for Main Chat — the user always lands here when they tap
 * "ASK PIN AI" in the Constellation. The transcript is a singleton main
 * thread per user (history accumulates); Landing is just the entry
 * surface (greeting + suggestions + composer). Submitting from a chip
 * or the composer transitions to the conversation view, where the
 * message is appended into the same thread.
 *
 * From the conversation, Back closes Main Chat and returns to the app's
 * Now surface; Landing remains only the ASK PIN AI entry surface.
 */
export default function MinimalistLanding({
  onBack,
  onSubmit,
  disabled = false,
}: MinimalistLandingProps) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [text]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText("");
    onSubmit(trimmed);
  }, [onSubmit, text, disabled]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleSuggestionTap = (s: Suggestion) => {
    if (disabled) return;
    onSubmit(s.prompt);
  };

  const canSend = !!text.trim() && !disabled;

  return (
    <div className="absolute inset-0 z-50 font-native overflow-hidden">
      {/* Background — same aurora system as ConstellationLayout / the
          reference MinimalistConstellationLayout. The page lives over a
          gradient image with three drifting aurora layers and a soft
          white wash so glass-card chips read clearly. */}
      <img
        src={bgGradient}
        alt=""
        className="absolute inset-0 w-full h-full object-cover opacity-60"
        aria-hidden="true"
      />
      <div className="absolute inset-0 aurora-layer aurora-layer-1" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-2" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-3" aria-hidden="true" />
      <div className="absolute inset-0 bg-white/35" />

      <div className="relative z-10 flex flex-col h-full">
        {/* Minimal top bar — single back chevron. The conversation view
            has its own header shown after the user enters it. */}
        <div className="shrink-0 px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-2">
          <button
            onClick={onBack}
            className="p-2 -ml-1 rounded-full hover:bg-foreground/[0.06] transition-colors"
            aria-label="Close"
          >
            <ChevronDown
              size={20}
              strokeWidth={1.5}
              className="text-foreground/65"
            />
          </button>
        </div>

        {/* Scrollable body — sphere + greeting + chips. No "Recent Chats"
            list: the thread is a singleton, the user simply continues
            their existing conversation by tapping a chip / typing. */}
        <div className="flex-1 overflow-y-auto px-4 pb-3">
          <div className="flex flex-col items-center pt-2 pb-4">
            <div className="mb-7">
              <AiSphere size={216} mode="idle" />
            </div>
            <h2 className="text-[28px] font-semibold tracking-tight text-foreground leading-[1.05] text-center px-6">
              What&apos;s on your mind?
            </h2>
            <p className="mt-2 text-[13px] text-foreground/50 leading-snug text-center px-8">
              Ask anything — I have your context.
            </p>
          </div>

          <div className="w-full flex flex-col gap-2 px-3">
            {SUGGESTIONS.map((s, i) => (
              <motion.button
                key={s.label}
                type="button"
                disabled={disabled}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.32,
                  delay: 0.12 + i * 0.05,
                  ease: [0.32, 0.72, 0, 1],
                }}
                onClick={() => handleSuggestionTap(s)}
                className="group w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border border-foreground/[0.08] text-left hover:bg-foreground/[0.03] transition-colors disabled:opacity-60 disabled:cursor-default"
                style={{
                  background: "rgba(255,255,255,0.45)",
                  backdropFilter: "blur(20px) saturate(1.4)",
                  WebkitBackdropFilter: "blur(20px) saturate(1.4)",
                }}
              >
                <span className="text-[13px] text-foreground/75 leading-snug">
                  {s.label}
                </span>
                <span className="text-foreground/30 group-hover:text-foreground/55 transition-colors shrink-0">
                  →
                </span>
              </motion.button>
            ))}
          </div>
        </div>

        {/* Composer — capsule glass card matching MainChatView's restyled
            composer. Submit appends the text into the singleton main
            thread and transitions to the conversation view. */}
        <div className="shrink-0 px-3 pb-6 pt-2">
          <div
            className="flex items-end gap-2 pl-4 pr-2 py-2 rounded-3xl border border-foreground/[0.08] focus-within:border-foreground/[0.18] transition-colors"
            style={{
              background: "rgba(255,255,255,0.6)",
              backdropFilter: "blur(20px) saturate(1.5)",
              WebkitBackdropFilter: "blur(20px) saturate(1.5)",
              boxShadow: "0 4px 24px hsl(0 0% 0% / 0.04)",
            }}
          >
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message PIN AI…"
              rows={1}
              className="flex-1 resize-none bg-transparent text-[15px] text-foreground placeholder:text-foreground/35 outline-none leading-[20px] py-2 min-h-9 max-h-[120px]"
            />
            <VoiceButton
              prefill={text}
              onUpdate={setText}
              size={18}
              className="w-9 h-9 rounded-full bg-transparent text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/80"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-95"
              style={
                canSend
                  ? {
                      background:
                        "linear-gradient(135deg, hsl(292 78% 63%) 0%, hsl(330 80% 65%) 100%)",
                      boxShadow: "0 4px 12px hsl(292 78% 63% / 0.35)",
                      color: "hsl(var(--background))",
                    }
                  : {
                      background: "hsl(var(--foreground) / 0.08)",
                      color: "hsl(var(--foreground) / 0.35)",
                    }
              }
              aria-label="Send"
            >
              <Send size={15} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
