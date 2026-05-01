import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Cpu, Loader2, Plus, Send, Smartphone, Trash2, Watch } from "lucide-react";
import { useUserDevices } from "@/hooks/useUserDevices";
import { type UserDevice, type UserDevicePlatform } from "@/lib/api";
import { ensureDevice, ingestSignals, type DeviceCredentials } from "@/lib/devices";
import DeviceTimeline from "./DeviceTimeline";

/**
 * Hardware Devices section in Control Center.
 * - Lists active devices from /api/proactive/devices.
 * - "Add hardware" opens an inline form to register a new device
 *   (platform=wearable | sensor | embedded).
 * - Native phones are auto-registered by the app and listed here as
 *   peer devices. The current web browser remains in SelfDevicePanel.
 * - Tapping a device drills into its time-axis waterfall view.
 */
type AddTab = null | "manual";

export default function DeviceConnections() {
  const { devices, loading, error, registerDevice, revoke, refresh } = useUserDevices(true);
  const [addTab, setAddTab] = useState<AddTab>(null);
  const [selectedDevice, setSelectedDevice] = useState<UserDevice | null>(null);

  const refreshDeviceList = useCallback(() => {
    void refresh();
  }, [refresh]);

  const peerDevices = useMemo(
    () => devices.filter((d) => d.platform !== "web"),
    [devices],
  );

  if (selectedDevice) {
    return <DeviceTimeline device={selectedDevice} onBack={() => setSelectedDevice(null)} />;
  }

  return (
    <div className="space-y-3 min-w-0">
      <SelfDevicePanel
        devices={devices}
        onDeviceReady={refreshDeviceList}
        onIngested={refreshDeviceList}
        onOpenTimeline={(d) => setSelectedDevice(d)}
      />
      <div className="space-y-2">
        <p className="text-[11px] leading-relaxed text-foreground/50">
          Mobile apps, wearables, sensors, and embedded devices that push to your container.
        </p>
        <div className="grid grid-cols-1 gap-2">
          <button
            onClick={() => setAddTab(addTab === "manual" ? null : "manual")}
            className={`min-h-8 justify-center whitespace-nowrap text-[11px] transition px-2.5 py-1.5 rounded-md border flex items-center gap-1 ${
              addTab === "manual"
                ? "bg-foreground/85 text-background border-foreground/85"
                : "text-foreground/40 hover:text-foreground/70 border-foreground/10"
            }`}
            title="Developer: register a device manually with a chosen ID"
          >
            <Plus size={10} /> Manual
          </button>
        </div>
      </div>

      {addTab === "manual" && (
        <AddDeviceForm
          onSubmit={async (input) => {
            await registerDevice(input);
            setAddTab(null);
          }}
        />
      )}

      {error && (
        <div className="text-xs text-red-500/80 px-2 py-1.5 rounded bg-red-500/10">
          {error}
        </div>
      )}

      {loading && peerDevices.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-foreground/50 py-4 justify-center">
          <Loader2 size={12} className="animate-spin" /> Loading devices…
        </div>
      ) : peerDevices.length === 0 && addTab === null ? (
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
  const Icon = iconForPlatform(device.platform);
  const lastSeen = device.last_seen_at ? formatRelativeTime(device.last_seen_at) : "never";

  return (
    <li className="glass-card p-3 flex items-center gap-3 group">
      <div className="w-9 h-9 rounded-md bg-foreground/5 flex items-center justify-center text-foreground/60 shrink-0">
        <Icon size={16} />
      </div>
      <button onClick={onOpen} className="flex-1 min-w-0 text-left">
        <div className="text-sm font-medium truncate">
          {device.display_name ?? device.device_id}
        </div>
        <div className="text-[10px] text-foreground/40 truncate">
          {device.platform}
          {device.model ? ` · ${device.model}` : ""}
          {" · last seen "}
          {lastSeen}
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

// ── Self device panel ───────────────────────────────────────────────────

/**
 * Bootstraps "this device" against the server: calls ensureDevice() so the
 * Web / iOS / Android client appears in user_devices, then exposes a
 * "Send test signal" button that pushes one PersonalSignal to the user's
 * own container. This is the smallest end-to-end demo of "phone ingest"
 * working — once it shows up in the timeline, the upload pipe is live.
 */
function SelfDevicePanel({
  devices,
  onDeviceReady,
  onIngested,
  onOpenTimeline,
}: {
  devices: UserDevice[];
  onDeviceReady: (deviceId: string) => void;
  onIngested: (deviceId: string) => void;
  onOpenTimeline: (device: UserDevice) => void;
}) {
  const [creds, setCreds] = useState<DeviceCredentials | null>(null);
  const [bootstrapErr, setBootstrapErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  // Lazy ensureDevice on first mount. Already-registered devices return
  // immediately from the local cache; first-time devices hit the server.
  useEffect(() => {
    let cancelled = false;
    setBootstrapErr(null);
    ensureDevice()
      .then((c) => {
        if (cancelled) return;
        setCreds(c);
        onDeviceReady(c.deviceId);
      })
      .catch((err) => { if (!cancelled) setBootstrapErr(err.message ?? String(err)); });
    return () => { cancelled = true; };
  }, [onDeviceReady]);

  const selfDevice = useMemo(
    () => (creds ? devices.find((d) => d.device_id === creds.deviceId) : undefined),
    [creds, devices],
  );

  const sendTest = async () => {
    if (!creds) return;
    setBusy(true);
    setLastResult(null);
    try {
      const r = await ingestSignals(creds, [
        {
          kind: "moment",
          title: "test signal from this device",
          summary: `Sent from ${creds.platform} at ${new Date().toLocaleTimeString()}`,
          payload: { producer: "ui-test-button" },
          salience: 0.4,
          confidence: 1.0,
        },
      ]);
      setLastResult(`Inserted ${r.inserted} signal(s)`);
      onIngested(creds.deviceId);
    } catch (err) {
      setLastResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass-card p-3 space-y-2.5 min-w-0">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
        <Smartphone size={14} className="text-foreground/60" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium shrink-0">This device</span>
            <span className="min-w-0 flex-1 truncate text-right text-[10px] text-foreground/40">
              {creds
                ? `${creds.platform} · ${creds.deviceId.slice(0, 12)}…`
                : bootstrapErr ? "bootstrap failed" : "registering…"}
            </span>
          </div>
          {selfDevice && (
            <button
              onClick={() => onOpenTimeline(selfDevice)}
              className="mt-1 ml-auto flex items-center gap-1 text-[10px] text-foreground/55 hover:text-foreground transition"
            >
              View timeline <ChevronRight size={10} />
            </button>
          )}
        </div>
      </div>

      {bootstrapErr && (
        <div className="text-[10px] text-red-500/80 px-1">{bootstrapErr}</div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void sendTest()}
          disabled={!creds || busy}
          className="min-h-8 whitespace-nowrap text-[11px] px-3 py-1.5 rounded-md bg-foreground/85 text-background hover:bg-foreground transition flex items-center gap-1.5 disabled:opacity-40"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
          Send test signal
        </button>
        {lastResult && (
          <span className={`min-w-0 text-[10px] ${lastResult.startsWith("Error") ? "text-red-500/80" : "text-emerald-600/80"}`}>
            {lastResult}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Add device form ─────────────────────────────────────────────────────

interface AddInput {
  deviceId: string;
  platform: UserDevicePlatform;
  displayName: string;
  model: string;
}

function AddDeviceForm({
  onSubmit,
}: {
  onSubmit: (input: {
    deviceId: string;
    platform: UserDevicePlatform;
    displayName: string;
    model: string;
  }) => Promise<void>;
}) {
  const [form, setForm] = useState<AddInput>({
    deviceId: cryptoRandomId(),
    platform: "wearable",
    displayName: "",
    model: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!form.displayName.trim()) {
      setErr("Display name is required.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await onSubmit({
        deviceId: form.deviceId,
        platform: form.platform,
        displayName: form.displayName.trim(),
        model: form.model.trim() || "",
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass-card p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px] text-foreground/50 col-span-2">
          Display name
          <input
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            placeholder="e.g. OMI pendant on my desk"
            className="mt-1 w-full px-2 py-1.5 text-xs rounded-md bg-foreground/5 border border-foreground/10 focus:border-foreground/30 outline-none"
          />
        </label>
        <label className="text-[10px] text-foreground/50">
          Platform
          <select
            value={form.platform}
            onChange={(e) => setForm({ ...form, platform: e.target.value as UserDevicePlatform })}
            className="mt-1 w-full px-2 py-1.5 text-xs rounded-md bg-foreground/5 border border-foreground/10 focus:border-foreground/30 outline-none"
          >
            <option value="wearable">wearable (necklace / watch)</option>
            <option value="sensor">sensor (ring / health)</option>
            <option value="embedded">embedded (other)</option>
          </select>
        </label>
        <label className="text-[10px] text-foreground/50">
          Model (optional)
          <input
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            placeholder="e.g. omi_pendant_v1"
            className="mt-1 w-full px-2 py-1.5 text-xs rounded-md bg-foreground/5 border border-foreground/10 focus:border-foreground/30 outline-none"
          />
        </label>
      </div>
      {err && (
        <div className="text-[10px] text-red-500/80 px-1">{err}</div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="text-[11px] px-3 py-1 rounded-md bg-foreground/85 text-background hover:bg-foreground transition flex items-center gap-1 disabled:opacity-50"
        >
          {busy && <Loader2 size={11} className="animate-spin" />}
          Register device
        </button>
      </div>
      <p className="text-[10px] text-foreground/40 leading-relaxed">
        On register we generate a device id + token. The token is shown once
        (paste it into the device app). It authenticates uploads to{" "}
        <code>/api/proactive/devices/ingest</code>.
      </p>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function iconForPlatform(p: UserDevicePlatform) {
  if (p === "wearable") return Watch;
  if (p === "sensor") return Cpu;
  if (p === "embedded") return Cpu;
  return Smartphone;
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `dev-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
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
