/**
 * Device-state 源（RN 直替：expo-battery 覆盖电量/充电/低电量模式）。
 * 信号形状与 web sources/device-state.ts 对齐（schema_version
 * device_state.v1）。
 */
import * as Battery from "expo-battery";

import { SIGNAL_KINDS, type AmbientSource, type SourceContext } from "../types";

export function createDeviceStateSource(ctx: SourceContext): AmbientSource {
  let subs: { remove(): void }[] = [];

  async function snapshot(reason: string) {
    const [level, state, lowPower] = await Promise.all([
      Battery.getBatteryLevelAsync(),
      Battery.getBatteryStateAsync(),
      Battery.isLowPowerModeEnabledAsync(),
    ]);
    const batteryPct = Math.round(level * 100);
    const charging = state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL;
    const summary = `battery ${batteryPct}%${charging ? " charging" : ""}${lowPower ? " low-power" : ""}`;
    ctx.push({
      kind: SIGNAL_KINDS.deviceState,
      title: "Device state",
      summary,
      payload: {
        schema_version: "device_state.v1",
        battery_pct: batteryPct,
        charging,
        low_power: lowPower,
        reason,
      },
    });
    ctx.onEvent("device_state", summary);
  }

  return {
    key: "device_state",
    label: "Device state",
    isStarted: () => subs.length > 0,
    async start() {
      if (subs.length > 0) return;
      await snapshot("start");
      subs = [
        Battery.addBatteryStateListener(() => void snapshot("battery_state")),
        Battery.addLowPowerModeListener(() => void snapshot("low_power")),
      ];
    },
    async stop() {
      for (const s of subs) s.remove();
      subs = [];
    },
  };
}
