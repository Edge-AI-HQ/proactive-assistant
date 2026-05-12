import type {
  VisitMonitorPlugin,
  VisitMonitorPermissions,
  PositionResult,
} from './definitions';

export class VisitMonitorWeb implements VisitMonitorPlugin {
  async requestPermissions(): Promise<VisitMonitorPermissions> {
    return { location: 'prompt' as PermissionState };
  }

  async checkPermissions(): Promise<VisitMonitorPermissions> {
    return { location: 'prompt' as PermissionState };
  }

  async startMonitoring(): Promise<void> {
    console.warn('[VisitMonitor] startMonitoring is not available on web');
  }

  async stopMonitoring(): Promise<void> {}

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
