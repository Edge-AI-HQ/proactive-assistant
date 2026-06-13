/**
 * 过渡 shim —— 实现已下沉 @pin-ai/ui-web（connect/ConnectorOnboardingInsight，
 * 测试随 DataConnections.test 在 ui-web）。旧路径保持可用。onboarding 专用
 * 组件，apps/web 暂不做 onboarding，但放 connect 共享层不碍事（依赖全已下沉、
 * 纯 web；tree-shake 不打进 apps/web bundle）。
 */
export { ConnectorOnboardingInsight as default, type ConnectorInsightStatus } from "@pin-ai/ui-web";
