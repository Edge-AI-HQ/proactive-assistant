/**
 * 顶栏 in-flight agent runs 徽章——web `components/common/AgentRunIndicator.tsx`
 * 的 RN 介质版。数据全部来自 @pin-ai/state useActiveAgentRuns（4s/30s 自适应
 * 轮询服务端），冷启/杀进程后回来即恢复（refresh-safe，web 同注释）。
 *
 * 显隐语义照 web：零 in-flight → 整体隐藏；单 run → "<kind>" + spinner +
 * elapsed；多 run → "N runs" + 点开下拉逐条列出；刚结束的（30s 服务端窗口内）
 * 短暂闪绿/红后随窗口关闭滚出。
 *
 * wiring（AppShell）：root View 里 MenuDrawerHost 之后挂 `<AgentRunIndicator />`
 * ——自带绝对定位（PageHeader 双圆钮左侧、垂直对中），ChatSheet/CardChatScreen
 * 等全屏 sheet 在其后渲染，天然盖住它（= web 全屏会话隐藏顶栏的语义）。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CheckCircle2, ChevronDown, Loader2, XCircle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useActiveAgentRuns } from "@pin-ai/state";
import type { ActiveAgentRun, AgentRunKind, AgentRunStatus } from "@pin-ai/core";

import i18n from "../../i18n";
// __HEAT_PROBE__ 临时发热探针(排查完删)。
import { probeCount } from "../../lib/heat-probe";
import { GlassCard } from "../../ui/GlassCard";

const FG = "29,33,48"; // --foreground ≈ rgb(29,33,48)

const KIND_LABEL_KEYS = {
  "auto.dreaming": "common:agentRuns.kind.autoDreaming",
  "connector.init": "common:agentRuns.kind.connectorInit",
  "connector.evolve": "common:agentRuns.kind.connectorEvolve",
  crystallize: "common:agentRuns.kind.crystallize",
  "generator.manual": "common:agentRuns.kind.generatorManual",
  "generator.auto": "common:agentRuns.kind.generatorAuto",
  "user.prompt": "common:agentRuns.kind.userPrompt",
} as const;

function isKnownRunKind(kind: AgentRunKind): kind is keyof typeof KIND_LABEL_KEYS {
  return kind in KIND_LABEL_KEYS;
}

function labelFor(kind: AgentRunKind): string {
  // Unknown kind (newer server): backend identifier renders raw（web 同注释）。
  return isKnownRunKind(kind) ? i18n.t(KIND_LABEL_KEYS[kind]) : kind;
}

/** 旋转（web Loader2 animate-spin 的 RN 对应物）。仅有 run 时挂载。 */
function Spin({ children }: { children: ReactNode }) {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(360, { duration: 800, easing: Easing.linear }), -1, false);
    return () => {
      cancelAnimation(r);
      r.value = 0;
    };
  }, [r]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function StatusIcon({ status }: { status: AgentRunStatus }) {
  if (status === "succeeded") return <CheckCircle2 size={12} color="#059669" />;
  if (status === "failed") return <XCircle size={12} color="#ef4444" />;
  return (
    <Spin>
      <Loader2 size={12} color={`rgba(${FG},0.55)`} />
    </Spin>
  );
}

