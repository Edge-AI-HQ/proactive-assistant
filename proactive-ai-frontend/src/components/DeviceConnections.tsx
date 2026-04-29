import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Cpu, KeyRound, Loader2, Plus, Send, Smartphone, Trash2, Watch } from "lucide-react";
import { useUserDevices } from "@/hooks/useUserDevices";
import { claimPairCode, type UserDevice, type UserDevicePlatform } from "@/lib/api";
import { ensureDevice, ingestSignals, type DeviceCredentials } from "@/lib/devices";
import DeviceTimeline from "./DeviceTimeline";

/**
 * Hardware Devices section in Control Center.
 * - Lists active devices from /api/proactive/devices.
 * - "Add hardware" opens an inline form to register a new device
 *   (platform=wearable | sensor | embedded; phone/web are auto-registered
 *   on app launch and not exposed here).
 * - Tapping a device drills into its time-axis waterfall view.
 */
type AddTab = null | "pair-code" | "manual";

export default function DeviceConnections() {
  const { devices, loading, error, registerDevice, revoke, refresh } = useUserDevices(true);
  const [addTab, setAddTab] = useState<AddTab>(null);
  const [selectedDevice, setSelectedDevice] = useState<UserDevice | null>(null);

  const hardwareDevices = useMemo(
    () => devices.filter((d) => d.platform !== "ios" && d.platform !== "android" && d.platform !== "web"),
    [devices],
  );

  if (selectedDevice) {
    return <DeviceTimeline device={selectedDevice} onBack={() => setSelectedDevice(null)} />;
  }

  return (
    <div className="space-y-3">
      <SelfDevicePanel
        devices={devices}
        onIngested={() => { void refresh(); }}
        onOpenTimeline={(d) => setSelectedDevice(d)}
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-foreground/50">
          Wearables, sensors, and other hardware that push to your container.
        </p>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setAddTab(addTab === "pair-code" ? null : "pair-code")}
            className={`text-[11px] transition px-2 py-1 rounded-md border flex items-center gap-1 ${
              addTab === "pair-code"
                ? "bg-foreground/85 text-background border-foreground/85"
                : "text-foreground/70 hover:text-foreground border-foreground/15"
            }`}
          >
            <KeyRound size={11} /> Pair with code
          </button>
          <button
            onClick={() => setAddTab(addTab === "manual" ? null : "manual")}
            className={`text-[10px] transition px-2 py-1 rounded-md border flex items-center gap-1 ${
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

      {addTab === "pair-code" && (
        <PairCodeForm
          onPaired={() => {
            setAddTab(null);
            void refresh();
          }}
        />
      )}

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

      {loading && hardwareDevices.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-foreground/50 py-4 justify-center">
          <Loader2 size={12} className="animate-spin" /> Loading devices…
        </div>
      ) : hardwareDevices.length === 0 && addTab === null ? (
        <div className="text-xs text-foreground/40 py-4 text-center">
          No hardware paired yet. Tap "Pair with code" — a device shows a 6-character
          code, you enter it here.
        </div>
      ) : (
        <ul className="space-y-2">
          {hardwareDevices.map((d) => (
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
  onIngested,
  onOpenTimeline,
}: {
  devices: UserDevice[];
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
      .then((c) => { if (!cancelled) setCreds(c); })
      .catch((err) => { if (!cancelled) setBootstrapErr(err.message ?? String(err)); });
    return () => { cancelled = true; };
  }, []);

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
    <div className="glass-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Smartphone size={14} className="text-foreground/60" />
        <span className="text-xs font-medium">This device</span>
        <span className="text-[10px] text-foreground/40 ml-auto">
          {creds
            ? `${creds.platform} · ${creds.deviceId.slice(0, 12)}…`
            : bootstrapErr ? "bootstrap failed" : "registering…"}
        </span>
      </div>

      {bootstrapErr && (
        <div className="text-[10px] text-red-500/80 px-1">{bootstrapErr}</div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => void sendTest()}
          disabled={!creds || busy}
          className="text-[11px] px-3 py-1.5 rounded-md bg-foreground/85 text-background hover:bg-foreground transition flex items-center gap-1.5 disabled:opacity-40"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
          Send test signal
        </button>
        {lastResult && (
          <span className={`text-[10px] ${lastResult.startsWith("Error") ? "text-red-500/80" : "text-emerald-600/80"}`}>
            {lastResult}
          </span>
        )}
        {selfDevice && (
          <button
            onClick={() => onOpenTimeline(selfDevice)}
            className="text-[10px] text-foreground/60 hover:text-foreground transition ml-auto flex items-center gap-1"
          >
            View timeline <ChevronRight size={10} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Pair code form ──────────────────────────────────────────────────────

function PairCodeForm({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ name: string; id: string } | null>(null);

  const submit = async () => {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length !== 6) {
      setErr("Code must be 6 characters.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const result = await claimPairCode(
        trimmed,
        displayName.trim() || undefined,
      );
      setConfirmed({ name: result.display_name, id: result.device_id });
      // Give the user a beat to read the confirmation, then close.
      setTimeout(onPaired, 1200);
    } catch (e) {
      const code = (e as { domainCode?: string }).domainCode;
      const status = (e as { status?: number }).status;
      // Map server's domain codes to specific copy.
      if (status === 404) setErr("Code not found. Double-check the 6 characters on the device.");
      else if (code === "CONFLICT") setErr(
        (e as Error).message?.includes("expired")
          ? "Code has expired — restart pairing on the device."
          : "Code has already been claimed."
      );
      else setErr((e as Error).message ?? "Pairing failed.");
    } finally {
      setBusy(false);
    }
  };

  if (confirmed) {
    return (
      <div className="glass-card p-3 text-xs text-emerald-600/90 border border-emerald-500/20">
        ✓ Paired <strong>{confirmed.name}</strong>. The device will receive its token on
        its next poll.
      </div>
    );
  }

  return (
    <div className="glass-card p-3 space-y-2">
      <label className="text-[10px] text-foreground/50 block">
        Code from the device
        <input
          autoFocus
          value={code}
          onChange={(e) => {
            // Force uppercase + restrict to alphabet (32 chars,
            // 23456789ABCDEFGHJKLMNPQRSTUVWXYZ — but accepting all and
            // letting the server reject keeps the UI simple).
            const cleaned = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
            setCode(cleaned);
            if (err) setErr(null);
          }}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          placeholder="6 characters,e.g. ANUNAV"
          className="mt-1 w-full px-2 py-2 text-base font-mono tracking-[0.4em] rounded-md bg-foreground/5 border border-foreground/10 focus:border-foreground/30 outline-none uppercase"
          maxLength={6}
        />
      </label>
      <label className="text-[10px] text-foreground/50 block">
        Display name (optional)
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g. OMI on my desk"
          className="mt-1 w-full px-2 py-1.5 text-xs rounded-md bg-foreground/5 border border-foreground/10 focus:border-foreground/30 outline-none"
        />
      </label>
      {err && <div className="text-[10px] text-red-500/80 px-1">{err}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={() => void submit()}
          disabled={busy || code.length !== 6}
          className="text-[11px] px-3 py-1 rounded-md bg-foreground/85 text-background hover:bg-foreground transition flex items-center gap-1 disabled:opacity-40"
        >
          {busy && <Loader2 size={11} className="animate-spin" />}
          Pair
        </button>
      </div>
      <p className="text-[10px] text-foreground/40 leading-relaxed">
        Devices show a code on their screen when they boot in pairing mode.
        The code expires after 5 minutes.
      </p>
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
          Pair device
        </button>
      </div>
      <p className="text-[10px] text-foreground/40 leading-relaxed">
        On pair we generate a device id + token. The token is shown once
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
