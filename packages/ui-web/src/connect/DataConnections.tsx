import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  Briefcase,
  ChevronDown,
  ChevronUp,
  X,
  Mail,
  Calendar,
  FolderOpen,
  MessageSquare,
  CreditCard,
  Users,
  Code,
  Loader2,
  XCircle,
  Plus,
  Video,
  Globe2,
  Search,
  FileText,
  Table2,
  Presentation,
  Pencil,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type {
  ComposioCatalogItem,
  ComposioState,
  Connection,
} from "@pin-ai/state";
import {
  buildConnectorInitTaskId,
  getComposioConnectionsForToolkit,
  normalizeComposioToolkit,
} from "@pin-ai/state";
import { useInitTask, isInitTaskFresh } from "@pin-ai/state";
import i18n from "../i18n";
import type connectEn from "../../../ui-kit/src/locales/en/connect.json";
import { resolveComposioConnectionIdentity } from "./composio-display-identity";
import { closeOAuthSurface, openOAuthAndAwaitClose } from "./oauth-popup";
import { Text } from "../primitives/Text";
import { BrowserLoginsSection } from "./BrowserLoginsSection";

/**
 * Small inline chip that polls connector.init tasks and renders a
 * one-line progress / outcome summary under the connector card.
 *
 * Reconstructs the deterministic backend task id from (toolkit, account)
 * so the chip survives page reloads without any persisted state — the
 * DebugPanel's reconnect chip uses the same id, so both panels poll the
 * same row. Once a task hits terminal status, it's only surfaced for
 * `FRESH_WINDOW_MS` (see useInitTask) — beyond that we treat the row as
 * historical and render nothing.
 *
 * Recurring connector.sync rows are intentionally not polled here: those can run
 * daily and should not keep adding noisy "last sync" status to this setup UI.
 *
 * Render rules:
 *   - while running:   "Initializing · Fetching data (limit 100)"
 *   - succeeded:       "Initialized · 12 fetched"  (hidden 1h after completion)
 *   - failed:          "Initialization failed — short error reason"  (same window)
 *   - lookup error:    nothing (silent fallback so we don't litter the UI)
 */
function resultNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getInitTaskResult(
  result: Record<string, unknown> | null,
  taskToolkit: string,
  sourceToolkit: string,
): Record<string, unknown> | null {
  if (!result) return null;
  const taskKey = normalizeComposioToolkit(taskToolkit);
  const sourceKey = normalizeComposioToolkit(sourceToolkit);
  const perToolkit = result.perToolkit;
  if (perToolkit && typeof perToolkit === "object" && !Array.isArray(perToolkit)) {
    const subResult = (perToolkit as Record<string, unknown>)[sourceKey];
    if (subResult && typeof subResult === "object" && !Array.isArray(subResult)) {
      return subResult as Record<string, unknown>;
    }
    return taskKey === sourceKey ? result : null;
  }
  return taskKey === sourceKey ? result : null;
}

function InitTaskChip({
  toolkit,
  connectedAccountId,
  sourceToolkit = toolkit,
}: {
  toolkit: string;
  connectedAccountId: string;
  sourceToolkit?: string;
}) {
  const { t } = useTranslation("connect");
  const taskId = buildConnectorInitTaskId(toolkit, connectedAccountId);
  const { task, error, terminal } = useInitTask(taskId);
  if (!task) {
    // Pre-first-fetch: keep loader silent on errors (the row may not exist
    // yet — e.g. user never triggered connect on this device).
    if (error) return null;
    return (
      <p className="text-micro text-foreground/40 truncate flex items-center gap-1">
        <Loader2 size={9} className="animate-spin" />
        {t("dataConnections.initTask.initializing")}
      </p>
    );
  }
  if (!isInitTaskFresh(task)) return null; // stale terminal — silent
  if (terminal) {
    if (task.status === "succeeded") {
      const taskResult = { ...task.progress, ...(task.result ?? {}) };
      const displayResult = getInitTaskResult(taskResult, toolkit, sourceToolkit);
      const memoriesWritten = resultNumber(displayResult?.memoriesWritten);
      const skillsAdded = resultNumber(displayResult?.skillsAdded);
      const fetched = finiteNumber(displayResult?.fetched) ?? resultNumber(displayResult?.rawInserted);
      const skipped = Boolean(task.result?.skipped);
      if (skipped) {
        // `reason` is a backend enum/slug — rendered raw on purpose.
        const reason = String(task.result?.reason ?? "skipped");
        return (
          <Text variant="micro" className="block text-foreground/40 truncate">
            {t("dataConnections.initTask.skipped", { reason })}
          </Text>
        );
      }
      return (
        <Text variant="micro" className="block text-emerald-600/80 truncate">
          {t("dataConnections.initTask.initialized", { fetched })}
          {memoriesWritten > 0 ? ` · ${t("dataConnections.initTask.memories", { count: memoriesWritten })}` : ""}
          {skillsAdded > 0 ? ` · ${t("dataConnections.initTask.skills", { count: skillsAdded })}` : ""}
        </Text>
      );
    }
    // failed / timed_out / cancelled / lost — show shortest possible error
    const shortErr = (
      task.last_error_message ?? task.last_error_code ?? t("dataConnections.initTask.unknownError")
    ).slice(0, 80);
    return (
      <Text variant="micro" className="block text-red-500/80 truncate">
        {t("dataConnections.initTask.failed", { error: shortErr })}
      </Text>
    );
  }
  // running / queued — surface stage + progress when present
  const stage = typeof task.progress?.stage === "string" ? task.progress.stage : null;
  const limit = Number(task.payload?.limit ?? 0);
  const progressDetail = (() => {
    if (!stage) return t("dataConnections.initTask.stageQueued");
    if (stage === "fetch") {
      return limit
        ? t("dataConnections.initTask.stageFetchWithLimit", { limit })
        : t("dataConnections.initTask.stageFetch");
    }
    if (stage === "raw") return t("dataConnections.initTask.stageRaw");
    if (stage === "signals") return t("dataConnections.initTask.stageSignals");
    if (stage === "evolve") return t("dataConnections.initTask.stageEvolve");
    return stage; // unknown stage = backend identifier, render raw
  })();
  return (
    <p className="text-micro text-foreground/45 truncate flex items-center gap-1">
      <Loader2 size={9} className="animate-spin" />
      {t("dataConnections.initTask.initializingDetail", { detail: progressDetail })}
    </p>
  );
}

