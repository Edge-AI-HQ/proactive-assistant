/**
 * 16kHz 单声道 16-bit LINEARPCM WAV 录音档位——对齐 web pcm-recorder 的
 * createPcmRecorder({ sampleRate: 16_000 }) → encodeWav（16-bit 小端整型 PCM）。
 * 后端 /voice/identity/reference 用 wave.open 解析、只收 WAV（非 WAV 直接 422），
 * /voice/transcribe 同样原生吃 WAV。声纹 enrollment（VoiceIdentitySettings）与
 * 听写独立采集（VoiceProvider recorder 路径）共用本档位。
 *
 * iOS 由 expo-audio 顶层 extension ".wav" + ios.outputFormat LINEARPCM 出真 WAV
 * （AVAudioRecorder 按扩展名选 RIFF/WAV 容器）；Android MediaRecorder 产不了 WAV，
 * android 子对象覆盖成合法 AAC/.m4a 档位只为不报错——iOS 是唯一目标端。
 */
import { AudioQuality, IOSOutputFormat, type RecordingOptions } from "expo-audio";

export const WAV_CONTENT_TYPE = "audio/wav";

export const WAV_RECORDING_OPTIONS: RecordingOptions = {
  extension: ".wav",
  sampleRate: 16_000,
  numberOfChannels: 1,
  // LPCM 无编码器，AVEncoderBitRateKey 不参与编码；写 16k × 16bit × mono 的真实码率自洽。
  bitRate: 256_000,
  android: { extension: ".m4a", outputFormat: "mpeg4", audioEncoder: "aac" },
  ios: {
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.MAX,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: "audio/webm", bitsPerSecond: 128_000 },
};
