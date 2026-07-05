import {
  AmbientAi,
  type BatterySnapshot,
  type DeviceStateSnapshot,
} from "@pin/capacitor-ambient-ai";
import type { PluginListenerHandle } from "@capacitor/core";
import { SIGNAL_KINDS } from "../kinds";
import type { AmbientSource, SourceContext } from "./types";

export class DeviceStateSource implements AmbientSource {
  readonly key = "device_state";
  readonly label = "Device State";

  private deviceHandle: PluginListenerHandle | null = null;
  private batteryHandle: PluginListenerHandle | null = null;
  private started = false;
  private latestBattery: BatterySnapshot | null = null;
  private lastConstrainedKey: string | null = null;

  constructor(private ctx: SourceContext) {}

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.deviceHandle = await AmbientAi.addListener("deviceState", (event) => this.handleDevice(event));
    this.batteryHandle = await AmbientAi.addListener("battery", (event) => this.handleBattery(event));
    const [device, battery] = await Promise.all([
      AmbientAi.device.getState(),
      AmbientAi.battery.getState(),
    ]);
    this.latestBattery = battery;
    this.handleDevice(device);
    await AmbientAi.device.startMonitoring();
    // 方案 A (2026-07-01): battery 5min → 1min(电量变化慢,再高频没意义)。
    await AmbientAi.battery.startMonitoring({ intervalMs: 60_000 });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await Promise.all([
        AmbientAi.device.stopMonitoring(),
        AmbientAi.battery.stopMonitoring(),
      ]);
    } finally {
      if (this.deviceHandle) await this.deviceHandle.remove();
      if (this.batteryHandle) await this.batteryHandle.remove();
      this.deviceHandle = null;
      this.batteryHandle = null;
      this.started = false;
      this.latestBattery = null;
      this.lastConstrainedKey = null;
    }
  }

  private handleBattery(event: BatterySnapshot): void {
    this.latestBattery = event;
  }

  private handleDevice(event: DeviceStateSnapshot): void {
    const batteryPct = this.latestBattery?.batteryPct;
    const reason = constrainedReason(event, batteryPct);
    if (!reason) return;
    const key = `${reason}:${event.thermal}:${event.lowPower}:${batteryPct ?? "unknown"}`;
    if (this.lastConstrainedKey === key) return;
    this.lastConstrainedKey = key;
    const summary = deviceSummary(reason, event, batteryPct);
    this.ctx.push({
      kind: SIGNAL_KINDS.deviceState,
      title: "Device collection constrained",
      summary,
      occurred_at: new Date(event.timestamp).toISOString(),
      payload: {
        schema_version: "device_state.v1",
        thermal: event.thermal,
        low_power: event.lowPower,
        battery_pct: batteryPct,
        charging: this.latestBattery?.charging,
        reason,
        observed_at: new Date(event.timestamp).toISOString(),
      },
      dedupe_key: `device_state:${key}:${event.timestamp}`,
    });
    this.ctx.onEvent(this.key, summary);
  }
}

function constrainedReason(
  event: DeviceStateSnapshot,
  batteryPct: number | undefined,
): "low_power" | "thermal" | "low_battery" | null {
  if (event.lowPower) return "low_power";
  if (event.thermal === "serious" || event.thermal === "critical") return "thermal";
  if (typeof batteryPct === "number" && batteryPct < 15) return "low_battery";
  return null;
}

function deviceSummary(
  reason: "low_power" | "thermal" | "low_battery",
  event: DeviceStateSnapshot,
  batteryPct: number | undefined,
): string {
  if (reason === "low_power") return "Collection constrained: Low Power Mode enabled.";
  if (reason === "thermal") return `Collection constrained: thermal state ${event.thermal}.`;
  return `Collection constrained: battery ${batteryPct ?? "unknown"}%.`;
}
