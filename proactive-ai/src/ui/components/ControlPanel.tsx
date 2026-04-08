import DataConnections from "./DataConnections";
import GenerationLanguageSettings from "./GenerationLanguageSettings";
import type { ComposioState } from "@/hooks/use-composio";

interface ControlPanelProps {
  composio: ComposioState;
}

export default function ControlPanel({ composio }: ControlPanelProps) {
  return (
    <div className="flex flex-col h-full min-h-0 px-4 pt-14">
      <div className="flex-shrink-0 mb-5">
        <h1 className="text-2xl font-semibold text-foreground tracking-tight mb-0.5">Control Center</h1>
        <p className="text-xs text-foreground/40">Preferences, data connections and integrations</p>
      </div>

      <div className="scrollbar-hidden flex-1 min-h-0 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))]">
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
              <h2 className="text-sm font-semibold text-foreground">Preferences</h2>
              <p className="text-[11px] text-foreground/42 mt-1">
                Tune how cards are generated and shown to you.
              </p>
            </div>
            <GenerationLanguageSettings />
          </section>
        </div>
      </div>
    </div>
  );
}
