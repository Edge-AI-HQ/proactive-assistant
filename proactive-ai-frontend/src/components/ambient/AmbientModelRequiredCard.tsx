import { Cpu } from "lucide-react";
import { RECOMMENDED_AMBIENT_LLM_LABEL } from "@/services/ambient/models-recommendation";
import { Text } from "@pin-ai/ui-web";

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
          <Text variant="label" weight="semibold" className="block text-foreground/80">On-device LLM required</Text>
          <Text variant="caption" className="block mt-1 leading-snug text-foreground/50">
            Download {RECOMMENDED_AMBIENT_LLM_LABEL} to turn your ambient signals into private local summaries.
          </Text>
          <button
            type="button"
            onClick={onOpenSetup}
            className="mt-3 min-h-9 rounded-full bg-foreground px-4 text-label font-semibold text-background transition-opacity hover:opacity-90"
          >
            Download {RECOMMENDED_AMBIENT_LLM_LABEL}
          </button>
        </div>
      </div>
    </div>
  );
}
