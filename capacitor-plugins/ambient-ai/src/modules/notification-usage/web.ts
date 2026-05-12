import type { NotificationUsagePlugin } from './definitions';

export class NotificationUsageWeb
  implements NotificationUsagePlugin
{
  async requestPermissions() {
    return { notifications: 'prompt' as const };
  }

  async checkPermissions() {
    return { notifications: 'prompt' as const };
  }

  async startMonitoring() {
    console.warn('NotificationUsage: not available on web');
  }

  async stopMonitoring() {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async addListener(_eventName: string, _listenerFunc: Function) {
    return {} as any;
  }

  async removeAllListeners() {}
}
