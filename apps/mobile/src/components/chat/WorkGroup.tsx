/**
 * 工具调用工作组——web ui-web/chat/conversation/WorkGroup + WorkGroupNodes +
 * TaskCard 的 RN 介质版。一段连续的 推理 / 工具 / 子代理任务 折叠进一条玻璃栏：
 * 流式时展开 + spinner + 当前动作，结束后自动收起、显示 LLM 标题或
 * 「Used N tools / Ran N subtasks / Thought」兜底。分组逻辑（segmentAssistantParts /
 * toolStatus / taskDescription / WorkGroupData）100% 复用 @pin-ai/core，本文件只
 * 渲染。web blur(20) saturate(1.3) → RN expo-blur + 白覆盖；framer cubic ease 的
 * 折叠 → RN LayoutAnimation。web 的 web-search favicon LinksList + 工具输出展开为
 * 后续细化项（先显示动词 + args 预览）。
 */
import { useEffect, useRef, useState } from "react";
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { AlertCircle, Check, ChevronDown, Clock, Loader2 } from "lucide-react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import {
  taskDescription,
  toolStatus,
  type ToolCallPart,
  type WorkGroupData,
} from "@pin-ai/core";

import { resolveToolPresentation } from "./tool-presentation";

const FG = "29,33,48";
/** web running StatusDot 的品红 hsl(304 75% 50%) ≈ rgb(199,32,199)。 */
const MAGENTA = "rgb(199,32,199)";

function easeNext() {
  LayoutAnimation.configureNext(LayoutAnimation.create(220, "easeInEaseOut", "opacity"));
}

/** Loader2 旋转（web animate-spin 的 RN 对应物）。 */
function Spin({ size, color }: { size: number; color: string }) {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(360, { duration: 800, easing: Easing.linear }), -1, false);
  }, [r]);
  const st = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return (
    <Animated.View style={st}>
      <Loader2 size={size} color={color} strokeWidth={2.2} />
    </Animated.View>
  );
}

/** 工具状态点（web StatusDot）：running 品红 spinner / ok 翠绿 ✓ / error 红 ✗。 */
function StatusDot({ status }: { status: "running" | "ok" | "error" }) {
  if (status === "running") return <Spin size={11} color={MAGENTA} />;
  if (status === "error") return <AlertCircle size={11} color="#ef4444" strokeWidth={2.4} />;
  return <Check size={11} color="#059669" strokeWidth={2.5} />;
}

/** 单工具行（web ToolNodeRow）：状态点 + 动作动词 + args 预览。 */
function ToolNodeRow({ part, nested }: { part: ToolCallPart; nested?: boolean }) {
  const { verb } = resolveToolPresentation(part.toolName);
  return (
    <View style={[styles.toolRow, nested && styles.nestedRow]}>
      <View style={styles.dot}>
        <StatusDot status={toolStatus(part)} />
      </View>
      <Text style={styles.verb} numberOfLines={1}>
        {verb}
      </Text>
      {part.argsText ? (
        <Text style={styles.preview} numberOfLines={1}>
          {part.argsText}
        </Text>
      ) : null}
    </View>
  );
}

