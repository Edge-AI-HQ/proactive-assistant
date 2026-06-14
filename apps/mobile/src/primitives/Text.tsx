import { Text as RNText } from "react-native";

import { cn } from "@pin-ai/ui-kit";
import type { TextProps, TextColor } from "@pin-ai/ui-kit";
import { typeScale, fontWeight } from "@pin-ai/design";

import { tracking, leading } from "../ui/typography";

/** 语义色 → token className（与 web 实现同表，双端 NativeWind 通用）。 */
const COLOR_CLASS: Record<TextColor, string> = {
  foreground: "text-foreground",
  muted: "text-muted-foreground",
  primary: "text-primary",
};

/**
 * Text primitive — RN 实现（react-native Text）。
 *
 * 消费与 web 同一 @pin-ai/ui-kit `TextProps` 契约 + typeScale/fontWeight token，
 * 各自投影：字重 → fontFamily（Inter 族名，RN 不支持 font-weight class）、
 * 字号 → fontSize、行高/字距经 typography.ts 的 leading/tracking 换算成 RN 绝对 pt。
 * 语义色走 NativeWind className。web 实现见 packages/ui-web/src/primitives/Text。
 */
export function Text({
  variant = "body",
  weight = "regular",
  color = "foreground",
  numberOfLines,
  className,
  children,
}: TextProps) {
  const v = typeScale[variant];
  return (
    <RNText
      numberOfLines={numberOfLines}
      className={cn(COLOR_CLASS[color], className)}
      style={{
        fontFamily: fontWeight[weight].native,
        fontSize: v.fontSize,
        lineHeight: leading(v.fontSize, v.lineHeight),
        letterSpacing: tracking(v.fontSize, v.letterSpacing),
      }}
    >
      {children}
    </RNText>
  );
}
