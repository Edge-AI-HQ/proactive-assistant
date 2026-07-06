/**
 * AI 水晶球——web AiSphere（sphere.webm + mix-blend multiply + 径向
 * mask 羽化）的 RN 介质版。资产转 H.264 mp4（iOS 不解码 VP9），
 * expo-video 循环播放；multiply 走 RN 0.77+ mixBlendMode；圆形羽化
 * mask 用 svg RadialGradient（black 50% → transparent 55%，web 同参）。
 * thinking 态 playbackRate 1.4（web 同值）。
 */
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import { VideoView, useVideoPlayer } from "expo-video";

// __HEAT_PROBE__ 临时发热探针(排查完删)。
import { probeSet } from "../lib/heat-probe";
// __HEAT_AB__ 临时发热对照开关(定位完删)。
import { useHeatAbFlags } from "../lib/heat-ab";

const source = require("../assets/sphere.mp4");

export default function AiSphere({
  size = 216,
  mode = "idle",
  active = true,
  probeKey = "main",
}: {
  size?: number;
  mode?: "idle" | "thinking";
  /** false = 所在聊天面已关闭 / 滑出屏外 → 暂停视频解码。 */
  active?: boolean;
  /** __HEAT_PROBE__ 双实例(main/card chat)区分探针 key,排查完随探针删。 */
  probeKey?: string;
}) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true;
    // 视频恒 muted → 混音、不抢占 AVAudioSession（默认 auto 会在冷启播放器初始化时
    // 夺会话暂停用户音乐；与 VideoBackdrop 同修）。
    p.audioMixingMode = "mixWithOthers";
  });
  player.playbackRate = mode === "thinking" ? 1.4 : 1;
  // 视频解码是持续 GPU/电力开销。web 现役离开 chat 会 unmount 视频自然停;RN 的
  // ChatSheet / CardChatScreen 常驻挂载(滑出屏外不卸载,保 SSE),所以必须显式
  // pause——否则关着的聊天里这个循环水晶球一直在后台解码发热。
  useEffect(() => {
    if (active) player.play();
    else player.pause();
    probeSet(`video.sphere.${probeKey}`, active ? "playing" : "paused"); // __HEAT_PROBE__
  }, [active, player, probeKey]);
  // __HEAT_PROBE__ 卸载写回:条件挂载(首条消息后卸载)时 player 已释放,gauge 不能留旧值。
  useEffect(() => {
    return () => probeSet(`video.sphere.${probeKey}`, "unmounted");
  }, [probeKey]);

  // web: inset 6% 的圆 + radial mask（black 50% → transparent 55%）。
  const inner = size * 0.88;
  // __HEAT_AB__ 两个渲染变体开关,隔离 GPU 大头(混合 / 遮罩各自的离屏合成)。
  const { sphereBlend, sphereMask } = useHeatAbFlags();
  const videoNode = (
    <VideoView
      player={player}
      nativeControls={false}
      contentFit="cover"
      style={[styles.video, { width: inner, height: inner }, sphereBlend ? null : styles.noBlend]}
    />
  );
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {sphereMask ? (
        <MaskedView
          style={{ width: inner, height: inner }}
          maskElement={
            <Svg width={inner} height={inner}>
              <Defs>
                <RadialGradient id="feather" cx="50%" cy="50%" r="50%">
                  <Stop offset="90%" stopColor="#000" stopOpacity={1} />
                  <Stop offset="100%" stopColor="#000" stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Circle cx={inner / 2} cy={inner / 2} r={inner / 2} fill="url(#feather)" />
            </Svg>
          }
        >
          {videoNode}
        </MaskedView>
      ) : (
        /* __HEAT_AB__ 硬边圆变体(borderRadius+overflow,无离屏遮罩),对照 MaskedView 开销。 */
        <View style={{ width: inner, height: inner, borderRadius: inner / 2, overflow: "hidden" }}>
          {videoNode}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // multiply 去白底（web 同款）；scale 1.05 裁掉视频边缘。
  video: { mixBlendMode: "multiply", transform: [{ scale: 1.05 }] },
  // __HEAT_AB__ sphereBlend=false 覆盖成 normal(去混合)。
  noBlend: { mixBlendMode: "normal" },
});
