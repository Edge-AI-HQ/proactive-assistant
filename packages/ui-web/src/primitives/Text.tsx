import type { CSSProperties, ElementType } from "react";

import { cn } from "@pin-ai/ui-kit";
import type { TextProps, TextColor } from "@pin-ai/ui-kit";
import { typeScale, fontWeight } from "@pin-ai/design";

/**
 * web 实现专属(不进共享 TextProps 契约,RN 无 DOM 元素概念):多态渲染元素。
 * 语义标题(h1-h4)/列表项(li)/表格单元(td)等需要正确标签时用 `as`,默认 span。
 */
type WebTextProps = TextProps & { as?: ElementType };

/** 语义色 → token className（双端通用；color token 加厚后扩展此表）。 */
const COLOR_CLASS: Record<TextColor, string> = {
  foreground: "text-foreground",
  muted: "text-muted-foreground",
  primary: "text-primary",
};

/**
 * Text primitive — web 实现（`<span>`）。
 *
 * 字号 / 行高 / 字距 / 字重走 typeScale + fontWeight token 的 **style 投影**
 * （双端单位差异大，style 比 className 更可控、双端绝对一致）;语义色走 token
 * **className**（双端 NativeWind 通用）。契约见 @pin-ai/ui-kit `TextProps`；
 * RN 实现见 apps/mobile/src/primitives/Text。
 */
export function Text({
  variant = "body",
  weight = "regular",
  color = "foreground",
  numberOfLines,
  className,
  children,
  as,
}: WebTextProps) {
  const Tag = as ?? "span";
  const t = typeScale[variant];

  const clamp: CSSProperties = {};
  if (numberOfLines === 1) {
    clamp.whiteSpace = "nowrap";
    clamp.overflow = "hidden";
    clamp.textOverflow = "ellipsis";
  } else if (numberOfLines && numberOfLines > 1) {
    clamp.display = "-webkit-box";
    clamp.WebkitLineClamp = numberOfLines;
    clamp.WebkitBoxOrient = "vertical";
    clamp.overflow = "hidden";
  }

  return (
    <Tag
      className={cn(COLOR_CLASS[color], className)}
      style={{
        fontSize: t.fontSize,
        lineHeight: t.lineHeight,
        // letterSpacing 不写进 inline style：inline 优先级高于 className，会
        // 覆盖调用方的 tailwind tracking-*（uppercase 标签常用 tracking-wider）。
        // web 字距统一走 className（需要 tight 的由调用方加 tracking-tight）;
        // typeScale.letterSpacing 仅 RN 实现用（RN 无 tracking class，走 style 投影）。
        fontWeight: fontWeight[weight].web,
        ...clamp,
      }}
    >
      {children}
    </Tag>
  );
}
