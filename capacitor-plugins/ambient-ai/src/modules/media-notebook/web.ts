import type { MediaNotebookPlugin } from './definitions';

export class MediaNotebookWeb implements MediaNotebookPlugin {
  async requestPermissions() {
    return { photos: 'prompt' as const };
  }

  async checkPermissions() {
    return { photos: 'prompt' as const };
  }

  async startMonitoring() {
    console.warn('MediaNotebook: not available on web');
  }

  async stopMonitoring() {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async addListener(_eventName: string, _listenerFunc: Function) {
    return {} as any;
  }

  async removeAllListeners() {}
}
