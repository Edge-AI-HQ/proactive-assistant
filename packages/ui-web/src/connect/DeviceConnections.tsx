import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { useUserDevices } from "@pin-ai/state";
import type { UserDevice, UserDevicePlatform } from "@pin-ai/core";
import DeviceTimeline from "./DeviceTimeline";
import { formatRelativeTime } from "../lib/format";

/**
 * Hardware Devices section in Control Center.
 * - Lists active devices from /api/devices on pinai-agents.
 * - Native phones and hardware devices register from their own apps.
 * - Manual/developer registration controls stay out of the main UI.
 * - Tapping a device drills into its time-axis waterfall view.
 */
export default function DeviceConnections() {
  const { t } = useTranslation("connect");
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
          <Loader2 size={12} className="animate-spin" /> {t("deviceConnections.loading")}
        </div>
      ) : peerDevices.length === 0 ? (
        <div className="text-xs text-foreground/40 py-4 text-center">
          {t("deviceConnections.empty")}
        </div>
      ) : (
        <ul className="space-y-2">
          {peerDevices.map((d) => (
            <DeviceRow
              key={d.device_id}
              device={d}
              onOpen={() => setSelectedDevice(d)}
              onRevoke={async () => {
                const name = d.display_name ?? d.device_id;
                if (!confirm(t("deviceConnections.removeConfirm", { name }))) return;
                await revoke(d.device_id);
              }}
            />
          ))}
        </ul>
      )}

      <div className="flex justify-end pt-1">
        <button
          onClick={() => void refresh()}
          className="text-micro text-foreground/40 hover:text-foreground/70 transition"
        >
          {t("deviceConnections.refresh")}
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
  const { t } = useTranslation("connect");
  const platform = platformDisplay(device.platform);
  const Icon = platform.Icon;
  const platformLabel = t(`deviceConnections.platform.${platform.labelKey}`);
  const lastSeen = device.last_seen_at
    ? safeRelativeTime(device.last_seen_at)
    : t("deviceConnections.never");
  const detail = [device.model, t("deviceConnections.lastSeen", { time: lastSeen })]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="glass-card p-3 flex items-center gap-3 group">
      <div
        className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 ${platform.iconClass}`}
        aria-label={t("deviceConnections.deviceAria", { platform: platformLabel })}
        role="img"
        title={t("deviceConnections.deviceAria", { platform: platformLabel })}
      >
        <Icon size={16} />
      </div>
      <button onClick={onOpen} className="flex-1 min-w-0 text-left">
        <div className="text-sm font-medium truncate">
          {device.display_name ?? device.device_id}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-micro text-foreground/40">
          <span className={`rounded-sm px-1.5 py-0.5 font-medium ${platform.badgeClass}`}>
            {platformLabel}
          </span>
          <span className="min-w-0 truncate">{detail}</span>
        </div>
      </button>
      <button
        onClick={onRevoke}
        className="opacity-0 group-hover:opacity-100 transition text-foreground/40 hover:text-red-500"
        title={t("deviceConnections.revokeDevice")}
      >
        <Trash2 size={14} />
      </button>
      <button
        onClick={onOpen}
        className="text-foreground/40 group-hover:text-foreground/80 transition"
        title={t("deviceConnections.openTimeline")}
      >
        <ChevronRight size={16} />
      </button>
    </li>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

type PlatformLabelKey = "ios" | "android" | "wearable" | "sensor" | "embedded" | "web";

function platformDisplay(p: UserDevicePlatform): {
  Icon: typeof Apple;
  labelKey: PlatformLabelKey;
  iconClass: string;
  badgeClass: string;
} {
  if (p === "ios") {
    return {
      Icon: Apple,
      labelKey: "ios",
      iconClass: "bg-neutral-900 text-white dark:bg-white dark:text-neutral-950",
      badgeClass: "bg-neutral-500/10 text-foreground/60",
    };
  }
  if (p === "android") {
    return {
      Icon: Bot,
      labelKey: "android",
      iconClass: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
      badgeClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }
  if (p === "wearable") {
    return {
      Icon: Watch,
      labelKey: "wearable",
      iconClass: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
      badgeClass: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
    };
  }
  if (p === "sensor") {
    return {
      Icon: Activity,
      labelKey: "sensor",
      iconClass: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
      badgeClass: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  if (p === "embedded") {
    return {
      Icon: Cpu,
      labelKey: "embedded",
      iconClass: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
      badgeClass: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    };
  }
  return {
    Icon: Smartphone,
    labelKey: "web",
    iconClass: "bg-foreground/5 text-foreground/60",
    badgeClass: "bg-foreground/5 text-foreground/50",
  };
}

/** Locale-aware relative time with the old defensive fallback (raw ISO on
 *  unparseable input — backend data is trusted but not blindly). */
function safeRelativeTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return formatRelativeTime(parsed);
}
