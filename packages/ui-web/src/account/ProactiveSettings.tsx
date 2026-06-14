import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useUserSettings } from "@pin-ai/state";
import { Text } from "../primitives/Text";

// The three heartbeat cadence buckets surfaced in the UI. Server enforces the
// set via a Pydantic Literal + DB CHECK (60/300/1800); this list is UX only.
const PRESETS_SECONDS = [60, 300, 1800] as const;

function formatPreset(sec: number): string {
  if (sec < 60) return `${sec} sec`;
  return `${sec / 60} min`;
}

export default function ProactiveSettings() {
  const { settings, loading, saving, error, patch } = useUserSettings();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
  }, []);

  // Default matches the DB column DEFAULT (`pai_user_settings`): 300s (5 min).
  // Server lazy-creates the row with this on first GET, so the fallback is only
  // the loading-flash visual before the response lands.
  const intervalSeconds = settings?.proactiveIntervalSeconds ?? 300;

  const flashSaved = () => {
    setSavedAt(Date.now());
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => setSavedAt(null), 1500);
  };

  const handleIntervalChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = Number(e.target.value);
    if (!Number.isFinite(next) || next === intervalSeconds) return;
    if (await patch({ proactiveIntervalSeconds: next })) flashSaved();
  };

  return (
    <div className="mb-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0 flex items-center gap-2.5">
          <h3 className="text-sm font-medium text-foreground/80">Proactive Heartbeat</h3>
          {saving && <Loader2 size={12} className="animate-spin text-foreground/40" />}
          {!saving && savedAt && <Check size={12} className="text-emerald-500" />}
        </div>
      </div>
      <Text variant="caption" className="block text-foreground/40 mt-1">
        How often your Proactive AI wakes to check your latest activity. Less
        frequent is calmer and uses fewer resources; turn it on/off on the
        Proactive page.
      </Text>
      <div className="mt-2 flex items-center gap-2">
        <label className="text-caption text-foreground/60">Every</label>
        <select
          value={intervalSeconds}
          disabled={loading || saving}
          onChange={(e) => void handleIntervalChange(e)}
          className="text-caption bg-background border border-foreground/15 rounded px-2 py-1 disabled:opacity-40"
        >
          {PRESETS_SECONDS.map((s) => (
            <option key={s} value={s}>{formatPreset(s)}</option>
          ))}
        </select>
      </div>
      {error && <Text variant="caption" className="block text-red-500 mt-1">{error}</Text>}
    </div>
  );
}
