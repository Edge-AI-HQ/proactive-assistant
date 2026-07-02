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

const source = require("../assets/sphere.mp4");

export default function AiSphere({
  size = 216,
  mode = "idle",
  active = true,
}: {
  size?: number;
  mode?: "idle" | "thinking";
  /** false = 所在聊天面已关闭 / 滑出屏外 → 暂停视频解码。 */
  active?: boolean;
}) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true;
  });
  player.playbackRate = mode === "thinking" ? 1.4 : 1;
  // 视频解码是持续 GPU/电力开销。web 现役离开 chat 会 unmount 视频自然停;RN 的
  // ChatSheet / CardChatScreen 常驻挂载(滑出屏外不卸载,保 SSE),所以必须显式
  // pause——否则关着的聊天里这个循环水晶球一直在后台解码发热。
  useEffect(() => {
    if (active) player.play();
    else player.pause();
  }, [active, player]);

  // web: inset 6% 的圆 + radial mask（black 50% → transparent 55%）。
  const inner = size * 0.88;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
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
        <VideoView
          player={player}
          nativeControls={false}
          contentFit="cover"
          style={[styles.video, { width: inner, height: inner }]}
        />
      </MaskedView>
    </View>
  );
}

const styles = StyleSheet.create({
  // multiply 去白底（web 同款）；scale 1.05 裁掉视频边缘。
  video: { mixBlendMode: "multiply", transform: [{ scale: 1.05 }] },
});
