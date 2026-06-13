/**
 * 过渡 shim —— voice 模块已下沉 @pin-ai/ui-web（纯 web 介质：getUserMedia +
 * 语音 stream API；ambient 外部麦克风协调改 registerExternalMicAcquirer
 * 注册点，main.tsx 注册）。旧路径保持可用。
 */
export {
  VoiceProvider,
  useVoiceInput,
  VoiceButton,
  appendVoiceTranscript,
  Waveform,
  BrowserSpeechEngine,
  ByteDanceStreamingEngine,
  GptTranscriptionEngine,
  type VoiceButtonProps,
  type VoiceEngine,
  type VoiceEngineHandle,
  type VoiceEngineCallbacks,
  type StartCaptureOptions,
  type VoiceContextValue,
  type VoiceProviderProps,
} from "@pin-ai/ui-web";
