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
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
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
// web autoRx/autoRy + 球心 同款常量（保证卡不出界、布局与 web 一致）。
const MAX_SCALE = 1.25;
const POLAR_SCALE = 0.83;
const Y_EXTENT = 0.75;
// 椭球 sizing 用的球心比例（web 原值 0.36）：此值让上半球卡片顶边贴到容器顶 ~32px、
// 椭球纵半径据此最大化不裁切。⚠️ 它和 ry 耦合——**别拿它当"位置"调**：f<0.5 时
// topSafe 恒为 min，单独调它只会把顶边钉死、向下拉伸，不会整体下移（踩过的坑）。
const SPHERE_CENTER_TOP = 0.36;
// 整体下移量（占容器高度比例）。⚠️ 这是"球星云高度"的**唯一真旋钮**：顶端包络
// screenY = H×SHIFT − 2，只随 SHIFT 变（SPHERE_CENTER_TOP 在位置和 ry 两处出现、
// 数学上互相抵消，调它对顶端零影响——别再动 CENTER_TOP）。0 = 贴顶；越大越低。
const SPHERE_SHIFT = 0.095;

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

/** 类目文案 i18n 键（web card-model CATEGORY_LABEL_KEYS 同源，card.json category.*）。 */
type CategoryLabelKey = `category.${"growth" | "work" | "finance" | "health" | "learn" | "life"}`;

/** web card-model CATEGORIES 同源（lucide 同名图标；label 走 i18n labelKey）。 */
export const CATEGORIES: Record<string, { icon: LucideIcon; labelKey: CategoryLabelKey }> = {
  growth: { icon: Sprout, labelKey: "category.growth" },
  work: { icon: Briefcase, labelKey: "category.work" },
  finance: { icon: TrendingUp, labelKey: "category.finance" },
  health: { icon: Heart, labelKey: "category.health" },
  learn: { icon: BookOpen, labelKey: "category.learn" },
  life: { icon: Sparkles, labelKey: "category.life" },
};

/** web ringClass 色表（pink/amber/green/rose 400 系）。 */
const RING: Partial<Record<SphereCardStatus, string>> = {
  new: "rgba(244, 114, 182, 0.5)",
  needs_input: "rgba(251, 191, 36, 0.6)",
  ready: "rgba(74, 222, 128, 0.5)",
  done: "rgba(74, 222, 128, 0.5)",
  failed: "rgba(251, 113, 133, 0.5)",
};

