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
import AmbientAudioDebugPanel from "./AmbientAudioDebugPanel";
import AmbientModelsPanel from "./AmbientModelsPanel";
import AmbientSourceControlsPanel from "./AmbientSourceControlsPanel";

export default function AmbientSourcesPanel() {
  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
      <AmbientSourceControlsPanel />
      <div className="mt-3">
        <AmbientAudioDebugPanel />
      </div>
      <div className="mt-3">
        <AmbientModelsPanel />
      </div>
    </div>
  );
}