function resolveIdentity(
  conn: Connection,
  allConnections: Connection[],
): string | null {
  return resolveComposioConnectionIdentity(conn, allConnections);
}

type CoverageNoteKey = keyof typeof connectEn.dataConnections.coverage;
type CategoryLabelKey = keyof typeof connectEn.dataConnections.categories;

export interface DataSource {
  name: string;
  composioId?: string;
  description: string;
  icon: LucideIcon;
  tier: 0 | 1 | 2;
  children?: DataSource[];
  coverageNoteKey?: CoverageNoteKey;
  showInitTask?: boolean;
}

export interface InputCategory {
  /** i18n key under `dataConnections.categories` for name + description. */
  labelKey: CategoryLabelKey;
  /** Stable id used as React key / expanded-state value — not displayed. */
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
      {
        name: "Gmail",
        composioId: "gmail",
        description: "Email messages",
        icon: Mail,
        tier: 0,
      },
      {
        name: "Calendar",
        composioId: "googlecalendar",
        description: "Events and scheduling",
        icon: Calendar,
        tier: 0,
      },
      {
        name: "Drive",
        composioId: "googledrive",
        description: "Files and folders",
        icon: FolderOpen,
        tier: 0,
      },
      {
        name: "Docs",
        composioId: "googledocs",
        description: "Documents",
        icon: FileText,
        tier: 0,
      },
      {
        name: "Sheets",
        composioId: "googlesheets",
        description: "Spreadsheets",
        icon: Table2,
        tier: 0,
      },
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
  {
    name: "Slack",
    composioId: "slack",
    description: "Channels and messages",
    icon: MessageSquare,
    tier: 0,
  },
  {
    name: "GitHub",
    composioId: "github",
    description: "Repositories, issues, PRs",
    icon: Code,
    tier: 0,
  },
  {
    name: "LinkedIn",
    composioId: "linkedin",
    description: "Professional network",
    icon: Users,
    tier: 0,
  },
  {
    name: "Stripe",
    composioId: "stripe",
    description: "Invoices and billing",
    icon: CreditCard,
    tier: 0,
  },
  {
    name: "YouTube",
    composioId: "youtube",
    description: "Subscriptions",
    icon: Video,
    tier: 0,
  },
  {
    name: "Calendly",
    composioId: "calendly",
    description: "Scheduling links",
    icon: Calendar,
    tier: 0,
  },
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

function ConnectorIconSlot({
  logo,
  Icon,
  iconClassName,
  size = 14,
}: {
  logo: string | null;
  Icon: LucideIcon;
  iconClassName: string;
  size?: number;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
      {logo && !logoFailed ? (
        <img
          src={logo}
          alt=""
          className="h-5 w-5 rounded-md"
          onError={() => setLogoFailed(true)}
        />
      ) : (
        <Icon size={size} strokeWidth={1.5} className={iconClassName} />
      )}
    </span>
  );
}

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

function isCustomMcpConnection(conn: Connection): boolean {
  return conn.status === "ACTIVE" && conn.userInfo?.type === "custom_mcp";
}

function customConnectorFromConnection(conn: Connection): CustomConnector | null {
  if (!isCustomMcpConnection(conn) || !conn.connectedAccountId) return null;
  const url = typeof conn.userInfo?.url === "string" ? conn.userInfo.url : "";
  const fetched = finiteNumber(conn.userInfo?.lastFetchedCount) ?? undefined;
  const rawInserted = finiteNumber(conn.userInfo?.lastRawInsertedCount) ?? undefined;
  const evolveTaskId = typeof conn.userInfo?.lastEvolveTaskId === "string" ? conn.userInfo.lastEvolveTaskId : undefined;
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
    return <Text variant="micro" weight="medium" className="text-red-500">{t("dataConnections.customMcp.syncFailed")}</Text>;
  }
  if (typeof fetched === "number") {
    return (
      <Text variant="micro" weight="medium" className="text-emerald-600">
        {t("dataConnections.customMcp.fetched", { value: formatCount(fetched) })}{isDistilling ? ` · ${t("dataConnections.customMcp.distilling")}` : ""}
      </Text>
    );
  }
  return <Text variant="micro" weight="medium" className="text-emerald-600">{t("dataConnections.customMcp.connected")}</Text>;
}

