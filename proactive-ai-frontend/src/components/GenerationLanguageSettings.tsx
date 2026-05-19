import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useUserSettings } from "@/hooks/useUserSettings";
import {
  GENERATION_LANGUAGE_OPTIONS,
  type SupportedGenerationLanguage,
} from "@/types/intent-card";

export default function GenerationLanguageSettings() {
  const { settings, loading, saving, error, patch } = useUserSettings();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
  }, []);

  const handleChange = async (next: SupportedGenerationLanguage) => {
    if (!settings || next === settings.generationLanguage) return;
    const result = await patch({ generationLanguage: next });
    if (result) {
      setSavedAt(Date.now());
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = window.setTimeout(() => setSavedAt(null), 1500);
    }
  };

  const value = settings?.generationLanguage ?? "en";

  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0 flex items-center gap-2.5">
          <h3 className="text-sm font-medium text-foreground/80">Language</h3>
          {saving && <Loader2 size={12} className="animate-spin text-foreground/40" />}
          {!saving && savedAt && <Check size={12} className="text-emerald-500" />}
        </div>
        <div className="relative">
          <select
            value={value}
            onChange={(e) => void handleChange(e.target.value as SupportedGenerationLanguage)}
            disabled={loading || saving}
            className="appearance-none rounded-lg border border-foreground/10 bg-white/60 px-3 py-1.5 pr-8 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-40"
          >
            {GENERATION_LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <ChevronDown size={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-foreground/40" />
        </div>
      </div>
      {error && <p className="text-[11px] text-red-500 mt-1">{error}</p>}
    </div>
  );
}
