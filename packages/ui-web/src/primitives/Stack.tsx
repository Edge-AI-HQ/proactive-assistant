import { cn, stackVariants } from "@pin-ai/ui-kit";
import type { StackProps } from "@pin-ai/ui-kit";

/**
 * Stack primitive — web 实现（flex `<div>` / 可点击 `<button>`）。
 *
 * 布局走与 RN 同一 `stackVariants` cva 配方。VStack/HStack/Spacer 为便捷派生。
 * RN 实现见 apps/mobile/src/primitives/Stack。
 */
export function Stack({ direction, align, justify, gap, className, onPress, children }: StackProps) {
  const cls = cn(stackVariants({ direction, align, justify, gap }), className);
  if (onPress) {
    return (
      <button type="button" onClick={onPress} className={cls}>
        {children}
      </button>
    );
  }
  return <div className={cls}>{children}</div>;
}

export function VStack(props: Omit<StackProps, "direction">) {
  return <Stack {...props} direction="col" />;
}

export function HStack(props: Omit<StackProps, "direction">) {
  return <Stack {...props} direction="row" />;
}

/** flex-1 占位,把 Stack 中其余项推开（VStack/HStack 通用）。 */
export function Spacer({ className }: { className?: string }) {
  return <div className={cn("flex-1", className)} />;
}
