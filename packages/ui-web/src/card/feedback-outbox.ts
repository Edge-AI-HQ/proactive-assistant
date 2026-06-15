/**
 * 过渡 shim —— feedback outbox 注入点已下沉 @pin-ai/core(ports/feedback-outbox),
 * 平台无关。ui-web 内部消费(useCardActions)+ app 注册点经此 shim 零改。
 */
export { registerFeedbackOutbox, enqueueFeedback, type FeedbackOutbox } from "@pin-ai/core";
