/**
 * 过渡 shim —— 外部麦克风注入点已下沉 @pin-ai/core(ports/external-mic),平台无关。
 * ui-web 内部消费(VoiceProvider)+ app 注册点经此 shim 零改。
 */
export { registerExternalMicAcquirer, acquireExternalMic, type ExternalMicLease } from "@pin-ai/core";
