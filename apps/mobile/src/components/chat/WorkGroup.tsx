/**
 * 工具调用工作组——web ui-web/chat/conversation/WorkGroup + WorkGroupNodes +
 * TaskCard 的 RN 介质版。一段连续的 推理 / 工具 / 子代理任务 折叠进一条玻璃栏：
 * 流式时展开 + spinner + 当前动作，结束后自动收起、显示 LLM 标题或
 * 「Used N tools / Ran N subtasks / Thought」兜底。分组逻辑（segmentAssistantParts /
 * toolStatus / taskDescription / WorkGroupData）100% 复用 @pin-ai/core，本文件只
 * 渲染。web blur(20) saturate(1.3) → RN expo-blur + 白覆盖；framer cubic ease 的
 * 折叠 → RN LayoutAnimation。web-search 结果 = favicon + 标题 + 域名的可点来源列
 * （web LinksList，favicon 走 google s2 端点，点击 Linking.openURL）；工具输出
 * 展开走 MarkdownText（web ToolNodeRow 的 MarkdownContent）。
 */
import { useEffect, useState } from "react";
import { Image, LayoutAnimation, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { AlertCircle, Check, ChevronDown, ChevronUp, Clock, Loader2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import Animated, {
  cancelAnimation,
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
  type ToolResultLink,
  type WorkGroupData,
} from "@pin-ai/core";

import MarkdownText from "./MarkdownText";
import { resolveToolPresentation } from "./tool-presentation";
import { usePageActive } from "../app/KeepAlivePage";

const FG = "29,33,48";
/** web running StatusDot 的品红 hsl(304 75% 50%) ≈ rgb(199,32,199)。 */
const MAGENTA = "rgb(199,32,199)";

function easeNext() {
  LayoutAnimation.configureNext(LayoutAnimation.create(220, "easeInEaseOut", "opacity"));
}

/** Loader2 旋转（web animate-spin 的 RN 对应物）。 */
function Spin({ size, color }: { size: number; color: string }) {
  const r = useSharedValue(0);
  const active = usePageActive();
  useEffect(() => {
    if (!active) {
      cancelAnimation(r);
      return;
    }
    r.value = withRepeat(withTiming(360, { duration: 800, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(r);
  }, [r, active]);
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

function stringArg(part: ToolCallPart, key: string): string {
  const value = part.args[key];
  return typeof value === "string" ? value : "";
}

/** favicon 解析（web WorkGroupNodes 同款 google s2 端点，域名取自结果 URL）。 */
function faviconUrl(url: string): string | null {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  } catch {
    return null;
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** web-search 来源列（web LinksList）：favicon + 标题 + 域名，点击外开浏览器
 *  （web `<a target=_blank>` 的 RN 对应 = Linking.openURL）。 */
function LinksList({ links }: { links: ToolResultLink[] }) {
  return (
    <View style={styles.linksBox}>
      {links.map((link, i) => {
        const icon = faviconUrl(link.url);
        return (
          <Pressable
            key={link.url}
            onPress={() => void Linking.openURL(link.url).catch(() => {})}
            accessibilityRole="link"
          >
            {/* web last:border-b-0——末行不画分隔线。 */}
            <View style={[styles.linkRow, i === links.length - 1 && styles.linkRowLast]}>
              {icon ? (
                <Image source={{ uri: icon }} style={styles.linkFavicon} />
              ) : (
                <View style={[styles.linkFavicon, styles.linkFaviconFallback]} />
              )}
              <Text style={styles.linkTitle} numberOfLines={1}>
                {link.title}
              </Text>
              <Text style={styles.linkDomain} numberOfLines={1}>
                {domainOf(link.url)}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 单工具行（web ToolNodeRow）：状态点 + 动作动词 + args 预览；点开看工具详情。 */
function ToolNodeRow({ part, nested }: { part: ToolCallPart; nested?: boolean }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const { verb } = resolveToolPresentation(part.toolName);
  const status = toolStatus(part);
  const argsPreview = stringArg(part, "argsPreview");
  const target =
    stringArg(part, "pinCommand") ||
    stringArg(part, "meta") ||
    argsPreview;
  // 与 web ToolNodeRow 同判：links 有无按字段存在算（含空数组），展开分支互斥。
  const canExpand = status !== "running" && (Boolean(target) || Boolean(part.links));

  return (
    <View style={styles.toolNode}>
      <Pressable
        onPress={() => {
          if (!canExpand) return;
          easeNext();
          setExpanded((v) => !v);
        }}
        disabled={!canExpand}
        accessibilityRole={canExpand ? "button" : undefined}
        style={[styles.toolRow, nested && styles.nestedRow, canExpand && styles.toolRowPressable]}
      >
        <View style={styles.dot}>
          <StatusDot status={status} />
        </View>
        <Text style={styles.verb} numberOfLines={1}>
          {verb}
        </Text>
        <Text style={styles.preview} numberOfLines={1}>
          {argsPreview}
        </Text>
        {part.links ? (
          <Text style={styles.resultCount}>{t("toolNode.results", { count: part.links.length })}</Text>
        ) : null}
        {canExpand ? (
          <View style={styles.toolChevron}>
            {expanded ? (
              <ChevronUp size={15} color={`rgba(${FG},0.45)`} strokeWidth={1.8} />
            ) : (
              <ChevronDown size={15} color={`rgba(${FG},0.45)`} strokeWidth={1.8} />
            )}
          </View>
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.toolDetailsWrap}>
          {part.links ? (
            <LinksList links={part.links} />
          ) : target ? (
            // web ToolNodeRow 展开:rounded-lg bg-foreground/[0.03] 内 MarkdownContent。
            <View style={styles.toolDetails}>
              <MarkdownText text={target} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** 推理节点（web ThinkingNode）：Clock + 斜体首行；流式显示尾窗，结束点开看全文。 */
function ThinkingNode({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation("chat");
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
  const firstLine = text.split("\n").find((l) => l.trim()) ?? t("workGroup.thought");
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
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const desc = taskDescription(part) || part.agentName || t("taskCard.subtask");
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

/** 流式状态行：对齐 web WorkGroup.currentActivity。 */
function currentActivity(group: WorkGroupData, t: TFunction<"chat">): string {
  const runningTasks = group.items.filter(
    (i) => i.kind === "task" && toolStatus(i.part) === "running",
  );
  if (runningTasks.length > 1) return t("workGroup.subtasksRunning", { count: runningTasks.length });
  for (let i = group.items.length - 1; i >= 0; i--) {
    const it = group.items[i];
    if (it.kind === "tool" && toolStatus(it.part) === "running") {
      return resolveToolPresentation(it.part.toolName).verb;
    }
    if (it.kind === "task" && toolStatus(it.part) === "running") {
      return taskDescription(it.part) || t("workGroup.runningSubtask");
    }
  }
  return t("workGroup.working");
}

/** 工作组标签：流式→当前动作；结束→LLM 标题 ?? 兜底计数。 */
function groupLabel(group: WorkGroupData, live: boolean, stepCount: number, t: TFunction<"chat">): string {
  if (live) {
    return currentActivity(group, t);
  }
  if (group.title) return group.title;
  const tasks = group.items.filter((i) => i.kind === "task").length;
  if (tasks > 0) return t("workGroup.ranSubtasks", { count: tasks });
  if (stepCount > 0) return t("workGroup.usedTools", { count: stepCount });
  return t("workGroup.thought");
}

export default function WorkGroup({
  group,
  streamingTail,
}: {
  group: WorkGroupData;
  /** 该组所属 assistant turn 仍在流式（最后一个 turn）。 */
  streamingTail: boolean;
}) {
  const { t } = useTranslation("chat");
  const live = streamingTail;
  const stepCount = group.items.filter((i) => i.kind !== "reasoning").length;
  const [expanded, setExpanded] = useState(live);
  // 对齐 web：只要 turn 还在流式/等待审批就展开；一旦 settle 就自动收起。
  useEffect(() => {
    if (!live) {
      easeNext();
      setExpanded(false);
    }
  }, [live]);

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
          {groupLabel(group, live, stepCount, t)}
        </Text>
        {!live && stepCount > 0 ? (
          <Text style={styles.stepCount}>
            {t("workGroup.steps", { count: stepCount }).toUpperCase()}
          </Text>
        ) : null}
        <ChevronDown size={13} color={`rgba(${FG},0.35)`} style={expanded ? styles.chevUp : undefined} />
      </Pressable>
      {expanded ? (
        <View style={styles.groupBody}>
          {group.items.map((item, i) => {
            if (item.kind === "reasoning") {
              return <ThinkingNode key={`r-${i}`} text={item.text} streaming={live && i === group.items.length - 1} />;
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
  groupLabelText: { flex: 1, fontSize: 13, color: `rgba(${FG},0.6)`, fontFamily: "Geist_400Regular" },
  groupLabelDone: { fontFamily: "Geist_500Medium" },
  stepCount: { fontSize: 10, letterSpacing: 1.2, color: `rgba(${FG},0.35)`, fontFamily: "Geist_500Medium" },
  groupBody: { marginLeft: 18, borderLeftWidth: 1, borderLeftColor: `rgba(${FG},0.08)`, paddingLeft: 12, paddingRight: 12, paddingBottom: 10, paddingTop: 2, gap: 4 },
  dot: { width: 16, alignItems: "center", justifyContent: "center" },
  toolNode: { alignSelf: "stretch", width: "100%" },
  toolRow: {
    alignSelf: "stretch",
    width: "100%",
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 5,
  },
  toolRowPressable: { borderRadius: 8, paddingHorizontal: 2 },
  nestedRow: { marginLeft: 8 },
  verb: { fontSize: 13, fontFamily: "Geist_500Medium", color: `rgba(${FG},0.8)`, flexShrink: 0, maxWidth: "58%" },
  preview: { flex: 1, minWidth: 0, fontSize: 12, color: `rgba(${FG},0.4)`, fontFamily: "Geist_400Regular" },
  resultCount: { fontSize: 11, color: `rgba(${FG},0.45)`, fontFamily: "Geist_400Regular" },
  toolChevron: { width: 18, alignItems: "flex-end", justifyContent: "center", flexShrink: 0 },
  toolDetailsWrap: { alignSelf: "stretch", paddingLeft: 20, paddingRight: 2, paddingBottom: 8 },
  // web: mt-1 rounded-lg bg-foreground/[0.03] px-2.5 py-2（内容 = MarkdownContent）。
  toolDetails: {
    marginTop: 4,
    borderRadius: 8,
    backgroundColor: `rgba(${FG},0.03)`,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  // web: mt-1.5 rounded-lg border-foreground/[0.06] bg-white/60 overflow-hidden。
  linksBox: {
    marginTop: 6,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.6)",
    borderWidth: 1,
    borderColor: `rgba(${FG},0.06)`,
    overflow: "hidden",
  },
  // web: flex gap-2 px-2.5 py-1.5 border-b fg/[0.04]。
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: `rgba(${FG},0.04)`,
  },
  linkRowLast: { borderBottomWidth: 0 },
  // web: h-3.5 w-3.5 rounded-sm。
  linkFavicon: { width: 14, height: 14, borderRadius: 3, flexShrink: 0 },
  linkFaviconFallback: { backgroundColor: `rgba(${FG},0.1)` },
  // web: flex-1 truncate text-label(12) text-foreground/80。
  linkTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: `rgba(${FG},0.8)`,
    fontFamily: "Geist_400Regular",
  },
  // web: caption(11) text-foreground/40。
  linkDomain: {
    flexShrink: 0,
    maxWidth: "38%",
    fontSize: 11,
    color: `rgba(${FG},0.4)`,
    fontFamily: "Geist_400Regular",
  },
  thinkRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  thinkIcon: { marginTop: 1 },
  thinkText: { flex: 1, fontSize: 12, fontStyle: "italic", color: `rgba(${FG},0.45)`, fontFamily: "Geist_400Regular", lineHeight: 17 },
  thinkFull: { paddingLeft: 19, paddingBottom: 6, fontSize: 13, fontStyle: "italic", color: `rgba(${FG},0.5)`, lineHeight: 20, fontFamily: "Geist_400Regular" },
  chevUp: { transform: [{ rotate: "180deg" }] },
  taskCard: { borderRadius: 10, backgroundColor: `rgba(${FG},0.03)`, paddingHorizontal: 8, paddingVertical: 2, marginVertical: 1 },
  taskHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 },
  taskTitle: { flex: 1, fontSize: 13, fontFamily: "Geist_500Medium", color: `rgba(${FG},0.78)` },
  taskAgent: { fontSize: 11, color: `rgba(${FG},0.4)`, fontFamily: "Geist_400Regular" },
  taskChildren: { marginLeft: 16, borderLeftWidth: 1, borderLeftColor: `rgba(${FG},0.08)`, paddingLeft: 10, paddingBottom: 4 },
});
