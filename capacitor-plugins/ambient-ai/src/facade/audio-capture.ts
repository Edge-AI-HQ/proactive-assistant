import type { PluginListenerHandle } from '@capacitor/core';

import type {
  AmbientLevelEvent,
  AudioCaptureReadResult,
  AudioCaptureConfig,
  AudioErrorEvent,
  AudioPermissions,
  AudioState,
  CaptureReadyEvent,
  RecentAudioCapture,
  SoundClassificationEvent,
  SpeechBurstEvent,
  TranscriptDraftEvent,
  TranscriptReadyEvent,
  TranscriptRefinedEvent,
} from './types';

export interface AudioCaptureEventMap {
  ambientLevel: AmbientLevelEvent;
  audioError: AudioErrorEvent;
  audioState: AudioState;
  captureReady: CaptureReadyEvent;
  soundClassification: SoundClassificationEvent;
  speechBurst: SpeechBurstEvent;
  transcriptDraft: TranscriptDraftEvent;
  transcriptReady: TranscriptReadyEvent;
  transcriptRefined: TranscriptRefinedEvent;
}

export interface AudioCapturePlugin {
  requestPermissions(): Promise<AudioPermissions>;
  checkPermissions(): Promise<AudioPermissions>;
  configure(config: AudioCaptureConfig): Promise<void>;
  startCapture(): Promise<void>;
  stopCapture(): Promise<void>;
  getState(): Promise<AudioState>;
  drainPendingTranscripts(): Promise<{ transcripts: TranscriptReadyEvent[] }>;
  listRecentCaptures(): Promise<{ captures: RecentAudioCapture[] }>;
  readCapture(options: { wavId: string }): Promise<AudioCaptureReadResult>;
  markCaptureProcessed(options: { wavId: string }): Promise<void>;
  playCapture(options: { wavId: string }): Promise<void>;
  stopPlayback(): Promise<void>;
  startClassification(): Promise<void>;
  stopClassification(): Promise<void>;
  addListener<K extends keyof AudioCaptureEventMap>(
    eventName: K,
    listenerFunc: (event: AudioCaptureEventMap[K]) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

const unavailableAudioState = (): AudioState => ({
  running: false,
  paused: false,
  capturing: false,
  suppressed: false,
});

const noopHandle = (): Promise<PluginListenerHandle> =>
  Promise.resolve({ remove: async () => {} });

export class AudioCaptureWeb implements AudioCapturePlugin {
  async requestPermissions(): Promise<AudioPermissions> {
    return { microphone: 'denied' };
  }

  async checkPermissions(): Promise<AudioPermissions> {
    return { microphone: 'denied' };
  }

  async configure(): Promise<void> {}

  async startCapture(): Promise<void> {}

  async stopCapture(): Promise<void> {}

  async getState(): Promise<AudioState> {
    return unavailableAudioState();
  }

  async drainPendingTranscripts(): Promise<{ transcripts: TranscriptReadyEvent[] }> {
    return { transcripts: [] };
  }

  async listRecentCaptures(): Promise<{ captures: RecentAudioCapture[] }> {
    return { captures: [] };
  }

  async readCapture(options: { wavId: string }): Promise<AudioCaptureReadResult> {
    return {
      wavId: options.wavId,
      contentType: 'audio/wav',
      base64: '',
      byteSize: 0,
    };
  }

  async markCaptureProcessed(): Promise<void> {}

  async playCapture(): Promise<void> {}

  async stopPlayback(): Promise<void> {}

  async startClassification(): Promise<void> {}

  async stopClassification(): Promise<void> {}

  async addListener<K extends keyof AudioCaptureEventMap>(
    _eventName: K,
    _listenerFunc: (event: AudioCaptureEventMap[K]) => void,
  ): Promise<PluginListenerHandle> {
    return noopHandle();
  }

  async removeAllListeners(): Promise<void> {}
}
