/**
 * keep-alive 页面壳 + 页面可见性上下文。
 * - 每页首访（或登录后空闲预挂载）后常驻、不卸载：切回零重载、滚动/状态原位，
 *   TQ 缓存持续新鲜。
 * - 隐藏 = 「保排版、移出屏外 + 透明」（UITabBarController 同思路：视图常驻且
 *   排版就绪，切换只翻位置/透明度）。**不用 display:none**——Yoga 对 display:none
 *   子树跳过排版（原生侧也不真正就绪），首次显形要当场排版整页 + 列表量视口再
 *   调整 = 「出现那一帧卡」（Tasks 首切卡顿实测根因，2026-07-07 修）。改为屏外
 *   平移后，预挂载在空闲期就把原生视图 + 排版做完，显形 = 纯 transform/opacity
 *   翻转，零排版成本。
 * - 触摸隔离靠「移出屏外」天然实现（命中测试跟随 transform 后的位置）；不用
 *   pointerEvents 翻转——该 prop 更新在原生侧偶发不生效、整页触摸钉死（2026-07-07
 *   Profile 首切卡死教训）。屏外页被玻璃卡的 overflow:hidden 裁剪，不参与绘制。
 * - PageActiveContext：常驻页里的无限动画循环（Tasks 徽章 Spin/Pulse、Ambient
 *   PingRing 等）据此在页面不可见时停帧——否则 keep-alive 会让 UI 线程空跑发热。
 *   默认 true：页面栈以外的使用处（chat sheet 等）行为不变。
 */
import { createContext, useContext, type ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";

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
  // 隐藏 = 屏外平移 + 透明（文件头注释）：transform 不影响 Yoga 排版 → 隐藏页
  // 与可见页同样排版就绪，显形只是把它移回原位。opacity:0 兜底「万一露出」；
  // 触摸随 transform 位置移出屏外，天然不可点，不碰 pointerEvents。
  const { width } = useWindowDimensions();
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        active ? null : { opacity: 0, transform: [{ translateX: width * 2 }] },
      ]}
    >
      <PageActiveContext.Provider value={active}>{children}</PageActiveContext.Provider>
    </View>
  );
}
