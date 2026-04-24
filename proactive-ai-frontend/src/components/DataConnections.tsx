import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Heart,
  Briefcase,
  User,
  TrendingUp,
  BookOpen,
  MapPin,
  ChevronDown,
  ChevronUp,
  Mail,
  Calendar,
  FolderOpen,
  MessageSquare,
  CreditCard,
  FileText,
  Activity,
  Watch,
  Users,
  Globe,
  Smartphone,
  Eye,
  Clock,
  Wifi,
  Code,
  BarChart3,
  Handshake,
  Key,
  Loader2,
  XCircle,
  Plus,
  Video,
  ListTodo,
  Music,
  Pen,
  CircleDot,
  Bike,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Browser } from "@capacitor/browser";
import type { ComposioState, Connection } from "@/hooks/useComposio";
import { useInitTask } from "@/hooks/useInitTask";
import { extractComposioDisplayIdentity } from "@/lib/composioDisplayIdentity";
import { isNative } from "@/lib/platform";

/**
 * Small inline chip that polls a connector.init task and renders a
 * one-line progress / outcome summary under the connector card.
 *
 * Render rules:
 *   - while running:   "初始化中… stage=fetch · 拉取 42/100"
 *   - succeeded:       "初始化完成 · 12 facts"  (auto-hides after a moment via parent)
 *   - failed:          "初始化失败 — short error reason"
 *   - lookup error:    nothing (silent fallback so we don't litter the UI)
 *
 * The hook handles polling lifecycle; this component is just presentation.
 */
function InitTaskChip({ taskId }: { taskId: string | null }) {
  const { task, error, terminal } = useInitTask(taskId);
  if (!taskId) return null;
  if (!task) {
    if (error) return null; // silent — could be 404 after eviction
    return (
      <p className="text-[10px] text-foreground/40 truncate flex items-center gap-1">
        <Loader2 size={9} className="animate-spin" />
        正在初始化…
      </p>
    );
  }
  if (terminal) {
    if (task.status === "succeeded") {
      const memoriesWritten = Number(task.result?.memoriesWritten ?? 0);
      const rawInserted = Number(task.result?.rawInserted ?? 0);
      const skipped = Boolean(task.result?.skipped);
      if (skipped) {
        const reason = String(task.result?.reason ?? "skipped");
        return (
          <p className="text-[10px] text-foreground/40 truncate">
            初始化跳过 · {reason}
          </p>
        );
      }
      return (
        <p className="text-[10px] text-emerald-600/80 truncate">
          初始化完成 · 拉取 {rawInserted}{memoriesWritten > 0 ? ` · 提炼 ${memoriesWritten} memories` : ""}
        </p>
      );
    }
    // failed / timed_out / cancelled / lost — show shortest possible error
    const shortErr = (task.last_error_message ?? task.last_error_code ?? "未知错误").slice(0, 80);
    return (
      <p className="text-[10px] text-red-500/80 truncate">
        初始化失败 — {shortErr}
      </p>
    );
  }
  // running / queued — surface stage + progress when present
  const stage = typeof task.progress?.stage === "string" ? task.progress.stage : null;
  const limit = Number(task.payload?.limit ?? 0);
  const progressDetail = (() => {
    if (!stage) return "排队中";
    if (stage === "fetch") return `拉取数据${limit ? ` (上限 ${limit})` : ""}`;
    if (stage === "raw") return "落本地";
    if (stage === "signals") return "提取观察";
    if (stage === "evolve") return "提炼记忆";
    return stage;
  })();
  return (
    <p className="text-[10px] text-foreground/45 truncate flex items-center gap-1">
      <Loader2 size={9} className="animate-spin" />
      初始化中 · {progressDetail}
    </p>
  );
}

/** Resolves when the popup window is closed (+ 3s grace period for OAuth callback processing). */
function windowClosed(win: Window | null): Promise<void> {
  return new Promise((resolve) => {
    if (!win) return;
    const poll = setInterval(() => {
      if (win.closed) {
        clearInterval(poll);
        setTimeout(resolve, 3000);
      }
    }, 1000);
  });
}

/**
 * Opens OAuth URL and resolves when the user closes the auth surface.
 * Web: popup window + closed-polling. Native (Capacitor): in-app Browser + browserFinished event.
 * window.open to external origins silently fails inside WKWebView, so native must go through @capacitor/browser.
 */
