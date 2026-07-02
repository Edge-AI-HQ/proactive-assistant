/**
 * voice-identity API 实现已上移 @pin-ai/core（双端 SSOT，apps/mobile 也消费同一份）。
 * 本文件保留为兼容 re-export，旧引用点（@/services/voice-identity-api）无需改动。
 */
export {
  fetchVoiceIdentity,
  uploadVoiceIdentityReference,
  setVoiceIdentityEnabled,
  deleteVoiceIdentityReference,
  transcribeVoiceAudioDiarized,
  type VoiceIdentityProfile,
  type SpeakerSegment,
  type DiarizationStatus,
  type DiarizedVoiceTranscriptionResult,
} from "@pin-ai/core";
