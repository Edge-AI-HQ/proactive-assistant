import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
} from "@/hooks/useComposio";
import {
  buildConnectorInitTaskId,
  getComposioConnectionsForToolkit,
  normalizeComposioToolkit,
} from "@/hooks/useComposio";
import { useInitTask, isInitTaskFresh } from "@/hooks/useInitTask";
import { resolveComposioConnectionIdentity } from "@/lib/composio-display-identity";
import { closeOAuthSurface, openOAuthAndAwaitClose } from "@/lib/oauth-popup";

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
  const taskId = buildConnectorInitTaskId(toolkit, connectedAccountId);
  const { task, error, terminal } = useInitTask(taskId);
  if (!task) {
    // Pre-first-fetch: keep loader silent on errors (the row may not exist
    // yet — e.g. user never triggered connect on this device).
    if (error) return null;
    return (
      <p className="text-[10px] text-foreground/40 truncate flex items-center gap-1">
        <Loader2 size={9} className="animate-spin" />
        Initializing…
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
        const reason = String(task.result?.reason ?? "skipped");
        return (
          <p className="text-[10px] text-foreground/40 truncate">
            Initialization skipped · {reason}
          </p>
        );
      }
      return (
        <p className="text-[10px] text-emerald-600/80 truncate">
          Initialized · {fetched} fetched{memoriesWritten > 0 ? ` · ${memoriesWritten} memories` : ""}{skillsAdded > 0 ? ` · ${skillsAdded} skills` : ""}
        </p>
      );
    }
    // failed / timed_out / cancelled / lost — show shortest possible error
    const shortErr = (task.last_error_message ?? task.last_error_code ?? "Unknown error").slice(0, 80);
    return (
      <p className="text-[10px] text-red-500/80 truncate">
        Initialization failed — {shortErr}
      </p>
    );
  }
  // running / queued — surface stage + progress when present
  const stage = typeof task.progress?.stage === "string" ? task.progress.stage : null;
  const limit = Number(task.payload?.limit ?? 0);
  const progressDetail = (() => {
    if (!stage) return "Queued";
    if (stage === "fetch") return `Fetching data${limit ? ` (limit ${limit})` : ""}`;
    if (stage === "raw") return "Saving locally";
    if (stage === "signals") return "Extracting signals";
    if (stage === "evolve") return "Distilling memories";
    return stage;
  })();
  return (
    <p className="text-[10px] text-foreground/45 truncate flex items-center gap-1">
      <Loader2 size={9} className="animate-spin" />
      Initializing · {progressDetail}
    </p>
  );
}

function resolveIdentity(
  conn: Connection,
  allConnections: Connection[],
): string | null {
  return resolveComposioConnectionIdentity(conn, allConnections);
}

export interface DataSource {
  name: string;
  composioId?: string;
  description: string;
  icon: LucideIcon;
  tier: 0 | 1 | 2;
  children?: DataSource[];
  coverageNote?: string;
  showInitTask?: boolean;
}

