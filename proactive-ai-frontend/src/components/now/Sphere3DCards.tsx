/**
 * 过渡 shim —— 实现已下沉 @pin-ai/ui-web（now/Sphere3DCards，测试随迁）。
 * 旧路径保持可用；新代码直接 import "@pin-ai/ui-web"。
 */
export {
  Sphere3DCards as default,
  getSphereCardPresentation,
  computeCardStyle,
  type Sphere3DCardItem,
  type SphereCardStatus,
} from "@pin-ai/ui-web";
