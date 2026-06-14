import { TextInput } from "react-native";

import { cn, inputVariants } from "@pin-ai/ui-kit";
import type { InputProps } from "@pin-ai/ui-kit";
import { typeScale } from "@pin-ai/design";

/**
 * Input primitive — RN 实现（TextInput）。
 *
 * 布局/边框走同一 `inputVariants` cva 配方;onValueChange 接 onChangeText;字号走
 * typeScale.body 的 style 投影;web 的 `type` prop 在 RN 忽略。
 * web 实现见 packages/ui-web/src/primitives/Input。
 */
export function Input({
  value,
  onValueChange,
  placeholder,
  disabled,
  className,
  size,
  onSubmit,
}: InputProps) {
  return (
    <TextInput
      value={value}
      onChangeText={onValueChange}
      onSubmitEditing={onSubmit}
      placeholder={placeholder}
      editable={disabled !== true}
      className={cn(inputVariants({ size: size ?? "md" }), "text-foreground", className)}
      style={{ fontSize: typeScale.body.fontSize }}
    />
  );
}
