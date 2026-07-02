/**
 * 悬浮「回到最新」按钮 —— web ui-web chat/conversation/scroll/JumpToLatest 的
 * RN 介质版。列表区底部居中悬浮（web bottom-3=12），玻璃圆按钮 + ChevronDown，
 * 右上角 attention 红点（下方有新内容 / 待审批时点亮）。视口未贴底时由 ChatScreen
 * 显示，点击 → scrollToEnd 并重新「跟随」底部。
 *
 * 玻璃 = expo-blur + 白底 0.7（web rgba(255,255,255,0.7) + blur20）。两层结构：
 *  - 外层 `wrap`（**不** overflow:hidden）只做定位容器，让红点逃出圆按钮边界
 *    （-2/-2），否则会被裁掉。
 *  - 内层 `button`（overflow:hidden + 圆角 + 边框）才是圆玻璃——iOS expo-blur
 *    必须靠父级 overflow:hidden 裁圆角（同 CardContextHeaderSlot），只给 BlurView
 *    borderRadius 不够，否则毛玻璃填成方角（= 之前的方块 bug）。
 */
import { Pressable, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { ChevronDown } from "lucide-react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useTranslation } from "react-i18next";

const FG = "29,33,48";
/** web --primary = hsl(292 78% 63%)（与 ChatComposer 发送键渐变起点同源）。 */
const PRIMARY = "hsl(292, 78%, 63%)";

export default function JumpToLatest({
  attention,
  onPress,
}: {
  attention: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(150)}
      style={styles.anchor}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={onPress}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("transcript.scrollToLatest")}
      >
        <View style={styles.wrap}>
          <View style={styles.button}>
            <BlurView intensity={20} tint="light" style={[StyleSheet.absoluteFill, styles.round]} />
            <View style={[StyleSheet.absoluteFill, styles.tint, styles.round]} />
            <ChevronDown size={17} strokeWidth={2} color={`rgba(${FG},0.65)`} />
          </View>
          {attention ? <View style={styles.dot} /> : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // 列表区底部居中（web absolute inset-x-0 bottom-3）。box-none：只有按钮拦截点击，
  // 其余区域穿透到下面的列表。
  anchor: { position: "absolute", left: 0, right: 0, bottom: 12, alignItems: "center" },
  // 定位容器：不裁剪，让红点露出圆按钮外。
  wrap: { width: 36, height: 36 },
  // 圆玻璃：overflow:hidden 才能把 BlurView 裁成圆（iOS expo-blur 不自裁）。
  button: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: `rgba(${FG},0.08)`,
    // web shadow-[0_2px_10px_rgba(0,0,0,0.08)]
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
  },
  round: { borderRadius: 18 },
  tint: { backgroundColor: "rgba(255,255,255,0.7)" },
  // web 红点：h-2.5 w-2.5(10) bg-primary border-2 border-white，-right-0.5/-top-0.5(-2)。
  dot: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: PRIMARY,
    borderWidth: 2,
    borderColor: "#fff",
  },
});
