/**
 * 过渡 shim —— normalizeVoiceLanguage 已下沉 @pin-ai/core（纯逻辑,RN 也用）。
 * 旧路径 `../voice/language` 保持可用;新代码直接 import "@pin-ai/core"。
 */
export { normalizeVoiceLanguage, type VoiceLanguageHint } from "@pin-ai/core";
