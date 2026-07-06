/**
 * DATA SOURCES 区——web `ui-web/connect/DataConnections.tsx`（1720 行）的 RN
 * 介质版。逻辑（state 机 / handleConnect / catalog 分页 / custom MCP CRUD）
 * 逐字对齐 web；数据层复用 @pin-ai/state 的 ComposioState + useInitTask。
 *
 * 介质映射（web → RN）：
 * - AnimatePresence height 折叠 → LayoutAnimation（本项目既定）。
 * - catalog 类目 `<select>`（dev = WKWebView 自动系统 UIMenu）→
 *   `@react-native-menu/menu` MenuView（AmbientModelsPanel Select 同款系统菜单）。
 * - OAuth popup（dev = @capacitor/browser）→ expo-web-browser（./oauth-surface）。
 * - custom MCP 居中 dialog → RN Modal（fade + 卡片 entering y18/scale.98/180ms 对齐
 *   web motion）。
 * - **hover 专属控件在触屏无 hover**：web `opacity-0 group-hover:opacity-100` 的
 *   Add / 子账户 Disconnect 按钮 RN **常显**；"Connected"⇄"Disconnect" 的 hover
 *   互换改为**两击**（tap1 = 变红 Disconnect（= dev 触屏首 tap 触发 hover），
 *   tap2 = 执行）——armedDisconnectId 状态。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FlatList,
  Image,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, { FadeIn, FadeInUp } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { SvgCss } from "react-native-svg/css";
import { MenuView } from "@react-native-menu/menu";
import {
  Briefcase,
  Calendar,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Code,
  CreditCard,
  FileText,
  FolderOpen,
  Globe2,
  Mail,
  MessageSquare,
  Pencil,
  Plus,
  Presentation,
  Search,
  Table2,
  Trash2,
  Users,
  Video,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react-native";
import { getComposioConnectionsForToolkit, normalizeComposioToolkit } from "@pin-ai/core";
import { resolveComposioConnectionIdentity } from "@pin-ai/core";
import {
  useInitTask,
  type ComposioCatalogItem,
  type ComposioState,
  type Connection,
} from "@pin-ai/state";

import i18n from "../../i18n";
import type connectEn from "../../../../../packages/ui-kit/src/locales/en/connect.json";
import { GlassCard } from "../../ui/GlassCard";
import { Spinner } from "../../ui/Spinner";
import InitTaskChip from "./InitTaskChip";
import { BrowserLoginsSection } from "./BrowserLoginsSection";
import { closeOAuthSurface, openOAuthAndAwaitClose } from "./oauth-surface";

const FG = "29,33,48";
const fg = (a: number) => `rgba(${FG},${a})`;
const EMERALD_600 = "#059669";
const RED_500 = "#ef4444";
const BACKGROUND = "#f2f4f8"; // --background hsl(220 30% 96%)

// ---------------------------------------------------------------------------
// Source catalog data —— web 同名结构（icon 换 lucide-react-native）
// ---------------------------------------------------------------------------

type CoverageNoteKey = keyof typeof connectEn.dataConnections.coverage;
type CategoryLabelKey = keyof typeof connectEn.dataConnections.categories;

export interface DataSource {
  name: string;
  composioId?: string;
  description: string;
  icon: LucideIcon;
  tier: 0 | 1 | 2;
  children?: DataSource[];
  /** dataConnections.coverage.* 的 i18n key（web 同款）。 */
  coverageNoteKey?: CoverageNoteKey;
  showInitTask?: boolean;
}

export interface InputCategory {
  /** name + description 的 i18n key（dataConnections.categories.*，web 同款）。 */
  labelKey: CategoryLabelKey;
  /** 稳定 id：React key / 展开态值用，不直接显示。 */
  name: string;
  icon: LucideIcon;
  sources: DataSource[];
}

export const RECOMMENDED_SOURCES: DataSource[] = [
  {
    name: "Google Workspace",
    composioId: "googlesuper",
    description: "Gmail, Calendar, Drive, Docs, Sheets, Slides",
    icon: FolderOpen,
    tier: 0,
    children: [
      { name: "Gmail", composioId: "gmail", description: "Email messages", icon: Mail, tier: 0 },
      { name: "Calendar", composioId: "googlecalendar", description: "Events and scheduling", icon: Calendar, tier: 0 },
      { name: "Drive", composioId: "googledrive", description: "Files and folders", icon: FolderOpen, tier: 0 },
      { name: "Docs", composioId: "googledocs", description: "Documents", icon: FileText, tier: 0 },
      { name: "Sheets", composioId: "googlesheets", description: "Spreadsheets", icon: Table2, tier: 0 },
      {
        name: "Slides",
        composioId: "googledrive",
        description: "Presentations",
        icon: Presentation,
        tier: 0,
        coverageNoteKey: "viaDriveMetadata",
        showInitTask: false,
      },
    ],
  },
  { name: "Slack", composioId: "slack", description: "Channels and messages", icon: MessageSquare, tier: 0 },
  { name: "GitHub", composioId: "github", description: "Repositories, issues, PRs", icon: Code, tier: 0 },
  { name: "LinkedIn", composioId: "linkedin", description: "Professional network", icon: Users, tier: 0 },
  { name: "Stripe", composioId: "stripe", description: "Invoices and billing", icon: CreditCard, tier: 0 },
  { name: "YouTube", composioId: "youtube", description: "Subscriptions", icon: Video, tier: 0 },
  { name: "Calendly", composioId: "calendly", description: "Scheduling links", icon: Calendar, tier: 0 },
];

export const INPUT_CATEGORIES: InputCategory[] = [
  {
    labelKey: "recommended",
    name: "Recommended",
    icon: Briefcase,
    sources: RECOMMENDED_SOURCES,
  },
];

const CATALOG_PAGE_SIZE = 40;
const RECOMMENDED_CATALOG_TOOLKITS = new Set(
  RECOMMENDED_SOURCES.flatMap((source) => [
    source.composioId,
    ...(source.children ?? []).map((child) => child.composioId),
  ])
    .filter((toolkit): toolkit is string => Boolean(toolkit))
    .map((toolkit) => normalizeComposioToolkit(toolkit)),
);

/** web CATALOG_CATEGORIES 同款（labelKey → dataConnections.catalog.categories.*）。 */
const CATALOG_CATEGORIES = [
  { value: "", labelKey: "all" },
  { value: "email", labelKey: "email" },
  { value: "calendar", labelKey: "calendar" },
  { value: "team-chat", labelKey: "teamChat" },
  { value: "productivity", labelKey: "productivity" },
  { value: "developer-tools", labelKey: "devTools" },
  { value: "crm", labelKey: "crm" },
  { value: "project-management", labelKey: "projects" },
  { value: "documents", labelKey: "documents" },
  { value: "databases", labelKey: "databases" },
  { value: "analytics", labelKey: "analytics" },
  { value: "marketing-automation", labelKey: "marketing" },
  { value: "ecommerce", labelKey: "ecommerce" },
  { value: "scheduling & booking", labelKey: "scheduling" },
  { value: "file management & storage", labelKey: "files" },
  { value: "video & audio", labelKey: "videoAudio" },
] as const satisfies ReadonlyArray<{
  value: string;
  labelKey: keyof typeof connectEn.dataConnections.catalog.categories;
}>;

function formatCount(value: number): string {
  return new Intl.NumberFormat(i18n.language || "en").format(value);
}

function getComposioLogoUrl(toolkit: string | undefined): string | null {
  if (!toolkit) return null;
  return `https://logos.composio.dev/api/${normalizeComposioToolkit(toolkit)}`;
}

export function isDataSourceConnected(source: DataSource, connections: Connection[]): boolean {
  if (source.composioId && getComposioConnectionsForToolkit(connections, source.composioId).length > 0) {
    return true;
  }
  return (source.children ?? []).some(
    (child) => child.composioId && getComposioConnectionsForToolkit(connections, child.composioId).length > 0,
  );
}

