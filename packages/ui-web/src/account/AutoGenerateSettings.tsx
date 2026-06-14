import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useUserSettings } from "@pin-ai/state";
import { Text } from "../primitives/Text";

// Preset interval buckets surfaced in the UI. Server enforces 15–1440min
// via Pydantic / DB CHECK; the bucket list here is purely UX.
const PRESETS_MINUTES = [30, 60, 120, 240, 720, 1440] as const;

function formatPreset(min: number): string {
  if (min < 60) return `${min} min`;
  if (min % 60 !== 0) return `${(min / 60).toFixed(1)} h`;
  const h = min / 60;
  if (h < 24) return `${h} h`;
  return `${h / 24} day${h === 24 ? "" : "s"}`;
}

export default function AutoGenerateSettings() {
  const { settings, loading, saving, error, patch } = useUserSettings();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
  }, []);

  // Defaults match the DB column DEFAULTs (`pai_user_settings`):
  // auto_generate=TRUE, interval=720min. Server lazy-creates the row
  // with these on first GET, so this fallback is only the loading-flash
  // visual before the response lands.
  const enabled = settings?.autoGenerate ?? true;
  const intervalMinutes = settings?.autoGenerateIntervalMinutes ?? 720;

  const flashSaved = () => {
    setSavedAt(Date.now());
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => setSavedAt(null), 1500);
  };

  const handleToggle = async () => {
    const next = !enabled;
    if (await patch({ autoGenerate: next })) flashSaved();
  };

  const handleIntervalChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = Number(e.target.value);
    if (!Number.isFinite(next) || next === intervalMinutes) return;
    if (await patch({ autoGenerateIntervalMinutes: next })) flashSaved();
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
          onClick={() => void handleToggle()}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${
            enabled ? "bg-primary border-primary" : "bg-foreground/15 border-foreground/15"
          }`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            enabled ? "translate-x-[22px]" : "translate-x-[3px]"
          }`} />
        </button>
      </div>
      <Text variant="caption" className="block text-foreground/40 mt-1">
        Automatically generate cards based on new data from your connected sources.
      </Text>
      <div className="mt-2 flex items-center gap-2">
        <label className="text-caption text-foreground/60">Every</label>
        <select
          value={intervalMinutes}
          disabled={loading || saving || !enabled}
          onChange={(e) => void handleIntervalChange(e)}
          className="text-caption bg-background border border-foreground/15 rounded px-2 py-1 disabled:opacity-40"
        >
          {PRESETS_MINUTES.map((m) => (
            <option key={m} value={m}>{formatPreset(m)}</option>
          ))}
        </select>
      </div>
      {error && <Text variant="caption" className="block text-red-500 mt-1">{error}</Text>}
    </div>
  );
}
