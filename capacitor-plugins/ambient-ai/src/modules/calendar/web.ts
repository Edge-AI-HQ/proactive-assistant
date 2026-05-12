import type { CalendarPermissions, CalendarPlugin } from './definitions';

export class CalendarWeb implements CalendarPlugin {
  async requestPermissions(): Promise<CalendarPermissions> {
    return { calendar: 'prompt' };
  }

  async checkPermissions(): Promise<CalendarPermissions> {
    return { calendar: 'prompt' };
  }

  async startMonitoring(): Promise<void> {
    console.warn('[Calendar] startMonitoring is not available on web');
  }

  async stopMonitoring(): Promise<void> {}

  async addListener(): Promise<{ remove: () => Promise<void> }> {
    return { remove: async () => {} };
  }

  async removeAllListeners(): Promise<void> {}
}
