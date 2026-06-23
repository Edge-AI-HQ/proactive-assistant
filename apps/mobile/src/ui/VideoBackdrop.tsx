/**
 * App 主壳背景——web components/app/VideoBackdrop.tsx 的 RN 对应物。
 * 结构逐字同源（web：白底 bg-white → constellation-bg.mp4 循环视频 @0.5×
 * object-cover →  white/70 白罩）。介质走 expo-video（与 AiSphere 同播放器）。
 * web 里这是 NOW 主页 + 所有菜单子页共享的壳背景；chat / card chat 各自盖自己的
 * 背景，不吃这层（RN 挂在 App.tsx 根，chat 两屏的 AuroraBackground 覆盖在上面）。
 */
import { StyleSheet, View } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";

const source = require("../assets/constellation-bg.mp4");

export default function VideoBackdrop() {
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true;
    p.playbackRate = 0.5; // web: el.playbackRate = 0.5（the subtle motion）
    p.play();
  });
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* web: <div className="absolute inset-0 bg-white" /> 白底 */}
      <View style={[StyleSheet.absoluteFill, styles.base]} />
      {/* web: <video object-cover loop muted playsInline playbackRate=0.5 /> */}
      <VideoView
        player={player}
        nativeControls={false}
        contentFit="cover"
        style={StyleSheet.absoluteFill}
      />
      {/* web: <div className="absolute inset-0 bg-white/70" /> 白罩，保可读性 */}
      <View style={[StyleSheet.absoluteFill, styles.veil]} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: { backgroundColor: "#ffffff" },
  veil: { backgroundColor: "rgba(255,255,255,0.7)" },
});
