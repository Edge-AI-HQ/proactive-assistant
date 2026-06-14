import { cva, type VariantProps } from "class-variance-authority";

/**
 * Divider variant 配方（双端共享，仅 NativeWind 通用 class 子集）。
 * 1px 分隔线,色走 border token。horizontal=整宽细线 / vertical=随父高细线。
 * web 实现 = ui-web/primitives/Divider，RN 实现 = apps/mobile/primitives/Divider。
 */
export const dividerVariants = cva("shrink-0 bg-border", {
  variants: {
    orientation: {
      horizontal: "h-px w-full",
      vertical: "w-px self-stretch",
    },
  },
  defaultVariants: { orientation: "horizontal" },
});

export type DividerOrientation = NonNullable<VariantProps<typeof dividerVariants>["orientation"]>;

export interface DividerProps extends VariantProps<typeof dividerVariants> {
  className?: string;
}
