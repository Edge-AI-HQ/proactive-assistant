/**
 * 过渡 shim —— 实现已下沉 @pin-ai/ui-web（now/card-model，测试随迁）。
 * 旧路径保持可用；新代码直接 import "@pin-ai/ui-web"。
 */
export {
  djb2,
  basketToLovableCategory,
  realIntentToChatCard,
  realCardToLovableIntent,
  CATEGORIES,
  type Intent,
  type CardStatus,
  type DetailData,
} from "@pin-ai/ui-web";
