import type { SoundClassifierPlugin, SoundClassifierPermissions } from './definitions';

export class SoundClassifierWeb implements SoundClassifierPlugin {
  async requestPermissions(): Promise<SoundClassifierPermissions> {
    return { microphone: 'prompt' as PermissionState };
  }

  async checkPermissions(): Promise<SoundClassifierPermissions> {
    return { microphone: 'prompt' as PermissionState };
  }

  async startListening(): Promise<void> {
    console.warn('[SoundClassifier] startListening is not available on web');
  }

  async stopListening(): Promise<void> {}

  async addListener(): Promise<{ remove: () => Promise<void> }> {
    return { remove: async () => {} };
  }

  async removeAllListeners(): Promise<void> {}
}
