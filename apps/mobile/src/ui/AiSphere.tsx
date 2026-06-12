/**
 * AI 水晶球——web AiSphere（sphere.webm + mix-blend multiply + 径向
 * mask 羽化）的 RN 介质版。资产转 H.264 mp4（iOS 不解码 VP9），
 * expo-video 循环播放；multiply 走 RN 0.77+ mixBlendMode；圆形羽化
 * mask 用 svg RadialGradient（black 50% → transparent 55%，web 同参）。
 * thinking 态 playbackRate 1.4（web 同值）。
 */
import { StyleSheet, View } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import { VideoView, useVideoPlayer } from "expo-video";

const source = require("../assets/sphere.mp4");

export default function AiSphere({
  size = 216,
  mode = "idle",
}: {
  size?: number;
  mode?: "idle" | "thinking";
}) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  player.playbackRate = mode === "thinking" ? 1.4 : 1;

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
