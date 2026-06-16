import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Check, ChevronDown, Loader2, Mic, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import bgGradient from "../../assets/bg-gradient.jpg";
import AiSphere from "../../now/AiSphere";
import { useVoiceInput, Waveform, appendVoiceTranscript } from "../../voice";
import { Text } from "../../primitives/Text";

interface Suggestion {
  /** chat-namespace key for the chip text (display only — translated). */
  labelKey:
    | "landing.suggestions.focusToday"
    | "landing.suggestions.summarizeWeek"
    | "landing.suggestions.onMyMind";
  /** The message actually sent to the LLM — stays English regardless of UI
   *  language (model-facing text is out of i18n scope). */
  prompt: string;
}

const SUGGESTIONS: Suggestion[] = [
  { labelKey: "landing.suggestions.focusToday", prompt: "What should I focus on today?" },
  { labelKey: "landing.suggestions.summarizeWeek", prompt: "Summarize my week so far" },
  { labelKey: "landing.suggestions.onMyMind", prompt: "What's on my mind lately?" },
];

function formatRecordDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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
  const { t } = useTranslation(["chat", "common"]);
  const [text, setText] = useState("");
  const { startCapture, stopCapture, captureStatus } = useVoiceInput();
  const [recording, setRecording] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceFinalizing, setVoiceFinalizing] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const recordingRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  // "整体上移" keyboard avoidance. The composer floats above the keyboard
  // (absolute bottom:--kb-height) while the body stays put, so the body's lower
  // chips can end up hidden behind the composer. We measure how far the content
  // overruns the composer's floated-up top edge and lift the whole body by
  // exactly that (+ a small gap) — the last chip lands just above the input and
  // the sphere rides off the top (clipped by the root overflow-hidden). At rest
  // (--kb-height 0) lift is 0, so the landing is byte-for-byte unchanged.
  const [lift, setLift] = useState(0);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [text]);

  useEffect(() => {
    const recompute = () => {
      const kb = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--kb-height"),
      );
      const body = bodyRef.current;
      const composer = composerRef.current;
      if (!body || !composer || !kb || kb <= 0) {
        setLift(0);
        return;
      }
      // Bottom of the real content — the chips block is the body's last child.
      // Body carries no transform here (lift was reset to 0 on the prior hide),
      // so this rect is the true on-screen position.
      const chips = body.lastElementChild;
      if (!chips) return;
      const contentBottom = chips.getBoundingClientRect().bottom;
      // Composer's top once floated to bottom:--kb-height. offsetHeight is
      // independent of the bottom transition, so we needn't wait for it.
      const composerTop = window.innerHeight - kb - composer.offsetHeight;
      const overrun = contentBottom - composerTop;
      setLift(overrun > 0 ? Math.ceil(overrun) + 12 : 0);
    };
    window.addEventListener("pinai:kbShow", recompute);
    window.addEventListener("pinai:kbHide", recompute);
    return () => {
      window.removeEventListener("pinai:kbShow", recompute);
      window.removeEventListener("pinai:kbHide", recompute);
    };
  }, []);

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

  const startRecording = useCallback(() => {
    if (disabled) return;
    setVoiceTranscript("");
    setVoiceFinalizing(false);
    setRecordSec(0);
    setRecording(true);
    startCapture({
      inline: true,
      onUpdate: setVoiceTranscript,
      onError: setVoiceTranscript,
      onResult: (final) => {
        setText((prev) => appendVoiceTranscript(prev, final));
        setRecording(false);
        setVoiceFinalizing(false);
        setVoiceTranscript("");
        window.setTimeout(() => taRef.current?.focus(), 0);
      },
    });
  }, [disabled, startCapture]);

  const cancelRecording = useCallback(() => {
    void stopCapture(false);
    setRecording(false);
    setVoiceFinalizing(false);
    setVoiceTranscript("");
  }, [stopCapture]);

  const confirmRecording = useCallback(() => {
    setVoiceFinalizing(true);
    void stopCapture(true);
  }, [stopCapture]);

  useEffect(() => {
    if (!recording) return;
    const startedAt = Date.now();
    const t = window.setInterval(
      () => setRecordSec(Math.floor((Date.now() - startedAt) / 1000)),
      250,
    );
    return () => window.clearInterval(t);
  }, [recording]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    return () => {
      if (recordingRef.current) void stopCapture(false);
    };
  }, [stopCapture]);

  const canSend = !!text.trim() && !disabled;
  const voiceConnecting = recording && captureStatus === "connecting";

  return (
    <div className="absolute inset-0 z-50 font-native overflow-hidden">
      {/* Background — same aurora system as AppLayout / the
          reference MinimalistAppLayout. The page lives over a
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

      {/* Content column. The landing layout itself NEVER moves when the keyboard
          opens — only the composer floats up (see its absolute bottom:--kb-height
          below). relative makes this the positioning context for that composer. */}
      <div className="relative z-10 flex flex-col h-full">
        {/* Minimal top bar — single back chevron. The conversation view
            has its own header shown after the user enters it. */}
        <div className="shrink-0 px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-2">
          <button
            onClick={onBack}
            className="p-2 -ml-1 rounded-full hover:bg-foreground/[0.06] transition-colors"
            aria-label={t("common:status.close")}
          >
            <ChevronDown
              size={20}
              strokeWidth={1.5}
              className="text-foreground/65"
            />
          </button>
        </div>

        {/* Inner column under the top bar — fills the remaining height and holds
            the scrollable body. The composer is NOT stacked in here; it's an
            absolutely-positioned element that floats above the keyboard, so the
            body (sphere + chips) keeps its resting position no matter what the
            keyboard does. */}
        <div className="flex-1 flex flex-col overflow-hidden">
        {/* Scrollable body — sphere + greeting + chips. Lifted up by `lift` when
            the keyboard is open (see the measuring effect above) so the chips
            clear the floated composer; untouched at rest. No "Recent Chats"
            list: the thread is a singleton, tap a chip / type to continue. */}
        <div
          ref={bodyRef}
          className="flex-1 overflow-y-auto px-4 pb-3"
          style={{
            transform: `translateY(-${lift}px)`,
            transition: "transform 250ms cubic-bezier(0.17, 0.59, 0.4, 0.77)",
          }}
        >
          <div className="flex flex-col items-center pt-2 pb-4">
            <div className="mb-7">
              <AiSphere size={216} mode="idle" />
            </div>
            <Text as="h2" variant="display" weight="semibold" className="tracking-tight text-center px-6">
              {t("landing.heading")}
            </Text>
            <Text variant="bodySm" className="block mt-2 text-foreground/50 leading-snug text-center px-8">
              {t("landing.subheading")}
            </Text>
          </div>

          <div className="w-full flex flex-col gap-2 px-3">
            {SUGGESTIONS.map((s, i) => (
              <motion.button
                key={s.labelKey}
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
                <Text variant="bodySm" className="text-foreground/75 leading-snug">
                  {t(s.labelKey)}
                </Text>
                <span className="text-foreground/30 group-hover:text-foreground/55 transition-colors shrink-0">
                  →
                </span>
              </motion.button>
            ))}
          </div>
        </div>

        {/* Composer — capsule glass card matching ConversationView's restyled
            composer. Floats above the keyboard via absolute bottom:--kb-height
            WITHOUT moving the landing body: at rest (--kb-height 0) it sits at
            the screen bottom exactly as before; when the keyboard opens it rides
            up to just above it, and the keyboard covers the empty space that was
            below the chips — so the landing layout never shifts. Submit appends
            the text into the singleton main thread and switches to the
            conversation view. */}
        <div
          ref={composerRef}
          className="absolute inset-x-0 px-3 pb-6 pt-2"
          style={{
            bottom: "var(--kb-height, 0px)",
            transition: "bottom 250ms cubic-bezier(0.17, 0.59, 0.4, 0.77)",
          }}
        >
          {recording ? (
            <div
              className="flex flex-col gap-2 rounded-3xl border border-foreground/[0.08] px-4 py-3"
              style={{
                background: "rgba(255,255,255,0.6)",
                backdropFilter: "blur(20px) saturate(1.5)",
                WebkitBackdropFilter: "blur(20px) saturate(1.5)",
                boxShadow: "0 4px 24px hsl(0 0% 0% / 0.04)",
              }}
            >
              <p className="flex min-h-[20px] items-center gap-1.5 text-body italic leading-snug text-foreground/55">
                {voiceConnecting && !voiceFinalizing && !voiceTranscript && (
                  <Loader2 size={14} strokeWidth={2} className="shrink-0 animate-spin" />
                )}
                <span className="min-w-0 truncate">
                  {voiceFinalizing
                    ? t("common:status.polishing")
                    : voiceTranscript ||
                      (voiceConnecting
                        ? t("common:status.connecting")
                        : t("common:status.listening"))}
                </span>
              </p>
              <div className="flex items-center gap-2.5">
                <Text variant="label" weight="medium" className="w-[40px] shrink-0 tabular-nums text-foreground/55">
                  {formatRecordDuration(recordSec)}
                </Text>
                {voiceConnecting ? (
                  <div className="flex min-w-0 flex-1 items-center justify-center">
                    <Loader2 size={19} strokeWidth={2} className="animate-spin text-foreground/50" />
                  </div>
                ) : (
                  <Waveform className="flex-1" />
                )}
                <button
                  type="button"
                  onClick={cancelRecording}
                  disabled={voiceFinalizing}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06] text-foreground/55 transition-colors hover:bg-foreground/10 disabled:opacity-40"
                  aria-label={t("composer.cancelRecording")}
                >
                  <X size={16} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={() => void confirmRecording()}
                  disabled={voiceFinalizing || voiceConnecting}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-background transition-transform active:scale-95 disabled:opacity-60"
                  style={{
                    background:
                      "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330 80% 65%) 100%)",
                    boxShadow: "0 4px 12px hsl(var(--primary) / 0.35)",
                  }}
                  aria-label={t("composer.useTranscript")}
                >
                  <Check size={16} strokeWidth={2.5} />
                </button>
              </div>
            </div>
          ) : (
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
                placeholder={t("composer.placeholder")}
                rows={1}
                className="flex-1 resize-none bg-transparent text-body text-foreground placeholder:text-foreground/35 outline-none leading-[20px] py-2 min-h-9 max-h-[120px]"
              />
              <button
                type="button"
                onClick={startRecording}
                disabled={disabled}
                className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-transparent text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/80 disabled:opacity-40"
                aria-label={t("composer.voiceInput")}
              >
                <Mic size={18} strokeWidth={1.6} />
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-95"
                style={
                  canSend
                    ? {
                        background:
                          "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330 80% 65%) 100%)",
                        boxShadow: "0 4px 12px hsl(var(--primary) / 0.35)",
                        color: "hsl(var(--background))",
                      }
                    : {
                        background: "hsl(var(--foreground) / 0.08)",
                        color: "hsl(var(--foreground) / 0.35)",
                      }
                }
                aria-label={t("composer.send")}
              >
                <Send size={15} strokeWidth={2} />
              </button>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
