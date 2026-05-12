import type { DeviceStatePlugin, DeviceStateSnapshot } from './definitions';

export class DeviceStateWeb implements DeviceStatePlugin {
  async getState(): Promise<DeviceStateSnapshot> {
    return {
      thermal: 'nominal',
      lowPower: false,
      timestamp: Date.now(),
    };
  }

  async startMonitoring(): Promise<void> {
    console.warn('[DeviceState] startMonitoring is not available on web');
  }

  async stopMonitoring(): Promise<void> {}

  async addListener(): Promise<{ remove: () => Promise<void> }> {
    return { remove: async () => {} };
  }

  async removeAllListeners(): Promise<void> {}
}
