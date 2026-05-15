import { Mic } from "lucide-react";

import { cn } from "@/lib/utils";

import { useVoiceInput } from "./VoiceProvider";
import type { StartCaptureOptions } from "./types";

export interface VoiceButtonProps extends StartCaptureOptions {
  className?: string;
  size?: number;
  "aria-label"?: string;
}

// Small mic-icon button that opens the global voice capture overlay.
// Drop in next to any text input:
//   <VoiceButton onUpdate={setInputValue} />
// For a "voice-only" entry (no text input mirroring), pass onResult instead.
export function VoiceButton({
  className,
  size = 17,
  prefill,
  onUpdate,
  onResult,
  "aria-label": ariaLabel,
}: VoiceButtonProps) {
  const { startCapture, isCapturing } = useVoiceInput();
  return (
    <button
      type="button"
      onClick={() => startCapture({ prefill, onUpdate, onResult })}
      disabled={isCapturing}
      className={cn(
        "w-8 h-8 rounded-full bg-foreground/10 flex items-center justify-center text-foreground/60 hover:bg-foreground/15 hover:text-foreground transition-colors disabled:opacity-40",
        className,
      )}
      aria-label={ariaLabel ?? "Voice input"}
    >
      <Mic size={size} strokeWidth={2} />
    </button>
  );
}
