/**
 * 渐变填充文字——web `bg-gradient-to-r ... bg-clip-text text-transparent`
 * 的 RN 对应物（介质映射：MaskedView 抠字形 + LinearGradient 填充）。
 * RN Text 内不能嵌非 Text 节点，调用方用 flex-row + alignItems:'baseline'
 * 与普通 Text 并排（web 的 inline span 对应物）。
 */
import { Text, type StyleProp, type TextStyle } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";

export function GradientText({
  text,
  colors,
  style,
}: {
  text: string;
  /** 渐变色标，web `from-... to-...` 对应（至少两个）。 */
  colors: readonly [string, string, ...string[]];
  style?: StyleProp<TextStyle>;
}) {
  return (
    <MaskedView maskElement={<Text style={style}>{text}</Text>}>
      <LinearGradient colors={colors} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}>
        {/* 透明同款文字撑出渐变区域尺寸。 */}
        <Text style={[style, { opacity: 0 }]}>{text}</Text>
      </LinearGradient>
    </MaskedView>
  );
}
