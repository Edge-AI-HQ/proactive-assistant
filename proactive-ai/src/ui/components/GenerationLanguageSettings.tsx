import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { apiFetch, apiPost } from "@/lib/api";
import type { SupportedGenerationLanguage } from "@shared/generation-language";

interface LanguageOption {
  value: SupportedGenerationLanguage;
  label: string;
}

interface GenerationLanguageResponse {
  ok: boolean;
  language: SupportedGenerationLanguage;
  options: LanguageOption[];
  error?: string;
}

export default function GenerationLanguageSettings() {
  const [language, setLanguage] = useState<SupportedGenerationLanguage>("en");
  const [options, setOptions] = useState<LanguageOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;

    async function loadSettings() {
      try {
        const res = await apiFetch("/api/settings/generation-language");
        const data = await res.json() as GenerationLanguageResponse;
        if (!mounted) return;

        if (res.ok && data.ok) {
          setLanguage(data.language);
          setOptions(data.options);
          setError(null);
        } else {
          setError(data.error ?? "Failed to load generation language");
        }
      } catch {
        if (!mounted) return;
        setError("Failed to load generation language");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadSettings();

    return () => {
      mounted = false;
      if (savedTimerRef.current) {
        window.clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  const handleChange = async (nextLanguage: SupportedGenerationLanguage) => {
    const previousLanguage = language;
    setLanguage(nextLanguage);
    setSaving(true);
    setError(null);

    try {
      const res = await apiPost("/api/settings/generation-language", { language: nextLanguage });
      const data = await res.json() as GenerationLanguageResponse;

      if (!res.ok || !data.ok) {
        setLanguage(previousLanguage);
        setError(data.error ?? "Failed to save generation language");
        return;
      }

      setLanguage(data.language);
      setOptions(data.options);
      setSavedAt(Date.now());

      if (savedTimerRef.current) {
        window.clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = window.setTimeout(() => setSavedAt(null), 1500);
    } catch {
      setLanguage(previousLanguage);
      setError("Failed to save generation language");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-3xl bg-white/42 px-4 py-4 backdrop-blur-2xl border border-white/45">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0 flex items-center gap-2.5">
          <h2 className="text-sm font-semibold text-foreground">Language</h2>
          {saving && (
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-foreground/[0.06]">
              <Loader2 size={10} className="animate-spin text-foreground/45" aria-hidden="true" />
            </span>
          )}
          {!saving && savedAt && (
            <span
              aria-label="Saved"
              className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500/12 text-emerald-600"
            >
              <Check size={10} />
            </span>
          )}
        </div>
        <div className="relative w-[184px] max-w-[50%]">
          <select
            aria-label="Generation language"
            value={language}
            onChange={(e) => handleChange(e.target.value as SupportedGenerationLanguage)}
            disabled={loading || saving || options.length === 0}
            className="w-full appearance-none rounded-2xl border border-white/45 bg-white/72 px-4 py-2.5 pr-10 text-sm font-medium text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_4px_16px_rgba(15,23,42,0.05)] backdrop-blur-xl transition-colors focus:outline-none focus:ring-2 focus:ring-primary/25 disabled:opacity-40"
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown
            size={16}
            strokeWidth={1.6}
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-foreground/35"
            aria-hidden="true"
          />
        </div>
      </div>

      {error && (
        <p className="text-[11px] text-red-500/80 mt-2">{error}</p>
      )}
    </div>
  );
}
