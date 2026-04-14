import DataConnections from "./DataConnections";
import AutoDreamingSettings from "./AutoDreamingSettings";
import AutoGenerateSettings from "./AutoGenerateSettings";
import GenerationLanguageSettings from "./GenerationLanguageSettings";
import type { ComposioState } from "@/hooks/useComposio";

interface ControlPanelProps {
  composio: ComposioState;
}

export default function ControlPanel({ composio }: ControlPanelProps) {
  return (
    <div className="flex flex-col h-full min-h-0 px-4 pt-3">
      <div className="flex-shrink-0 mb-5">
        <h1 className="text-display text-2xl text-foreground tracking-tight mb-0.5">Control Center</h1>
        <p className="text-xs text-foreground/40">Preferences, data connections and integrations</p>
      </div>

      <div className="scrollbar-hidden flex-1 min-h-0 overflow-y-auto pb-24">
        <div className="space-y-4">
          <section className="glass-card-strong p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">Data Connections</h2>
              <p className="text-[11px] text-foreground/42 mt-1">
                Manage the apps Proactive AI can read from and act on.
              </p>
            </div>
            <DataConnections composio={composio} />
          </section>

          <section className="glass-card-strong p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">Auto Dreaming</h2>
              <p className="text-[11px] text-foreground/42 mt-1">
                Automatic background context collection and card generation.
              </p>
            </div>
            <AutoDreamingSettings />
          </section>

          <section className="glass-card-strong p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">Preferences</h2>
              <p className="text-[11px] text-foreground/42 mt-1">
                Tune how cards are generated and shown to you.
              </p>
            </div>
            <AutoGenerateSettings />
            <GenerationLanguageSettings />
          </section>
        </div>
      </div>
    </div>
  );
}
