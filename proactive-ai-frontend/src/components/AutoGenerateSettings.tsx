import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { proxyFetch, proxyPost } from "@/lib/api";

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
        const res = await proxyFetch("/settings/auto-generate");
        const data = await res.json();
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
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  const handleToggle = async () => {
    const previous = enabled;
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const res = await proxyPost("/settings/auto-generate", { enabled: next });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setEnabled(previous);
        setError(data.error ?? "Failed to save");
        return;
      }
      setEnabled(data.enabled);
      setSavedAt(Date.now());
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = window.setTimeout(() => setSavedAt(null), 1500);
    } catch {
      setEnabled(previous);
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0 flex items-center gap-2.5">
          <h3 className="text-sm font-medium text-foreground/80">Auto Generate</h3>
          {saving && <Loader2 size={12} className="animate-spin text-foreground/40" />}
          {!saving && savedAt && <Check size={12} className="text-emerald-500" />}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={loading || saving}
          onClick={handleToggle}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${
            enabled ? "bg-primary border-primary" : "bg-foreground/15 border-foreground/15"
          }`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            enabled ? "translate-x-[22px]" : "translate-x-[3px]"
          }`} />
        </button>
      </div>
      <p className="text-[11px] text-foreground/40 mt-1">
        Automatically generate cards based on new data from your connected sources.
      </p>
      {error && <p className="text-[11px] text-red-500 mt-1">{error}</p>}
    </div>
  );
}
