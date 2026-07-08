import { isElectron } from "@pin-ai/ui-web";

/**
 * Electron 桌面壳顶部的隐藏标题栏(业界 convention 的 hidden draggable bar)。
 *
 * main 进程用 titleBarStyle: "hiddenInset"——traffic lights(红绿灯)原生浮在
 * 左上角,但窗口顶部默认不可拖。这条透明 drag region 让顶部留白带能拖动窗口
 * (+ 双击 zoom,均为 -webkit-app-region: drag 自带行为)。
 *
 * 不占视觉空间、不挡交互:Electron 下 zebra 布局顶部 0~40px 全是留白(侧栏与
 * slide-over panel top-10 避让隐藏 title bar 带 / 主视图 pt-10 / traffic
 * lights y:18),drag region(h-8)盖在其上无副作用。
 *
 * z 层级(zebra:主内容 z-10/20、侧栏 z-30、panel scrim z-40、conversation/
 * panel 实体 z-50)——取 z-[45]:高于 scrim(panel 打开时顶部边缘仍可拖)、
 * 低于实体模态(它们顶部的交互/关闭按钮不被 drag region 拦截)。
 *
 * isElectron 基于 preload 注入的 window.pinaiDesktop 探测——web / Capacitor
 * 构建下为 false,整条 bar 不渲染。
 */
export default function DesktopTitleBar() {
  if (!isElectron) return null;
  return (
    <div
      className="desktop-drag-region fixed inset-x-0 top-0 z-[45] h-8"
      aria-hidden
    />
  );
}