const BADGE: Partial<Record<SphereCardStatus, { labelKey: "badgeNew" | "badgeInput" | "badgeReady" | "badgeDone" | "badgeFailed"; color: string }>> = {
  new: { labelKey: "badgeNew", color: "#ec4899" },
  needs_input: { labelKey: "badgeInput", color: "#f59e0b" },
  ready: { labelKey: "badgeReady", color: "#22c55e" },
  done: { labelKey: "badgeDone", color: "#22c55e" },
  failed: { labelKey: "badgeFailed", color: "#f43f5e" },
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
  const { t } = useTranslation("card");
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
      // web 现役 Sphere3DCards 同款「二值」阴影(z>0 前半球有影 / 背面 none),
      // 不是每帧连续 ramp——连续 shadowOpacity 每帧触发 iOS 阴影重绘(14 卡 × 60fps)
      // 是真机发热源(见 Mengli 的 perf(now) f3294c1b:发热来自每帧重绘,非动画本身)。
      // 二值 → 卡片跨 z=0 才翻一下,近乎零逐帧重绘。
      shadowOpacity: z > 0 ? 0.12 : 0,
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
            {t(cat.labelKey).toUpperCase()}
          </Text>
          <View style={styles.spacerFlex} />
          {item.status === "processing" ? <Spinner /> : null}
          {badge ? <Text style={[styles.badge, { color: badge.color }]}>{t(`sphere.${badge.labelKey}`).toUpperCase()}</Text> : null}
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
  active = true,
  cacheKey = "now-sphere",
}: {
  items: SphereItem[];
  width: number;
  height: number;
  onTap: (id: string) => void;
  /** false = NOW 被 chat 盖住 / 切到别的页 → 停帧(NOW 常驻挂载,不停会空跑发热)。 */
  active?: boolean;
  cacheKey?: string;
}) {
  const cached = rotationCache.get(cacheKey);
  const yaw = useSharedValue(cached?.yaw ?? 0);
  // pitch 锁死 -10：web 拖动是 yaw-only、idle velPitch=0 → pitch 恒为初始 -10。
  // 不从 cache 恢复，避免旧缓存里的非 -10 值复活。
  const pitch = useSharedValue(-10);
  const velYaw = useSharedValue(IDLE_VEL_YAW);
  const dragging = useSharedValue(false);

  // 姿态记忆：unmount 时把当前角度写回 cache（web rotationCache 同构）。
  useEffect(() => {
    return () => {
      rotationCache.set(cacheKey, { yaw: yaw.value, pitch: pitch.value });
    };
  }, [cacheKey, yaw, pitch]);

  // id → 槽位「首见分配」（web Sphere3DCards:243-267 同构）：增删卡不整球重排。
  // 布点至少 12（少卡也铺开成星云）+ 4 个余量；新 id 找第一个空闲槽占住，
  // 已分配的 id 永远坐原槽。dev 同款不回收槽位（卡可能回来）。
  const pointsRef = useRef<{ x: number; y: number; z: number }[]>([]);
  const idToPointIdx = useRef<Map<string, number>>(new Map());
  const ensurePoints = (count: number) => {
    if (pointsRef.current.length < count) {
      pointsRef.current = fibonacciPoints(Math.max(count, 12));
    }
  };
  ensurePoints(items.length + 4);
  const assignedSlots = new Set(idToPointIdx.current.values());
  items.forEach((item) => {
    if (!idToPointIdx.current.has(item.id)) {
      // find first unused point index（web 同注释）
      for (let i = 0; i < pointsRef.current.length; i++) {
        if (!assignedSlots.has(i)) {
          idToPointIdx.current.set(item.id, i);
          assignedSlots.add(i);
          break;
        }
      }
    }
  });

  // 自转 + 惯性衰减回 idle 速度（web rAF idle 回路同款：衰减系数 0.015）。
  // pitch 锁死，不再缓动。帧回调直接写 SharedValue（UI 线程，不过 React），
  // 对齐 web 现役 Sphere3DCards 的「直接写、不 setState」思路。
  // ⚠️ NOW 屏在 AppShell 里常驻挂载（display:none 切换、不卸载）——若不门控，
  // 切到别的页 / 被 chat 盖住时这个 60fps 回路仍空跑发热。active=false 时
  // setActive(false) 彻底停帧；yaw/velYaw 是 SharedValue，恢复时从原值续转。
  const frame = useFrameCallback(() => {
    if (dragging.value) return;
    yaw.value += velYaw.value;
    velYaw.value += (IDLE_VEL_YAW - velYaw.value) * 0.015;
  }, false);
  useEffect(() => {
    frame.setActive(active);
  }, [active, frame]);

  const lastX = useSharedValue(0);
  const pan = Gesture.Pan()
    // 右缘 28px 让给全局抽屉左滑（负 hitSlop 收缩手势响应区；只影响本 pan
    // 的起手判定，卡片本身的点按不受影响）。
    .hitSlop({ right: -28 })
    .onBegin(() => {
      dragging.value = true;
      lastX.value = 0;
      velYaw.value = 0; // 抓住即停（web onPointerDown 同款）
    })
    .onUpdate((e) => {
      // web onPointerMove：仅转 yaw（pitch 锁死，防卡片越界）；灵敏度 0.3；
      // 速度按 web 累积式 velYaw*0.7 + dx*0.09，松手由它带出甩动惯性。
      const dx = e.translationX - lastX.value;
      lastX.value = e.translationX;
      yaw.value += dx * 0.3;
      velYaw.value = velYaw.value * 0.7 + dx * 0.09;
    })
    .onFinalize(() => {
      // 不重置 velYaw：累积值 → 甩动惯性 → idle 回路衰减回 IDLE_VEL_YAW。
      dragging.value = false;
    });

  // 椭球半径 = web autoRx/autoRy 原式：横向预留 maxScale 卡半宽；纵向取
  // min(居中, 顶安全, 底安全)/yExtent——球心在 36% 处顶部余量更小，纵向据此收窄，
  // 上半球卡片才不会被 overflow 裁掉。
  const halfW = (CARD_W / 2) * MAX_SCALE;
  const halfH = (CARD_H / 2) * POLAR_SCALE;
  const rx = Math.max(40, width / 2 - halfW - 4);
  const verticalMargin = halfH + 4;
  const centeredRy = height / 2 - halfH - 2;
  const topSafeRy = height * SPHERE_CENTER_TOP - verticalMargin;
  const bottomSafeRy = height * (1 - SPHERE_CENTER_TOP) - verticalMargin;
  const ry =
    height > 0 ? Math.max(1, Math.min(centeredRy, topSafeRy, bottomSafeRy) / Y_EXTENT) : 40;

  return (
    <GestureDetector gesture={pan}>
      <View style={[styles.stage, { width, height }]}>
        <View style={[styles.center, { top: height * (SPHERE_CENTER_TOP + SPHERE_SHIFT), left: width / 2 }]}>
          {items.map((item) => {
            const idx = idToPointIdx.current.get(item.id);
            const point = idx === undefined ? undefined : pointsRef.current[idx];
            // 槽位耗尽的极端情形（web rAF 循环同款 `if (!p) continue`）：不渲染。
            if (!point) return null;
            return (
              <Card
                key={item.id}
                item={item}
                point={point}
                yaw={yaw}
                pitch={pitch}
                rx={rx}
                ry={ry}
                onTap={onTap}
              />
            );
          })}
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
