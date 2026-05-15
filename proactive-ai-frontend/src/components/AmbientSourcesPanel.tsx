/**
 * AmbientSourcesPanel — user-facing opt-in toggle + DebugPanel inspection.
 *
 * Per V3 migration plan D-5 / Step 3, ambient capture is opt-in. The
 * user's enabled set lives in ``pai_user_settings.ambient_sources``
 * (server side); this panel reads from there via ``useUserSettings``,
 * writes a per-source patch when a toggle flips, and on the same flip
 * starts / stops the matching runtime source locally so the change
 * takes effect immediately.
 *
 */
import { useCallback, useState } from "react";
import AmbientAudioDebugPanel from "./AmbientAudioDebugPanel";
import AmbientModelsPanel from "./AmbientModelsPanel";
import AmbientSourceControlsPanel from "./AmbientSourceControlsPanel";
import { clearAmbientSqliteData } from "@/services/ambient/reset-sqlite";

export default function AmbientSourcesPanel() {
  const [clearing, setClearing] = useState(false);
  const [clearStatus, setClearStatus] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);

  const clearLocalData = useCallback(async () => {
    if (!confirm("Clear local Ambient SQLite data on this device? This cannot be undone.")) return;
    setClearing(true);
    setClearStatus(null);
    setClearError(null);
    try {
      await clearAmbientSqliteData();
      setClearStatus("Ambient SQLite data cleared. Restart the app to reopen fresh local databases.");
    } catch (err) {
      setClearError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  }, []);

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
      <AmbientSourceControlsPanel />
      <div className="mt-3">
        <AmbientAudioDebugPanel />
      </div>
      <div className="mt-3">
        <AmbientModelsPanel />
      </div>
      <div className="mt-3 rounded-xl border border-red-200 bg-red-50/60 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-red-600/80">
          Local debug actions
        </p>
        <p className="mt-1 text-[11px] leading-snug text-red-600/70">
          Clears only this device&apos;s Ambient SQLite databases. Account, consent settings, and other app state are kept.
        </p>
        <button
          type="button"
          onClick={() => void clearLocalData()}
          disabled={clearing}
          className="mt-2 min-h-10 w-full rounded-lg border border-red-200 bg-white/70 px-3 text-[11px] font-semibold text-red-600 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {clearing ? "Clearing..." : "Clear Ambient SQLite data"}
        </button>
        {clearStatus && (
          <p className="mt-2 text-[11px] leading-snug text-emerald-700">{clearStatus}</p>
        )}
        {clearError && (
          <p className="mt-2 text-[11px] leading-snug text-red-600">{clearError}</p>
        )}
      </div>
    </div>
  );
}
