import { CapacitorBarometer } from '@capgo/capacitor-barometer';
import type { MeasurementEvent } from '@capgo/capacitor-barometer';
import type { PluginListenerHandle } from '@capacitor/core';

import { CadenceGate } from '../../shared/cadence-gate';
import { EventEmitter } from '../../shared/event-emitter';
import { ensureNative } from '../../shared/platform';

import type {
  AltimeterEvent,
  SensorFusionPermissions,
  SensorFusionPlugin,
} from './definitions';

const MIN_EMIT_INTERVAL_MS = 5 * 60 * 1000;
const PRESSURE_DELTA_KPA_THRESHOLD = 0.2;

/**
 * SensorFusion adapter — wraps `@capgo/capacitor-barometer` with the same
 * surface the native plugin used to expose. Native barometer can deliver
 * samples at up to ~10 Hz, so we throttle here to "data layer min cadence":
 * emit when either 5 minutes elapsed or pressure moved at least 0.2 kPa.
 *
 * Foreground only — `setInterval` / barometer JS callbacks pause when the
 * app is backgrounded.
 */
export class SensorFusionAdapter extends EventEmitter implements SensorFusionPlugin {
  private monitoring = false;
  private listenerHandle: PluginListenerHandle | null = null;
  private gate = new CadenceGate(MIN_EMIT_INTERVAL_MS);
  private lastEmittedPressureKPa: number | null = null;

  constructor() {
    super('SensorFusion');
  }

  async requestPermissions(): Promise<SensorFusionPermissions> {
    return { motion: 'granted' };
  }

  async checkPermissions(): Promise<SensorFusionPermissions> {
    return { motion: 'granted' };
  }

  async startMonitoring(): Promise<void> {
    if (!ensureNative('SensorFusion')) return;
    if (this.monitoring) return;

    const { isAvailable } = await CapacitorBarometer.isAvailable();
    if (!isAvailable) {
      throw new Error('Altimeter not available on this device');
    }

    this.monitoring = true;
    this.gate.reset();
    this.lastEmittedPressureKPa = null;

    this.listenerHandle = await CapacitorBarometer.addListener(
      'measurement',
      (m: MeasurementEvent) => {
        this.handleMeasurement(m.pressure, m.relativeAltitude);
      },
    );
    await CapacitorBarometer.startMeasurementUpdates();
  }

  async stopMonitoring(): Promise<void> {
    if (!this.monitoring) return;
    this.monitoring = false;

    try {
      await CapacitorBarometer.stopMeasurementUpdates();
    } finally {
      if (this.listenerHandle) {
        await this.listenerHandle.remove();
        this.listenerHandle = null;
      }
      this.gate.reset();
      this.lastEmittedPressureKPa = null;
    }
  }

  private handleMeasurement(pressureHPa: number, relativeAltitude: number): void {
    const pressureKPa = pressureHPa / 10;

    const pressureDelta =
      this.lastEmittedPressureKPa === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(pressureKPa - this.lastEmittedPressureKPa);

    const passDelta = pressureDelta >= PRESSURE_DELTA_KPA_THRESHOLD;
    const passInterval = this.gate.shouldRun();

    if (!passDelta && !passInterval) return;

    this.lastEmittedPressureKPa = pressureKPa;
    if (passDelta) {
      // Force the cadence anchor forward so a series of small drift events
      // doesn't immediately retrigger via the interval window.
      this.gate.shouldRun();
    }

    const event: AltimeterEvent = {
      relativeAltitude,
      pressureKPa,
      timestamp: Date.now(),
    };
    this.emitTyped('altimeter', event);
  }
}
