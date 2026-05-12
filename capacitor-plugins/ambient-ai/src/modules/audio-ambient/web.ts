import type { AudioAmbientPlugin } from './definitions';

export class AudioAmbientWeb implements AudioAmbientPlugin {
  async requestPermissions() {
    return { microphone: 'prompt' as const };
  }

  async checkPermissions() {
    return { microphone: 'prompt' as const };
  }

  async startMonitoring() {
    console.warn('AudioAmbient: not available on web');
  }

  async stopMonitoring() {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async addListener(_eventName: string, _listenerFunc: Function) {
    return {} as any;
  }

  async removeAllListeners() {}
}
