import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { apiFetch, apiPost } from "@/lib/api";

interface AutoGenerateResponse {
  ok: boolean;
  enabled: boolean;
  error?: string;
}

export default function AutoGenerateSettings() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;

    async function loadSettings() {
      try {
        const res = await apiFetch("/api/settings/auto-generate");
        const data = await res.json() as AutoGenerateResponse;
        if (!mounted) return;

        if (res.ok && data.ok) {
          setEnabled(data.enabled);
          setError(null);
        } else {
          setError(data.error ?? "Failed to load auto-generate setting");
        }
      } catch {
        if (!mounted) return;
        setError("Failed to load auto-generate setting");
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

  const handleToggle = async () => {
    const previous = enabled;
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);

    try {
      const res = await apiPost("/api/settings/auto-generate", { enabled: next });
      const data = await res.json() as AutoGenerateResponse;

      if (!res.ok || !data.ok) {
        setEnabled(previous);
        setError(data.error ?? "Failed to save auto-generate setting");
        return;
      }

      setEnabled(data.enabled);
      setSavedAt(Date.now());

      if (savedTimerRef.current) {
        window.clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = window.setTimeout(() => setSavedAt(null), 1500);
    } catch {
      setEnabled(previous);
      setError("Failed to save auto-generate setting");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-3xl bg-white/42 px-4 py-4 backdrop-blur-2xl border border-white/45">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0 flex items-center gap-2.5">
          <h2 className="text-sm font-semibold text-foreground">Auto Generate</h2>
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
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Auto generate cards"
          disabled={loading || saving}
          onClick={handleToggle}
          className={`
            relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full
            border border-white/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_4px_16px_rgba(15,23,42,0.05)]
            backdrop-blur-xl transition-colors duration-200 ease-in-out
            focus:outline-none focus:ring-2 focus:ring-primary/25
            disabled:cursor-not-allowed disabled:opacity-40
            ${enabled ? "bg-primary" : "bg-foreground/10"}
          `}
        >
          <span
            className={`
              pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-md
              ring-0 transition-transform duration-200 ease-in-out
              ${enabled ? "translate-x-[22px]" : "translate-x-[3px]"}
            `}
          />
        </button>
      </div>
      <p className="text-[11px] text-foreground/42 mt-1.5">
        Automatically generate cards based on new data from your connected sources.
      </p>

      {error && (
        <p className="text-[11px] text-red-500/80 mt-2">{error}</p>
      )}
    </div>
  );
}
