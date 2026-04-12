import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  XCircle, Loader2, Plus, ChevronDown, Key, type LucideIcon,
  Mail, Calendar, MessageSquare, BookOpen, FileText,
  Briefcase, Github, Trello,
  BarChart3, CreditCard, Video, Pen, ListTodo,
  Users, Database, Linkedin, Twitter,
} from "lucide-react";
import type { ComposioState, Connection } from "@/hooks/use-composio";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SKIP_KEYS = /token|secret|key|password|code|cursor|etag|sync|url|endpoint|slug|status|type|version|id$/i;

/** Extract a human-readable identity from Composio's current_user_info.
 *  Canonical copy: core/domains/personal/provider.ts — keep in sync. */
function extractIdentity(info: Record<string, unknown> | null | undefined): string | null {
  if (!info) return null;
  for (const v of Object.values(info)) {
    if (typeof v === "string" && EMAIL_RE.test(v)) return v;
  }
  for (const [k, v] of Object.entries(info)) {
    if (typeof v !== "string" || v.length === 0 || v.length > 60) continue;
    if (v.startsWith("http") || SKIP_KEYS.test(k)) continue;
    return v;
  }
  return null;
}

interface ToolkitDef {
  id: string;
  label: string;
  icon: LucideIcon;
}

interface ToolkitCategory {
  name: string;
  toolkits: ToolkitDef[];
}

const PLATFORM_CATEGORIES: ToolkitCategory[] = [
  {
    name: "Email & Calendar",
    toolkits: [
      { id: "gmail", label: "Gmail", icon: Mail },
      { id: "outlook", label: "Outlook", icon: Mail },
      { id: "googlecalendar", label: "Google Calendar", icon: Calendar },
      { id: "outlookcalendar", label: "Outlook Calendar", icon: Calendar },
    ],
  },
  {
    name: "Messaging",
    toolkits: [
      { id: "slack", label: "Slack", icon: MessageSquare },
      { id: "discord", label: "Discord", icon: MessageSquare },
      { id: "telegram", label: "Telegram", icon: MessageSquare },
      { id: "microsoftteams", label: "MS Teams", icon: Users },
    ],
  },
  {
    name: "Docs & Files",
    toolkits: [
      { id: "googledrive", label: "Google Drive", icon: FileText },
      { id: "googledocs", label: "Google Docs", icon: FileText },
      { id: "googlesheets", label: "Google Sheets", icon: BarChart3 },
      { id: "notion", label: "Notion", icon: BookOpen },
      { id: "dropbox", label: "Dropbox", icon: Database },
      { id: "onedrive", label: "OneDrive", icon: FileText },
    ],
  },
  {
    name: "Code & Dev",
    toolkits: [
      { id: "github", label: "GitHub", icon: Github },
      { id: "gitlab", label: "GitLab", icon: Github },
      { id: "jira", label: "Jira", icon: ListTodo },
      { id: "linear", label: "Linear", icon: ListTodo },
    ],
  },
  {
    name: "Productivity",
    toolkits: [
      { id: "trello", label: "Trello", icon: Trello },
      { id: "asana", label: "Asana", icon: ListTodo },
      { id: "todoist", label: "Todoist", icon: ListTodo },
      { id: "airtable", label: "Airtable", icon: Database },
      { id: "clickup", label: "ClickUp", icon: ListTodo },
    ],
  },
  {
    name: "CRM & Sales",
    toolkits: [
      { id: "hubspot", label: "HubSpot", icon: Briefcase },
      { id: "salesforce", label: "Salesforce", icon: Briefcase },
    ],
  },
  {
    name: "Social",
    toolkits: [
      { id: "twitter", label: "Twitter / X", icon: Twitter },
      { id: "linkedin", label: "LinkedIn", icon: Linkedin },
    ],
  },
  {
    name: "Other",
    toolkits: [
      { id: "zoom", label: "Zoom", icon: Video },
      { id: "figma", label: "Figma", icon: Pen },
      { id: "stripe", label: "Stripe", icon: CreditCard },
    ],
  },
];

interface DataConnectionsProps {
  composio: ComposioState;
}

