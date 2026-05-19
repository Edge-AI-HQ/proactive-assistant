import { Cpu } from "lucide-react";
import { RECOMMENDED_AMBIENT_LLM_LABEL } from "@/services/ambient/models-recommendation";

interface AmbientModelRequiredCardProps {
  onOpenSetup: () => void;
}

export default function AmbientModelRequiredCard({ onOpenSetup }: AmbientModelRequiredCardProps) {
  return (
    <div className="mb-3 rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
          <Cpu size={15} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-foreground/80">On-device LLM required</p>
          <p className="mt-1 text-[11px] leading-snug text-foreground/50">
            Download {RECOMMENDED_AMBIENT_LLM_LABEL} to turn your ambient signals into private local summaries.
          </p>
          <button
            type="button"
            onClick={onOpenSetup}
            className="mt-3 min-h-9 rounded-full bg-foreground px-4 text-[12px] font-semibold text-background transition-opacity hover:opacity-90"
          >
            Download {RECOMMENDED_AMBIENT_LLM_LABEL}
          </button>
        </div>
      </div>
    </div>
  );
}
