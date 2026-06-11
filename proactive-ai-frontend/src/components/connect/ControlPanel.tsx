import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronUp, Smartphone } from "lucide-react";
import DataConnections, { INPUT_CATEGORIES, isDataSourceConnected } from "@/components/connect/DataConnections";
import DeviceConnections from "@/components/connect/DeviceConnections";
import { useUserDevices } from "@/hooks/useUserDevices";
import type { ComposioState } from "@/hooks/useComposio";

interface ControlPanelProps {
  composio: ComposioState;
}

export default function ControlPanel({ composio }: ControlPanelProps) {
  const [meshExpanded, setMeshExpanded] = useState(false);

  // Same hook as DeviceConnections; both auto-refresh via the shared TQ cache
  // so the count here stays in sync on register. Revoke is rare enough to accept
  // the brief drift until next refresh / mount.
  const { devices } = useUserDevices(true);
  useEffect(() => {
    if (composio.keyStatus?.configured !== true) return;
    void composio.loadConnections();
  }, [composio.keyStatus?.configured, composio.loadConnections]);

  const peerCount = useMemo(
    () => devices.filter((d) => d.platform !== "web").length,
    [devices],
  );

  const dataSourceTotal = useMemo(
    () =>
      INPUT_CATEGORIES.reduce(
        (sum, cat) =>
          sum + cat.sources.filter((s) => Boolean(s.composioId)).length,
        0,
      ),
    [],
  );
  const dataSourceConnected = useMemo(() => {
    let n = 0;
    for (const cat of INPUT_CATEGORIES) {
      for (const src of cat.sources) {
        if (isDataSourceConnected(src, composio.connections)) n++;
      }
    }
    return n;
  }, [composio.connections]);

  return (
    <div
      className="flex flex-col h-full min-h-0 px-4"
      style={{ paddingTop: "var(--constellation-header-top, 0.75rem)" }}
    >
      <div className="flex-shrink-0 mb-5">
        <h1 className="text-2xl font-semibold text-foreground tracking-tight mb-0.5 pr-20">Connect</h1>
        <p className="text-xs text-muted-foreground">Data sources & devices powering your AI</p>
      </div>

      <div className="scrollbar-hidden flex-1 min-h-0 overflow-y-auto pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))]">
        <div className="space-y-4">
          {/* Top stats — DATA SOURCES + DEVICES */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="glass-card p-4">
              <p className="text-[10px] font-semibold text-foreground/50 uppercase tracking-[0.12em] mb-1">
                Data Sources
              </p>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold text-foreground leading-none">
                  {dataSourceConnected}
                </span>
                <span className="text-sm text-foreground/40 leading-none">
                  of {dataSourceTotal}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span className="text-[10px] font-medium text-foreground/60">All synced</span>
              </div>
            </div>
            <div className="glass-card p-4">
              <p className="text-[10px] font-semibold text-foreground/50 uppercase tracking-[0.12em] mb-1">
                Devices
              </p>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold text-foreground leading-none">
                  {peerCount}
                </span>
                <span className="text-sm text-foreground/40 leading-none">paired</span>
              </div>
              <div className="flex items-center gap-1.5 mt-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span className="text-[10px] font-medium text-foreground/60">All synced</span>
              </div>
            </div>
          </div>

          {/* AMBIENT SOURCES — purple mesh card wrapping real DeviceConnections */}
          <div>
            <div className="flex items-center gap-2 mb-2 px-1">
              <span className="w-1 h-1 rounded-full bg-[hsl(304_75%_63%)]" />
              <span className="text-[10px] font-semibold text-[hsl(304_75%_63%)] uppercase tracking-[0.12em]">
                Ambient Sources
              </span>
            </div>
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-3xl overflow-hidden border border-[hsl(304_75%_63%/0.25)] bg-[hsl(304_75%_63%/0.04)] backdrop-blur-xl shadow-[0_8px_24px_-12px_hsl(304_75%_63%/0.25)]"
            >
              <button
                onClick={() => setMeshExpanded((v) => !v)}
                className="w-full p-4 flex items-center gap-3 transition-colors hover:bg-[hsl(304_75%_63%/0.06)]"
              >
                <div className="w-10 h-10 rounded-xl bg-[hsl(304_75%_63%/0.12)] flex items-center justify-center flex-shrink-0">
                  <Smartphone size={18} strokeWidth={1.5} className="text-[hsl(304_75%_63%)]" />
                </div>
                <div className="flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">Devices</span>
                    <span className="text-[10px] font-semibold text-[hsl(304_75%_63%)] bg-[hsl(304_75%_63%/0.1)] px-1.5 py-0.5 rounded-md">
                      {peerCount} active
                    </span>
                  </div>
                  <p className="text-[11px] text-foreground/50 mt-0.5 leading-snug">
                    Phones, laptops, wearables, glasses, cameras — encrypted peer-to-peer
                  </p>
                </div>
                <div className="flex-shrink-0 text-foreground/30">
                  {meshExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </button>
              <AnimatePresence>
                {meshExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: "easeInOut" }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-4">
                      <div className="h-px bg-[hsl(304_75%_63%/0.15)] mb-3" />
                      <DeviceConnections />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </div>

          {/* DATA SOURCES — composio categories (real OAuth) */}
          <div>
            <div className="flex items-center gap-2 mb-2 px-1">
              <span className="w-1 h-1 rounded-full bg-foreground/40" />
              <span className="text-[10px] font-semibold text-foreground/50 uppercase tracking-[0.12em]">
                Data Sources
              </span>
            </div>
            <DataConnections composio={composio} />
          </div>
        </div>
      </div>
    </div>
  );
}
