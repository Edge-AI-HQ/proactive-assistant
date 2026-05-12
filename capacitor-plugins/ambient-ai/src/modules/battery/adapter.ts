import { Device } from '@capacitor/device';

import { EventEmitter } from '../../shared/event-emitter';
import { ensureNative } from '../../shared/platform';

import type {
  BatteryPlugin,
  BatterySnapshot,
  BatteryStartOptions,
} from './definitions';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const PCT_DELTA_THRESHOLD = 5;

/**
 * Battery adapter — wraps `@capacitor/device.getBatteryInfo()`. The official
 * plugin only exposes a one-shot getter on Capacitor 8, so this adapter
 * polls (default 5min) and emits when battery percent changes by >= 5
 * points or charging state flips.
 *
 * Foreground only — `setInterval` is suspended in iOS background.
 */
export class BatteryAdapter extends EventEmitter implements BatteryPlugin {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot: BatterySnapshot | null = null;

  constructor() {
    super('Battery');
  }

  async getState(): Promise<BatterySnapshot> {
    return this.readSnapshot();
  }

  async startMonitoring(options?: BatteryStartOptions): Promise<void> {
    if (!ensureNative('Battery')) return;
    if (this.intervalId !== null) return;

    const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
    const initial = await this.readSnapshot();
    this.lastSnapshot = initial;
    this.emitTyped('battery', initial);

    this.intervalId = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  async stopMonitoring(): Promise<void> {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.lastSnapshot = null;
  }

  private async tick(): Promise<void> {
    const snapshot = await this.readSnapshot();
    if (this.shouldEmit(snapshot)) {
      this.lastSnapshot = snapshot;
      this.emitTyped('battery', snapshot);
    }
  }

  private shouldEmit(snapshot: BatterySnapshot): boolean {
    if (!this.lastSnapshot) return true;
    if (snapshot.charging !== this.lastSnapshot.charging) return true;
    if (Math.abs(snapshot.batteryPct - this.lastSnapshot.batteryPct) >= PCT_DELTA_THRESHOLD) {
      return true;
    }
    return false;
  }

  private async readSnapshot(): Promise<BatterySnapshot> {
    const info = await Device.getBatteryInfo();
    const level = info.batteryLevel ?? 0;
    return {
      batteryPct: Math.round(level * 100),
      charging: info.isCharging ?? false,
      timestamp: Date.now(),
    };
  }
}
