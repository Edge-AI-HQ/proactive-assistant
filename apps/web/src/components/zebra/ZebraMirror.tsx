import MirrorDesktop from "./MirrorDesktop";

/**
 * Desktop (zebra) MIRROR — 桌面布局 shell 在 MirrorDesktop（数据走
 * @pin-ai/state hook、展示复用 @/ui-web panel）。这里只是 zebra 阅读列
 * 的挂载点；MirrorDesktop 自带 h-full / 居中限宽 / 滚动。
 */
export default function ZebraMirror() {
  return <MirrorDesktop />;
}