function resolveIdentity(conn: Connection, allConnections: Connection[]): string | null {
  return resolveComposioConnectionIdentity(conn, allConnections);
}

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

/** logos.composio.dev 返回 image/svg+xml（curl 实测）。 */
function isSvgLogo(url: string): boolean {
  return url.includes("logos.composio.dev") || url.toLowerCase().endsWith(".svg");
}

/** 百分比 rgb()/rgba() → 整数 rgb()。react-native-svg 的 gradient stop 路径走
 *  RN processColor（不认百分比语法，extractGradient 直接丢弃该 stop → 渐变消失，
 *  outlook logo 只剩白环，2026-07-01 真机踩过；库只在 fill/stroke 路径接了
 *  convertPercentageColor）。渲染前统一预归一化，任何位置的百分比色都覆盖。 */
const PERCENT_RGB = /rgba?\(\s*([\d.]+)%\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+%?))?\s*\)/gi;
function normalizeSvgPercentColors(svg: string): string {
  const to255 = (v: string) => Math.round(parseFloat(v) * 2.55);
  return svg.replace(PERCENT_RGB, (_m, r: string, g: string, b: string, a?: string) => {
    if (a !== undefined) {
      const alpha = a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
      return `rgba(${to255(r)},${to255(g)},${to255(b)},${alpha})`;
    }
    return `rgb(${to255(r)},${to255(g)},${to255(b)})`;
  });
}

/** 模块级 xml 缓存：catalog 滚动会挂载大量行，同一 logo 只 fetch 一次；失败剔除给重试机会。 */
const svgXmlCache = new Map<string, Promise<string>>();
function fetchSvgXml(uri: string): Promise<string> {
  let pending = svgXmlCache.get(uri);
  if (!pending) {
    pending = fetch(uri)
      .then((res) => {
        if (!res.ok) throw new Error(`logo ${res.status}`);
        return res.text();
      })
      .then(normalizeSvgPercentColors);
    pending.catch(() => svgXmlCache.delete(uri));
    svgXmlCache.set(uri, pending);
  }
  return pending;
}

/** 远程 SVG logo：fetch 文本 → 预归一化百分比色 → SvgCss（比 SvgUri 多 <style>
 *  CSS 支持，第三方 logo 常见）。加载中/失败由父层 fallback。 */