async function openOAuthAndAwaitClose(url: string): Promise<void> {
  if (isNative) {
    const closedPromise = new Promise<void>((resolve) => {
      void Browser.addListener("browserFinished", () => {
        void Browser.removeAllListeners();
        setTimeout(resolve, 3000);
      });
    });
    await Browser.open({ url, presentationStyle: "popover" });
    return closedPromise;
  }
  const win = window.open(url, "_blank");
  return windowClosed(win);
}

const GOOGLE_FAMILY = new Set([
  "googlecalendar",
  "googledrive",
  "googledocs",
  "googlesheets",
]);

function resolveIdentity(
  conn: Connection,
  allConnections: Connection[],
): string | null {
  const direct = extractComposioDisplayIdentity(conn.userInfo);
  if (direct) return direct;
  if (!GOOGLE_FAMILY.has(conn.toolkit)) return null;

  const gmailIdentities = allConnections
    .filter((c) => c.toolkit === "gmail" && c.status === "ACTIVE" && c.userInfo)
    .map((c) => extractComposioDisplayIdentity(c.userInfo))
    .filter((id): id is string => !!id);

  if (gmailIdentities.length === 0) return null;

  const sameToolkit = allConnections.filter(
    (c) => c.toolkit === conn.toolkit && c.status === "ACTIVE",
  );
  const idx = sameToolkit.findIndex(
    (c) => c.connectedAccountId === conn.connectedAccountId,
  );

  return gmailIdentities[idx % gmailIdentities.length] ?? gmailIdentities[0];
}

interface DataSource {
  name: string;
  composioId?: string;
  description: string;
  icon: LucideIcon;
  tier: 0 | 1 | 2;
}

interface InputCategory {
  name: string;
  icon: LucideIcon;
  description: string;
  sources: DataSource[];
}

const INPUT_CATEGORIES: InputCategory[] = [
  {
    name: "Health",
    icon: Heart,
    description: "Wearables, fitness, sleep, vitals",
    sources: [
      {
        name: "Strava",
        composioId: "strava",
        description: "Workouts, running, cycling",
        icon: Bike,
        tier: 0,
      },
      {
        name: "Oura Ring",
        description: "Sleep, readiness, activity",
        icon: CircleDot,
        tier: 1,
      },
      {
        name: "Apple Health",
        description: "Steps, heart rate, sleep",
        icon: Watch,
        tier: 1,
      },
    ],
  },
  {
    name: "Work",
    icon: Briefcase,
    description: "Email, calendar, docs, projects, code, CRM",
    sources: [
      {
        name: "Gmail",
        composioId: "gmail",
        description: "Gmail workspace",
        icon: Mail,
        tier: 0,
      },
      {
        name: "Google Calendar",
        composioId: "googlecalendar",
        description: "Events, scheduling",
        icon: Calendar,
        tier: 0,
      },
      {
        name: "Slack",
        composioId: "slack",
        description: "Channels, messages",
        icon: MessageSquare,
        tier: 0,
      },
      {
        name: "Notion",
        composioId: "notion",
        description: "Workspace pages",
        icon: BookOpen,
        tier: 0,
      },
      {
        name: "Outlook",
        composioId: "outlook",
        description: "Email, calendar",
        icon: Mail,
        tier: 0,
      },
      {
        name: "GitHub",
        composioId: "github",
        description: "Repositories, PRs",
        icon: Code,
        tier: 1,
      },
      {
        name: "Jira",
        composioId: "jira",
        description: "Issues, sprints",
        icon: ListTodo,
        tier: 1,
      },
      {
        name: "Asana",
        composioId: "asana",
        description: "Tasks, projects",
        icon: Zap,
        tier: 1,
      },
      {
        name: "HubSpot",
        composioId: "hubspot",
        description: "CRM contacts, deals",
        icon: Handshake,
        tier: 2,
      },
    ],
  },
  {
    name: "Personal",
    icon: User,
    description: "Social, communication, music, scheduling",
    sources: [
      {
        name: "Twitter / X",
        composioId: "twitter",
        description: "Posts, DMs, timeline",
        icon: Globe,
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
        name: "Discord",
        composioId: "discord",
        description: "Servers, messages",
        icon: MessageSquare,
        tier: 0,
      },
      {
        name: "Spotify",
        composioId: "spotify",
        description: "Music, playlists",
        icon: Music,
        tier: 1,
      },
      {
        name: "YouTube",
        composioId: "youtube",
        description: "Watch history, channels",
        icon: Video,
        tier: 1,
      },
      {
        name: "Calendly",
        composioId: "calendly",
        description: "Scheduling links",
        icon: Calendar,
        tier: 1,
      },
      {
        name: "Zoom",
        composioId: "zoom",
        description: "Meetings, recordings",
        icon: Video,
        tier: 2,
      },
    ],
  },
  {
    name: "Finance",
    icon: TrendingUp,
    description: "Payments, billing, transactions",
    sources: [
      {
        name: "Stripe",
        composioId: "stripe",
        description: "Payments, invoices",
        icon: CreditCard,
        tier: 0,
      },
    ],
  },
  {
    name: "Knowledge",
    icon: BookOpen,
    description: "Docs, files, notes, design, tasks",
    sources: [
      {
        name: "Google Drive",
        composioId: "googledrive",
        description: "Files, folders",
        icon: FolderOpen,
        tier: 0,
      },
      {
        name: "Google Docs",
        composioId: "googledocs",
        description: "Documents",
        icon: FileText,
        tier: 0,
      },
      {
        name: "Google Sheets",
        composioId: "googlesheets",
        description: "Spreadsheets",
        icon: BarChart3,
        tier: 0,
      },
      {
        name: "Dropbox",
        composioId: "dropbox",
        description: "Cloud storage",
        icon: FolderOpen,
        tier: 1,
      },
      {
        name: "Todoist",
        composioId: "todoist",
        description: "Tasks, projects",
        icon: ListTodo,
        tier: 1,
      },
      {
        name: "Trello",
        composioId: "trello",
        description: "Boards, cards",
        icon: Pen,
        tier: 1,
      },
      {
        name: "Figma",
        composioId: "figma",
        description: "Design files",
        icon: Pen,
        tier: 2,
      },
      {
        name: "ClickUp",
        composioId: "clickup",
        description: "Tasks, docs, goals",
        icon: Zap,
        tier: 2,
      },
    ],
  },
  {
    name: "Context",
    icon: MapPin,
    description:
      "Real-time environment, location, activity, focus — always-on perception layer",
    sources: [
      {
        name: "Location",
        description: "GPS, places visited",
        icon: MapPin,
        tier: 0,
      },
      {
        name: "Screen Time",
        description: "App usage, focus",
        icon: Smartphone,
        tier: 0,
      },
      {
        name: "Attention",
        description: "Focus mode, deep work",
        icon: Eye,
        tier: 1,
      },
      {
        name: "Time Patterns",
        description: "Routines, habits",
        icon: Clock,
        tier: 1,
      },
      {
        name: "Network",
        description: "WiFi, Bluetooth context",
        icon: Wifi,
        tier: 2,
      },
    ],
  },
];

