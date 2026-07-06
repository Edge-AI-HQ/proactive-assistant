/**
 * App 主壳背景——web components/app/VideoBackdrop.tsx 的 RN 对应物。
 * 结构逐字同源（web：白底 bg-white → constellation-bg.mp4 循环视频 @0.5×
 * object-cover →  white/70 白罩）。介质走 expo-video（与 AiSphere 同播放器）。
 * web 里这是 NOW 主页 + 所有菜单子页共享的壳背景；chat / card chat 各自盖自己的
 * 背景，不吃这层（RN 挂在 App.tsx 根，chat 两屏的 AuroraBackground 覆盖在上面）。
 */
import { useEffect } from "react";
import { Image, StyleSheet, View } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";

import { useFullCover } from "../lib/full-cover";
// __HEAT_PROBE__ 临时发热探针(排查完删)。
import { probeSet } from "../lib/heat-probe";
// __HEAT_AB__ 临时发热对照开关(定位完删)。
import { useHeatAbFlags } from "../lib/heat-ab";

const source = require("../assets/constellation-bg.mp4");

export default function VideoBackdrop() {
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true;
    // 视频恒 muted → 混音、不抢占 AVAudioSession。默认 auto 会在冷启播放器初始化时
    // 拿下音频会话、暂停用户正在放的音乐（2026-07-05 真机复测坐实，ambient 关也复现）。
    p.audioMixingMode = "mixWithOthers";
    p.playbackRate = 0.5; // web: el.playbackRate = 0.5（the subtle motion）
    p.play();
  });

  // 被 chat/card-chat 全屏盖住时暂停解码省电（WS6）；露出时立即恢复。盖住后延迟一拍
  // 再停,让上滑遮盖动画期间视频仍在播,避免露出冻结帧。
  const covered = useFullCover();
  // __HEAT_AB__ backdropVideo=false → 静态图变体,暂停视频解码。
  const { backdropVideo } = useHeatAbFlags();
  useEffect(() => {
    if (!covered && backdropVideo) {
      player.play();
      probeSet("video.backdrop", "playing"); // __HEAT_PROBE__
      return;
    }
    // covered 时延迟一拍等遮盖动画;__HEAT_AB__ 关视频时立即停。
    const timer = setTimeout(() => {
      player.pause();
      probeSet("video.backdrop", backdropVideo ? "paused" : "ab-static"); // __HEAT_PROBE__
    }, covered ? 350 : 0);
    return () => clearTimeout(timer);
  }, [covered, backdropVideo, player]);
  // __HEAT_PROBE__ 卸载写回(sign-out 时),gauge 不留旧值。
  useEffect(() => {
    return () => probeSet("video.backdrop", "unmounted");
  }, []);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* web: <div className="absolute inset-0 bg-white" /> 白底 */}
      <View style={[StyleSheet.absoluteFill, styles.base]} />
      {backdropVideo ? (
        /* web: <video object-cover loop muted playsInline playbackRate=0.5 /> */
        <VideoView
          player={player}
          nativeControls={false}
          contentFit="cover"
          style={StyleSheet.absoluteFill}
        />
      ) : (
        /* __HEAT_AB__ 静态图变体(每帧零 GPU 成本),对照视频解码+合成的开销。 */
        <Image
          source={require("../assets/bg-gradient.jpg")}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
      )}
      {/* 白罩,保可读性。dev web 是 bg-white/70;这里按 Mengli 偏好调淡到 45%,让星空
          视频更显（有意偏离 web parity,浓度待真机定档）。 */}
      <View style={[StyleSheet.absoluteFill, styles.veil]} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: { backgroundColor: "#ffffff" },
  veil: { backgroundColor: "rgba(255,255,255,0.45)" },
});