function elapsed(run: ActiveAgentRun, now: number): string {
  const startIso = run.startedAt ?? run.createdAt;
  if (!startIso) return "";
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return "";
  const sec = Math.max(0, Math.floor((now - start) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export default function AgentRunIndicator() {
  const { t } = useTranslation("common");
  const { runs } = useActiveAgentRuns();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  // elapsed 每秒走字（web 同注释：一秒一 setState，便宜；无可见 run 时不跑）。
  useEffect(() => {
    if (runs.length === 0) return;
    const id = setInterval(() => {
      probeCount("agentRun.elapsedTick"); // __HEAT_PROBE__
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [runs.length]);

  if (runs.length === 0) return null;

  const inflight = runs.filter((r) => r.status === "queued" || r.status === "running");
  const finished = runs.filter((r) => r.status === "succeeded" || r.status === "failed");
  const primary = inflight[0] ?? finished[0];

  // Compact mode（web 同构）：1 run → run 摘要；>1 → 数量摘要。
  const summary =
    runs.length === 1
      ? labelFor(primary.kind)
      : t("agentRuns.runCount", { count: inflight.length || runs.length });

  const inflightCount = inflight.length;
  const summaryDetail =
    runs.length === 1 && primary.status !== "succeeded" && primary.status !== "failed"
      ? elapsed(primary, now)
      : null;

  return (
    <View style={styles.anchor} pointerEvents="box-none">
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={t("agentRuns.ariaLabel")}
      >
        <GlassCard radius={999}>
          <View style={styles.chipRow}>
            <StatusIcon status={primary.status} />
            <Text style={styles.chipText} numberOfLines={1}>
              {summary}
            </Text>
            {summaryDetail ? <Text style={styles.chipDetail}>{summaryDetail}</Text> : null}
            {runs.length > 1 ? (
              <ChevronDown
                size={12}
                color={`rgba(${FG},0.4)`}
                style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}
              />
            ) : null}
            {inflightCount > 0 && runs.length > 1 ? (
              <View style={styles.countPill}>
                <Text style={styles.countPillText}>{inflightCount}</Text>
              </View>
            ) : null}
          </View>
        </GlassCard>
      </Pressable>

      {open && runs.length > 0 ? (
        <GlassCard radius={16} style={styles.dropdown}>
          <View style={styles.dropdownInner}>
            <Text style={styles.dropdownTitle}>{t("agentRuns.title").toUpperCase()}</Text>
            <View style={styles.dropdownList}>
              {runs.map((r) => (
                <RunRow key={r.id} run={r} now={now} />
              ))}
            </View>
          </View>
        </GlassCard>
      ) : null}
    </View>
  );
}

function RunRow({ run, now }: { run: ActiveAgentRun; now: number }) {
  const isFinal = run.status === "succeeded" || run.status === "failed";
  return (
    <View
      style={[
        styles.runRow,
        run.status === "failed"
          ? styles.runRowFailed
          : run.status === "succeeded"
            ? styles.runRowSucceeded
            : styles.runRowActive,
      ]}
    >
      <StatusIcon status={run.status} />
      <View style={styles.flex1}>
        <Text style={styles.runLabel} numberOfLines={1}>
          {labelFor(run.kind)}
        </Text>
        <Text style={styles.runDetail} numberOfLines={1}>
          {isFinal ? run.status : elapsed(run, now)}
          {run.lastError ? ` · ${run.lastError.slice(0, 80)}` : ""}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // PageHeader（px-4 + 两个 40px 圆钮 gap-2）左侧：right = 16+40+8+40+8 = 112；
  // 圆钮带 pt-4 起于 y16、高 40，chip ~30 高 → top 21 垂直对中。
  anchor: {
    position: "absolute",
    top: 21,
    right: 112,
    zIndex: 30,
    alignItems: "flex-end",
  },
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  // web: text-caption(11) font-medium text-foreground/70 whitespace-nowrap
  chipText: { maxWidth: 160, fontSize: 11, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.7)` },
  chipDetail: { fontSize: 11, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.4)`, fontVariant: ["tabular-nums"] },
  countPill: { borderRadius: 999, backgroundColor: `rgba(${FG},0.1)`, paddingHorizontal: 6 },
  countPillText: { fontSize: 10, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.7)`, fontVariant: ["tabular-nums"] },
  // web: absolute right-0 top-[calc(100%+6px)] w-72 rounded-2xl p-2 shadow-lg
  dropdown: { marginTop: 6, width: 288 },
  dropdownInner: { padding: 8 },
  dropdownTitle: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.5,
    color: `rgba(${FG},0.45)`,
  },
  dropdownList: { gap: 4 },
  runRow: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 8 },
  runRowFailed: { backgroundColor: "rgba(254,242,242,0.6)" },
  runRowSucceeded: { backgroundColor: "rgba(236,253,245,0.6)" },
  runRowActive: { backgroundColor: "rgba(255,255,255,0.45)" },
  runLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.8)` },
  runDetail: { marginTop: 1, fontSize: 10, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.45)` },
  flex1: { flex: 1, minWidth: 0 },
});
