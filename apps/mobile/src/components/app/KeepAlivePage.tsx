/**
 * keep-alive 页面壳 + 页面可见性上下文。
 * - 每页首访（或登录后空闲预挂载）后常驻，display:none 隐藏、不卸载：切回零重载、
 *   滚动/状态原位，TQ 缓存持续新鲜。
 * - 切换 = display 秒切（无淡入、无延帧）：配合 AppShell 的「预挂载全部 tab」，目标页
 *   早已渲染好在抽屉底下 → 抽屉一消失即完整新页，拿到「本来就在那」的手感（对齐主流
 *   App 的 tab 秒切），不再是「现搭 + 淡入」。
 * - PageActiveContext：常驻页里的无限动画循环（Tasks 徽章 Spin/Pulse、Ambient
 *   PingRing 等）据此在页面不可见时停帧——否则 keep-alive 会让 UI 线程空跑发热。
 *   默认 true：页面栈以外的使用处（chat sheet 等）行为不变。
 */
import { createContext, useContext, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

const PageActiveContext = createContext(true);

/** 所在 keep-alive 页当前是否可见（不在页面栈内的组件恒 true）。 */
export function usePageActive(): boolean {
  return useContext(PageActiveContext);
}

/** 给非 keep-alive 页面栈的挂载点（ChatSheet / CardChatScreen 等）手动提供可见性,
 *  让其内部的无限动画循环据此停帧——常驻挂载但关闭时不空转 UI 线程（WS6）。 */
export function PageActiveProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <PageActiveContext.Provider value={value}>{children}</PageActiveContext.Provider>;
}

export function KeepAlivePage({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <View
      style={[StyleSheet.absoluteFill, active ? null : styles.hidden]}
      pointerEvents={active ? "auto" : "none"}
    >
      <PageActiveContext.Provider value={active}>{children}</PageActiveContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { display: "none" },
});
