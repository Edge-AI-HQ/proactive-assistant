import type { NearbyConnectivityPlugin } from './definitions';

export class NearbyConnectivityWeb implements NearbyConnectivityPlugin {
  async requestPermissions() {
    return { bluetooth: 'prompt' as const };
  }

  async checkPermissions() {
    return { bluetooth: 'prompt' as const };
  }

  async startMonitoring() {
    console.warn('NearbyConnectivity: not available on web');
  }

  async stopMonitoring() {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async addListener(_eventName: string, _listenerFunc: Function) {
    return {} as any;
  }

  async removeAllListeners() {}
}
