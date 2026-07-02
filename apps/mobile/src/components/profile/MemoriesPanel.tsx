/**
 * MemoriesPanel —— ui-web 同名组件（588 行）的 RN 全量移植。debug 面板：
 * 按 status（active / archived / superseded）列 v3 `memory` 行，可按 subject
 * 前缀 + min quality 筛选，支持 inline 编辑（text / subject / quality / tags）、
 * archive（软删）、supersede（新建 + 链接旧行）。无硬删——v3 视 memory 为
 * append-only ledger。
 *
 * 逻辑层零重写：useMemories / type Memory / MemoryStatus 直用 @pin-ai/state /
 * @pin-ai/core；筛选、分页、编辑、supersede 状态机逐字同源。渲染层
 * <div>→<View>、<button>→<Pressable children-as-function>、<input>/<textarea>→
 * <TextInput>、lucide-react→-native。
 *
 * subject `<select>`（dev 在 iOS 是系统下拉）→ MenuView 系统 UIMenu（= SETTING
 * 屏 select 既定方案，桥接系统控件、不自绘）。展开/折叠 + 创建表单的 framer
 * height:auto 动画 → LayoutAnimation + 条件渲染（RN 无 height:auto 动画，既定模式）。
 */
import { useEffect, useMemo, useState } from "react";
import { LayoutAnimation, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  X,
} from "lucide-react-native";
import { MenuView } from "@react-native-menu/menu";
import { useMemories } from "@pin-ai/state";
import type { Memory, MemoryStatus } from "@pin-ai/core";

interface MemoriesPanelProps {
  enabled: boolean;
}

const STATUS_TABS: MemoryStatus[] = ["active", "archived", "superseded"];

const SUBJECT_PRESETS = ["", "self", "person:", "topic:", "goal:", "place:"];
const PAGE_SIZE = 5;

// ── 颜色 ──（dev foreground = hsl(230,25%,15%)）
const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
/** token --background: 220 30% 96%（bg-foreground 按钮上的文字色）。 */
const BACKGROUND = "hsl(220, 30%, 96%)";
const WHITE = "#ffffff";

// dev status pill 配色（emerald-50/700/200、amber-50/700/200、foreground/5·50·10）。
const EMERALD_50 = "#ecfdf5";
const EMERALD_200 = "#a7f3d0";
const EMERALD_700 = "#047857";
const EMERALD_500 = "#10b981";
const AMBER_50 = "#fffbeb";
const AMBER_200 = "#fde68a";
const AMBER_700 = "#b45309";
const AMBER_400 = "#fbbf24";
const BLUE_50 = "#eff6ff";
const BLUE_200 = "#bfdbfe";
const BLUE_600 = "#2563eb";
const BLUE_700 = "#1d4ed8";
const RED_500 = "#ef4444";
const RED_50 = "#fef2f2";
const RED_200 = "#fecaca";
const RED_600 = "#dc2626";

// dev STATUS_STYLES（status pill 的 bg / text / border）。
const STATUS_PILL: Record<MemoryStatus, { bg: string; text: string; border: string }> = {
  active: { bg: EMERALD_50, text: EMERALD_700, border: EMERALD_200 },
  archived: { bg: fg(0.05), text: fg(0.5), border: fg(0.1) },
  superseded: { bg: AMBER_50, text: AMBER_700, border: AMBER_200 },
};

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

function qualityColor(q: number): string {
  if (q >= 0.75) return EMERALD_500;
  if (q >= 0.5) return fg(0.5);
  return AMBER_400;
}

/** dev Loader2 `animate-spin`（1s linear）。icon 不吃 transform → 包 Animated.View。 */
function Spin({ size, color }: { size: number; color: string }) {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(r);
  }, [r]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <Loader2 size={size} color={color} strokeWidth={1.5} />
    </Animated.View>
  );
}

/** web AnimatePresence height auto 展开/收起 → RN LayoutAnimation（既定模式，见 ProfileScreen）。 */
function animateLayout() {
  LayoutAnimation.configureNext(LayoutAnimation.create(150, "easeInEaseOut", "opacity"));
}

