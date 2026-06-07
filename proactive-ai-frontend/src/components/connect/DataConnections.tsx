import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Heart,
  Briefcase,
  User,
  TrendingUp,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Mail,
  Calendar,
  FolderOpen,
  MessageSquare,
  CreditCard,
  Watch,
  Users,
  Code,
  Loader2,
  XCircle,
  Plus,
  Video,
  CircleDot,
  type LucideIcon,
} from "lucide-react";
import type { ComposioState, Connection } from "@/hooks/useComposio";
import { buildConnectorInitTaskId } from "@/hooks/useComposio";
import { useInitTask, isInitTaskFresh } from "@/hooks/useInitTask";
import { resolveComposioConnectionIdentity } from "@/lib/composio-display-identity";
import { openOAuthAndAwaitClose } from "@/lib/oauth-popup";

/**
 * Small inline chip that polls a connector.init task and renders a
 * one-line progress / outcome summary under the connector card.
 *
 * Reconstructs the deterministic backend task id from (toolkit, account)
 * so the chip survives page reloads without any persisted state — the
 * DebugPanel's reconnect chip uses the same id, so both panels poll the
 * same row. Once a task hits terminal status, it's only surfaced for
 * `FRESH_WINDOW_MS` (see useInitTask) — beyond that we treat the row as
 * historical and render nothing.
 *
 * Render rules:
 *   - while running:   "初始化中… stage=fetch · 拉取 42/100"
 *   - succeeded:       "初始化完成 · 12 facts"  (hidden 1h after completion)
 *   - failed:          "初始化失败 — short error reason"  (same window)
 *   - lookup error:    nothing (silent fallback so we don't litter the UI)
 */
function InitTaskChip({ toolkit, connectedAccountId }: { toolkit: string; connectedAccountId: string }) {
  const taskId = buildConnectorInitTaskId(toolkit, connectedAccountId);
  const { task, error, terminal } = useInitTask(taskId);
  if (!task) {
    // Pre-first-fetch: keep loader silent on errors (the row may not exist
    // yet — e.g. user never triggered connect on this device).
    if (error) return null;
    return (
      <p className="text-[10px] text-foreground/40 truncate flex items-center gap-1">
        <Loader2 size={9} className="animate-spin" />
        正在初始化…
      </p>
    );
  }
  if (!isInitTaskFresh(task)) return null; // stale terminal — silent
  if (terminal) {
    if (task.status === "succeeded") {
      const memoriesWritten = Number(task.result?.memoriesWritten ?? 0);
      const skillsAdded = Number(task.result?.skillsAdded ?? 0);
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
          初始化完成 · 拉取 {rawInserted}{memoriesWritten > 0 ? ` · 提炼 ${memoriesWritten} memories` : ""}{skillsAdded > 0 ? ` · 生成 ${skillsAdded} skills` : ""}
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

function resolveIdentity(
  conn: Connection,
  allConnections: Connection[],
): string | null {
  return resolveComposioConnectionIdentity(conn, allConnections);
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

export const INPUT_CATEGORIES: InputCategory[] = [
  {
    name: "Health",
    icon: Heart,
    description: "Wearables, fitness, sleep, vitals",
    sources: [
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
    description: "Email, calendar, code",
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
        name: "GitHub",
        composioId: "github",
        description: "Repositories, PRs",
        icon: Code,
        tier: 1,
      },
    ],
  },
  {
    name: "Personal",
    icon: User,
    description: "Social, scheduling, taste",
    sources: [
      {
        name: "LinkedIn",
        composioId: "linkedin",
        description: "Professional network",
        icon: Users,
        tier: 0,
      },
      {
        name: "YouTube",
        composioId: "youtube",
        description: "Subscriptions",
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
    ],
  },
  {
    name: "Finance",
    icon: TrendingUp,
    description: "Payments, billing, invoices",
    sources: [
      {
        name: "Stripe",
        composioId: "stripe",
        description: "Invoices",
        icon: CreditCard,
        tier: 0,
      },
    ],
  },
  {
    name: "Knowledge",
    icon: BookOpen,
    description: "Docs, files",
    sources: [
      {
        name: "Google Drive",
        composioId: "googledrive",
        description: "Files, folders",
        icon: FolderOpen,
        tier: 0,
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
    connectToolkit,
    disconnectAccount,
    waitForToolkit,
    cancelWait,
  } = composio;

  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [connectingToolkit, setConnectingToolkit] = useState<string | null>(
    null,
  );
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

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
                                          {singleAccount?.connectedAccountId && source.composioId && (
                                            <InitTaskChip
                                              toolkit={source.composioId}
                                              connectedAccountId={singleAccount.connectedAccountId}
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
                                                    toolkit={conn.toolkit}
                                                    connectedAccountId={conn.connectedAccountId}
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
