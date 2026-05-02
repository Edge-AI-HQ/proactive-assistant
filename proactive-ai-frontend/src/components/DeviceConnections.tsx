import { useMemo, useState } from "react";
import {
  Activity,
  Apple,
  Bot,
  ChevronRight,
  Cpu,
  Loader2,
  Smartphone,
  Trash2,
  Watch,
} from "lucide-react";
import { useUserDevices } from "@/hooks/useUserDevices";
import { type UserDevice, type UserDevicePlatform } from "@/lib/api";
import DeviceTimeline from "./DeviceTimeline";

/**
 * Hardware Devices section in Control Center.
 * - Lists active devices from /api/proactive/devices.
 * - Native phones and hardware devices register from their own apps.
 * - Manual/developer registration controls stay out of the main UI.
 * - Tapping a device drills into its time-axis waterfall view.
 */
export default function DeviceConnections() {
  const { devices, loading, error, revoke, refresh } = useUserDevices(true);
  const [selectedDevice, setSelectedDevice] = useState<UserDevice | null>(null);

  const peerDevices = useMemo(
    () => devices.filter((d) => d.platform !== "web"),
    [devices],
  );

  if (selectedDevice) {
    return <DeviceTimeline device={selectedDevice} onBack={() => setSelectedDevice(null)} />;
  }

  return (
    <div className="space-y-3 min-w-0">
      {error && (
        <div className="text-xs text-red-500/80 px-2 py-1.5 rounded bg-red-500/10">
          {error}
        </div>
      )}

      {loading && peerDevices.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-foreground/50 py-4 justify-center">
          <Loader2 size={12} className="animate-spin" /> Loading devices…
        </div>
      ) : peerDevices.length === 0 ? (
        <div className="text-xs text-foreground/40 py-4 text-center">
          No other devices paired yet. Sign in on the mobile app to have it appear here.
        </div>
      ) : (
        <ul className="space-y-2">
          {peerDevices.map((d) => (
            <DeviceRow
              key={d.device_id}
              device={d}
              onOpen={() => setSelectedDevice(d)}
              onRevoke={async () => {
                if (!confirm(`Remove "${d.display_name ?? d.device_id}"?`)) return;
                await revoke(d.device_id);
              }}
            />
          ))}
        </ul>
      )}

      <div className="flex justify-end pt-1">
        <button
          onClick={() => void refresh()}
          className="text-[10px] text-foreground/40 hover:text-foreground/70 transition"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

// ── Device row ──────────────────────────────────────────────────────────

function DeviceRow({
  device,
  onOpen,
  onRevoke,
}: {
  device: UserDevice;
  onOpen: () => void;
  onRevoke: () => void;
}) {
  const platform = platformDisplay(device.platform);
  const Icon = platform.Icon;
  const lastSeen = device.last_seen_at ? formatRelativeTime(device.last_seen_at) : "never";
  const detail = [device.model, `last seen ${lastSeen}`].filter(Boolean).join(" · ");

  return (
    <li className="glass-card p-3 flex items-center gap-3 group">
      <div
        className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 ${platform.iconClass}`}
        aria-label={`${platform.label} device`}
        role="img"
        title={`${platform.label} device`}
      >
        <Icon size={16} />
      </div>
      <button onClick={onOpen} className="flex-1 min-w-0 text-left">
        <div className="text-sm font-medium truncate">
          {device.display_name ?? device.device_id}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-foreground/40">
          <span className={`rounded-sm px-1.5 py-0.5 font-medium ${platform.badgeClass}`}>
            {platform.label}
          </span>
          <span className="min-w-0 truncate">{detail}</span>
        </div>
      </button>
      <button
        onClick={onRevoke}
        className="opacity-0 group-hover:opacity-100 transition text-foreground/40 hover:text-red-500"
        title="Revoke device"
      >
        <Trash2 size={14} />
      </button>
      <button
        onClick={onOpen}
        className="text-foreground/40 group-hover:text-foreground/80 transition"
        title="Open timeline"
      >
        <ChevronRight size={16} />
      </button>
    </li>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function platformDisplay(p: UserDevicePlatform) {
  if (p === "ios") {
    return {
      Icon: Apple,
      label: "iOS",
      iconClass: "bg-neutral-900 text-white dark:bg-white dark:text-neutral-950",
      badgeClass: "bg-neutral-500/10 text-foreground/60",
    };
  }
  if (p === "android") {
    return {
      Icon: Bot,
      label: "Android",
      iconClass: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
      badgeClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }
  if (p === "wearable") {
    return {
      Icon: Watch,
      label: "Wearable",
      iconClass: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
      badgeClass: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
    };
  }
  if (p === "sensor") {
    return {
      Icon: Activity,
      label: "Sensor",
      iconClass: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
      badgeClass: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  if (p === "embedded") {
    return {
      Icon: Cpu,
      label: "Embedded",
      iconClass: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
      badgeClass: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    };
  }
  return {
    Icon: Smartphone,
    label: "Web",
    iconClass: "bg-foreground/5 text-foreground/60",
    badgeClass: "bg-foreground/5 text-foreground/50",
  };
}

function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diffSec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
    return `${Math.round(diffSec / 86400)}d ago`;
  } catch {
    return iso;
  }
}
