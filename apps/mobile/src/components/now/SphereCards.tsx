/**
 * 3D 球面卡片云——web Sphere3DCards 的 RN 对应物。数学完全同源
 * （fibonacci 球面分布 yMax=0.62 + yaw/pitch 旋转 + 椭球投影 +
 * depth→scale/opacity/亮度），渲染走 reanimated：yaw/pitch 是
 * SharedValue，useFrameCallback 驱动 idle 自转，每张卡的投影在
 * useAnimatedStyle worklet 内计算（UI 线程，零桥接）。
 * 状态系统照搬 web：6 态（normal/new/processing/needs_input/ready/
 * failed/done）→ 彩 ring + 右上徽章/spinner；category 图标行；
 * 深度阴影（前半球才有投影）；背面卡 pointerEvents 门控；
 * 姿态记忆（module 级 cache，切页回来不归零）。
 * 注：卡面不上 BlurView——14 张卡 × 每帧采样底图超性能红线（调研
 * §直通档），用 web 同款 depth 驱动的白底浓度替代。
 */
import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  BookOpen,
  Briefcase,
  Heart,
  Sparkles,
  Sprout,
  TrendingUp,
  type LucideIcon,
} from "lucide-react-native";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

const CARD_W = 160;
const CARD_H = 68;
const Y_MAX = 0.62;
const IDLE_VEL_YAW = 0.05; // 度/帧（web 同值）

/** web SphereCardStatus 同名。 */
export type SphereCardStatus =
  | "normal"
  | "new"
  | "processing"
  | "needs_input"
  | "ready"
  | "failed"
  | "done";

export interface SphereItem {
  id: string;
  title: string;
  /** lovable category key（growth/work/finance/health/learn/life）。 */
  category: string;
  status: SphereCardStatus;
}

/** web card-model CATEGORIES 同源（lucide 同名图标）。 */
export const CATEGORIES: Record<string, { icon: LucideIcon; label: string }> = {
  growth: { icon: Sprout, label: "Growth" },
  work: { icon: Briefcase, label: "Work" },
  finance: { icon: TrendingUp, label: "Finance" },
  health: { icon: Heart, label: "Health" },
  learn: { icon: BookOpen, label: "Learn" },
  life: { icon: Sparkles, label: "Life" },
};

/** web ringClass 色表（pink/amber/green/rose 400 系）。 */
const RING: Partial<Record<SphereCardStatus, string>> = {
  new: "rgba(244, 114, 182, 0.5)",
  needs_input: "rgba(251, 191, 36, 0.6)",
  ready: "rgba(74, 222, 128, 0.5)",
  done: "rgba(74, 222, 128, 0.5)",
  failed: "rgba(251, 113, 133, 0.5)",
};

const BADGE: Partial<Record<SphereCardStatus, { text: string; color: string }>> = {
  new: { text: "NEW", color: "#ec4899" },
  needs_input: { text: "INPUT", color: "#f59e0b" },
  ready: { text: "READY", color: "#22c55e" },
  done: { text: "DONE", color: "#22c55e" },
  failed: { text: "FAILED", color: "#f43f5e" },
};

/** 姿态记忆：unmount 时存 yaw/pitch，切页回来续转（web rotationCache 同构）。 */
const rotationCache = new Map<string, { yaw: number; pitch: number }>();

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

/** processing 态的旋转细环（web animate-spin border-t-transparent 对应物）。 */
function Spinner() {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(360, { duration: 800, easing: Easing.linear }), -1, false);
  }, [r]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return <Animated.View style={[styles.spinner, style]} />;
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
  const depthSV = useSharedValue(1);

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
    depthSV.value = depth;
    const scale = 0.6 + depth * 0.65;
    const frontBoost = Math.max(0, depth - 0.6) / 0.4;
    return {
      transform: [{ translateX: x - CARD_W / 2 }, { translateY: y - CARD_H / 2 }, { scale }],
      opacity: 0.32 + depth * 0.68,
      zIndex: Math.round(1000 + z),
      backgroundColor: `rgba(255,255,255,${(0.55 + frontBoost * 0.4).toFixed(2)})`,
      // web：z>0 才有深度投影（背面卡无影），0.2s transition 用插值平滑。
      shadowOpacity: 0.12 * Math.min(1, Math.max(0, (depth - 0.5) * 4)),
    };
  });

  // web：depth<0.25 的背面卡不可点。
  const tapGate = useAnimatedProps(() => ({
    pointerEvents: (depthSV.value < 0.25 ? "none" : "auto") as "none" | "auto",
  }));

  const cat = CATEGORIES[item.category] ?? CATEGORIES.life;
  const Icon = cat.icon;
  const ring = RING[item.status];
  const badge = BADGE[item.status];

  return (
    <Animated.View
      style={[styles.card, ring ? { borderWidth: 1, borderColor: ring } : null, style]}
      animatedProps={tapGate}
    >
      <Pressable
        onPress={() => onTap(item.id)}
        accessibilityRole="button"
        accessibilityLabel={item.title}
        style={styles.cardInner}
      >
        <View style={styles.cardTop}>
          <Icon size={12} strokeWidth={1.5} color="rgba(29,33,48,0.6)" />
          <Text style={styles.category} numberOfLines={1}>
            {cat.label.toUpperCase()}
          </Text>
          <View style={styles.spacerFlex} />
          {item.status === "processing" ? <Spinner /> : null}
          {badge ? <Text style={[styles.badge, { color: badge.color }]}>{badge.text}</Text> : null}
        </View>
        <Text style={styles.title} numberOfLines={3}>
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
  cacheKey = "now-sphere",
}: {
  items: SphereItem[];
  width: number;
  height: number;
  onTap: (id: string) => void;
  cacheKey?: string;
}) {
  const cached = rotationCache.get(cacheKey);
  const yaw = useSharedValue(cached?.yaw ?? 0);
  const pitch = useSharedValue(cached?.pitch ?? -10);
  const velYaw = useSharedValue(IDLE_VEL_YAW);
  const dragging = useSharedValue(false);

  // 姿态记忆：unmount 时把当前角度写回 cache（web rotationCache 同构）。
  useEffect(() => {
    return () => {
      rotationCache.set(cacheKey, { yaw: yaw.value, pitch: pitch.value });
    };
  }, [cacheKey, yaw, pitch]);

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
    minHeight: CARD_H,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.7)",
    shadowColor: "#000",
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 4 },
    // glass-card-strong 的 inset 顶高光（blur 因性能红线不上，见文件头）。
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4)",
  },
  cardInner: { flex: 1, paddingHorizontal: 10, paddingVertical: 8 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 },
  spacerFlex: { flex: 1 },
  category: {
    // web: text-[10px] font-semibold tracking-wide uppercase
    fontSize: 10,
    letterSpacing: 0.5,
    color: "rgba(29,33,48,0.6)",
    fontFamily: "Inter_600SemiBold",
    flexShrink: 1,
  },
  badge: {
    // web: text-[10px] font-bold uppercase tracking-wider
    fontSize: 10,
    letterSpacing: 0.8,
    fontFamily: "Inter_700Bold",
  },
  spinner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "#fbbf24",
    borderTopColor: "transparent",
  },
  title: {
    // web: text-[13px] font-medium leading-snug line-clamp-3
    fontSize: 13,
    lineHeight: 17,
    color: "#1d2130",
    fontFamily: "Inter_500Medium",
  },
});
