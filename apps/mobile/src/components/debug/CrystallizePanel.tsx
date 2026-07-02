/**
 * CrystallizePanel —— ui-web 同名组件（405 行）的 RN 全量移植。
 * conversation crystallize 管线的 debug 卡：进度（turn_count vs threshold）、
 * auto 开关、可调 config（可折叠）、skill 计数、Run-now 按钮、最近的 crystallize
 * 决策。逻辑层零重写：useCrystallize（@pin-ai/state）+ TunableCrystallizeKey
 * （@pin-ai/core）直用，可调参数 / run/trigger / 展开 / 轮询逐字同源。
 *
 * 文案与 dev 一致为硬编码英文（dev 未 i18n → 保持硬编码，i18n 铁律）。
 * 渲染层 <div>→<View>、lucide-react→-native、framer-motion→reanimated /
 * LayoutAnimation、<input>→<TextInput>。图标不吃 transform，旋转（Loader2 spin /
 * RefreshCw spin / ChevronDown 翻转）一律包 Animated.View 用 reanimated 驱动。
 */
import { useEffect, useMemo, useState } from "react";
import {
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { ChevronDown, Loader2, Play, RefreshCw, Sparkles } from "lucide-react-native";
import { useCrystallize } from "@pin-ai/state";
import type { TunableCrystallizeKey } from "@pin-ai/core";

interface CrystallizePanelProps {
  enabled: boolean;
}

// ── 颜色 helper ──
// token --foreground: 230 25% 15%。NativeWind 的 hsl(var()) 无 alpha 槽 → 内联 hsla。
const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
// token --background: 220 30% 96%（bg-foreground 按钮上的文字色 = text-background）。
const BACKGROUND = "hsl(220, 30%, 96%)";

// dev tailwind 色板对应的 RGB（bg-*-50 / text-*-700 / border-*-200 / *-500 换算）。
const EMERALD_500 = "#10b981";
const EMERALD_700 = "#047857";
const EMERALD_50 = "#ecfdf5";
const EMERALD_200 = "#a7f3d0";
const BLUE_600 = "#2563eb";
const BLUE_700 = "#1d4ed8";
const BLUE_50 = "#eff6ff";
const BLUE_200 = "#bfdbfe";
const RED_500 = "#ef4444";
const PRIMARY = "hsl(292, 78%, 63%)"; // token --primary（品红），focus ring 用

// dev DECISION_STYLES：memorize=emerald / create_skill=blue / discard=foreground。
interface Chip {
  bg: string;
  fg: string;
  border: string;
}
const DECISION_STYLES: Record<string, Chip> = {
  memorize: { bg: EMERALD_50, fg: EMERALD_700, border: EMERALD_200 },
  create_skill: { bg: BLUE_50, fg: BLUE_700, border: BLUE_200 },
  discard: { bg: fg(0.05), fg: fg(0.5), border: fg(0.1) },
};

function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  const diff = Date.now() - parsed;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** lucide `animate-spin`（1s linear）→ 图标不吃 transform，包 Animated.View 转。 */
function Spin({ size, color, strokeWidth = 1.5 }: { size: number; color: string; strokeWidth?: number }) {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(r);
  }, [r]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <Loader2 size={size} color={color} strokeWidth={strokeWidth} />
    </Animated.View>
  );
}

/** 刷新按钮的 RefreshCw：loading 时 spin（dev className={loading ? "animate-spin" : ""}）。 */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  const r = useSharedValue(0);
  useEffect(() => {
    if (spinning) {
      r.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1, false);
    } else {
      cancelAnimation(r);
      r.value = 0;
    }
    return () => cancelAnimation(r);
  }, [spinning, r]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <RefreshCw size={11} strokeWidth={1.5} color={fg(0.3)} />
    </Animated.View>
  );
}

/** dev auto 开关（w-7 h-4 = 28×16 轨 + w-3 h-3 = 12 拇指，off x=2 / on x=14，200ms）。 */
function AutoToggle({ on, disabled, onPress }: { on: boolean; disabled: boolean; onPress: () => void }) {
  const x = useSharedValue(on ? 14 : 2);
  useEffect(() => {
    x.value = withTiming(on ? 14 : 2, { duration: 200 });
  }, [on, x]);
  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
    >
      <View style={[styles.toggleTrack, { backgroundColor: on ? EMERALD_500 : fg(0.15) }, disabled && { opacity: 0.4 }]}>
        <Animated.View style={[styles.toggleThumb, thumbStyle]} />
      </View>
    </Pressable>
  );
}

