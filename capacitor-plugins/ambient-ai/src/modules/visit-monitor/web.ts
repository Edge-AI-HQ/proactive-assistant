import type {
  VisitMonitorPlugin,
  VisitMonitorPermissions,
  PositionResult,
} from './definitions';

export class VisitMonitorWeb implements VisitMonitorPlugin {
  async requestPermissions(): Promise<VisitMonitorPermissions> {
    return { location: 'prompt' };
  }

  async checkPermissions(): Promise<VisitMonitorPermissions> {
    return { location: 'prompt' };
  }

  async startMonitoring(): Promise<void> {
    console.warn('[VisitMonitor] startMonitoring is not available on web');
  }

  async stopMonitoring(): Promise<void> {}

  async drainPendingVisits(): Promise<{ visits: [] }> {
    return { visits: [] };
  }

  async ackPendingVisits(): Promise<void> {}

  async getMonitoringState() {
    return {
      authorization: 'prompt' as const,
      nativeMonitoring: false,
      enabled: false,
      pendingVisitCount: 0,
      storedVisitCount: 0,
      lastNativeVisitAt: null,
      lastDrainAt: null,
      lastError: null,
    };
  }

  async getCurrentPosition(): Promise<PositionResult> {
    throw new Error(
      '[VisitMonitor] getCurrentPosition is not available on web; use @capacitor/geolocation instead',
    );
  }

  async startActivityRecognition(): Promise<void> {
    console.warn('[VisitMonitor] startActivityRecognition is not available on web');
  }

  async stopActivityRecognition(): Promise<void> {}

  async addListener(): Promise<{ remove: () => Promise<void> }> {
    return { remove: async () => {} };
  }

  async removeAllListeners(): Promise<void> {}
}
