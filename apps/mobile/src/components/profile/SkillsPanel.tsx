/**
 * SkillsPanel —— ui-web `profile/SkillsPanel.tsx`（452 行）的 RN 全量移植。
 * 逻辑层零重写：useSkills（@pin-ai/state）/ fetchSkill / Skill / SkillStatus
 * （@pin-ai/core）全部直用；debounce 搜索、dirty 检测、body 懒加载、status 切换、
 * archive、create form 逐字同源。渲染层 <div>→<View>、<input>→<TextInput>、
 * lucide-react→-native、framer-motion→LayoutAnimation + reanimated FadeIn。
 *
 * 卡片介质复刻 dev debug-panel 风格：外壳 rounded-xl border foreground/10
 * bg foreground/[0.03] p-3.5；内层行 rounded-lg bg-white/50。字号按 token 换算成
 * 具体数值（micro=10 / caption=11）。fg() helper 同 ConnectorOnboardingInsight。
 *
 * 展开/折叠与 create form 的 height:auto 动画 → LayoutAnimation.easeInEaseOut
 * （RN 无 height:auto 过渡，既定模式）；ChevronDown 翻转 / Loader2 spin 因 icon
 * 不吃 transform，包 Animated.View 用 reanimated rotate 驱动。
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
import { useTranslation } from "react-i18next";
import {
  Archive,
  BookOpen,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  X,
} from "lucide-react-native";
import { useSkills } from "@pin-ai/state";
import { fetchSkill, type Skill, type SkillStatus } from "@pin-ai/core";

interface SkillsPanelProps {
  enabled: boolean;
}

const STATUS_TABS: SkillStatus[] = ["enabled", "disabled", "archived"];

// --foreground = 230 25% 15%（同 ConnectorOnboardingInsight 的 fg helper）。
const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
// --background = 220 30% 96%（bg-foreground 按钮上的文字 = text-background）。
const BACKGROUND = "hsl(220, 30%, 96%)";
// 表单底色（dev bg-white/50·/60·/70·/80 → rgba white）。
const WHITE_50 = "rgba(255,255,255,0.5)";
const WHITE_60 = "rgba(255,255,255,0.6)";
const WHITE_70 = "rgba(255,255,255,0.7)";
const WHITE_80 = "rgba(255,255,255,0.8)";
// status 徽章配色（dev 用精确 Tailwind 类，逐字对齐取其 hex，不用近似 rgba——
// emerald-50/200/700 · amber-50/200/700 · red-50/200/500/600 · foreground/5·/50·/10）。
const EMERALD_50 = "#ecfdf5";
const EMERALD_200 = "#a7f3d0";
const EMERALD_700 = "#047857";
const AMBER_50 = "#fffbeb";
const AMBER_200 = "#fde68a";
const AMBER_700 = "#b45309";
const RED_50 = "#fef2f2";
const RED_200 = "#fecaca";
const RED_500 = "#ef4444";
const RED_600 = "#dc2626";

interface StatusStyle {
  bg: string;
  text: string;
  border: string;
}

const STATUS_STYLES: Record<SkillStatus, StatusStyle> = {
  enabled: { bg: EMERALD_50, text: EMERALD_700, border: EMERALD_200 },
  disabled: { bg: AMBER_50, text: AMBER_700, border: AMBER_200 },
  archived: { bg: fg(0.05), text: fg(0.5), border: fg(0.1) },
};

/** LayoutAnimation preset for 展开/折叠 + create form（dev height:auto 过渡等价）。 */
function animateLayout() {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
}

/** dev Loader2 / RefreshCw 的 animate-spin（1s linear）。icon 不吃 transform → 包 Animated.View。 */
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

/** dev RefreshCw 在 loading 时 animate-spin，否则静止。 */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  if (spinning) return <Spin size={11} color={fg(0.3)} />;
  return <RefreshCw size={11} strokeWidth={1.5} color={fg(0.3)} />;
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