export function isDataSourceConnected(source: DataSource, connections: Connection[]): boolean {
  if (source.composioId && getComposioConnectionsForToolkit(connections, source.composioId).length > 0) {
    return true;
  }
  return (source.children ?? []).some(
    (child) => child.composioId && getComposioConnectionsForToolkit(connections, child.composioId).length > 0,
  );
}

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
  const [connectingToolkit, setConnectingToolkit] = useState<string | null>(
    null,
  );
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
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
    () => connections
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

  const handleConnect = async (
    composioId: string,
  ) => {
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
        if (result.ok)
          setConnectError(
            t("dataConnections.errors.missingRedirect"),
          );
        return;
      }
      void waitForToolkit(result.connectedAccountId)
        .then(async (waitResult) => {
          if (cancelledRef.current) return;
          if (waitResult.connected) {
            // Backend confirmed ACTIVE before the user dismissed the OAuth
            // surface. Composio's hosted success page doesn't deep-link back
            // to the app, so close it ourselves when possible.
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
        setConnectError(
          err instanceof Error ? err.message : t("dataConnections.errors.unexpected"),
        );
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
    setCatalogItems((prev) => reset ? page.items : [...prev, ...page.items]);
    setCatalogCursor(page.nextCursor);
    setCatalogTotalCount(page.totalCount);
    setCatalogLoaded(true);
  };

  const handleToggleCatalog = () => {
    setCatalogOpen((open) => {
      return !open;
    });
  };

  const handleCatalogCategoryChange = (category: string) => {
    setCatalogCategory(category);
  };

  const handleCatalogScroll = (event: UIEvent<HTMLDivElement>) => {
    if (catalogLoading || !catalogCursor) return;
    const target = event.currentTarget;
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distanceToBottom <= 32) {
      void loadCatalogPage(false);
    }
  };

  const catalogTotalLabel = catalogTotalCount !== null
    ? t("dataConnections.catalog.supportedCount", { total: formatCount(catalogTotalCount) })
    : t("dataConnections.catalog.supportedFallback");
  const catalogDisplayItems = useMemo(
    () => catalogItems
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
    const timer = window.setTimeout(() => {
      setDebouncedCatalogQuery(catalogQuery.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [catalogQuery]);

  useEffect(() => {
    if (!catalogOpen) return;
    setCatalogItems([]);
    setCatalogCursor(null);
    setCatalogTotalCount(null);
    setCatalogLoaded(false);
    void loadCatalogPage(true, catalogCategory, debouncedCatalogQuery);
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
    } catch (err) {
      setCustomError(t("dataConnections.customMcp.urlInvalid"));
      return;
    }
    setCustomSubmitting(true);
    try {
      const input = {
        name,
        url,
      };
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
    setConnectError(null);
    try {
      const result = await disconnectAccount(connectedAccountId);
      if (!result.ok) setConnectError(result.error ?? t("dataConnections.errors.disconnectFailed"));
    } finally {
      setDisconnectingId(null);
    }
  };

  // The backend holds the master Composio key. `configured=false` only
  // happens if the deploy is missing COMPOSIO_API_KEY env — surface a
  // service-unavailable banner rather than asking the user for a key.
  const configured = keyStatus?.configured ?? false;

  return (
    <div>
      {!configured && !statusLoading && (
        <div className="glass-card p-4 mb-4 flex items-start gap-1.5 text-caption text-foreground/60">
          <XCircle size={12} className="mt-0.5 flex-shrink-0 text-red-500" />
          <span>{t("dataConnections.notConfigured")}</span>
        </div>
      )}

      {/* Categories */}
      <div className="space-y-2.5">
        {INPUT_CATEGORIES.map((category) => {
          const isExpanded = expandedCategory === category.name;
          const CIcon = category.icon;
          const connected = countConnected(category);

          return (
            <div
              key={category.name}
              className="glass-card-strong overflow-hidden"
            >
              <button
                onClick={() =>
                  setExpandedCategory(isExpanded ? null : category.name)
                }
                className="w-full p-4 flex items-center gap-3 transition-colors hover:bg-white/20"
              >
                <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
                  <CIcon
                    size={18}
                    strokeWidth={1.5}
                    className="text-foreground/70"
                  />
                </div>
                <div className="flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {t(`dataConnections.categories.${category.labelKey}.name`)}
                    </span>
                    <Text variant="micro" weight="medium" className="text-foreground/40 bg-foreground/[0.06] px-1.5 py-0.5 rounded-md">
                      {connected} / {category.sources.length}
                    </Text>
                  </div>
                  <Text variant="caption" className="block text-foreground/40 mt-0.5 leading-snug">
                    {t(`dataConnections.categories.${category.labelKey}.description`)}
                  </Text>
                </div>
                <div className="flex-shrink-0 text-foreground/30">
                  {isExpanded ? (
                    <ChevronUp size={16} />
                  ) : (
                    <ChevronDown size={16} />
                  )}
                </div>
              </button>

              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: "easeInOut" }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-4 space-y-1">
                      <div className="h-px bg-foreground/[0.06] mb-2" />

                      {category.sources.length === 0 && (
                        <Text variant="caption" className="block text-foreground/40 italic px-1 py-3 text-center">
                          {t("dataConnections.noConnectors")}
                        </Text>
                      )}

                      {([0, 1, 2] as const).map((tier) => {
                        const tierSources = category.sources.filter(
                          (s) => s.tier === tier,
                        );
                        if (tierSources.length === 0) return null;
                        const tierLabelKeys = ["core", "more", "optional"] as const;
                        return (
                          <div key={tier}>
                            <div className="flex items-center gap-2 mb-1.5 mt-2.5">
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${
                                  tier === 0
                                    ? "bg-foreground"
                                    : tier === 1
                                      ? "bg-foreground/40"
                                      : "bg-foreground/20"
                                }`}
                              />
                              <Text variant="micro" weight="semibold" className="text-foreground/50 uppercase tracking-wider">
                                {t(`dataConnections.tiers.${tierLabelKeys[tier]}`)}
                              </Text>
                            </div>
                            <div className="space-y-1">
                              {tierSources.map((source) => {
                                const SrcIcon = source.icon;
                                const hasComposio =
                                  !!source.composioId && configured;
                                const accounts = source.composioId
                                  ? getComposioConnectionsForToolkit(
                                      connections,
                                      source.composioId,
                                    )
                                  : [];
                                const singleAccount =
                                  accounts.length === 1 ? accounts[0] : null;
                                const multiAccounts = accounts.length >= 2;
                                const isConnecting =
                                  connectingToolkit === source.composioId;
                                const isConnected = accounts.length > 0;

                                return (
                                  <div
                                    key={source.name}
                                    className="space-y-0.5"
                                  >
                                    {/* Single row */}
                                    {!multiAccounts && (
                                      <div
                                        className={`group flex items-center gap-2.5 rounded-xl px-3 py-2 transition-colors ${
                                          isConnected
                                            ? "bg-emerald-500/[0.06]"
                                            : "bg-foreground/[0.02]"
                                        }`}
                                      >
                                        <ConnectorIconSlot
                                          logo={getComposioLogoUrl(source.composioId)}
                                          Icon={SrcIcon}
                                          iconClassName={
                                            isConnected
                                              ? "text-emerald-600"
                                              : hasComposio
                                                ? "text-foreground/30"
                                                : "text-foreground/15"
                                          }
                                        />
                                        <div className="flex-1 min-w-0">
                                          <span
                                            className={`text-xs ${
                                              isConnected
                                                ? "text-foreground font-medium"
                                                : hasComposio
                                                  ? "text-foreground/45"
                                                  : "text-foreground/25"
                                            }`}
                                          >
                                            {source.name}
                                          </span>
                                          {singleAccount &&
                                            (() => {
                                              const identity = resolveIdentity(
                                                singleAccount,
                                                connections,
                                              );
                                              return identity ? (
                                                <Text variant="micro" className="block text-foreground/35 truncate">
                                                  {identity}
                                                </Text>
                                              ) : null;
                                            })()}
                                          {singleAccount?.connectedAccountId && source.composioId && (
                                            <InitTaskChip
                                              toolkit={singleAccount.toolkit}
                                              connectedAccountId={singleAccount.connectedAccountId}
                                              sourceToolkit={source.composioId}
                                            />
                                          )}
                                        </div>

                                        {singleAccount ? (
                                          <>
                                            {isConnecting ? (
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleCancel();
                                                }}
                                                className="text-micro font-medium text-foreground/50 hover:text-foreground/80 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.1] transition-colors flex items-center gap-1"
                                              >
                                                <Loader2
                                                  size={10}
                                                  className="animate-spin"
                                                />{" "}
                                                {t("common:status.cancel")}
                                              </button>
                                            ) : (
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleConnect(
                                                    source.composioId!,
                                                  );
                                                }}
                                                className="text-micro font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.1] transition-all opacity-0 group-hover:opacity-100"
                                              >
                                                <span className="flex items-center gap-1">
                                                  <Plus size={10} /> {t("dataConnections.add")}
                                                </span>
                                              </button>
                                            )}
                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                singleAccount.connectedAccountId &&
                                                  handleDisconnect(
                                                    singleAccount.connectedAccountId,
                                                  );
                                              }}
                                              disabled={
                                                disconnectingId ===
                                                singleAccount.connectedAccountId
                                              }
                                              className="text-micro font-medium rounded-lg px-2.5 py-0.5 transition-colors disabled:opacity-40 text-emerald-600 hover:text-red-500 hover:bg-red-500/[0.08]"
                                            >
                                              {disconnectingId ===
                                              singleAccount.connectedAccountId ? (
                                                <Loader2
                                                  size={10}
                                                  className="animate-spin text-red-500"
                                                />
                                              ) : (
                                                <span>
                                                  <span className="group-hover:hidden">
                                                    {t("dataConnections.connected")}
                                                  </span>
                                                  <span className="hidden group-hover:inline">
                                                    {t("dataConnections.disconnect")}
                                                  </span>
                                                </span>
                                              )}
                                            </button>
                                          </>
                                        ) : hasComposio ? (
                                          <>
                                            <span className="w-1.5 h-1.5 rounded-full bg-foreground/10 flex-shrink-0" />
                                            {isConnecting ? (
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleCancel();
                                                }}
                                                className="text-micro font-medium text-foreground/50 hover:text-foreground/80 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors flex items-center gap-1"
                                              >
                                                <Loader2
                                                  size={10}
                                                  className="animate-spin"
                                                />{" "}
                                                {t("common:status.cancel")}
                                              </button>
                                            ) : (
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleConnect(
                                                    source.composioId!,
                                                  );
                                                }}
                                                className="text-micro font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors"
                                              >
                                                {t("dataConnections.connect")}
                                              </button>
                                            )}
                                          </>
                                        ) : (
                                          <>
                                            <span className="w-1.5 h-1.5 rounded-full bg-foreground/10 flex-shrink-0" />
                                            <Text variant="micro" weight="medium" className="text-foreground/20 bg-foreground/[0.03] border border-foreground/[0.06] rounded-lg px-2.5 py-0.5 cursor-not-allowed">
                                              {t("dataConnections.connect")}
                                            </Text>
                                          </>
                                        )}
                                      </div>
                                    )}

                                    {/* Multi-account */}
                                    {multiAccounts && (
                                      <>
                                        <div className="flex items-center gap-2.5 rounded-xl px-3 py-2 bg-emerald-500/[0.06]">
                                          <ConnectorIconSlot
                                            logo={getComposioLogoUrl(source.composioId)}
                                            Icon={SrcIcon}
                                            iconClassName="text-emerald-600"
                                          />
                                          <span className="text-xs text-foreground font-medium flex-1">
                                            {source.name}
                                          </span>
                                          <Text variant="micro" className="text-foreground/30">
                                            {accounts.length}
                                          </Text>
                                          {isConnecting ? (
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                handleCancel();
                                              }}
                                              className="text-micro font-medium text-foreground/50 hover:text-foreground/80 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors flex items-center gap-1"
                                            >
                                              <Loader2
                                                size={10}
                                                className="animate-spin"
                                              />{" "}
                                              {t("common:status.cancel")}
                                            </button>
                                          ) : (
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                handleConnect(
                                                  source.composioId!,
                                                );
                                              }}
                                              className="text-micro font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors"
                                            >
                                              <span className="flex items-center gap-1">
                                                <Plus size={10} /> {t("dataConnections.add")}
                                              </span>
                                            </button>
                                          )}
                                        </div>
                                        {accounts.map((conn, idx) => {
                                          const identity = resolveIdentity(
                                            conn,
                                            connections,
                                          );
                                          const isDisconnecting =
                                            disconnectingId ===
                                            conn.connectedAccountId;
                                          return (
                                            <div
                                              key={conn.connectedAccountId}
                                              className="group flex flex-col gap-0.5 rounded-lg px-3 py-1.5 ml-6 bg-emerald-500/[0.03]"
                                            >
                                              <div className="flex items-center gap-2.5">
                                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                                                <span className="text-caption text-foreground/70 flex-1 truncate">
                                                  {identity ??
                                                    `${source.name} #${idx + 1}`}
                                                </span>
                                                <button
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    conn.connectedAccountId &&
                                                      handleDisconnect(
                                                        conn.connectedAccountId,
                                                      );
                                                  }}
                                                  disabled={isDisconnecting}
                                                  className="text-micro font-medium rounded-lg px-2 py-0.5 transition-colors disabled:opacity-40 text-foreground/30 hover:text-red-500 hover:bg-red-500/[0.08] opacity-0 group-hover:opacity-100"
                                                >
                                                  {isDisconnecting ? (
                                                    <Loader2
                                                      size={10}
                                                      className="animate-spin text-red-500"
                                                    />
                                                  ) : (
                                                    t("dataConnections.disconnect")
                                                  )}
                                                </button>
                                              </div>
                                              {conn.connectedAccountId && (
                                                <div className="ml-3.5">
                                                  <InitTaskChip
                                                    toolkit={conn.toolkit}
                                                    connectedAccountId={conn.connectedAccountId}
                                                    sourceToolkit={source.composioId}
                                                  />
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </>
                                    )}

                                    {source.children && (
                                      <div className="ml-6 mt-1.5 space-y-1 border-l border-foreground/[0.08] pl-2">
                                        {source.children.map((child) => {
                                          const ChildIcon = child.icon;
                                          const childHasComposio =
                                            !!child.composioId && configured;
                                          const childAccounts = child.composioId
                                            ? getComposioConnectionsForToolkit(
                                                connections,
                                                child.composioId,
                                              )
                                            : [];
                                          const childAccount =
                                            childAccounts.length === 1 ? childAccounts[0] : null;
                                          const childMultiAccounts = childAccounts.length >= 2;
                                          const childIsConnected = childAccounts.length > 0;
                                          const childIsConnecting =
                                            connectingToolkit === child.composioId;
                                          const childCanDisconnect =
                                            !!childAccount?.connectedAccountId &&
                                            childAccount.toolkit.toLowerCase() ===
                                              child.composioId?.toLowerCase();
                                          const childCanAddAccount =
                                            childHasComposio && !child.coverageNoteKey;
                                          return (
                                            <div key={child.name} className="space-y-0.5">
                                              <div
                                                className={`group/child flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                                                  childIsConnected
                                                    ? "bg-emerald-500/[0.035]"
                                                    : "bg-foreground/[0.015]"
                                                }`}
                                              >
                                                <ConnectorIconSlot
                                                  logo={getComposioLogoUrl(child.composioId)}
                                                  Icon={ChildIcon}
                                                  size={12}
                                                  iconClassName={
                                                    childIsConnected
                                                      ? "text-emerald-600"
                                                      : childHasComposio
                                                        ? "text-foreground/25"
                                                        : "text-foreground/15"
                                                  }
                                                />
                                                <div className="min-w-0 flex-1">
                                                  <div className="flex items-center gap-1.5">
                                                    <span
                                                      className={`truncate text-caption ${
                                                        childIsConnected
                                                          ? "text-foreground/75 font-medium"
                                                          : childHasComposio
                                                            ? "text-foreground/40"
                                                            : "text-foreground/25"
                                                      }`}
                                                    >
                                                      {child.name}
                                                    </span>
                                                    {child.coverageNoteKey && (
                                                      <Text variant="micro" className="text-foreground/30">
                                                        {t(`dataConnections.coverage.${child.coverageNoteKey}`)}
                                                      </Text>
                                                    )}
                                                  </div>
                                                  {child.showInitTask !== false &&
                                                    childAccount?.connectedAccountId &&
                                                    child.composioId && (
                                                      <InitTaskChip
                                                        toolkit={childAccount.toolkit}
                                                        connectedAccountId={childAccount.connectedAccountId}
                                                        sourceToolkit={child.composioId}
                                                      />
                                                    )}
                                                </div>
                                                {childIsConnected ? (
                                                  <div className="flex flex-shrink-0 items-center gap-1.5">
                                                    {childIsConnecting ? (
                                                      <button
                                                        onClick={(e) => {
                                                          e.stopPropagation();
                                                          handleCancel();
                                                        }}
                                                        className="text-micro font-medium text-foreground/50 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 flex items-center gap-1"
                                                      >
                                                        <Loader2 size={10} className="animate-spin" />
                                                        {t("common:status.cancel")}
                                                      </button>
                                                    ) : (
                                                      <>
                                                        {childCanAddAccount && (
                                                          <button
                                                            aria-label={t("dataConnections.addAccountAria", { name: child.name })}
                                                            onClick={(e) => {
                                                              e.stopPropagation();
                                                              handleConnect(child.composioId!);
                                                            }}
                                                            className="inline-flex items-center gap-1 text-micro font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.1] transition-all opacity-0 group-hover/child:opacity-100"
                                                          >
                                                            <Plus size={10} />
                                                            {t("dataConnections.add")}
                                                          </button>
                                                        )}
                                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                                                        {childCanDisconnect ? (
                                                          <button
                                                            onClick={(e) => {
                                                              e.stopPropagation();
                                                              handleDisconnect(childAccount.connectedAccountId!);
                                                            }}
                                                            disabled={
                                                              disconnectingId === childAccount.connectedAccountId
                                                            }
                                                            className="text-micro font-medium rounded-lg px-2 py-0.5 transition-colors disabled:opacity-40 text-emerald-600 hover:text-red-500 hover:bg-red-500/[0.08]"
                                                          >
                                                            {disconnectingId === childAccount.connectedAccountId ? (
                                                              <Loader2
                                                                size={10}
                                                                className="animate-spin text-red-500"
                                                              />
                                                            ) : (
                                                              <span>
                                                                <span className="group-hover/child:hidden">
                                                                  {t("dataConnections.connected")}
                                                                </span>
                                                                <span className="hidden group-hover/child:inline">
                                                                  {t("dataConnections.disconnect")}
                                                                </span>
                                                              </span>
                                                            )}
                                                          </button>
                                                        ) : (
                                                          <Text variant="micro" weight="medium" className="text-emerald-600">
                                                            {t("dataConnections.connected")}
                                                          </Text>
                                                        )}
                                                      </>
                                                    )}
                                                  </div>
                                                ) : childHasComposio ? (
                                                  child.coverageNoteKey ? (
                                                    <Text variant="micro" weight="medium" className="text-foreground/30">
                                                      {t(`dataConnections.coverage.${child.coverageNoteKey}`)}
                                                    </Text>
                                                  ) : childIsConnecting ? (
                                                    <button
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleCancel();
                                                      }}
                                                      className="text-micro font-medium text-foreground/50 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 flex items-center gap-1"
                                                    >
                                                      <Loader2 size={10} className="animate-spin" />
                                                      {t("common:status.cancel")}
                                                    </button>
                                                  ) : (
                                                    <button
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleConnect(child.composioId!);
                                                      }}
                                                      className="text-micro font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.1] transition-colors"
                                                    >
                                                      {t("dataConnections.connect")}
                                                    </button>
                                                  )
                                                ) : (
                                                  <Text variant="micro" weight="medium" className="text-foreground/20">
                                                    {t("dataConnections.connect")}
                                                  </Text>
                                                )}
                                              </div>
                                              {childMultiAccounts &&
                                                child.showInitTask !== false &&
                                                child.composioId && (
                                                  <div className="ml-4 space-y-0.5">
                                                    {childAccounts.map((conn, idx) => {
                                                      const identity = resolveIdentity(conn, connections);
                                                      const isDisconnecting =
                                                        disconnectingId === conn.connectedAccountId;
                                                      return (
                                                        <div
                                                          key={conn.connectedAccountId ?? `${child.name}-${idx}`}
                                                          className="rounded-lg bg-emerald-500/[0.02] px-2 py-1"
                                                        >
                                                          <div className="flex items-center gap-2">
                                                            <p className="min-w-0 flex-1 truncate text-micro text-foreground/45">
                                                              {identity ?? `${child.name} #${idx + 1}`}
                                                            </p>
                                                            {conn.connectedAccountId && (
                                                              <button
                                                                type="button"
                                                                onClick={(e) => {
                                                                  e.stopPropagation();
                                                                  handleDisconnect(conn.connectedAccountId!);
                                                                }}
                                                                disabled={isDisconnecting}
                                                                className="text-micro font-medium rounded-lg px-2 py-0.5 transition-colors disabled:opacity-40 text-foreground/35 hover:text-red-500 hover:bg-red-500/[0.08]"
                                                              >
                                                                {isDisconnecting ? (
                                                                  <Loader2
                                                                    size={10}
                                                                    className="animate-spin text-red-500"
                                                                  />
                                                                ) : (
                                                                  t("dataConnections.disconnect")
                                                                )}
                                                              </button>
                                                            )}
                                                          </div>
                                                          {conn.connectedAccountId && (
                                                            <InitTaskChip
                                                              toolkit={conn.toolkit}
                                                              connectedAccountId={conn.connectedAccountId}
                                                              sourceToolkit={child.composioId}
                                                            />
                                                          )}
                                                        </div>
                                                      );
                                                    })}
                                                  </div>
                                                )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* Additional connector catalog */}
      {configured && (
        <div className="glass-card-strong mt-3 overflow-hidden">
          <button
            onClick={handleToggleCatalog}
            className="w-full p-4 flex items-center gap-3 text-left hover:bg-foreground/[0.02] transition-colors"
          >
            <div className="w-9 h-9 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
              <Globe2 size={16} strokeWidth={1.5} className="text-foreground/60" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">{t("dataConnections.catalog.title")}</h3>
              </div>
              <Text variant="caption" className="block text-foreground/45 mt-0.5">
                {catalogTotalLabel}
              </Text>
            </div>
            <ChevronDown
              size={16}
              className={`text-foreground/30 transition-transform ${catalogOpen ? "rotate-180" : ""}`}
            />
          </button>

          <AnimatePresence initial={false}>
            {catalogOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="px-4 pb-4 space-y-3">
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <label className="relative min-w-0">
                      <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground/30" />
                      <input
                        value={catalogQuery}
                        onChange={(e) => setCatalogQuery(e.target.value)}
                        placeholder={t("dataConnections.catalog.searchPlaceholder")}
                        className="w-full rounded-xl border border-foreground/10 bg-foreground/[0.03] pl-8 pr-3 py-2 text-xs text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/25"
                      />
                    </label>
                    <select
                      value={catalogCategory}
                      onChange={(e) => handleCatalogCategoryChange(e.target.value)}
                      className="rounded-xl border border-foreground/10 bg-foreground/[0.03] px-2 py-2 text-xs text-foreground outline-none focus:border-foreground/25"
                    >
                      {CATALOG_CATEGORIES.map((cat) => (
                        <option key={cat.value} value={cat.value}>{t(`dataConnections.catalog.categories.${cat.labelKey}`)}</option>
                      ))}
                    </select>
                  </div>

                  {catalogItems.length === 0 && catalogLoading ? (
                    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] px-3 py-3 text-xs text-foreground/45 flex items-center gap-2">
                      <Loader2 size={13} className="animate-spin" />
                      {t("dataConnections.catalog.loading")}
                    </div>
                  ) : catalogItems.length === 0 && catalogLoaded ? (
                    <div className="rounded-xl bg-foreground/[0.02] px-3 py-3 text-xs text-foreground/40">
                      {t("dataConnections.catalog.empty")}
                    </div>
                  ) : catalogItems.length === 0 ? (
                    <button
                      onClick={() => void loadCatalogPage(true)}
                      disabled={catalogLoading}
                      className="w-full rounded-xl border border-foreground/10 bg-foreground/[0.04] px-3 py-2 text-xs font-medium text-foreground hover:bg-foreground/[0.08] disabled:opacity-50"
                    >
                      {t("dataConnections.catalog.load")}
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <div
                        aria-label={t("dataConnections.catalog.resultsAria")}
                        onScroll={handleCatalogScroll}
                        className="max-h-72 overflow-y-auto pr-1 space-y-1"
                      >
                        {catalogDisplayItems.map((item) => {
                          const isConnecting = connectingToolkit === item.slug;
                          const itemAccounts = getComposioConnectionsForToolkit(
                            connections,
                            item.slug,
                          );
                          const primaryAccount = itemAccounts[0];
                          const isConnected = itemAccounts.length > 0;
                          return (
                            <div
                              key={item.slug}
                              className={`group flex items-center gap-2.5 rounded-xl px-3 py-2 ${
                                isConnected ? "bg-emerald-500/[0.06]" : "bg-foreground/[0.02]"
                              }`}
                            >
                              <ConnectorIconSlot
                                logo={item.logo ?? getComposioLogoUrl(item.slug)}
                                Icon={Globe2}
                                iconClassName="text-foreground/35"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate text-xs font-medium text-foreground/75">{item.name || item.slug}</span>
                                </div>
                                <Text variant="micro" className="block text-foreground/35 truncate">
                                  {item.auth_schemes.length > 0 ? item.auth_schemes.join(", ") : "auth"}{item.categories.length > 0 ? ` · ${item.categories.join(", ")}` : ""}
                                </Text>
                                {primaryAccount?.connectedAccountId && (
                                  <InitTaskChip
                                    toolkit={primaryAccount.toolkit}
                                    connectedAccountId={primaryAccount.connectedAccountId}
                                    sourceToolkit={item.slug}
                                  />
                                )}
                              </div>
                              {isConnecting ? (
                                <button
                                  onClick={handleCancel}
                                  className="text-micro font-medium text-foreground/50 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5"
                                >
                                  {t("common:status.cancel")}
                                </button>
                              ) : isConnected ? (
                                <div className="flex flex-shrink-0 items-center gap-1.5">
                                  <button
                                    onClick={() => void handleConnect(item.slug)}
                                    className="inline-flex items-center gap-1 text-micro font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.1] opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-all"
                                  >
                                    <Plus size={10} />
                                    {t("dataConnections.add")}
                                  </button>
                                  <Text variant="micro" weight="medium" className="text-emerald-600">{t("dataConnections.connected")}</Text>
                                </div>
                              ) : (
                                <button
                                  onClick={() => void handleConnect(item.slug)}
                                  className="text-micro font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1]"
                                >
                                  {t("dataConnections.connect")}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        {catalogCursor && (
                          <Text variant="micro" className="text-foreground/30">
                            {catalogLoading ? t("common:status.loading") : t("dataConnections.catalog.scrollForMore")}
                          </Text>
                        )}
                      </div>
                    </div>
                  )}

                  {catalogError && (
                    <Text variant="caption" className="block text-red-500">{catalogError}</Text>
                  )}

                  {customConnectors.length > 0 && (
                    <div className="space-y-1.5 border-t border-foreground/[0.06] pt-2">
                      {customConnectors.map((connector) => (
                        <div
                          key={connector.id}
                          className="flex items-center gap-2.5 rounded-xl bg-foreground/[0.02] px-3 py-2"
                        >
                          <Globe2 size={14} className="flex-shrink-0 text-foreground/35" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-xs font-medium text-foreground/75">
                                {connector.name}
                              </span>
                              <Text variant="micro" weight="medium" className="text-foreground/30">
                                MCP
                              </Text>
                            </div>
                            <Text variant="micro" className="block truncate text-foreground/35">
                              {connector.url}
                            </Text>
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-1.5">
                            <CustomMcpStatus connector={connector} />
                            <button
                              onClick={() => openEditCustomConnector(connector)}
                              aria-label={t("dataConnections.customMcp.editAria", { name: connector.name })}
                              className="rounded-lg p-1 text-foreground/35 hover:bg-foreground/[0.06] hover:text-foreground"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              onClick={() => void handleCustomDelete(connector)}
                              aria-label={t("dataConnections.customMcp.deleteAria", { name: connector.name })}
                              disabled={disconnectingId === connector.id}
                              className="rounded-lg p-1 text-foreground/35 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                            >
                              {disconnectingId === connector.id ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Trash2 size={12} />
                              )}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="pt-2 border-t border-foreground/[0.06]">
                    <button
                      onClick={openAddCustomConnector}
                      className="w-full rounded-xl border border-dashed border-foreground/15 bg-foreground/[0.02] px-3 py-2 text-xs font-medium text-foreground/65 hover:text-foreground hover:bg-foreground/[0.05] flex items-center justify-center gap-1.5"
                    >
                      <Plus size={13} />
                      {t("dataConnections.customMcp.addButton")}
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Sites the user has logged into through the agent's browser */}
      <BrowserLoginsSection />

      {/* Connect error */}
      <AnimatePresence>
        {connectError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="glass-card px-4 py-3 mt-3 flex items-start gap-1.5 text-caption text-red-500"
          >
            <XCircle size={12} className="mt-0.5 flex-shrink-0" />
            <span>{connectError}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {customOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/20 px-4 py-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-connector-title"
          >
            <motion.div
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="w-full max-w-md rounded-2xl border border-foreground/10 bg-background p-5 shadow-2xl"
            >
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 id="custom-connector-title" className="text-lg font-semibold leading-snug text-foreground">
                      {editingCustomConnector
                        ? t("dataConnections.customMcp.editTitle")
                        : t("dataConnections.customMcp.addTitle")}
                    </h2>
                  </div>
                  <p className="mt-3 max-w-xl text-xs leading-5 text-foreground/50">
                    {t("dataConnections.customMcp.dialogDescription")}
                  </p>
                </div>
                <button
                  onClick={closeCustomConnectorDialog}
                  aria-label={t("dataConnections.customMcp.closeAria")}
                  className="rounded-full p-1.5 text-foreground/45 hover:bg-foreground/[0.08] hover:text-foreground"
                >
                  <X size={24} />
                </button>
              </div>

              <div className="mt-6 space-y-4">
                <input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder={t("dataConnections.customMcp.namePlaceholder")}
                  autoComplete="off"
                  name="pinai-custom-mcp-name"
                  spellCheck={false}
                  className="w-full rounded-xl border border-foreground/12 bg-white px-4 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/35 focus:border-foreground/30"
                />
                <input
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder={t("dataConnections.customMcp.urlPlaceholder")}
                  autoComplete="off"
                  name="pinai-custom-mcp-url"
                  spellCheck={false}
                  className="w-full rounded-xl border border-foreground/12 bg-white px-4 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/35 focus:border-foreground/30"
                />

                <p className="text-xs leading-5 text-foreground/45">
                  {t("dataConnections.customMcp.trustNote")}
                </p>

                {customError && (
                  <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">
                    {customError}
                  </p>
                )}
              </div>

              <div className="mt-7 flex justify-end gap-3">
                <button
                  onClick={closeCustomConnectorDialog}
                  className="rounded-xl bg-foreground/[0.08] px-5 py-2.5 text-sm font-semibold text-foreground hover:bg-foreground/[0.12]"
                >
                  {t("common:status.cancel")}
                </button>
                <button
                  onClick={() => void handleCustomConnect()}
                  disabled={customSubmitting}
                  className="rounded-xl bg-foreground px-5 py-2.5 text-sm font-semibold text-background hover:bg-foreground/85"
                >
                  {customSubmitting ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 size={14} className="animate-spin" />
                      {editingCustomConnector ? t("dataConnections.save") : t("dataConnections.add")}
                    </span>
                  ) : (
                    editingCustomConnector ? t("dataConnections.save") : t("dataConnections.add")
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {connectingToolkit && (
        <div className="glass-card px-4 py-3 mt-3 flex items-center justify-between">
          <p className="text-caption text-foreground/40 italic flex items-center gap-1.5">
            <Loader2 size={10} className="animate-spin" />
            {t("dataConnections.authorizeHint")}
          </p>
          <button
            onClick={handleCancel}
            className="text-micro font-medium text-foreground/40 hover:text-foreground/70 px-2 py-0.5 rounded-lg hover:bg-foreground/[0.06] transition-colors"
          >
            {t("common:status.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
