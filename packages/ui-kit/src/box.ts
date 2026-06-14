import type { ReactNode } from "react";

/**
 * Box primitive 契约（双端共享，平台无关）。最基础的容器原语:
 * web → `<div>`（可点击时 `<button>`），RN → `<View>`（可点击时 `<Pressable>`）。
 *
 * 纯容器 —— 无背景/边框/variant（那是 Surface 的职责），也不强加 flex（各端保留
 * 原生默认:web=block / RN=flex-col）。需要双端一致的 flex 布局用 Stack。Box 只是
 * 「挂 className 的双端容器逃生舱」。web 实现 = ui-web/primitives/Box，
 * RN 实现 = apps/mobile/primitives/Box。
 */
export interface BoxProps {
  className?: string;
  /** 有则可点击（web→onClick / RN→Pressable）。 */
  onPress?: () => void;
  children?: ReactNode;
}