/** ChevronDown 展开翻转（dev rotate-180 · duration-200）。图标不吃 transform → 包 Animated.View。 */
function ChevronFlip({ open }: { open: boolean }) {
  const r = useSharedValue(open ? 180 : 0);
  useEffect(() => {
    r.value = withTiming(open ? 180 : 0, { duration: 200 });
  }, [open, r]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <ChevronDown size={12} strokeWidth={1.5} color={fg(0.4)} />
    </Animated.View>
  );
}

/** dev motion.div 进度条：animate width（0.3s）。reanimated 驱动 width 百分比。 */
function ProgressBar({ progress }: { progress: number }) {
  const w = useSharedValue(progress * 100);
  useEffect(() => {
    w.value = withTiming(progress * 100, { duration: 300 });
  }, [progress, w]);
  const style = useAnimatedStyle(() => ({ width: `${w.value}%` }));
  const filled = progress >= 1;
  return (
    <View style={styles.progressTrack}>
      <Animated.View style={[styles.progressFill, { backgroundColor: filled ? EMERALD_500 : fg(0.5) }, style]} />
    </View>
  );
}

export default function CrystallizePanel({ enabled }: CrystallizePanelProps) {
  const { state, loading, mutating, running, error, lastRun, refetch, toggleAuto, patchConfig, forceRun } =
    useCrystallize(enabled);
  const [tunablesOpen, setTunablesOpen] = useState(false);

  // Local draft values for number inputs so we can debounce onBlur commits.
  const [drafts, setDrafts] = useState<Partial<Record<TunableCrystallizeKey, string>>>({});

  useEffect(() => {
    if (!state) return;
    // Whenever effective config changes (e.g. after PATCH), sync drafts.
    setDrafts({
      messageThreshold: String(state.config.effective.messageThreshold ?? ""),
      cooldownMs: String(Math.round((state.config.effective.cooldownMs ?? 0) / 60_000)),
      salienceFloor: (state.config.effective.salienceFloor ?? 0).toFixed(2),
      minUserChars: String(state.config.effective.minUserChars ?? ""),
    });
  }, [state]);

  const threshold = state?.config.effective.messageThreshold ?? 10;
  const turnCount = state?.state.turn_count ?? 0;
  const progress = useMemo(() => Math.min(1, turnCount / Math.max(1, threshold)), [turnCount, threshold]);
  const autoEnabled = state?.settings?.auto_crystallize ?? true;

  const commitNumber = async (key: TunableCrystallizeKey, raw: string) => {
    if (!state) return;
    const bounds = state.config.bounds[key];
    if (raw === "") {
      // Empty input clears the override back to default.
      await patchConfig({ [key]: null });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    if (n < bounds.min || n > bounds.max) return;
    if (bounds.integer && !Number.isInteger(n)) return;
    // For cooldown we stored minutes in the input — convert back to ms.
    const value = key === "cooldownMs" ? Math.round(n * 60_000) : n;
    if (value === state.config.effective[key]) return;
    await patchConfig({ [key]: value });
  };

  const resetAll = async () => {
    await patchConfig({
      messageThreshold: null,
      cooldownMs: null,
      salienceFloor: null,
      minUserChars: null,
    });
  };

  const toggleTunables = () => {
    // web AnimatePresence height auto 展开/收起 → RN LayoutAnimation（本项目既定）。
    LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut", "opacity"));
    setTunablesOpen((v) => !v);
  };

  return (
    <View style={styles.card}>
      {/* 头部：Sparkles + "Chat Learning" + 加载 spinner ｜ 刷新 + Auto 开关 */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Sparkles size={14} strokeWidth={1.5} color={fg(0.4)} />
          <Text style={styles.headerLabel}>Chat Learning</Text>
          {loading && !state ? <Spin size={11} color={fg(0.3)} /> : null}
        </View>
        <View style={styles.headerRight}>
          <Pressable
            onPress={() => void refetch()}
            disabled={loading}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Refresh"
          >
            {({ pressed }) => (
              <View style={[styles.refreshButton, pressed && { backgroundColor: fg(0.05) }, loading && { opacity: 0.4 }]}>
                <RefreshIcon spinning={loading} />
              </View>
            )}
          </Pressable>
          <View style={styles.autoWrap}>
            <Text style={styles.autoLabel}>Auto</Text>
            <AutoToggle
              on={autoEnabled}
              disabled={!state || mutating}
              onPress={() => void toggleAuto(!autoEnabled)}
            />
          </View>
        </View>
      </View>

      {/* Diagnostics — last session kind */}
      {state?.diagnostics?.lastSessionKind ? (
        <View style={styles.diagRow}>
          <Text style={styles.micro40}>Last session</Text>
          <View
            style={[
              styles.sessionChip,
              state.diagnostics.lastSessionKind === "card" && { backgroundColor: BLUE_50, borderColor: BLUE_200 },
              state.diagnostics.lastSessionKind === "main" && { backgroundColor: EMERALD_50, borderColor: EMERALD_200 },
              state.diagnostics.lastSessionKind === "other" && { backgroundColor: fg(0.05), borderColor: fg(0.1) },
            ]}
          >
            <Text
              style={[
                styles.sessionChipText,
                state.diagnostics.lastSessionKind === "card" && { color: BLUE_700 },
                state.diagnostics.lastSessionKind === "main" && { color: EMERALD_700 },
                state.diagnostics.lastSessionKind === "other" && { color: fg(0.5) },
              ]}
            >
              {state.diagnostics.lastSessionKind === "card"
                ? "card chat"
                : state.diagnostics.lastSessionKind === "main"
                  ? "main chat"
                  : "other"}
            </Text>
          </View>
          {state.diagnostics.secondsSinceLastBump !== null ? (
            <Text style={[styles.micro30, styles.tabular]}>
              · {formatSeconds(state.diagnostics.secondsSinceLastBump)} ago
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Progress */}
      <View>
        <View style={styles.progressHeader}>
          <Text style={styles.micro40}>Turns</Text>
          <Text style={[styles.micro40, styles.mono, styles.tabular]}>
            {turnCount} / {threshold}
          </Text>
        </View>
        <ProgressBar progress={progress} />
        <View style={styles.metaGrid}>
          <Text style={[styles.micro40, styles.metaKey]}>Last bumped</Text>
          <Text style={[styles.micro40, styles.tabular, styles.metaVal]}>
            {relativeTime(state?.state.last_message_at)}
          </Text>
          <Text style={[styles.micro40, styles.metaKey]}>Last learned</Text>
          <Text style={[styles.micro40, styles.tabular, styles.metaVal]}>
            {relativeTime(state?.state.last_crystallized_at)}
          </Text>
        </View>
      </View>

      {/* Skills counters + Run Now */}
      <View style={styles.skillsRow}>
        <View style={styles.skillsLeft}>
          <Text style={[styles.micro40, styles.medium]}>Skills:</Text>
          <View style={styles.skillChipActive}>
            <Text style={styles.skillChipActiveText}>active {state?.skillCounts.active ?? 0}</Text>
          </View>
          {(state?.skillCounts.disabled ?? 0) > 0 ? (
            <View style={styles.skillChipDisabled}>
              <Text style={styles.skillChipDisabledText}>disabled {state?.skillCounts.disabled}</Text>
            </View>
          ) : null}
        </View>
        <Pressable
          onPress={() => void forceRun()}
          disabled={!state || running || !enabled}
          accessibilityRole="button"
          accessibilityLabel="Run now"
        >
          {({ pressed }) => (
            <View
              style={[
                styles.runButton,
                pressed && { opacity: 0.85 },
                (!state || running || !enabled) && { opacity: 0.4 },
              ]}
            >
              {running ? (
                <Spin size={10} color={BACKGROUND} strokeWidth={2} />
              ) : (
                <Play size={10} strokeWidth={2} color={BACKGROUND} />
              )}
              <Text style={styles.runButtonText}>{running ? "Running…" : "Run now"}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {lastRun ? (
        <View style={styles.lastRunBox}>
          {lastRun.skipped ? (
            <Text style={styles.lastRunText}>
              <Text style={[styles.medium, { color: fg(0.5) }]}>skipped</Text>
              <Text style={{ color: fg(0.4) }}> — {lastRun.reason ?? "no reason"}</Text>
            </Text>
          ) : (
            <Text style={styles.lastRunText}>
              <Text
                style={[
                  styles.semibold,
                  styles.upper,
                  lastRun.decision === "memorize" && { color: EMERALD_700 },
                  lastRun.decision === "create_skill" && { color: BLUE_700 },
                  lastRun.decision === "discard" && { color: fg(0.5) },
                ]}
              >
                {lastRun.decision ?? "done"}
              </Text>
              {typeof lastRun.salience === "number" ? (
                <Text style={{ color: fg(0.4) }}> · s={lastRun.salience.toFixed(2)}</Text>
              ) : null}
              {lastRun.memoryId ? (
                <Text style={{ color: fg(0.4) }}> · mem={lastRun.memoryId.slice(0, 8)}</Text>
              ) : null}
              {lastRun.skillId ? (
                <Text style={{ color: fg(0.4) }}> · skill={lastRun.skillId.slice(0, 8)}</Text>
              ) : null}
            </Text>
          )}
        </View>
      ) : null}

      {/* Tunables (collapsible) */}
      <Pressable onPress={toggleTunables} accessibilityRole="button" accessibilityLabel="Toggle tunables">
        {({ pressed }) => (
          <View style={styles.tunablesToggleRow}>
            <Text style={[styles.micro40, styles.medium, pressed && { color: fg(0.6) }]}>Tunables</Text>
            <ChevronFlip open={tunablesOpen} />
          </View>
        )}
      </Pressable>
      {tunablesOpen && state ? (
        <Animated.View entering={FadeIn.duration(200)}>
          <View style={styles.tunablesGrid}>
            <TunableRow
              label="Threshold"
              unit="turns"
              draft={drafts.messageThreshold ?? ""}
              onChange={(v) => setDrafts((d) => ({ ...d, messageThreshold: v }))}
              onCommit={(v) => void commitNumber("messageThreshold", v)}
              bounds={state.config.bounds.messageThreshold}
              overridden={state.config.override.messageThreshold !== undefined}
            />
            <TunableRow
              label="Cooldown"
              unit="min"
              draft={drafts.cooldownMs ?? ""}
              onChange={(v) => setDrafts((d) => ({ ...d, cooldownMs: v }))}
              onCommit={(v) => void commitNumber("cooldownMs", v)}
              bounds={{
                min: state.config.bounds.cooldownMs.min / 60_000,
                max: state.config.bounds.cooldownMs.max / 60_000,
                integer: true,
              }}
              overridden={state.config.override.cooldownMs !== undefined}
            />
            <TunableRow
              label="Salience floor"
              unit=""
              draft={drafts.salienceFloor ?? ""}
              step={0.05}
              onChange={(v) => setDrafts((d) => ({ ...d, salienceFloor: v }))}
              onCommit={(v) => void commitNumber("salienceFloor", v)}
              bounds={state.config.bounds.salienceFloor}
              overridden={state.config.override.salienceFloor !== undefined}
            />
            <TunableRow
              label="Min user chars"
              unit="chars"
              draft={drafts.minUserChars ?? ""}
              onChange={(v) => setDrafts((d) => ({ ...d, minUserChars: v }))}
              onCommit={(v) => void commitNumber("minUserChars", v)}
              bounds={state.config.bounds.minUserChars}
              overridden={state.config.override.minUserChars !== undefined}
            />
          </View>
          {Object.keys(state.config.override).length > 0 ? (
            <Pressable onPress={() => void resetAll()} disabled={mutating} accessibilityRole="button">
              {({ pressed }) => (
                <Text
                  style={[
                    styles.resetAll,
                    pressed && { color: fg(0.7) },
                    mutating && { opacity: 0.4 },
                  ]}
                >
                  Reset all to default
                </Text>
              )}
            </Pressable>
          ) : null}
        </Animated.View>
      ) : null}

      {/* Recent decisions */}
      {state && state.recentDecisions.length > 0 ? (
        <View style={styles.recentBlock}>
          <Text style={styles.recentHeading}>Recent decisions</Text>
          <View style={{ gap: 4 }}>
            {state.recentDecisions.map((d, i) => {
              const chip = DECISION_STYLES[d.decision] ?? DECISION_STYLES.discard;
              return (
                <View key={`${d.ts}-${i}`} style={styles.decisionRow}>
                  <View style={[styles.decisionChip, { backgroundColor: chip.bg, borderColor: chip.border }]}>
                    <Text style={[styles.decisionChipText, { color: chip.fg }]}>{d.decision}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={styles.decisionMetaRow}>
                      {typeof d.salience === "number" ? (
                        <Text style={[styles.micro40, styles.mono, styles.tabular]}>s={d.salience.toFixed(2)}</Text>
                      ) : null}
                      <Text style={[styles.micro40, styles.tabular]}>{relativeTime(d.ts)}</Text>
                      {d.memoryId ? <Text style={styles.micro30}>· mem</Text> : null}
                      {d.skillId ? <Text style={styles.micro30}>· skill</Text> : null}
                    </View>
                    {d.summary ? (
                      <Text numberOfLines={2} style={styles.decisionSummary}>
                        {d.summary}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      ) : null}

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

interface TunableRowProps {
  label: string;
  unit: string;
  draft: string;
  step?: number;
  bounds: { min: number; max: number; integer: boolean };
  overridden: boolean;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
}

function TunableRow({ label, unit, draft, bounds, overridden, onChange, onCommit }: TunableRowProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.tunableRow}>
      <Text
        style={[styles.tunableLabel, overridden && { fontFamily: "Inter_600SemiBold", color: BLUE_600 }]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <TextInput
        value={draft}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onCommit(draft);
        }}
        onSubmitEditing={() => onCommit(draft)}
        keyboardType={bounds.integer ? "number-pad" : "decimal-pad"}
        returnKeyType="done"
        style={[styles.tunableInput, focused && { borderColor: PRIMARY }]}
        selectionColor={PRIMARY}
      />
      <Text style={styles.tunableUnit}>{unit}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // dev: rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: fg(0.03),
    padding: 14,
  },

  // ── 头部 ──
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerLabel: { fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg(0.5) },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  refreshButton: { padding: 4, borderRadius: 6 },
  autoWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  autoLabel: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: fg(0.4) },

  // auto 开关（28×16 轨 + 12 拇指）
  toggleTrack: { width: 28, height: 16, borderRadius: 999, justifyContent: "center" },
  toggleThumb: {
    position: "absolute",
    top: 2,
    left: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 1 },
  },

  // ── Diagnostics ──
  diagRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  sessionChip: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  sessionChipText: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    lineHeight: 12,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },

  // ── Progress ──
  progressHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 },
  progressTrack: { height: 6, borderRadius: 999, backgroundColor: fg(0.1), overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 999 },
  metaGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },
  metaKey: { width: "50%", paddingRight: 12, marginBottom: 2 },
  metaVal: { width: "50%", textAlign: "right", marginBottom: 2 },

  // ── Skills + Run ──
  skillsRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  skillsLeft: { flexDirection: "row", alignItems: "center", gap: 4, flex: 1, flexWrap: "wrap" },
  skillChipActive: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: EMERALD_50,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  skillChipActiveText: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: EMERALD_700 },
  skillChipDisabled: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: fg(0.1),
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  skillChipDisabledText: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.5) },
  runButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 8,
    backgroundColor: fg(),
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  runButtonText: { fontFamily: "Inter_600SemiBold", fontSize: 10, lineHeight: 14, color: BACKGROUND },

  // ── lastRun ──
  lastRunBox: {
    marginTop: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.5)",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  lastRunText: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.6) },

  // ── Tunables ──
  tunablesToggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 },
  tunablesGrid: { marginTop: 8, gap: 6 },
  tunableRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  tunableLabel: { width: 96, fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.5) },
  tunableInput: {
    flex: 1,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.6)",
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontFamily: "Menlo",
    fontSize: 10,
    color: fg(),
    fontVariant: ["tabular-nums"],
  },
  tunableUnit: { width: 36, fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.3) },
  resetAll: {
    marginTop: 8,
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    lineHeight: 14,
    color: fg(0.4),
    textDecorationLine: "underline",
  },

  // ── Recent decisions ──
  recentBlock: { marginTop: 12 },
  recentHeading: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    lineHeight: 14,
    color: fg(0.4),
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  decisionRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.4)",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  decisionChip: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  decisionChipText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    lineHeight: 12,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  decisionMetaRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  decisionSummary: { marginTop: 2, fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.6) },

  // ── error ──
  errorText: { marginTop: 8, fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: RED_500 },

  // ── 复用文字 ──
  micro40: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.4) },
  micro30: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.3) },
  medium: { fontFamily: "Inter_500Medium" },
  semibold: { fontFamily: "Inter_600SemiBold" },
  mono: { fontFamily: "Menlo" },
  tabular: { fontVariant: ["tabular-nums"] },
  upper: { textTransform: "uppercase" },
});
