import DataConnections from "./DataConnections";
import type { ComposioState } from "@/hooks/use-composio";

interface ControlPanelProps {
  composio: ComposioState;
}

export default function ControlPanel({ composio }: ControlPanelProps) {
  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      <h1 className="text-2xl font-semibold text-foreground tracking-tight mb-0.5">Control Center</h1>
      <p className="text-xs text-foreground/40 mb-5">Data connections and integrations</p>

      <DataConnections composio={composio} />
    </div>
  );
}