export default function MemoriesPanel({ enabled }: MemoriesPanelProps) {
  const { t } = useTranslation("profile");
  const { memories, total, loading, mutating, error, filter, setFilter, refetch, create, update, archive, supersede } =
    useMemories(enabled);

  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const status = filter.status ?? "active";
  const pageSize = filter.limit ?? PAGE_SIZE;
  const page = Math.floor((filter.offset ?? 0) / pageSize);
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const firstVisible = total === 0 ? 0 : page * pageSize + 1;
  const lastVisible = Math.min(total, page * pageSize + memories.length);
  const setStatus = (next: MemoryStatus) => setFilter({ ...filter, status: next, limit: pageSize, offset: 0 });

  const subjectPrefix = filter.subjectPrefix ?? "";
  const minQuality = filter.minQuality ?? 0;
  const setPage = (nextPage: number) => {
    const bounded = Math.max(0, Math.min(maxPage, nextPage));
    setFilter({ ...filter, limit: pageSize, offset: bounded * pageSize });
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Brain size={14} strokeWidth={1.5} color={fg(0.4)} />
          <Text style={styles.headerTitle}>{t("memoriesPanel.title")}</Text>
          {loading && <Spin size={11} color={fg(0.3)} />}
        </View>
        <View style={styles.headerRight}>
          <Pressable
            onPress={() => void refetch()}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={t("memoriesPanel.refresh")}
          >
            {({ pressed }) => (
              <View style={[styles.iconBtn, pressed && styles.iconBtnPressed, loading && styles.disabled]}>
                {loading ? (
                  <Spin size={11} color={fg(0.3)} />
                ) : (
                  <RefreshCw size={11} strokeWidth={1.5} color={fg(0.3)} />
                )}
              </View>
            )}
          </Pressable>
          <Pressable onPress={() => { animateLayout(); setCreating((v) => !v); }} accessibilityRole="button">
            {({ pressed }) => (
              <View style={[styles.newBtn, pressed && styles.newBtnPressed]}>
                <Plus size={10} strokeWidth={2} color={BACKGROUND} />
                <Text style={styles.newBtnText}>{t("memoriesPanel.new")}</Text>
              </View>
            )}
          </Pressable>
        </View>
      </View>

      {/* Status tabs */}
      <View style={styles.tabsRow}>
        {STATUS_TABS.map((tab) => {
          const active = status === tab;
          return (
            <Pressable key={tab} onPress={() => setStatus(tab)} accessibilityRole="button" accessibilityState={{ selected: active }}>
              {({ pressed }) => (
                <View style={[styles.tabPill, active ? styles.tabPillActive : styles.tabPillIdle, !active && pressed && styles.tabPillIdlePressed]}>
                  <Text style={active ? styles.tabPillTextActive : styles.tabPillTextIdle}>
                    {t(`memoriesPanel.tabs.${tab}`)}
                  </Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {/* Filters */}
      <View style={styles.filtersRow}>
        {/* dev subject `<select>`（iOS WKWebView 自动渲染成系统菜单）→ RN 用
            @react-native-menu/menu 的 MenuView 拿同一个系统 UIMenu（= SETTING 屏
            select 既定方案，不自绘 chip 组）。空串 value 用 __any__ 哨兵（MenuView
            action id 不能空）。 */}
        <MenuView
          onPressAction={({ nativeEvent }) => {
            const val = nativeEvent.event === "__any__" ? "" : nativeEvent.event;
            setFilter({ ...filter, subjectPrefix: val || undefined, limit: pageSize, offset: 0 });
          }}
          actions={SUBJECT_PRESETS.map((s) => ({
            id: s || "__any__",
            title: s === "" ? t("memoriesPanel.subjectAny") : s,
            state: subjectPrefix === s ? ("on" as const) : undefined,
          }))}
        >
          <View style={styles.subjectTrigger}>
            <Text style={styles.subjectTriggerText} numberOfLines={1}>
              {subjectPrefix === "" ? t("memoriesPanel.subjectAny") : subjectPrefix}
            </Text>
            <ChevronDown size={13} strokeWidth={2} color={fg(0.4)} />
          </View>
        </MenuView>
        <View style={styles.minQualityWrap}>
          <Text style={styles.minQualityLabel}>{t("memoriesPanel.minQuality")}</Text>
          <TextInput
            keyboardType="decimal-pad"
            value={String(minQuality)}
            onChangeText={(txt) => {
              const v = Number(txt);
              setFilter({
                ...filter,
                minQuality: Number.isFinite(v) && v > 0 ? v : undefined,
                limit: pageSize,
                offset: 0,
              });
            }}
            style={styles.minQualityInput}
          />
        </View>
        <Text style={styles.rowRange}>
          {total === 0
            ? t("memoriesPanel.zeroRows")
            : t("memoriesPanel.rowRange", { first: firstVisible, last: lastVisible, total })}
        </Text>
      </View>

      {/* Create form（framer height auto → LayoutAnimation + 条件渲染 + FadeIn 入场） */}
      {creating && (
        <Animated.View entering={FadeIn.duration(150)} style={styles.createWrap}>
          <CreateMemoryForm
            mutating={mutating}
            onCancel={() => { animateLayout(); setCreating(false); }}
            onSubmit={async (input) => {
              const created = await create(input);
              if (created) { animateLayout(); setCreating(false); }
            }}
          />
        </Animated.View>
      )}

      {/* List */}
      <View style={styles.list}>
        {memories.length === 0 && !loading && (
          <Text style={styles.emptyList}>{t(`memoriesPanel.emptyList.${status}`)}</Text>
        )}
        {memories.map((m) => (
          <MemoryRow
            key={m.id}
            memory={m}
            expanded={expandedId === m.id}
            onToggle={() => { animateLayout(); setExpandedId(expandedId === m.id ? null : m.id); }}
            mutating={mutating}
            onUpdate={(patch) => update(m.id, patch)}
            onArchive={() => archive(m.id)}
            onSupersede={(newText) =>
              supersede(m.id, {
                text: newText,
                source: m.source.startsWith("manual") ? "manual" : `manual:revised-from-${m.source}`,
                subject: m.subject,
                quality: m.quality,
                tags: m.tags,
              })
            }
          />
        ))}
      </View>

      <View style={styles.paginationRow}>
        <Text style={styles.pageOf}>
          {t("memoriesPanel.pageOf", {
            page: total === 0 ? 0 : page + 1,
            total: total === 0 ? 0 : maxPage + 1,
          })}
        </Text>
        <View style={styles.pageBtns}>
          <Pressable
            onPress={() => setPage(page - 1)}
            disabled={page <= 0 || loading}
            accessibilityRole="button"
            accessibilityLabel={t("memoriesPanel.previousPage")}
          >
            {({ pressed }) => (
              <View style={[styles.pageBtn, pressed && styles.pageBtnPressed, (page <= 0 || loading) && styles.pageBtnDisabled]}>
                <ChevronLeft size={13} strokeWidth={1.7} color={fg(0.45)} />
              </View>
            )}
          </Pressable>
          <Pressable
            onPress={() => setPage(page + 1)}
            disabled={page >= maxPage || loading || total === 0}
            accessibilityRole="button"
            accessibilityLabel={t("memoriesPanel.nextPage")}
          >
            {({ pressed }) => (
              <View style={[styles.pageBtn, pressed && styles.pageBtnPressed, (page >= maxPage || loading || total === 0) && styles.pageBtnDisabled]}>
                <ChevronRight size={13} strokeWidth={1.7} color={fg(0.45)} />
              </View>
            )}
          </Pressable>
        </View>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

interface MemoryRowProps {
  memory: Memory;
  expanded: boolean;
  mutating: boolean;
  onToggle: () => void;
  onUpdate: (patch: Parameters<ReturnType<typeof useMemories>["update"]>[1]) => Promise<Memory | null>;
  onArchive: () => Promise<boolean>;
  onSupersede: (newText: string) => Promise<Memory | null>;
}

function MemoryRow({ memory, expanded, mutating, onToggle, onUpdate, onArchive, onSupersede }: MemoryRowProps) {
  const { t } = useTranslation(["profile", "common"]);
  const [text, setText] = useState(memory.text);
  const [subject, setSubject] = useState(memory.subject ?? "");
  const [quality, setQuality] = useState(memory.quality);
  const [tagsText, setTagsText] = useState(memory.tags.join(", "));
  const [supersedeDraft, setSupersedeDraft] = useState("");
  const [supersedeOpen, setSupersedeOpen] = useState(false);

  const dirty = useMemo(() => {
    const tags = tagsText.split(",").map((tag) => tag.trim()).filter(Boolean);
    return (
      text !== memory.text
      || (subject || null) !== memory.subject
      || quality !== memory.quality
      || tags.join("|") !== memory.tags.join("|")
    );
  }, [text, subject, quality, tagsText, memory]);

  const save = async () => {
    const tags = tagsText.split(",").map((tag) => tag.trim()).filter(Boolean);
    await onUpdate({
      text: text.trim() || memory.text,
      subject: subject.trim() ? subject.trim() : null,
      quality,
      tags,
    });
  };

  const pill = STATUS_PILL[memory.status];

  return (
    <View style={styles.row}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded }}>
        {({ pressed }) => (
          <View style={[styles.rowHeader, pressed && styles.rowHeaderPressed]}>
            <View style={[styles.statusBadge, { backgroundColor: pill.bg, borderColor: pill.border }]}>
              <Text style={[styles.statusBadgeText, { color: pill.text }]}>
                {t(`memoriesPanel.status.${memory.status}`)}
              </Text>
            </View>
            <View style={styles.rowMain}>
              <Text numberOfLines={2} style={styles.rowText}>{memory.text}</Text>
              <View style={styles.rowMetaRow}>
                {memory.subject ? (
                  <View style={styles.metaChip}>
                    <Text numberOfLines={1} style={[styles.metaChipText, styles.metaChipSubject]}>{memory.subject}</Text>
                  </View>
                ) : null}
                <View style={styles.metaChip}>
                  <Text numberOfLines={1} style={[styles.metaChipText, styles.metaChipSource]}>{memory.source}</Text>
                </View>
                {memory.tags.slice(0, 3).map((tag) => (
                  <View key={tag} style={styles.tagChip}>
                    <Text numberOfLines={1} style={styles.tagChipText}>#{tag}</Text>
                  </View>
                ))}
                {memory.tags.length > 3 ? (
                  <Text style={styles.tagOverflow}>+{memory.tags.length - 3}</Text>
                ) : null}
              </View>
            </View>
            <View style={styles.rowRight}>
              <View style={styles.qualityRow}>
                <View style={styles.qualityTrack}>
                  <View
                    style={[styles.qualityFill, { width: `${Math.round(memory.quality * 100)}%`, backgroundColor: qualityColor(memory.quality) }]}
                  />
                </View>
                <Text style={styles.qualityText}>{memory.quality.toFixed(2)}</Text>
              </View>
              <Text style={styles.rowTime}>{relativeTime(memory.created_at)}</Text>
            </View>
            <ChevronDown
              size={11}
              strokeWidth={1.5}
              color={fg(0.3)}
              style={[styles.rowChevron, { transform: [{ rotate: expanded ? "180deg" : "0deg" }] }]}
            />
          </View>
        )}
      </Pressable>

      {expanded && (
        <Animated.View entering={FadeIn.duration(150)} style={styles.rowExpanded}>
          <View style={styles.editBody}>
            <View>
              <Text style={styles.fieldLabel}>{t("memoriesPanel.fields.text")}</Text>
              <TextInput
                value={text}
                onChangeText={setText}
                multiline
                style={[styles.textInput, styles.textArea]}
              />
            </View>

            <View style={styles.grid2}>
              <View style={styles.gridCol}>
                <Text style={styles.fieldLabel}>{t("memoriesPanel.fields.subject")}</Text>
                <TextInput
                  value={subject}
                  onChangeText={setSubject}
                  placeholder={t("memoriesPanel.subjectPlaceholder")}
                  placeholderTextColor={fg(0.3)}
                  style={styles.textInput}
                />
              </View>
              <View style={styles.gridCol}>
                <Text style={styles.fieldLabel}>{t("memoriesPanel.fields.quality")}</Text>
                <TextInput
                  keyboardType="decimal-pad"
                  value={String(quality)}
                  onChangeText={(txt) => setQuality(Number(txt))}
                  style={[styles.textInput, styles.mono]}
                />
              </View>
            </View>

            <View>
              <Text style={styles.fieldLabel}>{t("memoriesPanel.fields.tags")}</Text>
              <TextInput
                value={tagsText}
                onChangeText={setTagsText}
                style={styles.textInput}
              />
            </View>

            <View style={styles.actionsRow}>
              <Pressable onPress={() => void save()} disabled={!dirty || mutating} accessibilityRole="button">
                {({ pressed }) => (
                  <View style={[styles.primaryBtn, pressed && styles.primaryBtnPressed, (!dirty || mutating) && styles.disabled]}>
                    {mutating ? <Spin size={10} color={BACKGROUND} /> : <Save size={10} strokeWidth={2} color={BACKGROUND} />}
                    <Text style={styles.primaryBtnText}>{t("memoriesPanel.save")}</Text>
                  </View>
                )}
              </Pressable>
              {memory.status === "active" ? (
                <>
                  <Pressable onPress={() => { animateLayout(); setSupersedeOpen((v) => !v); }} disabled={mutating} accessibilityRole="button">
                    {({ pressed }) => (
                      <View style={[styles.secondaryBtn, pressed && styles.secondaryBtnPressed, mutating && styles.disabled]}>
                        <GitBranch size={10} strokeWidth={2} color={fg(0.7)} />
                        <Text style={styles.secondaryBtnText}>{t("memoriesPanel.supersede")}</Text>
                      </View>
                    )}
                  </Pressable>
                  <Pressable onPress={() => void onArchive()} disabled={mutating} accessibilityRole="button">
                    {({ pressed }) => (
                      <View style={[styles.secondaryBtn, pressed && styles.archiveBtnPressed, mutating && styles.disabled]}>
                        <Archive size={10} strokeWidth={2} color={pressed ? RED_600 : fg(0.7)} />
                        <Text style={[styles.secondaryBtnText, pressed && styles.archiveBtnText]}>{t("memoriesPanel.archive")}</Text>
                      </View>
                    )}
                  </Pressable>
                </>
              ) : null}
            </View>

            {supersedeOpen ? (
              <View style={styles.supersedeBox}>
                <Text style={styles.supersedeLabel}>{t("memoriesPanel.replacementText")}</Text>
                <TextInput
                  value={supersedeDraft}
                  onChangeText={setSupersedeDraft}
                  multiline
                  placeholder={t("memoriesPanel.replacementPlaceholder")}
                  placeholderTextColor={fg(0.3)}
                  style={[styles.supersedeInput, styles.textArea]}
                />
                <View style={styles.supersedeActions}>
                  <Pressable
                    onPress={async () => {
                      if (!supersedeDraft.trim()) return;
                      const ok = await onSupersede(supersedeDraft.trim());
                      if (ok) {
                        setSupersedeDraft("");
                        animateLayout();
                        setSupersedeOpen(false);
                      }
                    }}
                    disabled={!supersedeDraft.trim() || mutating}
                    accessibilityRole="button"
                  >
                    {({ pressed }) => (
                      <View style={[styles.confirmSupersedeBtn, pressed && { opacity: 0.9 }, (!supersedeDraft.trim() || mutating) && styles.disabled]}>
                        <Text style={styles.confirmSupersedeText}>{t("memoriesPanel.confirmSupersede")}</Text>
                      </View>
                    )}
                  </Pressable>
                  <Pressable onPress={() => { animateLayout(); setSupersedeOpen(false); }} accessibilityRole="button">
                    {({ pressed }) => (
                      <View style={[styles.cancelSupersedeBtn, pressed && styles.cancelSupersedePressed]}>
                        <Text style={styles.cancelSupersedeText}>{t("common:status.cancel")}</Text>
                      </View>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : null}
          </View>
        </Animated.View>
      )}
    </View>
  );
}

interface CreateMemoryFormProps {
  mutating: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    text: string;
    source: string;
    subject?: string | null;
    quality?: number;
    tags?: string[];
  }) => Promise<void>;
}

function CreateMemoryForm({ mutating, onCancel, onSubmit }: CreateMemoryFormProps) {
  const { t } = useTranslation(["profile", "common"]);
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("self");
  const [quality, setQuality] = useState(0.6);
  const [tagsText, setTagsText] = useState("");

  const disabled = !text.trim() || mutating;

  return (
    <View style={styles.createForm}>
      <View>
        <Text style={styles.fieldLabel}>{t("memoriesPanel.fields.text")}</Text>
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder={t("memoriesPanel.createTextPlaceholder")}
          placeholderTextColor={fg(0.3)}
          style={[styles.createInput, styles.textArea]}
        />
      </View>
      <View style={styles.grid2}>
        <View style={styles.gridCol}>
          <Text style={styles.fieldLabel}>{t("memoriesPanel.fields.subject")}</Text>
          <TextInput
            value={subject}
            onChangeText={setSubject}
            style={styles.createInput}
          />
        </View>
        <View style={styles.gridCol}>
          <Text style={styles.fieldLabel}>{t("memoriesPanel.fields.quality")}</Text>
          <TextInput
            keyboardType="decimal-pad"
            value={String(quality)}
            onChangeText={(txt) => setQuality(Number(txt))}
            style={[styles.createInput, styles.mono]}
          />
        </View>
      </View>
      <View>
        <Text style={styles.fieldLabel}>{t("memoriesPanel.fields.tags")}</Text>
        <TextInput
          value={tagsText}
          onChangeText={setTagsText}
          style={styles.createInput}
        />
      </View>
      <View style={styles.actionsRow}>
        <Pressable
          onPress={() =>
            void onSubmit({
              text: text.trim(),
              source: "manual",
              subject: subject.trim() || null,
              quality,
              tags: tagsText.split(",").map((tag) => tag.trim()).filter(Boolean),
            })
          }
          disabled={disabled}
          accessibilityRole="button"
        >
          {({ pressed }) => (
            <View style={[styles.primaryBtn, pressed && styles.primaryBtnPressed, disabled && styles.disabled]}>
              {mutating ? <Spin size={10} color={BACKGROUND} /> : <Save size={10} strokeWidth={2} color={BACKGROUND} />}
              <Text style={styles.primaryBtnText}>{t("memoriesPanel.create")}</Text>
            </View>
          )}
        </Pressable>
        <Pressable onPress={onCancel} disabled={mutating} accessibilityRole="button">
          {({ pressed }) => (
            <View style={[styles.secondaryBtn, pressed && styles.secondaryBtnPressed, mutating && styles.disabled]}>
              <X size={10} strokeWidth={2} color={fg(0.6)} />
              <Text style={styles.cancelBtnText}>{t("common:status.cancel")}</Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 卡片容器：dev rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: fg(0.03),
    padding: 14,
  },

  // 头部行（mb-2.5）
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerTitle: { fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg(0.5) },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  iconBtn: { padding: 4, borderRadius: 6 },
  iconBtnPressed: { backgroundColor: fg(0.05) },
  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 6,
    backgroundColor: fg(),
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  newBtnPressed: { backgroundColor: fg(0.85) },
  newBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 10, lineHeight: 14, color: BACKGROUND },

  // status tabs（gap-1 mb-2）
  tabsRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 8 },
  tabPill: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  tabPillActive: { backgroundColor: fg() },
  tabPillIdle: { backgroundColor: fg(0.05) },
  tabPillIdlePressed: { backgroundColor: fg(0.1) },
  tabPillTextActive: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: BACKGROUND },
  tabPillTextIdle: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: fg(0.5) },

  // filters（gap-1.5 mb-2）
  filtersRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" },
  // subject select 触发框（dev <select> 观感：bg-white/60 + border + rounded-md + chevron）。
  subjectTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.6)",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  subjectTriggerText: { fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.7) },
  minQualityWrap: { flexDirection: "row", alignItems: "center", gap: 4 },
  minQualityLabel: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.5) },
  minQualityInput: {
    width: 56,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.6)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontFamily: "Menlo",
    fontVariant: ["tabular-nums"],
    fontSize: 10,
    color: fg(),
  },
  rowRange: {
    marginLeft: "auto",
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    lineHeight: 14,
    color: fg(0.4),
    fontVariant: ["tabular-nums"],
  },

  // create form（mb-2）
  createWrap: { marginBottom: 8 },
  createForm: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.7)",
    padding: 10,
    gap: 8,
  },

  // list（space-y-1）
  list: { gap: 4 },
  emptyList: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.4), paddingVertical: 12, textAlign: "center" },

  // memory row：rounded-lg border border-foreground/10 bg-white/50
  row: { borderRadius: 8, borderWidth: 1, borderColor: fg(0.1), backgroundColor: "rgba(255,255,255,0.5)" },
  rowHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 10, paddingVertical: 6 },
  rowHeaderPressed: { backgroundColor: fg(0.05) },
  statusBadge: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  statusBadgeText: { fontFamily: "Inter_600SemiBold", fontSize: 10, lineHeight: 14, letterSpacing: 0.4, textTransform: "uppercase" },
  rowMain: { flex: 1, minWidth: 0 },
  rowText: { fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg() },
  rowMetaRow: { marginTop: 2, flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  metaChip: { borderRadius: 4, backgroundColor: fg(0.05), paddingHorizontal: 4, paddingVertical: 1 },
  metaChipText: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.4) },
  metaChipSubject: { fontFamily: "Inter_500Medium", maxWidth: 72 },
  metaChipSource: { maxWidth: 92 },
  tagChip: { borderRadius: 4, backgroundColor: BLUE_50, paddingHorizontal: 4, paddingVertical: 1, maxWidth: 76 },
  tagChipText: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: BLUE_700 },
  tagOverflow: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.3) },
  rowRight: { alignItems: "flex-end", gap: 2 },
  qualityRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  qualityTrack: { width: 32, height: 4, borderRadius: 999, backgroundColor: fg(0.1), overflow: "hidden" },
  qualityFill: { height: "100%" },
  qualityText: { fontFamily: "Menlo", fontVariant: ["tabular-nums"], fontSize: 10, lineHeight: 14, color: fg(0.5) },
  rowTime: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.4), fontVariant: ["tabular-nums"] },
  rowChevron: { marginTop: 4 },

  // expanded edit（border-t border-foreground/10）
  rowExpanded: { borderTopWidth: 1, borderTopColor: fg(0.1) },
  editBody: { padding: 10, gap: 8 },
  fieldLabel: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, letterSpacing: 0.5, textTransform: "uppercase", color: fg(0.4) },
  // inline 编辑 input（bg-white/60 border-foreground/10 text-caption=11）
  textInput: {
    marginTop: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.6)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    lineHeight: 15,
    color: fg(),
  },
  textArea: { minHeight: 64, textAlignVertical: "top" },
  mono: { fontFamily: "Menlo", fontVariant: ["tabular-nums"] },
  grid2: { flexDirection: "row", gap: 8 },
  gridCol: { flex: 1 },

  // actions（gap-1.5 flex-wrap）
  actionsRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 6,
    backgroundColor: fg(),
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  primaryBtnPressed: { opacity: 0.9 },
  primaryBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 10, lineHeight: 14, color: BACKGROUND },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.6)",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  secondaryBtnPressed: { backgroundColor: fg(0.05) },
  secondaryBtnText: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: fg(0.7) },
  archiveBtnPressed: { backgroundColor: RED_50, borderColor: RED_200 },
  archiveBtnText: { color: RED_600 },
  cancelBtnText: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: fg(0.6) },

  // supersede box（border-blue-200 bg-blue-50/50 p-2）
  supersedeBox: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: BLUE_200,
    backgroundColor: "rgba(239,246,255,0.5)",
    padding: 8,
    gap: 6,
  },
  supersedeLabel: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, letterSpacing: 0.5, textTransform: "uppercase", color: BLUE_700 },
  supersedeInput: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: BLUE_200,
    backgroundColor: "rgba(255,255,255,0.8)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    lineHeight: 15,
    color: fg(),
  },
  supersedeActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  confirmSupersedeBtn: { borderRadius: 6, backgroundColor: BLUE_600, paddingHorizontal: 8, paddingVertical: 4 },
  confirmSupersedeText: { fontFamily: "Inter_600SemiBold", fontSize: 10, lineHeight: 14, color: WHITE },
  cancelSupersedeBtn: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: BLUE_200,
    backgroundColor: "rgba(255,255,255,0.6)",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  cancelSupersedePressed: { backgroundColor: WHITE },
  cancelSupersedeText: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: BLUE_700 },

  // create form input（bg-white/80）
  createInput: {
    marginTop: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.8)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    lineHeight: 15,
    color: fg(),
  },

  // pagination（border-t border-foreground/5 pt-2 mt-2）
  paginationRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: fg(0.05),
    paddingTop: 8,
  },
  pageOf: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.35), fontVariant: ["tabular-nums"] },
  pageBtns: { flexDirection: "row", alignItems: "center", gap: 4 },
  pageBtn: {
    height: 28,
    width: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.6)",
  },
  pageBtnPressed: { backgroundColor: "rgba(255,255,255,0.9)" },
  pageBtnDisabled: { opacity: 0.35 },

  errorText: { marginTop: 8, fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 15, color: RED_500 },

  disabled: { opacity: 0.4 },
});
