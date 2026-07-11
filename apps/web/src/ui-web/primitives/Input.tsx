import { cn, inputVariants } from "@pin-ai/ui-kit";
import type { InputProps } from "@pin-ai/ui-kit";
import { typeScale } from "@pin-ai/design";

/**
 * Input primitive — web 实现（`<input>`）。
 *
 * 布局/边框走 ui-kit `inputVariants` cva 配方（双端共享）;文字字号走 typeScale.body
 * 的 style 投影（双端一致）;onValueChange 双端统一事件。契约见 @pin-ai/ui-kit
 * `InputProps`;RN 实现见 apps/mobile/src/primitives/Input。
 */
export function Input({
  value,
  onValueChange,
  placeholder,
  disabled,
  className,
  type = "text",
  size,
  onSubmit,
}: InputProps) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
      onKeyDown={
        onSubmit
          ? (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              }
            }
          : undefined
      }
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        inputVariants({ size: size ?? "md" }),
        "text-foreground placeholder:text-foreground/35 outline-none focus:ring-1 focus:ring-foreground/20 disabled:opacity-50",
        className,
      )}
      style={{ fontSize: typeScale.body.fontSize }}
    />
  );
}
