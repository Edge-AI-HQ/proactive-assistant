import { cva, type VariantProps } from "class-variance-authority";

/** Input variant 配方（双端共享，仅 NativeWind 通用 class 子集）。 */
export const inputVariants = cva("rounded-xl border border-foreground/12 bg-background px-3", {
  variants: {
    size: { sm: "h-8", md: "h-10", lg: "h-11" },
  },
  defaultVariants: { size: "md" },
});

export type InputSize = NonNullable<VariantProps<typeof inputVariants>["size"]>;

/**
 * Input primitive 契约（双端共享）。web 实现 = ui-web/primitives/Input，
 * RN 实现 = apps/mobile/primitives/Input。文字字号走 typeScale.body 的 style 投影
 * （双端一致）;onValueChange 是双端统一变更事件（web onChange / RN onChangeText）。
 */
export interface InputProps extends VariantProps<typeof inputVariants> {
  value?: string;
  /** 双端统一变更事件，回调 string 值。 */
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** 仅 web。 */
  type?: "text" | "password" | "email" | "search";
  /** Enter（web）/ submit（RN）触发。 */
  onSubmit?: () => void;
}