/** 推理节点（web ThinkingNode）：Clock + 斜体首行；流式显示尾窗，结束点开看全文。 */
function ThinkingNode({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (streaming) {
    return (
      <View style={styles.thinkRow}>
        <Clock size={11} color={`rgba(${FG},0.35)`} style={styles.thinkIcon} />
        <Text style={styles.thinkText} numberOfLines={2}>
          {text.slice(-220)}
        </Text>
      </View>
    );
  }
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "Thought";
  return (
    <View>
      <Pressable
        onPress={() => {
          easeNext();
          setExpanded((v) => !v);
        }}
        style={styles.thinkRow}
        accessibilityRole="button"
      >
        <Clock size={11} color={`rgba(${FG},0.35)`} style={styles.thinkIcon} />
        <Text style={styles.thinkText} numberOfLines={1}>
          {firstLine}
        </Text>
        <ChevronDown size={12} color={`rgba(${FG},0.3)`} style={expanded ? styles.chevUp : undefined} />
      </Pressable>
      {expanded ? <Text style={styles.thinkFull}>{text}</Text> : null}
    </View>
  );
}

/** 子代理任务卡（web TaskCard）：任务描述 + agent 标签 + 嵌套子工具行（可展开）。 */
function TaskCard({ part, subParts }: { part: ToolCallPart; subParts: ToolCallPart[] }) {
  const [expanded, setExpanded] = useState(false);
  const desc = taskDescription(part) || part.agentName || "Subtask";
  const canExpand = subParts.length > 0;
  return (
    <View style={styles.taskCard}>
      <Pressable
        onPress={() => {
          if (!canExpand) return;
          easeNext();
          setExpanded((v) => !v);
        }}
        style={styles.taskHeader}
        accessibilityRole="button"
        disabled={!canExpand}
      >
        <View style={styles.dot}>
          <StatusDot status={toolStatus(part)} />
        </View>
        <Text style={styles.taskTitle} numberOfLines={1}>
          {desc}
        </Text>
        {part.agentName ? <Text style={styles.taskAgent}>{part.agentName}</Text> : null}
        {canExpand ? (
          <ChevronDown size={12} color={`rgba(${FG},0.3)`} style={expanded ? styles.chevUp : undefined} />
        ) : null}
      </Pressable>
      {expanded && canExpand ? (
        <View style={styles.taskChildren}>
          {subParts.map((c) => (
            <ToolNodeRow key={c.toolCallId} part={c} nested />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** 工作组标签：流式→最近 running 工具/任务的动词；结束→LLM 标题 ?? 兜底计数。 */
function groupLabel(group: WorkGroupData): string {
  if (group.hasRunning) {
    for (let i = group.items.length - 1; i >= 0; i--) {
      const it = group.items[i];
      if (it.kind === "tool" && toolStatus(it.part) === "running") {
        return resolveToolPresentation(it.part.toolName).verb;
      }
      if (it.kind === "task" && toolStatus(it.part) === "running") {
        return taskDescription(it.part) || "Working…";
      }
    }
    return "Working…";
  }
  if (group.title) return group.title;
  const tasks = group.items.filter((i) => i.kind === "task").length;
  if (tasks > 0) return `Ran ${tasks} subtask${tasks === 1 ? "" : "s"}`;
  if (group.toolCount > 0) return `Used ${group.toolCount} tool${group.toolCount === 1 ? "" : "s"}`;
  return "Thought";
}

export default function WorkGroup({
  group,
  streamingTail,
}: {
  group: WorkGroupData;
  /** 该组所属 assistant turn 仍在流式（最后一个 turn）。 */
  streamingTail: boolean;
}) {
  const live = group.hasRunning && streamingTail;
  const [expanded, setExpanded] = useState(live);
  // 流式结束（不再 running）→ 自动收起（web：文本到达后 auto-collapse）。
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !group.hasRunning) {
      easeNext();
      setExpanded(false);
    }
    wasLive.current = group.hasRunning;
  }, [group.hasRunning]);

  return (
    <View style={styles.group}>
      <BlurView intensity={24} tint="light" style={[StyleSheet.absoluteFill, styles.blurRound]} />
      <View style={[StyleSheet.absoluteFill, styles.groupTint]} />
      <Pressable
        onPress={() => {
          easeNext();
          setExpanded((v) => !v);
        }}
        style={styles.groupHeader}
        accessibilityRole="button"
      >
        <View style={styles.dot}>
          {live ? (
            <Spin size={11} color={`rgba(${FG},0.45)`} />
          ) : group.hasError ? (
            <AlertCircle size={11} color="#ef4444" strokeWidth={2.4} />
          ) : (
            <Check size={11} color={`rgba(${FG},0.45)`} strokeWidth={2.5} />
          )}
        </View>
        <Text style={[styles.groupLabelText, !live && styles.groupLabelDone]} numberOfLines={1}>
          {groupLabel(group)}
        </Text>
        {!live && group.toolCount > 0 ? (
          <Text style={styles.stepCount}>
            {group.toolCount} STEP{group.toolCount === 1 ? "" : "S"}
          </Text>
        ) : null}
        <ChevronDown size={13} color={`rgba(${FG},0.35)`} style={expanded ? styles.chevUp : undefined} />
      </Pressable>
      {expanded ? (
        <View style={styles.groupBody}>
          {group.items.map((item, i) => {
            if (item.kind === "reasoning") {
              return <ThinkingNode key={`r-${i}`} text={item.text} streaming={live} />;
            }
            if (item.kind === "task") {
              return <TaskCard key={item.part.toolCallId} part={item.part} subParts={item.children} />;
            }
            return <ToolNodeRow key={item.part.toolCallId} part={item.part} />;
          })}
        </View>
      ) : null}
    </View>
  );
}

/** propose_action / notify_user 段——AI 面向用户的卡（暂停征询 / 通知）。完整富
 *  交互（选项 chips / 回复）是 ② 流式刀的 ProposeActionCard；此处先稳妥显示动词 +
 *  预览，避免段消失。 */
export function SpecialCard({ part }: { part: ToolCallPart }) {
  const { verb } = resolveToolPresentation(part.toolName);
  return (
    <View style={styles.special}>
      <Text style={styles.specialLabel}>{verb}</Text>
      {part.argsText ? <Text style={styles.specialBody}>{part.argsText}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    marginTop: 4,
    marginBottom: 12,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: `rgba(${FG},0.1)`,
  },
  // expo-blur iOS 不跟随父级 overflow 裁圆角，borderRadius 直接给 BlurView + tint。
  groupTint: { backgroundColor: "rgba(255,255,255,0.4)", borderRadius: 16 },
  blurRound: { borderRadius: 16 },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 8 },
  groupLabelText: { flex: 1, fontSize: 13, color: `rgba(${FG},0.6)`, fontFamily: "Inter_400Regular" },
  groupLabelDone: { fontFamily: "Inter_500Medium" },
  stepCount: { fontSize: 10, letterSpacing: 1.2, color: `rgba(${FG},0.35)`, fontFamily: "Inter_500Medium" },
  groupBody: { marginLeft: 18, borderLeftWidth: 1, borderLeftColor: `rgba(${FG},0.08)`, paddingLeft: 12, paddingRight: 12, paddingBottom: 10, paddingTop: 2, gap: 4 },
  dot: { width: 16, alignItems: "center", justifyContent: "center" },
  toolRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 },
  nestedRow: { marginLeft: 8 },
  verb: { fontSize: 13, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.8)`, flexShrink: 0 },
  preview: { flex: 1, fontSize: 12, color: `rgba(${FG},0.4)`, fontFamily: "Inter_400Regular" },
  thinkRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  thinkIcon: { marginTop: 1 },
  thinkText: { flex: 1, fontSize: 12, fontStyle: "italic", color: `rgba(${FG},0.45)`, fontFamily: "Inter_400Regular", lineHeight: 17 },
  thinkFull: { paddingLeft: 19, paddingBottom: 6, fontSize: 13, fontStyle: "italic", color: `rgba(${FG},0.5)`, lineHeight: 20, fontFamily: "Inter_400Regular" },
  chevUp: { transform: [{ rotate: "180deg" }] },
  taskCard: { borderRadius: 10, backgroundColor: `rgba(${FG},0.03)`, paddingHorizontal: 8, paddingVertical: 2, marginVertical: 1 },
  taskHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 },
  taskTitle: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.78)` },
  taskAgent: { fontSize: 11, color: `rgba(${FG},0.4)`, fontFamily: "Inter_400Regular" },
  taskChildren: { marginLeft: 16, borderLeftWidth: 1, borderLeftColor: `rgba(${FG},0.08)`, paddingLeft: 10, paddingBottom: 4 },
  special: { marginTop: 4, marginBottom: 12, borderRadius: 14, borderWidth: 1, borderColor: `rgba(${FG},0.1)`, backgroundColor: "rgba(255,255,255,0.5)", paddingHorizontal: 14, paddingVertical: 10 },
  specialLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.4, color: `rgba(${FG},0.5)`, marginBottom: 4, textTransform: "uppercase" },
  specialBody: { fontSize: 14, color: `rgba(${FG},0.85)`, fontFamily: "Inter_400Regular", lineHeight: 20 },
});