interface DataConnectionsProps {
  composio: ComposioState;
}

export default function DataConnections({ composio }: DataConnectionsProps) {
  const {
    keyStatus,
    connections,
    statusLoading,
    saveApiKey,
    connectToolkit,
    disconnectAccount,
    waitForToolkit,
    cancelWait,
  } = composio;

  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [connectingToolkit, setConnectingToolkit] = useState<string | null>(
    null,
  );
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  // Phase B/C: connector.init task ids returned by /composio/wait, keyed
  // by connectedAccountId. Populated only when the backend scheduler is on
  // (BACKGROUND_AUTO_LOOP_TASKS_ENABLED=1) — when off, /wait omits the
  // initTaskId field and this map stays empty (no chips render).
  const [initTaskByAccount, setInitTaskByAccount] = useState<Record<string, string>>({});

  const connectionsByToolkit = new Map<string, Connection[]>();
  for (const conn of connections) {
    if (conn.status !== "ACTIVE") continue;
    const key = conn.toolkit.toLowerCase();
    const list = connectionsByToolkit.get(key) ?? [];
    list.push(conn);
    connectionsByToolkit.set(key, list);
  }

  const countConnected = (category: InputCategory) =>
    category.sources.filter(
      (s) => s.composioId && connectionsByToolkit.has(s.composioId),
    ).length;

  const totalConnected = INPUT_CATEGORIES.reduce(
    (sum, c) => sum + countConnected(c),
    0,
  );
  const totalSources = INPUT_CATEGORIES.reduce(
    (sum, c) => sum + c.sources.length,
    0,
  );

  const handleSaveKey = async () => {
    const key = apiKeyInput.trim();
    if (!key) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      const result = await saveApiKey(key);
      if (!result.ok) setKeyError(result.error ?? "Failed to save key");
      else setApiKeyInput("");
    } finally {
      setSavingKey(false);
    }
  };

  const cancelledRef = useRef(false);

  const handleConnect = async (composioId: string) => {
    setConnectingToolkit(composioId);
    setConnectError(null);
    cancelledRef.current = false;
    try {
      const result = await connectToolkit(composioId);
      if (!result.ok) {
        setConnectError(result.error ?? "Connect failed");
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
      if (!raceResult.connected && !cancelledRef.current)
        setConnectError("Connection not confirmed — please try again");
      // Stash the init task id (if the backend scheduler is on) so the
      // chip below this connector starts polling for progress.
      if (raceResult.connected && raceResult.initTaskId && result.connectedAccountId) {
        const accountId = result.connectedAccountId;
        const taskId = raceResult.initTaskId;
        setInitTaskByAccount((prev) => ({ ...prev, [accountId]: taskId }));
      }
    } catch (err) {
      if (!cancelledRef.current)
        setConnectError(
          err instanceof Error ? err.message : "Unexpected error",
        );
    } finally {
      setConnectingToolkit(null);
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

  const configured = keyStatus?.configured;

  return (
    <div>
      {/* API key setup */}
      {!configured && !statusLoading && (
        <div className="glass-card p-4 mb-4 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Key size={14} className="text-foreground/50" />
            <span className="text-xs font-medium text-foreground/70">
              Connect your apps
            </span>
          </div>
          <p className="text-[11px] text-foreground/40">
            Enter your Composio API key to connect apps. Find it in your
            Composio workspace settings
          </p>
          <div className="flex gap-2">
            <input
              value={apiKeyInput}
              onChange={(e) => {
                setApiKeyInput(e.target.value);
                setKeyError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveKey();
              }}
              placeholder="ak_..."
              type="password"
              className="flex-1 rounded-lg bg-foreground/5 border border-foreground/10 px-3 py-1.5 text-xs font-mono text-foreground placeholder:text-foreground/25 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button
              onClick={handleSaveKey}
              disabled={savingKey || !apiKeyInput.trim()}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-foreground text-background hover:bg-foreground/85 transition-colors disabled:opacity-40"
            >
              {savingKey ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                "Save"
              )}
            </button>
          </div>
          {keyError && (
            <div className="flex items-start gap-1.5 text-[11px] text-red-500">
              <XCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span>{keyError}</span>
            </div>
          )}
        </div>
      )}

      {/* Stats row */}
      {configured && (
        <div className="grid grid-cols-4 gap-2 mb-4">
          {[
            {
              value: String(totalConnected),
              label: "Connected",
              sub: `of ${totalSources}`,
            },
            {
              value: `${INPUT_CATEGORIES.filter((c) => countConnected(c) > 0).length}/${INPUT_CATEGORIES.length}`,
              label: "Layers",
              sub: "active",
            },
            {
              value: String(
                connections.filter((c) => c.status === "ACTIVE").length,
              ),
              label: "Accounts",
              sub: "linked",
            },
            { value: "—", label: "Last Sync", sub: "" },
          ].map((stat) => (
            <div key={stat.label} className="glass-card p-2.5">
              <span className="text-lg font-semibold text-foreground">
                {stat.value}
              </span>
              <p className="text-[10px] text-foreground/50 mt-0.5 leading-tight">
                {stat.label}
              </p>
              {stat.sub && (
                <p className="text-[9px] text-foreground/30">{stat.sub}</p>
              )}
            </div>
          ))}
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

                      {[0, 1, 2].map((tier) => {
                        const tierSources = category.sources.filter(
                          (s) => s.tier === tier,
                        );
                        if (tierSources.length === 0) return null;
                        const tierLabels = ["Recommended", "More sources", "Optional"];
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
                                  ? (connectionsByToolkit.get(
                                      source.composioId,
                                    ) ?? [])
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
                                        <SrcIcon
                                          size={14}
                                          strokeWidth={1.5}
                                          className={
                                            isConnected
                                              ? "text-emerald-600 flex-shrink-0"
                                              : hasComposio
                                                ? "text-foreground/30 flex-shrink-0"
                                                : "text-foreground/15 flex-shrink-0"
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
                                          {singleAccount?.connectedAccountId && (
                                            <InitTaskChip
                                              taskId={initTaskByAccount[singleAccount.connectedAccountId] ?? null}
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
                                          <SrcIcon
                                            size={14}
                                            strokeWidth={1.5}
                                            className="text-emerald-600 flex-shrink-0"
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
                                                    taskId={initTaskByAccount[conn.connectedAccountId] ?? null}
                                                  />
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </>
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
