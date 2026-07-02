/**
 * LiveSessionCard —— dev components/ambient/LiveSessionCard.tsx 的 RN 移植版。
 * ambient 开且检测到实时会话时显示（转写流式进来）。视觉逐字对齐 dev：粉色玻璃卡 +
 * ping 圆点 + Focus/关闭钮 + 图标格 + signals chips + 最近 3 条 assist 淡入。
 * <div>→<View>、framer-motion→reanimated、lucide-react→lucide-react-native；文案走 i18n
 * （ns ambient，key 与 dev 一致）。
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { Expand, MapPin, Mic, Radio, X } from "lucide-react-native";

import type { LiveSession } from "../../ambient/live/live-session";
import { usePageActive } from "../app/KeepAlivePage";

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
// dev live 卡的粉色（hsl(304 75% L%)）。
const pink = (l: number, a?: number) =>
  a === undefined ? `hsl(304, 75%, ${l}%)` : `hsla(304, 75%, ${l}%, ${a})`;

interface LiveSessionCardProps {
  session: LiveSession | null;
  previewVisibleCount: number;
  variant: "ambient" | "now";
  alwaysVisible?: boolean;
  onFocus?: (session: LiveSession) => void;
  onDismiss?: () => void;
}

export default function LiveSessionCard({
  session,
  previewVisibleCount,
  variant,
  alwaysVisible = false,
  onFocus,
  onDismiss,
}: LiveSessionCardProps) {
  const { t } = useTranslation("ambient");
  if (!session && !alwaysVisible) return null;
  const isNow = variant === "now";
  const isIdle = !session;
  const title = session?.title ?? t("liveCard.standbyTitle");
  const kind = session?.kind ?? t("liveCard.standbyKind");
  const location = session?.location ?? t("liveCard.standbyLocation");
  const device = session?.device ?? t("liveCard.standbyDevice");
  const SessionIcon = session?.icon ?? Radio;

  const visibleAssists = session
    ? session.assists.slice(0, previewVisibleCount).slice(-3).reverse()
    : [];

  return (
    <Animated.View
      entering={FadeInDown.duration(400)}
      exiting={FadeOut.duration(300)}
      style={{
        // 与同屏其它卡统一用「上间距」——RN margin 不合并，若这里用 marginBottom 而邻卡用
        // marginTop，会 hero→live 贴死(0)、live→设备条翻倍(40)。改 marginTop 对齐 dev 的 20 节奏。
        marginTop: isNow ? 16 : 20,
        borderRadius: 16,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: isIdle ? "hsla(0, 0%, 100%, 0.46)" : pink(63, 0.3),
        boxShadow: isIdle ? undefined : `0 8px 32px ${pink(63, 0.15)}`,
      }}
    >
      {/* 背景渐变（active=粉,idle=玻璃白）*/}
      <LinearGradient
        colors={
          isIdle
            ? ["hsla(0, 0%, 100%, 0.42)", "hsla(0, 0%, 100%, 0.24)"]
            : [pink(63, 0.12), pink(63, 0.08)]
        }
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />

      {/* 头部条 */}
      <View
        style={{
          paddingHorizontal: 14,
          paddingVertical: 8,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottomWidth: 1,
          borderBottomColor: isIdle ? fg(0.08) : pink(63, 0.18),
          backgroundColor: isIdle ? fg(0.03) : pink(63, 0.06),
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
          <View style={{ width: 8, height: 8, alignItems: "center", justifyContent: "center" }}>
            {!isIdle ? <PingDot /> : null}
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: isIdle ? fg(0.35) : pink(63),
              }}
            />
          </View>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: "Inter_700Bold",
              fontSize: 10,
              letterSpacing: 1.6,
              textTransform: "uppercase",
              color: isIdle ? fg(0.5) : pink(42),
              flex: 1,
            }}
          >
            {t("live.label", { kind })}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {session && onFocus ? (
            <Pressable onPress={() => onFocus(session)} accessibilityRole="button" accessibilityLabel={t("liveCard.openFullscreenAria")}>
              <View
                style={{
                  height: 32,
                  paddingHorizontal: 12,
                  borderRadius: 16,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  backgroundColor: pink(63, 0.16),
                  borderWidth: 1,
                  borderColor: pink(63, 0.35),
                }}
              >
                <Expand size={14} strokeWidth={2.4} color={pink(32)} />
                <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: pink(32) }}>{t("liveCard.focus")}</Text>
              </View>
            </Pressable>
          ) : null}
          {!isNow && onDismiss ? (
            <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel={t("liveCard.endSessionAria")}>
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: fg(0.05),
                  borderWidth: 1,
                  borderColor: fg(0.1),
                }}
              >
                <X size={17} strokeWidth={2.2} color={fg(0.7)} />
              </View>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* 会话头（图标 + 标题 + 地点·设备）*/}
      <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8, flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: fg(0.06),
            borderWidth: 1,
            borderColor: fg(0.08),
          }}
        >
          <SessionIcon size={17} strokeWidth={1.8} color={fg()} />
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 18, color: fg() }}>
            {title}
          </Text>
          <View style={{ marginTop: 2, flexDirection: "row", alignItems: "center", gap: 4 }}>
            <MapPin size={10} color={fg(0.55)} />
            <Text numberOfLines={1} style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.55), flexShrink: 1 }}>
              {location}
            </Text>
            <Text style={{ fontSize: 11, color: fg(0.3) }}>·</Text>
            <Text numberOfLines={1} style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.55), flexShrink: 1 }}>
              {device}
            </Text>
          </View>
        </View>
      </View>

      {/* signals chips */}
      {session && session.signals.length > 0 ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {session.signals.slice(0, 5).map((signal) => (
            <View
              key={signal}
              style={{
                borderRadius: 999,
                backgroundColor: fg(0.05),
                borderWidth: 1,
                borderColor: fg(0.08),
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text style={{ fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: fg(0.6) }}>{signal}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* 最近 3 条 assist（新→旧，age 递减透明度）或空态 */}
      {session ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
          <View style={{ minHeight: 126, overflow: "hidden" }}>
            {visibleAssists.map((a, idx) => {
              const ageOpacity = idx === 0 ? 1 : idx === 1 ? 0.7 : 0.42;
              const isNewest = idx === 0;
              return (
                <Animated.View
                  key={a.time + a.text}
                  entering={FadeIn.duration(500)}
                  style={{ flexDirection: "row", gap: 10, paddingVertical: 4, opacity: ageOpacity }}
                >
                  <Text
                    style={{
                      fontFamily: "Inter_500Medium",
                      fontSize: 10,
                      lineHeight: 16,
                      width: 40,
                      color: isNewest ? pink(45) : fg(0.35),
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {a.time}
                  </Text>
                  <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
                    {a.kind === "action" ? (
                      <View style={{ marginRight: 6, borderRadius: 4, backgroundColor: pink(63), paddingHorizontal: 6, paddingVertical: 1 }}>
                        <Text style={{ fontFamily: "Inter_700Bold", fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", color: "#fff" }}>
                          {t("live.actionBadge")}
                        </Text>
                      </View>
                    ) : null}
                    <Text
                      style={{
                        fontFamily: a.kind === "action" ? "Inter_500Medium" : "Inter_400Regular",
                        fontSize: 12,
                        lineHeight: 16,
                        color: a.kind === "action" ? fg() : a.kind === "assist" ? fg(0.85) : fg(0.65),
                        flexShrink: 1,
                      }}
                    >
                      {a.text}
                    </Text>
                  </View>
                </Animated.View>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
          <View
            style={{
              borderRadius: 12,
              borderWidth: 1,
              borderStyle: "dashed",
              borderColor: fg(0.15),
              backgroundColor: fg(0.03),
              paddingHorizontal: 12,
              paddingVertical: 12,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Mic size={14} color={fg(0.45)} />
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 18, color: fg(0.55), flexShrink: 1 }}>
              {t("liveCard.empty")}
            </Text>
          </View>
        </View>
      )}
    </Animated.View>
  );
}

/** dev 头部 animate-ping 粉点（1s scale 1→2 + opacity 0.75→0）。
 *  页面隐藏时停帧（keep-alive 常驻后无限循环不能空跑）。 */
function PingDot() {
  const pageActive = usePageActive();
  const t = useSharedValue(0);
  useEffect(() => {
    if (!pageActive) return;
    t.value = withRepeat(withTiming(1, { duration: 1000, easing: Easing.out(Easing.ease) }), -1, false);
    return () => {
      cancelAnimation(t);
      t.value = 0;
    };
  }, [t, pageActive]);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + t.value }],
    opacity: 0.75 * (1 - t.value),
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: "absolute", width: 8, height: 8, borderRadius: 4, backgroundColor: pink(63) },
        style,
      ]}
    />
  );
}
