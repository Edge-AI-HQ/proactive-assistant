/**
 * 全屏出血浮层壳——逃出 App 根的 SafeAreaView（edges top/bottom），把内容撑到
 * 物理屏满高（顶到刘海、底到 home-indicator 下）。滑出面板 / 全屏 overlay 的统一
 * 底座：MenuDrawer（左滑抽屉）、DebugPanel（齿轮面板）复用，避免每个新面板重踩
 * 「顶部露一条 / 底部内容溢出可视区滑不到」的 safe-area bug。
 *
 * 边界：本壳只负责「出血容器」（消除 top:-insets.top / bottom:-insets.bottom
 * 这段重复）。内容避开刘海/home-indicator 的 header paddingTop、ScrollView
 * paddingBottom，仍由使用方自取 useSafeAreaInsets 决定（各面板布局细节不同）；
 * 手势（右滑关闭等）与动画也由使用方在 children 内自挂，本壳不涉及。
 */
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function FullBleedOverlay({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <View style={[styles.root, { top: -insets.top, bottom: -insets.bottom }]}>{children}</View>;
}

const styles = StyleSheet.create({
  root: { position: "absolute", left: 0, right: 0 },
});
