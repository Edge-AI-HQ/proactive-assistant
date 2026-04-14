import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { proxyFetch, proxyPost } from "@/lib/api";
import type { SupportedGenerationLanguage } from "@/types/intent-card";
import { GENERATION_LANGUAGE_OPTIONS } from "@/types/intent-card";

export default function GenerationLanguageSettings() {
  const [language, setLanguage] = useState<SupportedGenerationLanguage>("en");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    async function loadSettings() {
      try {
        const res = await proxyFetch("/settings/generation-language");
        const data = await res.json();
        if (!mounted) return;
        if (res.ok && data.ok) {
          setLanguage(data.language);
          setError(null);
        } else {
          setError(data.error ?? "Failed to load language setting");
        }
      } catch {
        if (!mounted) return;
        setError("Failed to load language setting");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadSettings();
    return () => {
      mounted = false;
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  const handleChange = async (nextLanguage: SupportedGenerationLanguage) => {
    const previous = language;
    setLanguage(nextLanguage);
    setSaving(true);
    setError(null);
    try {
      const res = await proxyPost("/settings/generation-language", { language: nextLanguage });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setLanguage(previous);
        setError(data.error ?? "Failed to save");
        return;
      }
      setLanguage(data.language);
      setSavedAt(Date.now());
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = window.setTimeout(() => setSavedAt(null), 1500);
    } catch {
      setLanguage(previous);
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  };

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
            value={language}
            onChange={(e) => handleChange(e.target.value as SupportedGenerationLanguage)}
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
