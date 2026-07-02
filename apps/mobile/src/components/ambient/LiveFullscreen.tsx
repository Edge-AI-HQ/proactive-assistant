/**
 * LiveFullscreen —— dev AmbientView 里 LiveFullscreen overlay 的 RN 移植版。
 * 全屏深色 + 粉晕 + 顶栏(Live·kind / 计时 / Exit) + 会话头 + signals 横滑 +
 * REAL-TIME ASSIST 流(新消息在底、跟随底部、上滑露出「N new」回到最新) + 底部 hint。
 * <div>→RN Modal/ScrollView、framer→reanimated、lucide-react→lucide-react-native；文案走 i18n
 * （ns ambient，key 与 dev 一致）。
 * 注:dev 的径向粉晕用 CSS radial-gradient，RN 无原生 radial → 用顶部→透明的 LinearGradient 近似。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { ChevronDown, Lightbulb, MapPin, Mic, Minimize2, Sparkles } from "lucide-react-native";

import type { LiveSession } from "../../ambient/live/live-session";

const DARK = "hsl(0, 0%, 4%)";
const white = (a: number) => `hsla(0, 0%, 100%, ${a})`;
const pink = (l: number, a?: number) =>
  a === undefined ? `hsl(304, 75%, ${l}%)` : `hsla(304, 75%, ${l}%, ${a})`;

function fmt(totalSeconds: number): string {
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export default function LiveFullscreen({
  session,
  onClose,
}: {
  session: LiveSession;
  onClose: () => void;
}) {
  const { t } = useTranslation("ambient");
  const insets = useSafeAreaInsets();
  const [elapsed, setElapsed] = useState(0);
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const followingRef = useRef(true);
  const prevCount = useRef(session.assists.length);
  const SessionIcon = session.icon;

  useEffect(() => {
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const scrollToBottom = useCallback((animated = true) => {
    scrollRef.current?.scrollToEnd({ animated });
    followingRef.current = true;
    setFollowing(true);
    setUnseen(0);
  }, []);

  // 新 assist 进来：跟随中就贴底，否则累加未读。
  useEffect(() => {
    const added = session.assists.length - prevCount.current;
    prevCount.current = session.assists.length;
    if (added <= 0) return;
    if (followingRef.current) {
      requestAnimationFrame(() => scrollToBottom(true));
    } else {
      setUnseen((c) => c + added);
    }
  }, [session.assists.length, scrollToBottom]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const atBottom = contentSize.height - contentOffset.y - layoutMeasurement.height <= 64;
    followingRef.current = atBottom;
    setFollowing(atBottom);
    if (atBottom) setUnseen(0);
  }, []);

  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: DARK }}>
        {/* 顶部粉晕（近似 dev radial）*/}
        <LinearGradient
          pointerEvents="none"
          colors={[pink(50, 0.22), pink(50, 0.06), "transparent"]}
          style={{ position: "absolute", top: 0, left: 0, right: 0, height: 260 }}
        />

        {/* 顶栏 */}
        <View
          style={{
            paddingTop: insets.top + 14,
            paddingBottom: 14,
            paddingHorizontal: 20,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottomWidth: 1,
            borderBottomColor: white(0.08),
            backgroundColor: "hsla(0, 0%, 4%, 0.85)",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: pink(70) }} />
            <Text
              numberOfLines={1}
              style={{ fontFamily: "Inter_700Bold", fontSize: 11, letterSpacing: 2.4, textTransform: "uppercase", color: pink(78), flexShrink: 1 }}
            >
              {t("live.label", { kind: session.kind })}
            </Text>
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, color: white(0.55), fontVariant: ["tabular-nums"] }}>
              {fmt(elapsed)}
            </Text>
          </View>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t("live.exitFullscreenAria")}>
            <View
              style={{
                height: 36,
                paddingHorizontal: 14,
                borderRadius: 18,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                backgroundColor: white(0.06),
                borderWidth: 1,
                borderColor: white(0.08),
              }}
            >
              <Minimize2 size={14} strokeWidth={2.2} color={white(0.85)} />
              <Text style={{ fontFamily: "Inter_500Medium", fontSize: 13, color: white(0.85) }}>{t("live.exit")}</Text>
            </View>
          </Pressable>
        </View>

        {/* 会话头 */}
        <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: white(0.06),
                borderWidth: 1,
                borderColor: white(0.08),
              }}
            >
              <SessionIcon size={16} strokeWidth={1.8} color={white(0.85)} />
            </View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ fontFamily: "Inter_600SemiBold", fontSize: 15, lineHeight: 20, color: white(0.96) }}>
                {session.title}
              </Text>
              <View style={{ marginTop: 2, flexDirection: "row", alignItems: "center", gap: 4 }}>
                <MapPin size={10} color={white(0.5)} />
                <Text numberOfLines={1} style={{ fontFamily: "Inter_400Regular", fontSize: 11, color: white(0.5), flexShrink: 1 }}>
                  {session.location}
                </Text>
                <Text style={{ fontSize: 11, color: white(0.3) }}>·</Text>
                <Text numberOfLines={1} style={{ fontFamily: "Inter_400Regular", fontSize: 11, color: white(0.5), flexShrink: 1 }}>
                  {session.device}
                </Text>
              </View>
            </View>
          </View>

          {/* signals 横滑 */}
          {session.signals.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginTop: 10 }}
              contentContainerStyle={{ gap: 6 }}
            >
              {session.signals.map((s) => (
                <View
                  key={s}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    borderRadius: 999,
                    backgroundColor: white(0.05),
                    borderWidth: 1,
                    borderColor: white(0.06),
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                  }}
                >
                  <Mic size={9} strokeWidth={2} color={white(0.65)} />
                  <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, color: white(0.65) }}>{s}</Text>
                </View>
              ))}
            </ScrollView>
          ) : null}
        </View>

        {/* REAL-TIME ASSIST 分隔 */}
        <View
          style={{
            marginHorizontal: 20,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingVertical: 10,
            borderTopWidth: 1,
            borderBottomWidth: 1,
            borderColor: white(0.06),
          }}
        >
          <Sparkles size={11} color={pink(75)} />
          <Text style={{ fontFamily: "Inter_700Bold", fontSize: 10, letterSpacing: 2.2, textTransform: "uppercase", color: pink(75) }}>
            {t("live.realTimeAssist")}
          </Text>
          <Text style={{ marginLeft: "auto", fontFamily: "Inter_400Regular", fontSize: 10, color: white(0.4), fontVariant: ["tabular-nums"] }}>
            {session.assists.length}
          </Text>
        </View>

        {/* assist 流 */}
        <View style={{ flex: 1 }}>
          <ScrollView
            ref={scrollRef}
            onScroll={onScroll}
            scrollEventThrottle={16}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24, gap: 16 }}
            onContentSizeChange={() => {
              if (followingRef.current) scrollRef.current?.scrollToEnd({ animated: false });
            }}
          >
            {session.assists.map((a, idx) => {
              const isNewest = idx === session.assists.length - 1;
              return (
                <Animated.View key={a.time + a.text} entering={FadeIn.duration(450)} style={{ flexDirection: "row", gap: 12 }}>
                  <Text
                    style={{
                      fontFamily: "Inter_500Medium",
                      fontSize: 11,
                      lineHeight: 22,
                      width: 44,
                      color: isNewest ? pink(70) : white(0.3),
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {a.time}
                  </Text>
                  <View style={{ flex: 1 }}>
                    {a.kind === "action" ? (
                      <View style={{ alignSelf: "flex-start", marginBottom: 6, borderRadius: 4, backgroundColor: pink(63), paddingHorizontal: 6, paddingVertical: 1 }}>
                        <Text style={{ fontFamily: "Inter_700Bold", fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
                          {t("live.actionBadge")}
                        </Text>
                      </View>
                    ) : null}
                    <Text
                      style={{
                        fontFamily: a.kind === "action" ? "Inter_500Medium" : "Inter_400Regular",
                        fontSize: a.kind === "context" ? 15 : 17,
                        lineHeight: a.kind === "context" ? 21 : 24,
                        color: a.kind === "action" ? white(1) : a.kind === "assist" ? white(0.9) : white(0.75),
                      }}
                    >
                      {a.text}
                    </Text>
                    {a.source ? (
                      <Text style={{ marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 11, color: white(0.4) }}>
                        {t("live.viaSource", { source: a.source })}
                      </Text>
                    ) : null}
                  </View>
                </Animated.View>
              );
            })}
          </ScrollView>

          {/* 回到最新 */}
          {!following && unseen > 0 ? (
            <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 16, alignItems: "center" }}>
              <Pressable onPress={() => scrollToBottom(true)} accessibilityRole="button">
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: pink(70, 0.35),
                    backgroundColor: "hsla(0, 0%, 4%, 0.88)",
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                  }}
                >
                  <ChevronDown size={14} strokeWidth={2.2} color={pink(82)} />
                  <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, color: pink(82) }}>{t("live.newCount", { count: unseen })}</Text>
                </View>
              </Pressable>
            </View>
          ) : null}
        </View>

        {/* 底部 hint */}
        <View
          style={{
            paddingHorizontal: 24,
            paddingTop: 14,
            paddingBottom: insets.bottom + 14,
            borderTopWidth: 1,
            borderTopColor: white(0.06),
            backgroundColor: "hsla(0, 0%, 0%, 0.4)",
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Lightbulb size={11} color={white(0.45)} />
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, color: white(0.45) }}>
            {t("live.footerHint")}
          </Text>
        </View>
      </View>
    </Modal>
  );
}
