import { Health } from '@capgo/capacitor-health';
import type { HealthSample } from '@capgo/capacitor-health';

import { EventEmitter } from '../../shared/event-emitter';
import { ensureNative } from '../../shared/platform';

import type {
  HealthConnectPermissions,
  HealthConnectPlugin,
  HeartRateEvent,
  SleepEvent,
  StepsEvent,
} from './definitions';

const POLL_INTERVAL_MS = 15 * 60 * 1000;
const SLEEP_LOOKBACK_MS = 36 * 60 * 60 * 1000;
const HEART_RATE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const HEALTH_DATA_TYPES = ['steps', 'sleep', 'heartRate'] as const;

/**
 * HealthConnect adapter — wraps `@capgo/capacitor-health` (which targets
 * HealthKit on iOS, Health Connect on Android). Replaces the in-tree native
 * implementation. Polls every 15 min for steps/sleep/heart-rate aggregates.
 *
 * Foreground only — JS `setInterval` is suspended when the app is locked
 * or backgrounded; business runtime should restart monitoring on resume.
 */
export class HealthConnectAdapter extends EventEmitter implements HealthConnectPlugin {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super('HealthConnect');
  }

  async requestPermissions(): Promise<HealthConnectPermissions> {
    if (!ensureNative('HealthConnect')) return { health: 'denied' };
    const status = await Health.requestAuthorization({ read: [...HEALTH_DATA_TYPES] });
    const allGranted = HEALTH_DATA_TYPES.every((t) => status.readAuthorized.includes(t));
    return { health: allGranted ? 'granted' : 'denied' };
  }

  async checkPermissions(): Promise<HealthConnectPermissions> {
    if (!ensureNative('HealthConnect')) return { health: 'denied' };
    const status = await Health.checkAuthorization({ read: [...HEALTH_DATA_TYPES] });
    const allGranted = HEALTH_DATA_TYPES.every((t) => status.readAuthorized.includes(t));
    return { health: allGranted ? 'granted' : 'prompt' };
  }

  async startMonitoring(): Promise<void> {
    if (!ensureNative('HealthConnect')) return;

    const { available } = await Health.isAvailable();
    if (!available) {
      throw new Error('HealthKit not available on this device');
    }

    await this.readAndEmit(false);
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      void this.readAndEmit(true);
    }, POLL_INTERVAL_MS);
  }

  async stopMonitoring(): Promise<void> {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async readAndEmit(swallowUnexpected: boolean): Promise<void> {
    const results = await Promise.allSettled([
      this.readSteps(),
      this.readLastSleep(),
      this.readHeartRate(),
    ]);
    let unexpectedError: unknown;
    for (const result of results) {
      if (result.status === 'fulfilled') continue;
      if (isProtectedHealthDataError(result.reason)) {
        console.debug('[HealthConnect] locked_protected_data', result.reason);
        continue;
      }
      console.warn('[HealthConnect] read failed', result.reason);
      unexpectedError ??= result.reason;
    }
    if (unexpectedError && !swallowUnexpected) {
      throw unexpectedError;
    }
  }

  private async readSteps(): Promise<void> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const result = await Health.readSamples({
      dataType: 'steps',
      startDate: startOfDay.toISOString(),
    });
    const total = sumSamples(result.samples);
    const event: StepsEvent = {
      stepsToday: Math.round(total),
      timestamp: Date.now(),
    };
    this.emitTyped('steps', event);
  }

  private async readLastSleep(): Promise<void> {
    const startDate = new Date(Date.now() - SLEEP_LOOKBACK_MS).toISOString();
    const result = await Health.readSamples({
      dataType: 'sleep',
      startDate,
      ascending: false,
      limit: 1,
    });
    const last = result.samples[0];
    if (!last) return;

    const start = new Date(last.startDate).getTime();
    const end = new Date(last.endDate).getTime();
    const durationMin = Math.max(0, Math.round((end - start) / 60_000));
    const event: SleepEvent = {
      durationMin,
      endedAt: last.endDate,
      timestamp: Date.now(),
    };
    this.emitTyped('sleep', event);
  }

  private async readHeartRate(): Promise<void> {
    const startDate = new Date(Date.now() - HEART_RATE_LOOKBACK_MS).toISOString();
    const result = await Health.readSamples({
      dataType: 'heartRate',
      startDate,
    });
    if (result.samples.length === 0) return;
    const avg = avgSamples(result.samples);
    const event: HeartRateEvent = {
      avgBpm6h: Math.round(avg),
      timestamp: Date.now(),
    };
    this.emitTyped('heartRate', event);
  }
}

function sumSamples(samples: HealthSample[]): number {
  let total = 0;
  for (const s of samples) total += s.value;
  return total;
}

function avgSamples(samples: HealthSample[]): number {
  if (samples.length === 0) return 0;
  return sumSamples(samples) / samples.length;
}

function isProtectedHealthDataError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('protected health data is inaccessible');
}