export default function SkillsPanel({ enabled }: SkillsPanelProps) {
  const { t } = useTranslation("profile");
  const { skills, loading, mutating, error, filter, setFilter, refetch, create, update, archive } =
    useSkills(enabled);

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Debounce client-side filter string.
  useEffect(() => {
    const id = setTimeout(() => {
      setFilter({ ...filter, q: query.trim() || undefined });
    }, 200);
    return () => clearTimeout(id);
    // 依赖刻意只挂 query：debounce 仅跟搜索词变化，filter 自身变化不重启计时器
    // （本仓 lint 未启 react-hooks 规则，注释留意图）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const status = filter.status ?? "enabled";
  const setStatus = (next: SkillStatus) => setFilter({ ...filter, status: next });

  return (
    <View style={styles.panel}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <BookOpen size={14} strokeWidth={1.5} color={fg(0.4)} />
          <Text style={styles.headerTitle}>{t("skillsPanel.title")}</Text>
          {loading ? <Spin size={11} color={fg(0.3)} /> : null}
        </View>
        <View style={styles.headerRight}>
          <Pressable
            onPress={() => void refetch()}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={t("skillsPanel.refresh")}
            hitSlop={6}
          >
            {({ pressed }) => (
              <View style={[styles.iconBtn, pressed && styles.iconBtnPressed, loading && styles.disabled]}>
                <RefreshIcon spinning={loading} />
              </View>
            )}
          </Pressable>
          <Pressable onPress={() => setCreating((v) => !v)} accessibilityRole="button" hitSlop={4}>
            {({ pressed }) => (
              <View style={[styles.primaryBtn, pressed && styles.primaryBtnPressed]}>
                <Plus size={10} strokeWidth={2} color={BACKGROUND} />
                <Text style={styles.primaryBtnText}>{t("skillsPanel.new")}</Text>
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
            <Pressable key={tab} onPress={() => setStatus(tab)} accessibilityRole="button" hitSlop={4}>
              {({ pressed }) => (
                <View
                  style={[
                    styles.tab,
                    active ? styles.tabActive : styles.tabInactive,
                    !active && pressed && styles.tabInactivePressed,
                  ]}
                >
                  <Text style={active ? styles.tabTextActive : styles.tabTextInactive}>
                    {t(`skillsPanel.tabs.${tab}`)}
                  </Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {/* Search */}
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={t("skillsPanel.searchPlaceholder")}
        placeholderTextColor={fg(0.35)}
        style={styles.searchInput}
        autoCapitalize="none"
        autoCorrect={false}
      />

      {/* Create form */}
      {creating ? (
        <Animated.View entering={FadeIn.duration(150)} style={styles.createWrap}>
          <CreateSkillForm
            mutating={mutating}
            onCancel={() => {
              animateLayout();
              setCreating(false);
            }}
            onSubmit={async (input) => {
              const created = await create(input);
              if (created) {
                animateLayout();
                setCreating(false);
              }
            }}
          />
        </Animated.View>
      ) : null}

      {/* List */}
      <View style={styles.list}>
        {skills.length === 0 && !loading ? (
          <Text style={styles.emptyText}>{t(`skillsPanel.emptyList.${status}`)}</Text>
        ) : null}
        {skills.map((skill) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            expanded={expandedId === skill.id}
            onToggle={() => {
              animateLayout();
              setExpandedId(expandedId === skill.id ? null : skill.id);
            }}
            mutating={mutating}
            onUpdate={(patch) => update(skill.id, patch)}
            onArchive={() => archive(skill.id)}
          />
        ))}
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

interface SkillRowProps {
  skill: Skill;
  expanded: boolean;
  mutating: boolean;
  onToggle: () => void;
  onUpdate: (patch: Parameters<ReturnType<typeof useSkills>["update"]>[1]) => Promise<Skill | null>;
  onArchive: () => Promise<boolean>;
}

/** ChevronDown 展开翻转（icon 不吃 transform → 包 Animated.View 用 reanimated rotate）。 */
function ChevronToggle({ expanded }: { expanded: boolean }) {
  const rot = useSharedValue(expanded ? 180 : 0);
  useEffect(() => {
    rot.value = withTiming(expanded ? 180 : 0, { duration: 150 });
  }, [expanded, rot]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <ChevronDown size={11} strokeWidth={1.5} color={fg(0.3)} />
    </Animated.View>
  );
}

function SkillRow({ skill, expanded, mutating, onToggle, onUpdate, onArchive }: SkillRowProps) {
  const { t } = useTranslation("profile");
  const [title, setTitle] = useState(skill.title);
  const [description, setDescription] = useState(skill.description ?? "");
  const [triggersText, setTriggersText] = useState(skill.triggers.join("\n"));
  const [body, setBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);

  useEffect(() => {
    setTitle(skill.title);
    setDescription(skill.description ?? "");
    setTriggersText(skill.triggers.join("\n"));
  }, [skill.title, skill.description, skill.triggers]);

  useEffect(() => {
    if (!expanded) return;
    if (body !== null) return;
    setLoadingBody(true);
    fetchSkill(skill.id)
      .then((res) => setBody(res.skill.body ?? ""))
      .catch(() => setBody(""))
      .finally(() => setLoadingBody(false));
  }, [expanded, skill.id, body]);

  const dirty = useMemo(
    () =>
      title !== skill.title
      || (description || null) !== (skill.description ?? null)
      || triggersText.split("\n").map((s) => s.trim()).filter(Boolean).join("|")
        !== skill.triggers.join("|")
      || (body !== null && body !== (skill.body ?? body)),
    [title, description, triggersText, body, skill],
  );

  const save = async () => {
    const triggers = triggersText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    await onUpdate({
      title: title.trim() || skill.title,
      description: description.trim() ? description : null,
      triggers,
      ...(body !== null ? { body } : {}),
    });
  };

  const toggleStatus = async () => {
    const next = skill.status === "enabled" ? "disabled" : "enabled";
    await onUpdate({ status: next });
  };

  const statusStyle = STATUS_STYLES[skill.status];

  return (
    <View style={styles.row}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded }}>
        {({ pressed }) => (
          <View style={[styles.rowHeader, pressed && styles.rowHeaderPressed]}>
            <View
              style={[
                styles.statusBadge,
                { backgroundColor: statusStyle.bg, borderColor: statusStyle.border },
              ]}
            >
              <Text style={[styles.statusBadgeText, { color: statusStyle.text }]}>
                {t(`skillsPanel.status.${skill.status}`)}
              </Text>
            </View>
            <View style={styles.rowHeaderMain}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {skill.title}
              </Text>
              {skill.description ? (
                <Text style={styles.rowDescription} numberOfLines={1}>
                  {skill.description}
                </Text>
              ) : null}
            </View>
            <Text style={styles.rowMeta}>
              r{skill.revision} · {relativeTime(skill.updated_at)}
            </Text>
            <ChevronToggle expanded={expanded} />
          </View>
        )}
      </Pressable>

      {expanded ? (
        <View style={styles.rowBody}>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t("skillsPanel.fields.title")}</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              style={styles.fieldInput}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t("skillsPanel.fields.description")}</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder={t("skillsPanel.optionalPlaceholder")}
              placeholderTextColor={fg(0.35)}
              style={styles.fieldInput}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t("skillsPanel.fields.triggers")}</Text>
            <TextInput
              value={triggersText}
              onChangeText={setTriggersText}
              multiline
              numberOfLines={3}
              style={[styles.fieldInput, styles.fieldInputMono, styles.fieldInputMulti3]}
              autoCapitalize="none"
              autoCorrect={false}
              textAlignVertical="top"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t("skillsPanel.fields.body")}</Text>
            {loadingBody && body === null ? (
              <Text style={styles.loadingBody}>{t("skillsPanel.loadingBody")}</Text>
            ) : (
              <TextInput
                value={body ?? ""}
                onChangeText={setBody}
                multiline
                numberOfLines={8}
                style={[styles.fieldInput, styles.fieldInputMono, styles.fieldInputMulti8]}
                autoCapitalize="none"
                autoCorrect={false}
                textAlignVertical="top"
              />
            )}
          </View>

          <View style={styles.actionsRow}>
            <Pressable
              onPress={() => void save()}
              disabled={!dirty || mutating}
              accessibilityRole="button"
              hitSlop={4}
            >
              {({ pressed }) => (
                <View
                  style={[
                    styles.primaryBtn,
                    pressed && styles.primaryBtnPressed,
                    (!dirty || mutating) && styles.disabled,
                  ]}
                >
                  {mutating ? (
                    <Spin size={10} color={BACKGROUND} strokeWidth={2} />
                  ) : (
                    <Save size={10} color={BACKGROUND} />
                  )}
                  <Text style={styles.primaryBtnText}>{t("skillsPanel.save")}</Text>
                </View>
              )}
            </Pressable>
            {skill.status !== "archived" ? (
              <Pressable
                onPress={() => void toggleStatus()}
                disabled={mutating}
                accessibilityRole="button"
                hitSlop={4}
              >
                {({ pressed }) => (
                  <View style={[styles.secondaryBtn, pressed && styles.secondaryBtnPressed, mutating && styles.disabled]}>
                    <Text style={styles.secondaryBtnText}>
                      {skill.status === "enabled" ? t("skillsPanel.disable") : t("skillsPanel.enable")}
                    </Text>
                  </View>
                )}
              </Pressable>
            ) : null}
            {skill.status !== "archived" ? (
              <Pressable
                onPress={() => void onArchive()}
                disabled={mutating}
                accessibilityRole="button"
                hitSlop={4}
              >
                {({ pressed }) => (
                  <View
                    style={[
                      styles.secondaryBtn,
                      styles.archiveBtn,
                      pressed && styles.archiveBtnPressed,
                      mutating && styles.disabled,
                    ]}
                  >
                    <Archive size={10} color={pressed ? RED_600 : fg(0.7)} />
                    <Text style={[styles.secondaryBtnText, pressed && styles.archiveBtnText]}>
                      {t("skillsPanel.archive")}
                    </Text>
                  </View>
                )}
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

interface CreateSkillFormProps {
  mutating: boolean;
  onCancel: () => void;
  onSubmit: (input: { title: string; body: string; description?: string | null; triggers?: string[] }) => Promise<void>;
}

function CreateSkillForm({ mutating, onCancel, onSubmit }: CreateSkillFormProps) {
  const { t } = useTranslation(["profile", "common"]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [triggersText, setTriggersText] = useState("");
  const [body, setBody] = useState("");

  const disabled = !title.trim() || !body.trim() || mutating;

  return (
    <View style={styles.createForm}>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{t("skillsPanel.fields.title")}</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          style={[styles.fieldInput, styles.fieldInputCreate]}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{t("skillsPanel.fields.description")}</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          style={[styles.fieldInput, styles.fieldInputCreate]}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{t("skillsPanel.fields.triggers")}</Text>
        <TextInput
          value={triggersText}
          onChangeText={setTriggersText}
          multiline
          numberOfLines={2}
          style={[styles.fieldInput, styles.fieldInputCreate, styles.fieldInputMono, styles.fieldInputMulti2]}
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{t("skillsPanel.fields.body")}</Text>
        <TextInput
          value={body}
          onChangeText={setBody}
          multiline
          numberOfLines={6}
          placeholder={t("skillsPanel.bodyPlaceholder")}
          placeholderTextColor={fg(0.35)}
          style={[styles.fieldInput, styles.fieldInputCreate, styles.fieldInputMono, styles.fieldInputMulti6]}
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
        />
      </View>
      <View style={styles.actionsRow}>
        <Pressable
          onPress={() =>
            void onSubmit({
              title: title.trim(),
              body,
              description: description.trim() ? description : null,
              triggers: triggersText.split("\n").map((s) => s.trim()).filter(Boolean),
            })
          }
          disabled={disabled}
          accessibilityRole="button"
          hitSlop={4}
        >
          {({ pressed }) => (
            <View style={[styles.primaryBtn, pressed && styles.primaryBtnPressed, disabled && styles.disabled]}>
              {mutating ? (
                <Spin size={10} color={BACKGROUND} strokeWidth={2} />
              ) : (
                <Save size={10} color={BACKGROUND} />
              )}
              <Text style={styles.primaryBtnText}>{t("skillsPanel.create")}</Text>
            </View>
          )}
        </Pressable>
        <Pressable onPress={onCancel} disabled={mutating} accessibilityRole="button" hitSlop={4}>
          {({ pressed }) => (
            <View style={[styles.cancelBtn, pressed && styles.cancelBtnPressed, mutating && styles.disabled]}>
              <X size={10} color={fg(0.6)} />
              <Text style={styles.cancelBtnText}>{t("common:status.cancel")}</Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 外壳 dev rounded-xl border foreground/10 bg foreground/[0.03] p-3.5。
  panel: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: fg(0.03),
    padding: 14,
  },

  // header
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10, // mb-2.5
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerTitle: { fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg(0.5) }, // text-xs font-medium foreground/50
  headerRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  iconBtn: { padding: 4, borderRadius: 6 },
  iconBtnPressed: { backgroundColor: fg(0.05) },
  // dev bg-foreground text-background text-micro(10) font-semibold px-2 py-1 rounded-md。
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 6,
    backgroundColor: fg(),
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  primaryBtnPressed: { opacity: 0.85 }, // hover:bg-foreground/85
  primaryBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 10, lineHeight: 14, color: BACKGROUND },

  // status tabs（dev gap-1 mb-2；pill px-2 py-0.5 text-micro）。
  tabsRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 8 },
  tab: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  tabActive: { backgroundColor: fg() },
  tabInactive: { backgroundColor: fg(0.05) },
  tabInactivePressed: { backgroundColor: fg(0.1) }, // hover:bg-foreground/10
  tabTextActive: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: BACKGROUND },
  tabTextInactive: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: fg(0.5) },

  // search（dev w-full bg-white/60 border foreground/10 px-2 py-1 text-caption mb-2）。
  searchInput: {
    borderRadius: 6,
    backgroundColor: WHITE_60,
    borderWidth: 1,
    borderColor: fg(0.1),
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    lineHeight: 15,
    color: fg(),
    marginBottom: 8,
  },

  createWrap: { marginBottom: 8 },
  // create form 卡（dev rounded-lg border foreground/10 bg-white/70 p-2.5）。
  createForm: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: WHITE_70,
    padding: 10,
    gap: 8,
  },

  // list（dev space-y-1）。
  list: { gap: 4 },
  emptyText: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    lineHeight: 14,
    color: fg(0.4),
    paddingVertical: 12,
    textAlign: "center",
  },

  // row（dev rounded-lg border foreground/10 bg-white/50）。
  row: { borderRadius: 8, borderWidth: 1, borderColor: fg(0.1), backgroundColor: WHITE_50, overflow: "hidden" },
  rowHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 6 }, // px-2.5 py-1.5
  rowHeaderPressed: { backgroundColor: fg(0.05) },
  // status 徽章（dev rounded-md border px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide）。
  statusBadge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  statusBadgeText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.25, // tracking-wide
    textTransform: "uppercase",
  },
  rowHeaderMain: { flex: 1, minWidth: 0 },
  rowTitle: { fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: fg() }, // caption medium foreground
  rowDescription: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.5) }, // micro foreground/50
  rowMeta: {
    fontFamily: "Menlo",
    fontSize: 10,
    lineHeight: 14,
    color: fg(0.4),
    fontVariant: ["tabular-nums"],
  },

  // row body（dev border-t + p-2.5 space-y-2）。
  rowBody: {
    borderTopWidth: 1,
    borderTopColor: fg(0.1),
    padding: 10,
    gap: 8,
  },

  // 表单字段（dev label block → Text；micro medium uppercase tracking-wider foreground/40）。
  field: { gap: 2 }, // mt-0.5 between label & input
  fieldLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.5, // tracking-wider
    textTransform: "uppercase",
    color: fg(0.4),
  },
  // input（dev rounded-md bg-white/60 border foreground/10 px-2 py-1 text-caption）。
  fieldInput: {
    borderRadius: 6,
    backgroundColor: WHITE_60,
    borderWidth: 1,
    borderColor: fg(0.1),
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    lineHeight: 15,
    color: fg(),
  },
  fieldInputCreate: { backgroundColor: WHITE_80 }, // create form 用 bg-white/80
  fieldInputMono: { fontFamily: "Menlo" }, // font-mono
  // multiline 高度 ≈ rows × lineHeight + padding（RN 无 rows 属性，按行高估算最小高）。
  fieldInputMulti2: { minHeight: 15 * 2 + 12 },
  fieldInputMulti3: { minHeight: 15 * 3 + 12 },
  fieldInputMulti6: { minHeight: 15 * 6 + 12 },
  fieldInputMulti8: { minHeight: 15 * 8 + 12 },
  loadingBody: { fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.4), paddingVertical: 8 },

  // actions（dev flex gap-1.5）。
  actionsRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  // secondary（dev border foreground/10 bg-white/60 text-foreground/70 text-micro font-medium px-2 py-1）。
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: WHITE_60,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  secondaryBtnPressed: { backgroundColor: fg(0.05) },
  secondaryBtnText: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: fg(0.7) },
  // archive 按下 → hover:bg-red-50 text-red-600 border-red-200。
  archiveBtn: {},
  archiveBtnPressed: { backgroundColor: RED_50, borderColor: RED_200 },
  archiveBtnText: { color: RED_600 },

  // cancel（dev border foreground/10 bg-white/60 text-foreground/60 text-micro font-medium）。
  cancelBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: WHITE_60,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  cancelBtnPressed: { backgroundColor: fg(0.05) },
  cancelBtnText: { fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: fg(0.6) },

  disabled: { opacity: 0.4 }, // disabled:opacity-40

  // error（dev Text micro block mt-2 text-red-500 leading-snug）。
  errorText: { marginTop: 8, fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: RED_500 },
});