export interface InputCategory {
  name: string;
  icon: LucideIcon;
  description: string;
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
        coverageNote: "via Drive metadata",
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
    name: "Recommended",
    icon: Briefcase,
    description: "Best first-party data sources",
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
  { value: "", label: "All" },
  { value: "email", label: "Email" },
  { value: "calendar", label: "Calendar" },
  { value: "team-chat", label: "Team chat" },
  { value: "productivity", label: "Productivity" },
  { value: "developer-tools", label: "Dev tools" },
  { value: "crm", label: "CRM" },
  { value: "project-management", label: "Projects" },
  { value: "documents", label: "Documents" },
  { value: "databases", label: "Databases" },
  { value: "analytics", label: "Analytics" },
  { value: "marketing-automation", label: "Marketing" },
  { value: "ecommerce", label: "Ecommerce" },
  { value: "scheduling & booking", label: "Scheduling" },
  { value: "file management & storage", label: "Files" },
  { value: "video & audio", label: "Video & audio" },
] as const;

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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
  const { task } = useInitTask(connector.evolveTaskId ?? null);
  const fetched = connector.fetched ?? connector.rawInserted;
  const isDistilling = task?.status === "queued" || task?.status === "running";
  if (connector.lastError) {
    return <span className="text-[10px] font-medium text-red-500">Sync failed</span>;
  }
  if (typeof fetched === "number") {
    return (
      <span className="text-[10px] font-medium text-emerald-600">
        {formatCount(fetched)} fetched{isDistilling ? " · Distilling" : ""}
      </span>
    );
  }
  return <span className="text-[10px] font-medium text-emerald-600">Connected</span>;
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
        setConnectError(result.error ?? "Connect failed");
        return;
      }
      if (!result.redirectUrl && result.connectedAccountId) {
        await composio.loadConnections();
        return;
      }
      if (!result.redirectUrl || !result.connectedAccountId) {
        if (result.ok)
          setConnectError(
            "Connect succeeded but missing redirect info — please try again",
          );
        return;
      }
      const raceResult = await Promise.race<{ connected: boolean; initTaskId?: string }>([
        waitForToolkit(result.connectedAccountId),
        openOAuthAndAwaitClose(result.redirectUrl).then(() => {
          cancelWait();
          return { connected: false };
        }),
      ]);
      if (raceResult.connected) {
        // Backend confirmed ACTIVE before the user dismissed the OAuth
        // surface. Composio's hosted success page doesn't deep-link back
        // to the app, so close it ourselves — otherwise the in-app browser
        // (mobile) / popup (web) sits open on the "you can close this"
        // page after linking finishes.
        await closeOAuthSurface();
      } else if (!cancelledRef.current) {
        setConnectError("Connection not confirmed — please try again");
      }
      // No need to thread initTaskId — the chip rebuilds it from
      // (toolkit, connectedAccountId) and polls on mount once the
      // connection appears in `connections`.
    } catch (err) {
      if (!cancelledRef.current)
        setConnectError(
          err instanceof Error ? err.message : "Unexpected error",
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
      setCatalogError(result.error ?? "Catalog unavailable");
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

  const catalogTotalLabel =
    catalogTotalCount !== null ? `${formatCount(catalogTotalCount)} supported` : "1000+ supported";
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
      setCustomError("Enter a connector name");
      return;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        setCustomError("Remote MCP server URL must use https");
        return;
      }
    } catch (err) {
      setCustomError("Enter a valid Remote MCP server URL");
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
        setCustomError(result.error ?? "Custom connector failed");
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
        setConnectError(result.error ?? "Delete custom connector failed");
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
      if (!result.ok) setConnectError(result.error ?? "Disconnect failed");
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
        <div className="glass-card p-4 mb-4 flex items-start gap-1.5 text-[11px] text-foreground/60">
          <XCircle size={12} className="mt-0.5 flex-shrink-0 text-red-500" />
          <span>
            Composio is not configured on this deployment. Connections will be
            unavailable until the backend operator sets it up.
          </span>
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
                      {category.name}
                    </span>
                    <span className="text-[10px] font-medium text-foreground/40 bg-foreground/[0.06] px-1.5 py-0.5 rounded-md">
                      {connected} / {category.sources.length}
                    </span>
                  </div>
                  <p className="text-[11px] text-foreground/40 mt-0.5 leading-snug">
                    {category.description}
                  </p>
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
                        <p className="text-[11px] text-foreground/40 italic px-1 py-3 text-center">
                          No connectors available yet
                        </p>
                      )}

                      {[0, 1, 2].map((tier) => {
                        const tierSources = category.sources.filter(
                          (s) => s.tier === tier,
                        );
                        if (tierSources.length === 0) return null;
                        const tierLabels = ["Core sources", "More sources", "Optional"];
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
                              <span className="text-[10px] font-semibold text-foreground/50 uppercase tracking-wider">
                                {tierLabels[tier]}
                              </span>
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
                                                <p className="text-[10px] text-foreground/35 truncate">
                                                  {identity}
                                                </p>
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
                                                className="text-[10px] font-medium text-foreground/50 hover:text-foreground/80 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.1] transition-colors flex items-center gap-1"
                                              >
                                                <Loader2
                                                  size={10}
                                                  className="animate-spin"
                                                />{" "}
                                                Cancel
                                              </button>
                                            ) : (
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleConnect(
                                                    source.composioId!,
                                                  );
                                                }}
                                                className="text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.1] transition-all opacity-0 group-hover:opacity-100"
                                              >
                                                <span className="flex items-center gap-1">
                                                  <Plus size={10} /> Add
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
                                              className="text-[10px] font-medium rounded-lg px-2.5 py-0.5 transition-colors disabled:opacity-40 text-emerald-600 hover:text-red-500 hover:bg-red-500/[0.08]"
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
                                                    Connected
                                                  </span>
                                                  <span className="hidden group-hover:inline">
                                                    Disconnect
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
                                                className="text-[10px] font-medium text-foreground/50 hover:text-foreground/80 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors flex items-center gap-1"
                                              >
                                                <Loader2
                                                  size={10}
                                                  className="animate-spin"
                                                />{" "}
                                                Cancel
                                              </button>
                                            ) : (
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleConnect(
                                                    source.composioId!,
                                                  );
                                                }}
                                                className="text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors"
                                              >
                                                Connect
                                              </button>
                                            )}
                                          </>
                                        ) : (
                                          <>
                                            <span className="w-1.5 h-1.5 rounded-full bg-foreground/10 flex-shrink-0" />
                                            <span className="text-[10px] font-medium text-foreground/20 bg-foreground/[0.03] border border-foreground/[0.06] rounded-lg px-2.5 py-0.5 cursor-not-allowed">
                                              Connect
                                            </span>
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
                                          <span className="text-[10px] text-foreground/30">
                                            {accounts.length}
                                          </span>
                                          {isConnecting ? (
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                handleCancel();
                                              }}
                                              className="text-[10px] font-medium text-foreground/50 hover:text-foreground/80 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors flex items-center gap-1"
                                            >
                                              <Loader2
                                                size={10}
                                                className="animate-spin"
                                              />{" "}
                                              Cancel
                                            </button>
                                          ) : (
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                handleConnect(
                                                  source.composioId!,
                                                );
                                              }}
                                              className="text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors"
                                            >
                                              <span className="flex items-center gap-1">
                                                <Plus size={10} /> Add
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
                                                <span className="text-[11px] text-foreground/70 flex-1 truncate">
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
                                                  className="text-[10px] font-medium rounded-lg px-2 py-0.5 transition-colors disabled:opacity-40 text-foreground/30 hover:text-red-500 hover:bg-red-500/[0.08] opacity-0 group-hover:opacity-100"
                                                >
                                                  {isDisconnecting ? (
                                                    <Loader2
                                                      size={10}
                                                      className="animate-spin text-red-500"
                                                    />
                                                  ) : (
                                                    "Disconnect"
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
                                            childHasComposio && !child.coverageNote;
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
                                                      className={`truncate text-[11px] ${
                                                        childIsConnected
                                                          ? "text-foreground/75 font-medium"
                                                          : childHasComposio
                                                            ? "text-foreground/40"
                                                            : "text-foreground/25"
                                                      }`}
                                                    >
                                                      {child.name}
                                                    </span>
                                                    {child.coverageNote && (
                                                      <span className="text-[9px] text-foreground/30">
                                                        {child.coverageNote}
                                                      </span>
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
                                                        className="text-[10px] font-medium text-foreground/50 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 flex items-center gap-1"
                                                      >
                                                        <Loader2 size={10} className="animate-spin" />
                                                        Cancel
                                                      </button>
                                                    ) : (
                                                      <>
                                                        {childCanAddAccount && (
                                                          <button
                                                            aria-label={`Add ${child.name} account`}
                                                            onClick={(e) => {
                                                              e.stopPropagation();
                                                              handleConnect(child.composioId!);
                                                            }}
                                                            className="inline-flex items-center gap-1 text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.1] transition-all opacity-0 group-hover/child:opacity-100"
                                                          >
                                                            <Plus size={10} />
                                                            Add
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
                                                            className="text-[10px] font-medium rounded-lg px-2 py-0.5 transition-colors disabled:opacity-40 text-emerald-600 hover:text-red-500 hover:bg-red-500/[0.08]"
                                                          >
                                                            {disconnectingId === childAccount.connectedAccountId ? (
                                                              <Loader2
                                                                size={10}
                                                                className="animate-spin text-red-500"
                                                              />
                                                            ) : (
                                                              <span>
                                                                <span className="group-hover/child:hidden">
                                                                  Connected
                                                                </span>
                                                                <span className="hidden group-hover/child:inline">
                                                                  Disconnect
                                                                </span>
                                                              </span>
                                                            )}
                                                          </button>
                                                        ) : (
                                                          <span className="text-[10px] font-medium text-emerald-600">
                                                            Connected
                                                          </span>
                                                        )}
                                                      </>
                                                    )}
                                                  </div>
                                                ) : childHasComposio ? (
                                                  child.coverageNote ? (
                                                    <span className="text-[10px] font-medium text-foreground/30">
                                                      {child.coverageNote}
                                                    </span>
                                                  ) : childIsConnecting ? (
                                                    <button
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleCancel();
                                                      }}
                                                      className="text-[10px] font-medium text-foreground/50 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 flex items-center gap-1"
                                                    >
                                                      <Loader2 size={10} className="animate-spin" />
                                                      Cancel
                                                    </button>
                                                  ) : (
                                                    <button
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleConnect(child.composioId!);
                                                      }}
                                                      className="text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.1] transition-colors"
                                                    >
                                                      Connect
                                                    </button>
                                                  )
                                                ) : (
                                                  <span className="text-[10px] font-medium text-foreground/20">
                                                    Connect
                                                  </span>
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
                                                            <p className="min-w-0 flex-1 truncate text-[10px] text-foreground/45">
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
                                                                className="text-[10px] font-medium rounded-lg px-2 py-0.5 transition-colors disabled:opacity-40 text-foreground/35 hover:text-red-500 hover:bg-red-500/[0.08]"
                                                              >
                                                                {isDisconnecting ? (
                                                                  <Loader2
                                                                    size={10}
                                                                    className="animate-spin text-red-500"
                                                                  />
                                                                ) : (
                                                                  "Disconnect"
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
                <h3 className="text-sm font-semibold text-foreground">More data connectors</h3>
              </div>
              <p className="text-[11px] text-foreground/45 mt-0.5">
                {catalogTotalLabel} sources
              </p>
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
                        placeholder="Search connectors"
                        className="w-full rounded-xl border border-foreground/10 bg-foreground/[0.03] pl-8 pr-3 py-2 text-xs text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/25"
                      />
                    </label>
                    <select
                      value={catalogCategory}
                      onChange={(e) => handleCatalogCategoryChange(e.target.value)}
                      className="rounded-xl border border-foreground/10 bg-foreground/[0.03] px-2 py-2 text-xs text-foreground outline-none focus:border-foreground/25"
                    >
                      {CATALOG_CATEGORIES.map((cat) => (
                        <option key={cat.value} value={cat.value}>{cat.label}</option>
                      ))}
                    </select>
                  </div>

                  {catalogItems.length === 0 && catalogLoading ? (
                    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] px-3 py-3 text-xs text-foreground/45 flex items-center gap-2">
                      <Loader2 size={13} className="animate-spin" />
                      Loading connectors
                    </div>
                  ) : catalogItems.length === 0 && catalogLoaded ? (
                    <div className="rounded-xl bg-foreground/[0.02] px-3 py-3 text-xs text-foreground/40">
                      No connectors found
                    </div>
                  ) : catalogItems.length === 0 ? (
                    <button
                      onClick={() => void loadCatalogPage(true)}
                      disabled={catalogLoading}
                      className="w-full rounded-xl border border-foreground/10 bg-foreground/[0.04] px-3 py-2 text-xs font-medium text-foreground hover:bg-foreground/[0.08] disabled:opacity-50"
                    >
                      Load connectors
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <div
                        aria-label="Connector results"
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
                                <p className="text-[10px] text-foreground/35 truncate">
                                  {item.auth_schemes.length > 0 ? item.auth_schemes.join(", ") : "auth"}{item.categories.length > 0 ? ` · ${item.categories.join(", ")}` : ""}
                                </p>
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
                                  className="text-[10px] font-medium text-foreground/50 bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5"
                                >
                                  Cancel
                                </button>
                              ) : isConnected ? (
                                <div className="flex flex-shrink-0 items-center gap-1.5">
                                  <button
                                    onClick={() => void handleConnect(item.slug)}
                                    className="inline-flex items-center gap-1 text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.1] opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-all"
                                  >
                                    <Plus size={10} />
                                    Add
                                  </button>
                                  <span className="text-[10px] font-medium text-emerald-600">Connected</span>
                                </div>
                              ) : (
                                <button
                                  onClick={() => void handleConnect(item.slug)}
                                  className="text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1]"
                                >
                                  Connect
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        {catalogCursor && (
                          <span className="text-[10px] text-foreground/30">
                            {catalogLoading ? "Loading..." : "Scroll for more"}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {catalogError && (
                    <p className="text-[11px] text-red-500">{catalogError}</p>
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
                              <span className="text-[10px] font-medium text-foreground/30">
                                MCP
                              </span>
                            </div>
                            <p className="truncate text-[10px] text-foreground/35">
                              {connector.url}
                            </p>
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-1.5">
                            <CustomMcpStatus connector={connector} />
                            <button
                              onClick={() => openEditCustomConnector(connector)}
                              aria-label={`Edit ${connector.name}`}
                              className="rounded-lg p-1 text-foreground/35 hover:bg-foreground/[0.06] hover:text-foreground"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              onClick={() => void handleCustomDelete(connector)}
                              aria-label={`Delete ${connector.name}`}
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
                      Add custom connector
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Connect error */}
      <AnimatePresence>
        {connectError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="glass-card px-4 py-3 mt-3 flex items-start gap-1.5 text-[11px] text-red-500"
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
                      {editingCustomConnector ? "Edit custom connector" : "Add custom connector"}
                    </h2>
                  </div>
                  <p className="mt-3 max-w-xl text-xs leading-5 text-foreground/50">
                    Connect PIN AI to your data and tools with a remote MCP server.
                  </p>
                </div>
                <button
                  onClick={closeCustomConnectorDialog}
                  aria-label="Close custom connector dialog"
                  className="rounded-full p-1.5 text-foreground/45 hover:bg-foreground/[0.08] hover:text-foreground"
                >
                  <X size={24} />
                </button>
              </div>

              <div className="mt-6 space-y-4">
                <input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="Name"
                  autoComplete="off"
                  name="pinai-custom-mcp-name"
                  spellCheck={false}
                  className="w-full rounded-xl border border-foreground/12 bg-white px-4 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/35 focus:border-foreground/30"
                />
                <input
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="Remote MCP server URL"
                  autoComplete="off"
                  name="pinai-custom-mcp-url"
                  spellCheck={false}
                  className="w-full rounded-xl border border-foreground/12 bg-white px-4 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/35 focus:border-foreground/30"
                />

                <p className="text-xs leading-5 text-foreground/45">
                  Only use connectors from developers you trust. PIN AI cannot verify that third-party tools will work as intended or remain unchanged.
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
                  Cancel
                </button>
                <button
                  onClick={() => void handleCustomConnect()}
                  disabled={customSubmitting}
                  className="rounded-xl bg-foreground px-5 py-2.5 text-sm font-semibold text-background hover:bg-foreground/85"
                >
                  {customSubmitting ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 size={14} className="animate-spin" />
                      {editingCustomConnector ? "Save" : "Add"}
                    </span>
                  ) : (
                    editingCustomConnector ? "Save" : "Add"
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {connectingToolkit && (
        <div className="glass-card px-4 py-3 mt-3 flex items-center justify-between">
          <p className="text-[11px] text-foreground/40 italic flex items-center gap-1.5">
            <Loader2 size={10} className="animate-spin" />
            Authorize in your browser — this will update automatically
          </p>
          <button
            onClick={handleCancel}
            className="text-[10px] font-medium text-foreground/40 hover:text-foreground/70 px-2 py-0.5 rounded-lg hover:bg-foreground/[0.06] transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
