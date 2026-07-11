import type { BoxProps } from "@pin-ai/ui-kit";

/**
 * Box primitive — web 实现（`<div>` / 可点击时 `<button>`）。
 *
 * 纯容器,无样式默认;布局/外观由 className 决定。需要双端一致的 flex 布局用 Stack。
 * RN 实现见 apps/mobile/src/primitives/Box。
 */
export function Box({ className, onPress, children }: BoxProps) {
  if (onPress) {
    return (
      <button type="button" onClick={onPress} className={className}>
        {children}
      </button>
    );
  }
  return <div className={className}>{children}</div>;
}
