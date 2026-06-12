/**
 * 3D 球面卡片云——web Sphere3DCards 的 RN 对应物。数学完全同源
 * （fibonacci 球面分布 yMax=0.62 + yaw/pitch 旋转 + 椭球投影 +
 * depth→scale/opacity/亮度），渲染走 reanimated：yaw/pitch 是
 * SharedValue，useFrameCallback 驱动 idle 自转，每张卡的投影在
 * useAnimatedStyle worklet 内计算（UI 线程，零桥接）。
 */
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";

const CARD_W = 160;
const CARD_H = 68;
const Y_MAX = 0.62;
const IDLE_VEL_YAW = 0.05; // 度/帧（web 同值）

export interface SphereItem {
  id: string;
  title: string;
  categoryLabel: string;
  ready: boolean;
}

function fibonacciPoints(n: number) {
  const phi = Math.PI * (3 - Math.sqrt(5));
  const pts: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const y = (1 - t * 2) * Y_MAX;
    const r = Math.sqrt(1 - y * y);
    const theta = phi * i;
    pts.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return pts;
}

function Card({
  item,
  point,
  yaw,
  pitch,
  rx,
  ry,
  onTap,
}: {
  item: SphereItem;
  point: { x: number; y: number; z: number };
  yaw: SharedValue<number>;
  pitch: SharedValue<number>;
  rx: number;
  ry: number;
  onTap: (id: string) => void;
}) {
  const style = useAnimatedStyle(() => {
    // web computeCardStyle 的 worklet 版（数学同源）。
    const yawR = (yaw.value * Math.PI) / 180;
    const pitchR = (pitch.value * Math.PI) / 180;
    const cy = Math.cos(yawR);
    const sy = Math.sin(yawR);
    const x0 = point.x * cy + point.z * sy;
    const z0 = -point.x * sy + point.z * cy;
    const cp = Math.cos(pitchR);
    const sp = Math.sin(pitchR);
    const y1 = point.y * cp - z0 * sp;
    const z1 = point.y * sp + z0 * cp;
    const rDepth = Math.min(rx, ry);
    const x = x0 * rx;
    const y = y1 * ry;
    const z = z1 * rDepth;
    const depth = (z + rDepth) / (2 * rDepth);
    const scale = 0.6 + depth * 0.65;
    const frontBoost = Math.max(0, depth - 0.6) / 0.4;
    return {
      transform: [{ translateX: x - CARD_W / 2 }, { translateY: y - CARD_H / 2 }, { scale }],
      opacity: 0.32 + depth * 0.68,
      zIndex: Math.round(1000 + z),
      backgroundColor: `rgba(255,255,255,${(0.55 + frontBoost * 0.4).toFixed(2)})`,
    };
  });

  return (
    <Animated.View style={[styles.card, style]}>
      <Pressable onPress={() => onTap(item.id)} style={styles.cardInner}>
        <View style={styles.cardTop}>
          <Text style={styles.category} numberOfLines={1}>
            {item.categoryLabel.toUpperCase()}
          </Text>
          {item.ready ? <Text style={styles.ready}>READY</Text> : null}
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

export default function SphereCards({
  items,
  width,
  height,
  onTap,
}: {
  items: SphereItem[];
  width: number;
  height: number;
  onTap: (id: string) => void;
}) {
  const yaw = useSharedValue(0);
  const pitch = useSharedValue(-10);
  const velYaw = useSharedValue(IDLE_VEL_YAW);
  const dragging = useSharedValue(false);

  const points = useMemo(() => fibonacciPoints(items.length), [items.length]);

  // 自动旋转 + 惯性衰减回 idle 速度（web rAF loop 对应物）。
  useFrameCallback(() => {
    if (dragging.value) return;
    yaw.value += velYaw.value;
    velYaw.value += (IDLE_VEL_YAW - velYaw.value) * 0.02;
    pitch.value += (-10 - pitch.value) * 0.02;
  });

  const lastX = useSharedValue(0);
  const lastY = useSharedValue(0);
  const pan = Gesture.Pan()
    .onBegin(() => {
      dragging.value = true;
      lastX.value = 0;
      lastY.value = 0;
    })
    .onUpdate((e) => {
      const dx = e.translationX - lastX.value;
      const dy = e.translationY - lastY.value;
      lastX.value = e.translationX;
      lastY.value = e.translationY;
      yaw.value += dx * 0.35;
      pitch.value = Math.max(-40, Math.min(25, pitch.value - dy * 0.2));
    })
    .onEnd((e) => {
      velYaw.value = Math.max(-3, Math.min(3, e.velocityX * 0.006));
    })
    .onFinalize(() => {
      dragging.value = false;
    });

  // 椭球半径（web autoRx/autoRy 简化版：同样保证卡不出界）。
  const rx = Math.max(40, width / 2 - (CARD_W / 2) * 1.25 - 4);
  const ry = Math.max(40, (height / 2 - CARD_H / 2 - 6) / 0.75);

  return (
    <GestureDetector gesture={pan}>
      <View style={[styles.stage, { width, height }]}>
        <View style={[styles.center, { top: height * 0.42, left: width / 2 }]}>
          {items.map((item, i) => (
            <Card
              key={item.id}
              item={item}
              point={points[i]}
              yaw={yaw}
              pitch={pitch}
              rx={rx}
              ry={ry}
              onTap={onTap}
            />
          ))}
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  stage: { overflow: "hidden" },
  center: { position: "absolute", width: 0, height: 0 },
  card: {
    position: "absolute",
    width: CARD_W,
    height: CARD_H,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.7)",
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 4 },
  },
  cardInner: { flex: 1, paddingHorizontal: 10, paddingVertical: 7 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  category: {
    fontSize: 8.5,
    letterSpacing: 0.8,
    color: "#71717a",
    fontFamily: "Inter_600SemiBold",
    flexShrink: 1,
  },
  ready: { fontSize: 8.5, letterSpacing: 0.8, color: "#16a34a", fontFamily: "Inter_700Bold" },
  title: { marginTop: 3, fontSize: 11.5, lineHeight: 15, color: "#26262b", fontFamily: "Inter_500Medium" },
});
