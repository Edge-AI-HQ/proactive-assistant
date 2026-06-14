import { useState } from "react";
import bgVideo from "@/assets/constellation-bg.mp4";
import bgGradient from "@/assets/bg-gradient.jpg";

/**
 * Login backdrop — frontend 端登录页的 nebula 氛围，与 apps/web 的
 * ZebraBackdrop 一一对应（双端登录视觉统一）：aurora 渐变底 + 循环 nebula
 * 视频淡入，白罩压到 30%。比 shell 的 VideoBackdrop（white/70，为卡片文字
 * 可读性压得更白）更通透——登录页只有一个按钮，让 nebula 像 web 端那样明显。
 *
 * aurora-layer / bg-flow 的 keyframes 在 index.css；native-power-save 下
 * aurora 自动停（见 index.css），慢放视频继续（WKWebView muted+playsInline
 * 允许 autoplay）。
 */
export default function LoginBackdrop() {
  const [videoReady, setVideoReady] = useState(false);
  return (
    <>
      <div className="absolute inset-0 bg-white" aria-hidden="true" />
      <img
        src={bgGradient}
        alt=""
        className="absolute inset-0 h-full w-full object-cover opacity-60"
        aria-hidden="true"
      />
      <div className="absolute inset-0 aurora-layer aurora-layer-1" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-2" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-3" aria-hidden="true" />
      <video
        ref={(el) => {
          if (el) el.playbackRate = 0.5;
        }}
        src={bgVideo}
        autoPlay
        loop
        muted
        playsInline
        onLoadedData={() => setVideoReady(true)}
        className="absolute inset-0 h-full w-full object-cover transition-opacity duration-700"
        style={{ opacity: videoReady ? 0.75 : 0 }}
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-white/30" aria-hidden="true" />
    </>
  );
}