export default function DataConnections({ composio }: DataConnectionsProps) {
  const { keyStatus, connections, statusLoading, saveApiKey, connectToolkit, disconnectAccount, waitForToolkit, cancelWait } = composio;

  const [connectingToolkit, setConnectingToolkit] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const handleSaveKey = async () => {
    const key = apiKeyInput.trim();
    if (!key) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      const result = await saveApiKey(key);
      if (!result.ok) {
        setKeyError(result.error ?? "Failed to save key");
      } else {
        setApiKeyInput("");
      }
    } finally {
      setSavingKey(false);
    }
  };

  // Group connections by toolkit (multiple accounts per toolkit)
  const connectionsByToolkit = new Map<string, Connection[]>();
  for (const conn of connections) {
    if (conn.status !== "ACTIVE") continue;
    const key = conn.toolkit.toLowerCase();
    const list = connectionsByToolkit.get(key) ?? [];
    list.push(conn);
    connectionsByToolkit.set(key, list);
  }

  const handleConnect = async (toolkit: string) => {
    setConnectingToolkit(toolkit);
    setConnectError(null);
    try {
      const result = await connectToolkit(toolkit);
      if (!result.ok) {
        setConnectError(result.error ?? "Connect failed");
        return;
      }

      if (!result.redirectUrl) return;

      // Open OAuth in the system browser (uses the user's existing sessions)
      window.open(result.redirectUrl, "_blank");

      // Wait for backend to confirm the connection is ACTIVE (polls up to 120s)
      const { connected } = await waitForToolkit(toolkit);
      if (!connected) {
        setConnectError("Connection not confirmed — please try again");
      }
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setConnectingToolkit(null);
    }
  };

  const handleDisconnect = async (connectedAccountId: string) => {
    setDisconnectingId(connectedAccountId);
    setConnectError(null);
    try {
      const result = await disconnectAccount(connectedAccountId);
      if (!result.ok) {
        setConnectError(result.error ?? "Disconnect failed");
      }
    } finally {
      setDisconnectingId(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* Platforms by category */}
      {keyStatus?.configured && (
        <div className="space-y-2">
          {PLATFORM_CATEGORIES.map((category) => {
            const isExpanded = expandedCategory === category.name;
            const catAccountCount = category.toolkits.reduce(
              (sum, t) => sum + (connectionsByToolkit.get(t.id)?.length ?? 0), 0,
            );

            return (
              <div key={category.name} className="glass-card-strong overflow-hidden">
                <button
                  onClick={() => setExpandedCategory(isExpanded ? null : category.name)}
                  className="w-full p-4 flex items-center gap-3 transition-colors hover:bg-white/20"
                >
                  <div className="flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{category.name}</span>
                      {catAccountCount > 0 && (
                        <span className="text-[10px] font-medium text-emerald-600 bg-emerald-500/[0.08] px-1.5 py-0.5 rounded-md">
                          {catAccountCount} {catAccountCount === 1 ? "account" : "accounts"}
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronDown
                    size={14}
                    strokeWidth={1.5}
                    className={`text-foreground/25 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                  />
                </button>

                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25 }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-4 space-y-1">
                        <div className="h-px bg-foreground/[0.06] mb-2" />
                        {category.toolkits.map((tk) => {
                          const Icon = tk.icon;
                          const accounts = connectionsByToolkit.get(tk.id) ?? [];
                          const isConnecting = connectingToolkit === tk.id;
                          const isBusy = !!connectingToolkit || !!disconnectingId;
                          const singleAccount = accounts.length === 1 ? accounts[0] : null;
                          const multiAccounts = accounts.length >= 2;

                          return (
                            <div key={tk.id} className="space-y-0.5">
                              {/* Single row: not connected, or exactly 1 account */}
                              {!multiAccounts && (
                                <div
                                  className={`group flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-colors ${
                                    singleAccount ? "bg-emerald-500/[0.06]" : "bg-foreground/[0.02]"
                                  }`}
                                >
                                  <Icon
                                    size={14}
                                    strokeWidth={1.5}
                                    className={singleAccount ? "text-emerald-600 flex-shrink-0" : "text-foreground/30 flex-shrink-0"}
                                  />
                                  <span className={`text-xs flex-1 ${
                                    singleAccount ? "text-foreground font-medium" : "text-foreground/45"
                                  }`}>
                                    {tk.label}
                                  </span>
                                  {singleAccount ? (<>
                                    {/* + Add button: hidden by default, shown on hover */}
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleConnect(tk.id); }}
                                      disabled={isBusy}
                                      className="text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.1] transition-all disabled:opacity-40 opacity-0 group-hover:opacity-100"
                                    >
                                      {isConnecting ? (
                                        <Loader2 size={10} className="animate-spin" />
                                      ) : (
                                        <span className="flex items-center gap-1"><Plus size={10} /> Add</span>
                                      )}
                                    </button>
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                                    {/* Connected / Disconnect toggle */}
                                    <button
                                      onClick={(e) => { e.stopPropagation(); singleAccount.connectedAccountId && handleDisconnect(singleAccount.connectedAccountId); }}
                                      disabled={isBusy}
                                      className="text-[10px] font-medium rounded-lg px-2.5 py-0.5 transition-colors disabled:opacity-40 text-emerald-600 hover:text-red-500 hover:bg-red-500/[0.08]"
                                    >
                                      {disconnectingId === singleAccount.connectedAccountId ? (
                                        <Loader2 size={10} className="animate-spin text-red-500" />
                                      ) : (
                                        <span>
                                          <span className="group-hover:hidden">Connected</span>
                                          <span className="hidden group-hover:inline">Disconnect</span>
                                        </span>
                                      )}
                                    </button>
                                  </>) : (<>
                                    <span className="w-1.5 h-1.5 rounded-full bg-foreground/10 flex-shrink-0" />
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleConnect(tk.id); }}
                                      disabled={isBusy}
                                      className="text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors disabled:opacity-40"
                                    >
                                      {isConnecting ? (
                                        <Loader2 size={10} className="animate-spin" />
                                      ) : (
                                        "Connect"
                                      )}
                                    </button>
                                  </>)}
                                </div>
                              )}

                              {/* Multi-account: header + account list */}
                              {multiAccounts && (<>
                                <div className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 bg-emerald-500/[0.06]">
                                  <Icon size={14} strokeWidth={1.5} className="text-emerald-600 flex-shrink-0" />
                                  <span className="text-xs text-foreground font-medium flex-1">{tk.label}</span>
                                  <span className="text-[10px] text-foreground/30">{accounts.length}</span>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleConnect(tk.id); }}
                                    disabled={isBusy}
                                    className="text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors disabled:opacity-40"
                                  >
                                    {isConnecting ? (
                                      <Loader2 size={10} className="animate-spin" />
                                    ) : (
                                      <span className="flex items-center gap-1"><Plus size={10} /> Add</span>
                                    )}
                                  </button>
                                </div>
                                {accounts.map((conn) => {
                                  const identity = extractIdentity(conn.userInfo);
                                  const isDisconnecting = disconnectingId === conn.connectedAccountId;

                                  return (
                                    <div
                                      key={conn.connectedAccountId}
                                      className="group flex items-center gap-2.5 rounded-lg px-3 py-1.5 ml-6 bg-emerald-500/[0.03]"
                                    >
                                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                                      <span className="text-[11px] text-foreground/70 flex-1 truncate">
                                        {identity ?? conn.connectedAccountId?.slice(0, 12) ?? ""}
                                      </span>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); conn.connectedAccountId && handleDisconnect(conn.connectedAccountId); }}
                                        disabled={isBusy}
                                        className="text-[10px] font-medium rounded-lg px-2 py-0.5 transition-colors disabled:opacity-40 text-foreground/30 hover:text-red-500 hover:bg-red-500/[0.08] opacity-0 group-hover:opacity-100"
                                      >
                                        {isDisconnecting ? (
                                          <Loader2 size={10} className="animate-spin text-red-500" />
                                        ) : (
                                          "Disconnect"
                                        )}
                                      </button>
                                    </div>
                                  );
                                })}
                              </>)}
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
      )}

      {/* Not configured — API key input */}
      {!keyStatus?.configured && !statusLoading && (
        <div className="glass-card-strong p-5 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Key size={16} className="text-foreground/40" />
            <span className="text-sm font-semibold text-foreground">Connect your apps</span>
          </div>
          <p className="text-xs text-foreground/45">
            Enter your Composio API key to connect apps. Find it in{" "}
            <a
              href="https://platform.composio.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-foreground/60 hover:text-foreground/80"
            >
              platform.composio.dev
            </a>
            {" "}→ Settings → API Keys
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="ak_..."
              value={apiKeyInput}
              onChange={(e) => { setApiKeyInput(e.target.value); setKeyError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveKey(); }}
              className="flex-1 text-xs bg-foreground/[0.04] border border-foreground/10 rounded-lg px-3 py-2 text-foreground placeholder:text-foreground/25 focus:outline-none focus:border-foreground/25 transition-colors"
            />
            <button
              onClick={handleSaveKey}
              disabled={savingKey || !apiKeyInput.trim()}
              className="text-xs font-medium bg-foreground text-background rounded-lg px-4 py-2 hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {savingKey ? <Loader2 size={12} className="animate-spin" /> : "Save"}
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

      {/* Connect error */}
      <AnimatePresence>
        {connectError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="glass-card px-4 py-3 flex items-start gap-1.5 text-[11px] text-red-500"
          >
            <XCircle size={12} className="mt-0.5 flex-shrink-0" />
            <span>{connectError}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {connectingToolkit && (
        <div className="glass-card px-4 py-3 flex items-center justify-between">
          <p className="text-[11px] text-foreground/40 italic flex items-center gap-1.5">
            <Loader2 size={10} className="animate-spin" />
            Authorize in your browser — this will update automatically
          </p>
          <button
            onClick={() => { cancelWait(); setConnectingToolkit(null); }}
            className="text-[10px] font-medium text-foreground/40 hover:text-foreground/70 px-2 py-0.5 rounded-lg hover:bg-foreground/[0.06] transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