function SvgLogo({ uri, onError }: { uri: string; onError: () => void }) {
  const [xml, setXml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchSvgXml(uri)
      .then((x) => {
        if (!cancelled) setXml(x);
      })
      .catch(() => {
        if (!cancelled) onError();
      });
    return () => {
      cancelled = true;
    };
    // onError = 父组件 setState，引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);
  if (!xml) return null;
  return <SvgCss xml={xml} width={20} height={20} />;
}

/** 品牌 logo（失败回退 lucide 图标）——web ConnectorIconSlot。
 *  ⚠️ RN 的 Image 不渲 SVG（web `<img>` 可以）——composio logo API 全是
 *  image/svg+xml，走 SvgLogo（fetch+归一化+SvgCss）；catalog item.logo
 *  可能是位图 URL，仍走 Image。 */
function ConnectorIconSlot({
  logo,
  Icon,
  iconColor,
  size = 14,
}: {
  logo: string | null;
  Icon: LucideIcon;
  iconColor: string;
  size?: number;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <View style={styles.iconSlot}>
      {logo && !logoFailed ? (
        isSvgLogo(logo) ? (
          <View style={styles.iconLogoClip}>
            <SvgLogo uri={logo} onError={() => setLogoFailed(true)} />
          </View>
        ) : (
          <Image
            source={{ uri: logo }}
            style={styles.iconLogo}
            onError={() => setLogoFailed(true)}
          />
        )
      ) : (
        <Icon size={size} strokeWidth={1.5} color={iconColor} />
      )}
    </View>
  );
}

/** 动作小胶囊（Connect/Add/Cancel/Load…）——web text-micro/500 bg-fg6 border-fg12 rounded-lg。 */
function PillButton({
  onPress,
  disabled,
  muted,
  wide,
  children,
}: {
  onPress: () => void;
  disabled?: boolean;
  /** Cancel 态的 fg/50 文字。 */
  muted?: boolean;
  /** px-2.5（默认 px-2）。 */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button">
      <View style={[styles.pillBtn, wide && styles.pillBtnWide, disabled && styles.disabled40]}>
        <View style={styles.rowGap4}>
          {typeof children === "string" ? (
            <Text style={[styles.pillBtnText, muted && { color: fg(0.5) }]}>{children}</Text>
          ) : (
            children
          )}
        </View>
      </View>
    </Pressable>
  );
}

/** "Connected"⇄"Disconnect" 两击钮（= dev 触屏 hover 首 tap 的等价交互）。 */
function ConnectedToggle({
  accountId,
  armedId,
  disconnectingId,
  onArm,
  onDisconnect,
}: {
  accountId: string;
  armedId: string | null;
  disconnectingId: string | null;
  onArm: (id: string) => void;
  onDisconnect: (id: string) => void;
}) {
  const { t } = useTranslation("connect");
  const armed = armedId === accountId;
  const busy = disconnectingId === accountId;
  return (
    <Pressable
      onPress={() => (armed ? onDisconnect(accountId) : onArm(accountId))}
      disabled={busy}
      accessibilityRole="button"
    >
      <View style={[styles.togglePill, armed && styles.togglePillArmed, busy && styles.disabled40]}>
        {busy ? (
          <Spinner size={10} color={RED_500} />
        ) : (
          <Text style={[styles.togglePillText, armed && { color: RED_500 }]}>
            {armed ? t("dataConnections.disconnect") : t("dataConnections.connected")}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** 子账户行的直接 Disconnect 文本钮（web hover 显，RN 常显）。 */
function SubDisconnectButton({
  accountId,
  disconnectingId,
  onDisconnect,
}: {
  accountId: string;
  disconnectingId: string | null;
  onDisconnect: (id: string) => void;
}) {
  const { t } = useTranslation("connect");
  const busy = disconnectingId === accountId;
  return (
    <Pressable onPress={() => onDisconnect(accountId)} disabled={busy} accessibilityRole="button">
      <View style={[styles.subDisconnect, busy && styles.disabled40]}>
        {busy ? (
          <Spinner size={10} color={RED_500} />
        ) : (
          <Text style={styles.subDisconnectText}>{t("dataConnections.disconnect")}</Text>
        )}
      </View>
    </Pressable>
  );
}

/** catalog 类目下拉——dev `<select>` 的系统 UIMenu 等价（AmbientModelsPanel Select 同款模式），
 *  触发框逐字对齐 web select className：rounded-xl(12) border-fg10 bg-fg3 px-2 py-2 text-xs。 */
function CatalogCategorySelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("connect");
  const current = CATALOG_CATEGORIES.find((c) => c.value === value) ?? CATALOG_CATEGORIES[0];
  return (
    <MenuView
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => {
        // MenuView id 不接受空串，"" 类目用哨兵 "__all__" 走一层转换。
        onChange(nativeEvent.event === "__all__" ? "" : nativeEvent.event);
      }}
      actions={CATALOG_CATEGORIES.map((c) => ({
        id: c.value === "" ? "__all__" : c.value,
        title: t(`dataConnections.catalog.categories.${c.labelKey}`),
        state: (c.value === value ? "on" : "off") as "on" | "off",
      }))}
    >
      <View style={styles.categoryTrigger}>
        <Text style={styles.categoryTriggerText} numberOfLines={1}>
          {t(`dataConnections.catalog.categories.${current.labelKey}`)}
        </Text>
        <ChevronsUpDown size={12} strokeWidth={1.75} color={fg(0.4)} />
      </View>
    </MenuView>
  );
}

// ---------------------------------------------------------------------------
// Custom MCP
// ---------------------------------------------------------------------------

interface CustomConnector {
  id: string;
  slug: string;
  name: string;
  url: string;
  rawInserted?: number;
  fetched?: number;
  evolveTaskId?: string;
  lastError?: string;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isCustomMcpConnection(conn: Connection): boolean {
  return conn.status === "ACTIVE" && conn.userInfo?.type === "custom_mcp";
}

function customConnectorFromConnection(conn: Connection): CustomConnector | null {
  if (!isCustomMcpConnection(conn) || !conn.connectedAccountId) return null;
  const url = typeof conn.userInfo?.url === "string" ? conn.userInfo.url : "";
  const fetched = finiteNumber(conn.userInfo?.lastFetchedCount) ?? undefined;
  const rawInserted = finiteNumber(conn.userInfo?.lastRawInsertedCount) ?? undefined;
  const evolveTaskId =
    typeof conn.userInfo?.lastEvolveTaskId === "string" ? conn.userInfo.lastEvolveTaskId : undefined;
  const lastError = typeof conn.userInfo?.lastError === "string" ? conn.userInfo.lastError : undefined;
  return {
    id: conn.connectedAccountId,
    slug: conn.toolkit,
    name: conn.label ?? conn.toolkit,
    url,
    fetched,
    rawInserted,
    evolveTaskId,
    lastError,
  };
}

function CustomMcpStatus({ connector }: { connector: CustomConnector }) {
  const { t } = useTranslation("connect");
  const { task } = useInitTask(connector.evolveTaskId ?? null);
  const fetched = connector.fetched ?? connector.rawInserted;
  const isDistilling = task?.status === "queued" || task?.status === "running";
  if (connector.lastError) {
    return <Text style={styles.mcpStatusFailed}>{t("dataConnections.customMcp.syncFailed")}</Text>;
  }
  if (typeof fetched === "number") {
    return (
      <Text style={styles.mcpStatusOk}>
        {`${t("dataConnections.customMcp.fetched", { value: formatCount(fetched) })}${
          isDistilling ? ` · ${t("dataConnections.customMcp.distilling")}` : ""
        }`}
      </Text>
    );
  }
  return <Text style={styles.mcpStatusOk}>{t("dataConnections.customMcp.connected")}</Text>;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface DataConnectionsProps {
  composio: ComposioState;
}

export default function DataConnections({ composio }: DataConnectionsProps) {
  const { t } = useTranslation(["connect", "common"]);
  const {
    keyStatus,
    connections,
    statusLoading,
    connectToolkit,
    loadCatalog,
    disconnectAccount,
    waitForToolkit,
    cancelWait,
    createCustomMcpConnector,
    updateCustomMcpConnector,
    deleteCustomMcpConnector,
  } = composio;

  const [expandedCategory, setExpandedCategory] = useState<string | null>("Recommended");
  const [connectingToolkit, setConnectingToolkit] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  /** 两击 disconnect 的「已武装」账户（见文件头 hover 映射说明）。 */
  const [armedDisconnectId, setArmedDisconnectId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogItems, setCatalogItems] = useState<ComposioCatalogItem[]>([]);
  const [catalogCursor, setCatalogCursor] = useState<string | null>(null);
  const [catalogTotalCount, setCatalogTotalCount] = useState<number | null>(null);
  const [catalogCategory, setCatalogCategory] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [debouncedCatalogQuery, setDebouncedCatalogQuery] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const [customSubmitting, setCustomSubmitting] = useState(false);
  const [editingCustomConnector, setEditingCustomConnector] = useState<CustomConnector | null>(null);
  const [optimisticCustomConnectors, setOptimisticCustomConnectors] = useState<CustomConnector[]>([]);

  const countConnected = (category: InputCategory) =>
    category.sources.filter((source) => isDataSourceConnected(source, connections)).length;

  const backendCustomConnectors = useMemo(
    () =>
      connections
        .map(customConnectorFromConnection)
        .filter((connector): connector is CustomConnector => connector !== null),
    [connections],
  );
  const customConnectors = useMemo(() => {
    const byId = new Map<string, CustomConnector>();
    for (const connector of optimisticCustomConnectors) byId.set(connector.id, connector);
    for (const connector of backendCustomConnectors) byId.set(connector.id, connector);
    return Array.from(byId.values());
  }, [backendCustomConnectors, optimisticCustomConnectors]);

  const cancelledRef = useRef(false);
  const catalogRequestRef = useRef(0);

  const handleConnect = async (composioId: string) => {
    setConnectingToolkit(composioId);
    setConnectError(null);
    cancelledRef.current = false;
    try {
      const result = await connectToolkit(composioId);
      if (!result.ok) {
        setConnectError(result.error ?? t("dataConnections.errors.connectFailed"));
        return;
      }
      if (!result.redirectUrl && result.connectedAccountId) {
        await composio.loadConnections();
        return;
      }
      if (!result.redirectUrl || !result.connectedAccountId) {
        if (result.ok) setConnectError(t("dataConnections.errors.missingRedirect"));
        return;
      }
      void waitForToolkit(result.connectedAccountId)
        .then(async (waitResult) => {
          if (cancelledRef.current) return;
          if (waitResult.connected) {
            // 后端已确认 ACTIVE：Composio hosted 成功页不会自己关，主动收掉。
            await closeOAuthSurface();
          }
          await composio.loadConnections();
        })
        .catch(() => undefined);

      await openOAuthAndAwaitClose(result.redirectUrl);
      if (!cancelledRef.current) {
        void composio.loadConnections();
      }
    } catch (err) {
      if (!cancelledRef.current)
        setConnectError(err instanceof Error ? err.message : t("dataConnections.errors.unexpected"));
    } finally {
      setConnectingToolkit(null);
    }
  };

  const loadCatalogPage = async (
    reset = false,
    category = catalogCategory,
    query = debouncedCatalogQuery,
  ) => {
    const requestId = ++catalogRequestRef.current;
    if (reset) setCatalogLoaded(false);
    setCatalogLoading(true);
    setCatalogError(null);
    const result = await loadCatalog({
      category: category || undefined,
      query: query || undefined,
      cursor: reset ? undefined : catalogCursor ?? undefined,
      limit: CATALOG_PAGE_SIZE,
    });
    if (requestId !== catalogRequestRef.current) return;
    setCatalogLoading(false);
    if (!result.ok || !result.page) {
      setCatalogError(result.error ?? t("dataConnections.errors.catalogUnavailable"));
      return;
    }
    const page = result.page;
    setCatalogItems((prev) => (reset ? page.items : [...prev, ...page.items]));
    setCatalogCursor(page.nextCursor);
    setCatalogTotalCount(page.totalCount);
    setCatalogLoaded(true);
  };

  const handleToggleCatalog = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(220, "easeInEaseOut", "opacity"));
    setCatalogOpen((open) => !open);
  };

  const toggleCategory = (name: string, isExpanded: boolean) => {
    LayoutAnimation.configureNext(LayoutAnimation.create(250, "easeInEaseOut", "opacity"));
    setExpandedCategory(isExpanded ? null : name);
  };

  const catalogTotalLabel =
    catalogTotalCount !== null
      ? t("dataConnections.catalog.supportedCount", { total: formatCount(catalogTotalCount) })
      : t("dataConnections.catalog.supportedFallback");
  const catalogDisplayItems = useMemo(
    () =>
      catalogItems
        .map((item, index) => ({
          item,
          index,
          isRecommended: RECOMMENDED_CATALOG_TOOLKITS.has(normalizeComposioToolkit(item.slug)),
        }))
        .sort((a, b) => Number(a.isRecommended) - Number(b.isRecommended) || a.index - b.index)
        .map(({ item }) => item),
    [catalogItems],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedCatalogQuery(catalogQuery.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [catalogQuery]);

  useEffect(() => {
    if (!catalogOpen) return;
    setCatalogItems([]);
    setCatalogCursor(null);
    setCatalogTotalCount(null);
    setCatalogLoaded(false);
    void loadCatalogPage(true, catalogCategory, debouncedCatalogQuery);
    // web 同款依赖（loadCatalogPage 非稳定引用，按值触发）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogOpen, catalogCategory, debouncedCatalogQuery]);

  const openAddCustomConnector = () => {
    setEditingCustomConnector(null);
    setCustomName("");
    setCustomUrl("");
    setCustomError(null);
    setCustomOpen(true);
  };

  const openEditCustomConnector = (connector: CustomConnector) => {
    setEditingCustomConnector(connector);
    setCustomName(connector.name);
    setCustomUrl(connector.url);
    setCustomError(null);
    setCustomOpen(true);
  };

  const closeCustomConnectorDialog = () => {
    setCustomOpen(false);
    setEditingCustomConnector(null);
    setCustomError(null);
  };

  const handleCustomConnect = async () => {
    const name = customName.trim();
    const url = customUrl.trim();
    setCustomError(null);
    if (!name) {
      setCustomError(t("dataConnections.customMcp.nameRequired"));
      return;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        setCustomError(t("dataConnections.customMcp.httpsRequired"));
        return;
      }
    } catch {
      setCustomError(t("dataConnections.customMcp.urlInvalid"));
      return;
    }
    setCustomSubmitting(true);
    try {
      const input = { name, url };
      const result = editingCustomConnector
        ? await updateCustomMcpConnector(editingCustomConnector.id, input)
        : await createCustomMcpConnector(input);
      if (!result.ok || !result.connector) {
        setCustomError(result.error ?? t("dataConnections.customMcp.failed"));
        return;
      }
      const connector: CustomConnector = {
        id: result.connector.id,
        slug: result.connector.slug,
        name: result.connector.name,
        url: result.connector.url,
        fetched: result.fetched,
        rawInserted: result.rawInserted,
        evolveTaskId: result.evolveTaskId,
      };
      setOptimisticCustomConnectors((prev) => [
        connector,
        ...prev.filter((item) => item.id !== connector.id && item.url !== connector.url),
      ]);
      setCustomName("");
      setCustomUrl("");
      setEditingCustomConnector(null);
      setCustomOpen(false);
    } finally {
      setCustomSubmitting(false);
    }
  };

  const handleCustomDelete = async (connector: CustomConnector) => {
    setDisconnectingId(connector.id);
    setConnectError(null);
    try {
      const result = await deleteCustomMcpConnector(connector.id);
      if (!result.ok) {
        setConnectError(result.error ?? t("dataConnections.customMcp.deleteFailed"));
        return;
      }
      setOptimisticCustomConnectors((prev) => prev.filter((item) => item.id !== connector.id));
    } finally {
      setDisconnectingId(null);
    }
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    cancelWait();
    setConnectingToolkit(null);
    setConnectError(null);
  };

  const handleDisconnect = async (connectedAccountId: string) => {
    setDisconnectingId(connectedAccountId);
    setArmedDisconnectId(null);
    setConnectError(null);
    try {
      const result = await disconnectAccount(connectedAccountId);
      if (!result.ok) setConnectError(result.error ?? t("dataConnections.errors.disconnectFailed"));
    } finally {
      setDisconnectingId(null);
    }
  };

  // 后端持 master Composio key；configured=false 只在部署缺 env 时发生。
  const configured = keyStatus?.configured ?? false;

  return (
    <View>
      {!configured && !statusLoading ? (
        <GlassCard style={styles.notConfiguredCard}>
          <View style={styles.rowStartGap6}>
            <XCircle size={12} color={RED_500} style={{ marginTop: 2 }} />
            <Text style={styles.notConfiguredText}>{t("dataConnections.notConfigured")}</Text>
          </View>
        </GlassCard>
      ) : null}

      {/* Categories */}
      <View style={{ gap: 10 }}>
        {INPUT_CATEGORIES.map((category) => {
          const isExpanded = expandedCategory === category.name;
          const CIcon = category.icon;
          const connected = countConnected(category);

          return (
            <GlassCard key={category.name}>
              <Pressable
                onPress={() => toggleCategory(category.name, isExpanded)}
                accessibilityRole="button"
                accessibilityState={{ expanded: isExpanded }}
              >
                <View style={styles.categoryHeader}>
                  <View style={styles.categoryIconBox}>
                    <CIcon size={18} strokeWidth={1.5} color={fg(0.7)} />
                  </View>
                  <View style={styles.flex1}>
                    <View style={styles.rowGap8}>
                      <Text style={styles.categoryTitle}>
                        {t(`dataConnections.categories.${category.labelKey}.name`)}
                      </Text>
                      <View style={styles.countBadge}>
                        <Text style={styles.countBadgeText}>
                          {connected} / {category.sources.length}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.categoryDesc}>
                      {t(`dataConnections.categories.${category.labelKey}.description`)}
                    </Text>
                  </View>
                  {isExpanded ? (
                    <ChevronUp size={16} color={fg(0.3)} />
                  ) : (
                    <ChevronDown size={16} color={fg(0.3)} />
                  )}
                </View>
              </Pressable>

              {isExpanded ? (
                <View style={styles.categoryBody}>
                  <View style={styles.hairline} />

                  {category.sources.length === 0 ? (
                    <Text style={styles.noConnectors}>{t("dataConnections.noConnectors")}</Text>
                  ) : null}

                  {([0, 1, 2] as const).map((tier) => {
                    const tierSources = category.sources.filter((s) => s.tier === tier);
                    if (tierSources.length === 0) return null;
                    const tierLabelKeys = ["core", "more", "optional"] as const;
                    return (
                      <View key={tier}>
                        <View style={styles.tierHeader}>
                          <View
                            style={[
                              styles.tierDot,
                              { backgroundColor: tier === 0 ? fg(1) : tier === 1 ? fg(0.4) : fg(0.2) },
                            ]}
                          />
                          <Text style={styles.tierLabel}>
                            {t(`dataConnections.tiers.${tierLabelKeys[tier]}`).toUpperCase()}
                          </Text>
                        </View>
                        <View style={{ gap: 4 }}>
                          {tierSources.map((source) => {
                            const SrcIcon = source.icon;
                            const hasComposio = !!source.composioId && configured;
                            const accounts = source.composioId
                              ? getComposioConnectionsForToolkit(connections, source.composioId)
                              : [];
                            const singleAccount = accounts.length === 1 ? accounts[0] : null;
                            const multiAccounts = accounts.length >= 2;
                            const isConnecting = connectingToolkit === source.composioId;
                            const isConnected = accounts.length > 0;

                            return (
                              <View key={source.name} style={{ gap: 2 }}>
                                {/* 单账户行 */}
                                {!multiAccounts ? (
                                  <View
                                    style={[
                                      styles.sourceRow,
                                      { backgroundColor: isConnected ? "rgba(16,185,129,0.06)" : fg(0.02) },
                                    ]}
                                  >
                                    <ConnectorIconSlot
                                      logo={getComposioLogoUrl(source.composioId)}
                                      Icon={SrcIcon}
                                      iconColor={
                                        isConnected ? EMERALD_600 : hasComposio ? fg(0.3) : fg(0.15)
                                      }
                                    />
                                    <View style={styles.flex1MinW0}>
                                      <Text
                                        style={[
                                          styles.sourceName,
                                          isConnected
                                            ? styles.sourceNameConnected
                                            : { color: hasComposio ? fg(0.45) : fg(0.25) },
                                        ]}
                                        numberOfLines={1}
                                      >
                                        {source.name}
                                      </Text>
                                      {singleAccount
                                        ? (() => {
                                            const identity = resolveIdentity(singleAccount, connections);
                                            return identity ? (
                                              <Text style={styles.identityText} numberOfLines={1}>
                                                {identity}
                                              </Text>
                                            ) : null;
                                          })()
                                        : null}
                                      {singleAccount?.connectedAccountId && source.composioId ? (
                                        <InitTaskChip
                                          toolkit={singleAccount.toolkit}
                                          connectedAccountId={singleAccount.connectedAccountId}
                                          sourceToolkit={source.composioId}
                                        />
                                      ) : null}
                                    </View>

                                    {singleAccount ? (
                                      <>
                                        {isConnecting ? (
                                          <PillButton muted onPress={handleCancel}>
                                            <Spinner size={10} color={fg(0.5)} />
                                            <Text style={[styles.pillBtnText, { color: fg(0.5) }]}>
                                              {t("common:status.cancel")}
                                            </Text>
                                          </PillButton>
                                        ) : (
                                          <PillButton onPress={() => void handleConnect(source.composioId!)}>
                                            <Plus size={10} color={fg(1)} />
                                            <Text style={styles.pillBtnText}>{t("dataConnections.add")}</Text>
                                          </PillButton>
                                        )}
                                        <View style={styles.dotEmerald} />
                                        {singleAccount.connectedAccountId ? (
                                          <ConnectedToggle
                                            accountId={singleAccount.connectedAccountId}
                                            armedId={armedDisconnectId}
                                            disconnectingId={disconnectingId}
                                            onArm={setArmedDisconnectId}
                                            onDisconnect={(id) => void handleDisconnect(id)}
                                          />
                                        ) : null}
                                      </>
                                    ) : hasComposio ? (
                                      <>
                                        <View style={styles.dotIdle} />
                                        {isConnecting ? (
                                          <PillButton muted wide onPress={handleCancel}>
                                            <Spinner size={10} color={fg(0.5)} />
                                            <Text style={[styles.pillBtnText, { color: fg(0.5) }]}>
                                              {t("common:status.cancel")}
                                            </Text>
                                          </PillButton>
                                        ) : (
                                          <PillButton wide onPress={() => void handleConnect(source.composioId!)}>
                                            {t("dataConnections.connect")}
                                          </PillButton>
                                        )}
                                      </>
                                    ) : (
                                      <>
                                        <View style={styles.dotIdle} />
                                        <View style={styles.pillDisabled}>
                                          <Text style={styles.pillDisabledText}>{t("dataConnections.connect")}</Text>
                                        </View>
                                      </>
                                    )}
                                  </View>
                                ) : null}

                                {/* 多账户 */}
                                {multiAccounts ? (
                                  <>
                                    <View style={[styles.sourceRow, { backgroundColor: "rgba(16,185,129,0.06)" }]}>
                                      <ConnectorIconSlot
                                        logo={getComposioLogoUrl(source.composioId)}
                                        Icon={SrcIcon}
                                        iconColor={EMERALD_600}
                                      />
                                      <Text style={[styles.sourceName, styles.sourceNameConnected, styles.flex1]}>
                                        {source.name}
                                      </Text>
                                      <Text style={styles.accountCount}>{accounts.length}</Text>
                                      {isConnecting ? (
                                        <PillButton muted wide onPress={handleCancel}>
                                          <Spinner size={10} color={fg(0.5)} />
                                          <Text style={[styles.pillBtnText, { color: fg(0.5) }]}>
                                            {t("common:status.cancel")}
                                          </Text>
                                        </PillButton>
                                      ) : (
                                        <PillButton wide onPress={() => void handleConnect(source.composioId!)}>
                                          <Plus size={10} color={fg(1)} />
                                          <Text style={styles.pillBtnText}>{t("dataConnections.add")}</Text>
                                        </PillButton>
                                      )}
                                    </View>
                                    {accounts.map((conn, idx) => {
                                      const identity = resolveIdentity(conn, connections);
                                      return (
                                        <View key={conn.connectedAccountId ?? idx} style={styles.accountRow}>
                                          <View style={styles.rowGap10}>
                                            <View style={styles.dotEmerald} />
                                            <Text style={styles.accountIdentity} numberOfLines={1}>
                                              {identity ?? `${source.name} #${idx + 1}`}
                                            </Text>
                                            {conn.connectedAccountId ? (
                                              <SubDisconnectButton
                                                accountId={conn.connectedAccountId}
                                                disconnectingId={disconnectingId}
                                                onDisconnect={(id) => void handleDisconnect(id)}
                                              />
                                            ) : null}
                                          </View>
                                          {conn.connectedAccountId ? (
                                            <View style={{ marginLeft: 14 }}>
                                              <InitTaskChip
                                                toolkit={conn.toolkit}
                                                connectedAccountId={conn.connectedAccountId}
                                                sourceToolkit={source.composioId}
                                              />
                                            </View>
                                          ) : null}
                                        </View>
                                      );
                                    })}
                                  </>
                                ) : null}

                                {/* children（Google Workspace 子行） */}
                                {source.children ? (
                                  <View style={styles.childrenWrap}>
                                    {source.children.map((child) => {
                                      const ChildIcon = child.icon;
                                      const childHasComposio = !!child.composioId && configured;
                                      const childAccounts = child.composioId
                                        ? getComposioConnectionsForToolkit(connections, child.composioId)
                                        : [];
                                      const childAccount = childAccounts.length === 1 ? childAccounts[0] : null;
                                      const childMultiAccounts = childAccounts.length >= 2;
                                      const childIsConnected = childAccounts.length > 0;
                                      const childIsConnecting = connectingToolkit === child.composioId;
                                      const childCanDisconnect =
                                        !!childAccount?.connectedAccountId &&
                                        childAccount.toolkit.toLowerCase() === child.composioId?.toLowerCase();
                                      const childCanAddAccount = childHasComposio && !child.coverageNoteKey;
                                      return (
                                        <View key={child.name} style={{ gap: 2 }}>
                                          <View
                                            style={[
                                              styles.childRow,
                                              {
                                                backgroundColor: childIsConnected
                                                  ? "rgba(16,185,129,0.035)"
                                                  : fg(0.015),
                                              },
                                            ]}
                                          >
                                            <ConnectorIconSlot
                                              logo={getComposioLogoUrl(child.composioId)}
                                              Icon={ChildIcon}
                                              size={12}
                                              iconColor={
                                                childIsConnected
                                                  ? EMERALD_600
                                                  : childHasComposio
                                                    ? fg(0.25)
                                                    : fg(0.15)
                                              }
                                            />
                                            <View style={styles.flex1MinW0}>
                                              <View style={styles.rowGap6}>
                                                <Text
                                                  style={[
                                                    styles.childName,
                                                    childIsConnected
                                                      ? styles.childNameConnected
                                                      : { color: childHasComposio ? fg(0.4) : fg(0.25) },
                                                  ]}
                                                  numberOfLines={1}
                                                >
                                                  {child.name}
                                                </Text>
                                                {child.coverageNoteKey ? (
                                                  <Text style={styles.coverageNote}>
                                                    {t(`dataConnections.coverage.${child.coverageNoteKey}`)}
                                                  </Text>
                                                ) : null}
                                              </View>
                                              {child.showInitTask !== false &&
                                              childAccount?.connectedAccountId &&
                                              child.composioId ? (
                                                <InitTaskChip
                                                  toolkit={childAccount.toolkit}
                                                  connectedAccountId={childAccount.connectedAccountId}
                                                  sourceToolkit={child.composioId}
                                                />
                                              ) : null}
                                            </View>
                                            {childIsConnected ? (
                                              <View style={styles.rowGap6}>
                                                {childIsConnecting ? (
                                                  <PillButton muted onPress={handleCancel}>
                                                    <Spinner size={10} color={fg(0.5)} />
                                                    <Text style={[styles.pillBtnText, { color: fg(0.5) }]}>
                                                      {t("common:status.cancel")}
                                                    </Text>
                                                  </PillButton>
                                                ) : (
                                                  <>
                                                    {childCanAddAccount ? (
                                                      <PillButton
                                                        onPress={() => void handleConnect(child.composioId!)}
                                                      >
                                                        <Plus size={10} color={fg(1)} />
                                                        <Text style={styles.pillBtnText}>{t("dataConnections.add")}</Text>
                                                      </PillButton>
                                                    ) : null}
                                                    <View style={styles.dotEmerald} />
                                                    {childCanDisconnect ? (
                                                      <ConnectedToggle
                                                        accountId={childAccount.connectedAccountId!}
                                                        armedId={armedDisconnectId}
                                                        disconnectingId={disconnectingId}
                                                        onArm={setArmedDisconnectId}
                                                        onDisconnect={(id) => void handleDisconnect(id)}
                                                      />
                                                    ) : (
                                                      <Text style={styles.connectedText}>{t("dataConnections.connected")}</Text>
                                                    )}
                                                  </>
                                                )}
                                              </View>
                                            ) : childHasComposio ? (
                                              child.coverageNoteKey ? (
                                                <Text style={styles.coverageNote}>
                                                  {t(`dataConnections.coverage.${child.coverageNoteKey}`)}
                                                </Text>
                                              ) : childIsConnecting ? (
                                                <PillButton muted onPress={handleCancel}>
                                                  <Spinner size={10} color={fg(0.5)} />
                                                  <Text style={[styles.pillBtnText, { color: fg(0.5) }]}>
                                                    {t("common:status.cancel")}
                                                  </Text>
                                                </PillButton>
                                              ) : (
                                                <PillButton onPress={() => void handleConnect(child.composioId!)}>
                                                  {t("dataConnections.connect")}
                                                </PillButton>
                                              )
                                            ) : (
                                              <Text style={styles.pillDisabledText}>{t("dataConnections.connect")}</Text>
                                            )}
                                          </View>
                                          {childMultiAccounts && child.showInitTask !== false && child.composioId ? (
                                            <View style={styles.childAccountsWrap}>
                                              {childAccounts.map((conn, idx) => {
                                                const identity = resolveIdentity(conn, connections);
                                                return (
                                                  <View
                                                    key={conn.connectedAccountId ?? `${child.name}-${idx}`}
                                                    style={styles.childAccountRow}
                                                  >
                                                    <View style={styles.rowGap8}>
                                                      <Text style={styles.childAccountIdentity} numberOfLines={1}>
                                                        {identity ?? `${child.name} #${idx + 1}`}
                                                      </Text>
                                                      {conn.connectedAccountId ? (
                                                        <SubDisconnectButton
                                                          accountId={conn.connectedAccountId}
                                                          disconnectingId={disconnectingId}
                                                          onDisconnect={(id) => void handleDisconnect(id)}
                                                        />
                                                      ) : null}
                                                    </View>
                                                    {conn.connectedAccountId ? (
                                                      <InitTaskChip
                                                        toolkit={conn.toolkit}
                                                        connectedAccountId={conn.connectedAccountId}
                                                        sourceToolkit={child.composioId}
                                                      />
                                                    ) : null}
                                                  </View>
                                                );
                                              })}
                                            </View>
                                          ) : null}
                                        </View>
                                      );
                                    })}
                                  </View>
                                ) : null}
                              </View>
                            );
                          })}
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </GlassCard>
          );
        })}
      </View>

      {/* Additional connector catalog */}
      {configured ? (
        <GlassCard style={styles.catalogCard}>
          <Pressable onPress={handleToggleCatalog} accessibilityRole="button" accessibilityState={{ expanded: catalogOpen }}>
            <View style={styles.categoryHeader}>
              <View style={styles.catalogIconBox}>
                <Globe2 size={16} strokeWidth={1.5} color={fg(0.6)} />
              </View>
              <View style={styles.flex1MinW0}>
                <Text style={styles.categoryTitle}>{t("dataConnections.catalog.title")}</Text>
                <Text style={styles.catalogSubtitle}>{catalogTotalLabel}</Text>
              </View>
              <ChevronDown
                size={16}
                color={fg(0.3)}
                style={{ transform: [{ rotate: catalogOpen ? "180deg" : "0deg" }] }}
              />
            </View>
          </Pressable>

          {catalogOpen ? (
            <View style={styles.catalogBody}>
              {/* 搜索 + 类目 select */}
              <View style={styles.catalogControls}>
                <View style={styles.searchWrap}>
                  <Search size={13} color={fg(0.3)} style={styles.searchIcon} />
                  <TextInput
                    value={catalogQuery}
                    onChangeText={setCatalogQuery}
                    placeholder={t("dataConnections.catalog.searchPlaceholder")}
                    placeholderTextColor={fg(0.3)}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.searchInput}
                  />
                </View>
                <CatalogCategorySelect value={catalogCategory} onChange={setCatalogCategory} />
              </View>

              {catalogItems.length === 0 && catalogLoading ? (
                <View style={styles.catalogLoadingRow}>
                  <Spinner size={13} color={fg(0.45)} />
                  <Text style={styles.catalogLoadingText}>{t("dataConnections.catalog.loading")}</Text>
                </View>
              ) : catalogItems.length === 0 && catalogLoaded ? (
                <View style={styles.catalogEmptyRow}>
                  <Text style={styles.catalogEmptyText}>{t("dataConnections.catalog.empty")}</Text>
                </View>
              ) : catalogItems.length === 0 ? (
                <Pressable onPress={() => void loadCatalogPage(true)} disabled={catalogLoading} accessibilityRole="button">
                  <View style={[styles.catalogLoadBtn, catalogLoading && { opacity: 0.5 }]}>
                    <Text style={styles.catalogLoadBtnText}>{t("dataConnections.catalog.load")}</Text>
                  </View>
                </Pressable>
              ) : (
                <View style={{ gap: 8 }}>
                  <FlatList
                    style={styles.catalogList}
                    contentContainerStyle={{ gap: 4, paddingRight: 4 }}
                    data={catalogDisplayItems}
                    keyExtractor={(item) => item.slug}
                    nestedScrollEnabled
                    onEndReachedThreshold={0.3}
                    onEndReached={() => {
                      if (!catalogLoading && catalogCursor) void loadCatalogPage(false);
                    }}
                    renderItem={({ item }) => {
                      const isConnecting = connectingToolkit === item.slug;
                      const itemAccounts = getComposioConnectionsForToolkit(connections, item.slug);
                      const primaryAccount = itemAccounts[0];
                      const isConnected = itemAccounts.length > 0;
                      return (
                        <View
                          style={[
                            styles.sourceRow,
                            { backgroundColor: isConnected ? "rgba(16,185,129,0.06)" : fg(0.02) },
                          ]}
                        >
                          <ConnectorIconSlot
                            logo={item.logo ?? getComposioLogoUrl(item.slug)}
                            Icon={Globe2}
                            iconColor={fg(0.35)}
                          />
                          <View style={styles.flex1MinW0}>
                            <Text style={styles.catalogItemName} numberOfLines={1}>
                              {item.name || item.slug}
                            </Text>
                            <Text style={styles.identityText} numberOfLines={1}>
                              {item.auth_schemes.length > 0 ? item.auth_schemes.join(", ") : "auth"}
                              {item.categories.length > 0 ? ` · ${item.categories.join(", ")}` : ""}
                            </Text>
                            {primaryAccount?.connectedAccountId ? (
                              <InitTaskChip
                                toolkit={primaryAccount.toolkit}
                                connectedAccountId={primaryAccount.connectedAccountId}
                                sourceToolkit={item.slug}
                              />
                            ) : null}
                          </View>
                          {isConnecting ? (
                            <PillButton muted wide onPress={handleCancel}>
                              {t("common:status.cancel")}
                            </PillButton>
                          ) : isConnected ? (
                            <View style={styles.rowGap6}>
                              <PillButton onPress={() => void handleConnect(item.slug)}>
                                <Plus size={10} color={fg(1)} />
                                <Text style={styles.pillBtnText}>{t("dataConnections.add")}</Text>
                              </PillButton>
                              <Text style={styles.connectedText}>{t("dataConnections.connected")}</Text>
                            </View>
                          ) : (
                            <PillButton wide onPress={() => void handleConnect(item.slug)}>
                              {t("dataConnections.connect")}
                            </PillButton>
                          )}
                        </View>
                      );
                    }}
                  />
                  {catalogCursor ? (
                    <Text style={styles.scrollForMore}>
                      {catalogLoading ? t("common:status.loading") : t("dataConnections.catalog.scrollForMore")}
                    </Text>
                  ) : null}
                </View>
              )}

              {catalogError ? <Text style={styles.catalogError}>{catalogError}</Text> : null}

              {customConnectors.length > 0 ? (
                <View style={styles.customList}>
                  {customConnectors.map((connector) => (
                    <View key={connector.id} style={styles.customRow}>
                      <Globe2 size={14} color={fg(0.35)} />
                      <View style={styles.flex1MinW0}>
                        <View style={styles.rowGap6}>
                          <Text style={styles.catalogItemName} numberOfLines={1}>
                            {connector.name}
                          </Text>
                          <Text style={styles.mcpBadge}>MCP</Text>
                        </View>
                        <Text style={styles.identityText} numberOfLines={1}>
                          {connector.url}
                        </Text>
                      </View>
                      <View style={styles.rowGap6}>
                        <CustomMcpStatus connector={connector} />
                        <Pressable
                          onPress={() => openEditCustomConnector(connector)}
                          accessibilityRole="button"
                          accessibilityLabel={t("dataConnections.customMcp.editAria", { name: connector.name })}
                        >
                          <View style={styles.iconBtn}>
                            <Pencil size={12} color={fg(0.35)} />
                          </View>
                        </Pressable>
                        <Pressable
                          onPress={() => void handleCustomDelete(connector)}
                          disabled={disconnectingId === connector.id}
                          accessibilityRole="button"
                          accessibilityLabel={t("dataConnections.customMcp.deleteAria", { name: connector.name })}
                        >
                          <View style={[styles.iconBtn, disconnectingId === connector.id && { opacity: 0.5 }]}>
                            {disconnectingId === connector.id ? (
                              <Spinner size={12} color={fg(0.35)} />
                            ) : (
                              <Trash2 size={12} color={fg(0.35)} />
                            )}
                          </View>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}

              <View style={styles.addCustomWrap}>
                <Pressable onPress={openAddCustomConnector} accessibilityRole="button">
                  <View style={styles.addCustomBtn}>
                    <Plus size={13} color={fg(0.65)} />
                    <Text style={styles.addCustomText}>{t("dataConnections.customMcp.addButton")}</Text>
                  </View>
                </Pressable>
              </View>
            </View>
          ) : null}
        </GlassCard>
      ) : null}

      {/* 网站登录（agent 浏览器） */}
      <BrowserLoginsSection />

      {/* Connect error */}
      {connectError ? (
        <Animated.View entering={FadeIn.duration(180)}>
          <GlassCard style={styles.errorCard}>
            <View style={styles.rowStartGap6}>
              <XCircle size={12} color={RED_500} style={{ marginTop: 2 }} />
              <Text style={styles.errorText}>{connectError}</Text>
            </View>
          </GlassCard>
        </Animated.View>
      ) : null}

      {/* Custom MCP dialog。
          键盘避让**刻意**保留 RN 内建 KeyboardAvoidingView（不迁 keyboard-controller）:
          本 dialog 在 RN <Modal> 独立 host view 里,库版 KAV 在 Modal 内测量已知不稳；且这是
          居中弹窗、非满屏出血,无 chat 那种双算/常驻离屏问题。chat 的键盘整改不覆盖这里。 */}
      <Modal visible={customOpen} transparent animationType="fade" onRequestClose={closeCustomConnectorDialog}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.dialogOverlay}
        >
          <Animated.View
            entering={FadeInUp.duration(180).withInitialValues({
              opacity: 0,
              transform: [{ translateY: 18 }, { scale: 0.98 }],
            })}
            style={styles.dialogCard}
          >
            <View style={styles.rowStartGap16}>
              <View style={styles.flex1MinW0}>
                <Text style={styles.dialogTitle}>
                  {editingCustomConnector
                    ? t("dataConnections.customMcp.editTitle")
                    : t("dataConnections.customMcp.addTitle")}
                </Text>
                <Text style={styles.dialogDesc}>{t("dataConnections.customMcp.dialogDescription")}</Text>
              </View>
              <Pressable
                onPress={closeCustomConnectorDialog}
                accessibilityRole="button"
                accessibilityLabel={t("dataConnections.customMcp.closeAria")}
              >
                <View style={styles.dialogClose}>
                  <X size={24} color={fg(0.45)} />
                </View>
              </Pressable>
            </View>

            <View style={styles.dialogInputs}>
              <TextInput
                value={customName}
                onChangeText={setCustomName}
                placeholder={t("dataConnections.customMcp.namePlaceholder")}
                placeholderTextColor={fg(0.35)}
                autoCorrect={false}
                spellCheck={false}
                style={styles.dialogInput}
              />
              <TextInput
                value={customUrl}
                onChangeText={setCustomUrl}
                placeholder={t("dataConnections.customMcp.urlPlaceholder")}
                placeholderTextColor={fg(0.35)}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                keyboardType="url"
                style={styles.dialogInput}
              />
              <Text style={styles.trustNote}>{t("dataConnections.customMcp.trustNote")}</Text>
              {customError ? (
                <View style={styles.dialogErrorBox}>
                  <Text style={styles.dialogErrorText}>{customError}</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.dialogFooter}>
              <Pressable onPress={closeCustomConnectorDialog} accessibilityRole="button">
                <View style={styles.dialogCancelBtn}>
                  <Text style={styles.dialogCancelText}>{t("common:status.cancel")}</Text>
                </View>
              </Pressable>
              <Pressable onPress={() => void handleCustomConnect()} disabled={customSubmitting} accessibilityRole="button">
                <View style={styles.dialogSubmitBtn}>
                  {customSubmitting ? (
                    <View style={styles.rowGap6}>
                      <Spinner size={14} color={BACKGROUND} />
                      <Text style={styles.dialogSubmitText}>
                        {editingCustomConnector ? t("dataConnections.save") : t("dataConnections.add")}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.dialogSubmitText}>
                      {editingCustomConnector ? t("dataConnections.save") : t("dataConnections.add")}
                    </Text>
                  )}
                </View>
              </Pressable>
            </View>
          </Animated.View>
        </KeyboardAvoidingView>
      </Modal>

      {/* authorize 提示条 */}
      {connectingToolkit ? (
        <GlassCard style={styles.authorizeBar}>
          <View style={[styles.rowGap6, styles.flex1]}>
            <Spinner size={10} color={fg(0.4)} />
            <Text style={styles.authorizeText} numberOfLines={2}>
              {t("dataConnections.authorizeHint")}
            </Text>
          </View>
          <Pressable onPress={handleCancel} accessibilityRole="button">
            <View style={styles.authorizeCancel}>
              <Text style={styles.authorizeCancelText}>{t("common:status.cancel")}</Text>
            </View>
          </Pressable>
        </GlassCard>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  flex1MinW0: { flex: 1, minWidth: 0 },
  rowGap4: { flexDirection: "row", alignItems: "center", gap: 4 },
  rowGap6: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowGap8: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowGap10: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowStartGap6: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  rowStartGap16: { flexDirection: "row", alignItems: "flex-start", gap: 16 },
  disabled40: { opacity: 0.4 },

  notConfiguredCard: { padding: 16, marginBottom: 16 },
  notConfiguredText: { flex: 1, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.6) },

  // category（glass-card-strong）
  categoryHeader: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  categoryIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: fg(0.06),
    alignItems: "center",
    justifyContent: "center",
  },
  categoryTitle: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  countBadge: { backgroundColor: fg(0.06), paddingHorizontal: 6, paddingVertical: 2, borderRadius: 18 },
  countBadgeText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: fg(0.4) },
  categoryDesc: { marginTop: 2, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.4) },
  categoryBody: { paddingHorizontal: 16, paddingBottom: 16, gap: 4 },
  hairline: { height: 1, backgroundColor: fg(0.06), marginBottom: 8 },
  noConnectors: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    color: fg(0.4),
    textAlign: "center",
    paddingVertical: 12,
    paddingHorizontal: 4,
  },

  // tier
  tierHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6, marginTop: 10 },
  tierDot: { width: 6, height: 6, borderRadius: 999 },
  tierLabel: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, color: fg(0.5) },

  // source rows
  sourceRow: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  iconSlot: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  iconLogo: { width: 20, height: 20, borderRadius: 18 },
  // SVG 走 SvgUri，圆角靠外层 View 裁（web img rounded-md=18）。
  iconLogoClip: { width: 20, height: 20, borderRadius: 18, overflow: "hidden" },
  sourceName: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular" },
  sourceNameConnected: { color: "#1d2130", fontFamily: "Inter_500Medium" },
  identityText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.35) },
  dotEmerald: { width: 6, height: 6, borderRadius: 999, backgroundColor: "#10b981" },
  dotIdle: { width: 6, height: 6, borderRadius: 999, backgroundColor: fg(0.1) },
  accountCount: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.3) },

  // 动作胶囊
  pillBtn: {
    backgroundColor: fg(0.06),
    borderWidth: 1,
    borderColor: fg(0.12),
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  pillBtnWide: { paddingHorizontal: 10 },
  pillBtnText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: "#1d2130" },
  pillDisabled: {
    backgroundColor: fg(0.03),
    borderWidth: 1,
    borderColor: fg(0.06),
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
  pillDisabledText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: fg(0.2) },
  togglePill: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 2 },
  togglePillArmed: { backgroundColor: "rgba(239,68,68,0.08)" },
  togglePillText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: EMERALD_600 },
  connectedText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: EMERALD_600 },
  subDisconnect: { borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
  subDisconnectText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: fg(0.35) },

  // multi-account rows
  accountRow: { marginLeft: 24, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "rgba(16,185,129,0.03)", gap: 2 },
  accountIdentity: { flex: 1, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.7) },

  // children
  childrenWrap: { marginLeft: 24, marginTop: 6, gap: 4, borderLeftWidth: 1, borderLeftColor: fg(0.08), paddingLeft: 8 },
  childRow: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 6 },
  childName: { flexShrink: 1, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular" },
  childNameConnected: { color: fg(0.75), fontFamily: "Inter_500Medium" },
  coverageNote: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: fg(0.3) },
  childAccountsWrap: { marginLeft: 16, gap: 2 },
  childAccountRow: { borderRadius: 20, backgroundColor: "rgba(16,185,129,0.02)", paddingHorizontal: 8, paddingVertical: 4 },
  childAccountIdentity: { flex: 1, minWidth: 0, fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.45) },

  // catalog
  catalogCard: { marginTop: 12 },
  catalogIconBox: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: fg(0.06),
    alignItems: "center",
    justifyContent: "center",
  },
  catalogSubtitle: { marginTop: 2, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.45) },
  catalogBody: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  catalogControls: { flexDirection: "row", alignItems: "center", gap: 8 },
  searchWrap: { flex: 1, minWidth: 0, justifyContent: "center" },
  searchIcon: { position: "absolute", left: 12, zIndex: 1 },
  searchInput: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: fg(0.03),
    paddingLeft: 32,
    paddingRight: 12,
    height: 32,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#1d2130",
  },
  categoryTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: fg(0.03),
    paddingHorizontal: 8,
    height: 32,
  },
  categoryTriggerText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: "#1d2130" },
  catalogLoadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: fg(0.03),
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  catalogLoadingText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: fg(0.45) },
  catalogEmptyRow: { borderRadius: 12, backgroundColor: fg(0.02), paddingHorizontal: 12, paddingVertical: 12 },
  catalogEmptyText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: fg(0.4) },
  catalogLoadBtn: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: fg(0.04),
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: "center",
  },
  catalogLoadBtnText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_500Medium", color: "#1d2130" },
  catalogList: { maxHeight: 288 },
  catalogItemName: { flexShrink: 1, fontSize: 12, lineHeight: 16, fontFamily: "Inter_500Medium", color: fg(0.75) },
  scrollForMore: { alignSelf: "flex-end", fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: fg(0.3) },
  catalogError: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: RED_500 },

  // custom MCP list
  customList: { gap: 6, borderTopWidth: 1, borderTopColor: fg(0.06), paddingTop: 8 },
  customRow: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 12, backgroundColor: fg(0.02), paddingHorizontal: 12, paddingVertical: 8 },
  mcpBadge: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: fg(0.3) },
  mcpStatusOk: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: EMERALD_600 },
  mcpStatusFailed: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: RED_500 },
  iconBtn: { borderRadius: 20, padding: 4 },
  addCustomWrap: { paddingTop: 8, borderTopWidth: 1, borderTopColor: fg(0.06) },
  addCustomBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: fg(0.15),
    backgroundColor: fg(0.02),
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addCustomText: { fontSize: 12, lineHeight: 16, fontFamily: "Inter_500Medium", color: fg(0.65) },

  // error / authorize
  errorCard: { paddingHorizontal: 16, paddingVertical: 12, marginTop: 12 },
  errorText: { flex: 1, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: RED_500 },
  authorizeBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: 12,
  },
  authorizeText: { flex: 1, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", fontStyle: "italic", color: fg(0.4) },
  authorizeCancel: { borderRadius: 20, paddingHorizontal: 8, paddingVertical: 2 },
  authorizeCancelText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: fg(0.4) },

  // dialog
  dialogOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.2)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  dialogCard: {
    width: "100%",
    maxWidth: 448,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: BACKGROUND,
    padding: 20,
    boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
  },
  dialogTitle: { fontSize: 18, lineHeight: 25, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  dialogDesc: { marginTop: 12, fontSize: 12, lineHeight: 20, fontFamily: "Inter_400Regular", color: fg(0.5) },
  dialogClose: { borderRadius: 999, padding: 6 },
  dialogInputs: { marginTop: 24, gap: 16 },
  dialogInput: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: fg(0.12),
    backgroundColor: "#fff",
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#1d2130",
  },
  trustNote: { fontSize: 12, lineHeight: 20, fontFamily: "Inter_400Regular", color: fg(0.45) },
  dialogErrorBox: { borderRadius: 12, backgroundColor: "rgba(239,68,68,0.1)", paddingHorizontal: 12, paddingVertical: 8 },
  dialogErrorText: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_400Regular", color: RED_500 },
  dialogFooter: { marginTop: 28, flexDirection: "row", justifyContent: "flex-end", gap: 12 },
  dialogCancelBtn: { borderRadius: 12, backgroundColor: fg(0.08), paddingHorizontal: 20, paddingVertical: 10 },
  dialogCancelText: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  dialogSubmitBtn: { borderRadius: 12, backgroundColor: "#1d2130", paddingHorizontal: 20, paddingVertical: 10 },
  dialogSubmitText: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: BACKGROUND },
});
