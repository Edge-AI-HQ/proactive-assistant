import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  XCircle, Loader2, Plus, ChevronDown, Key, type LucideIcon,
  Mail, Calendar, MessageSquare, BookOpen, FileText,
  Briefcase, GitFork, Kanban,
  BarChart3, CreditCard, Video, Pen, ListTodo,
  Users, Database, Globe, MessageSquareMore,
} from "lucide-react";
import type { ComposioState, Connection } from "@/hooks/useComposio";

/** Resolves when the popup window is closed (+ 3s grace period for OAuth callback processing). */
function windowClosed(win: Window | null): Promise<void> {
  return new Promise((resolve) => {
    if (!win) return; // popup blocked — never resolves, wait continues until server timeout or manual cancel
    const poll = setInterval(() => {
      if (win.closed) {
        clearInterval(poll);
        setTimeout(resolve, 3000);
      }
    }, 1000);
  });
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SKIP_KEYS = /token|secret|key|password|code|cursor|etag|sync|url|endpoint|slug|status|type|version|id$/i;

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

interface ToolkitDef { id: string; label: string; icon: LucideIcon; }
interface ToolkitCategory { name: string; toolkits: ToolkitDef[]; }

const PLATFORM_CATEGORIES: ToolkitCategory[] = [
  { name: "Email & Calendar", toolkits: [
    { id: "gmail", label: "Gmail", icon: Mail },
    { id: "outlook", label: "Outlook", icon: Mail },
    { id: "googlecalendar", label: "Google Calendar", icon: Calendar },
    { id: "outlookcalendar", label: "Outlook Calendar", icon: Calendar },
  ]},
  { name: "Messaging", toolkits: [
    { id: "slack", label: "Slack", icon: MessageSquare },
    { id: "discord", label: "Discord", icon: MessageSquare },
    { id: "telegram", label: "Telegram", icon: MessageSquare },
    { id: "microsoftteams", label: "MS Teams", icon: Users },
  ]},
  { name: "Docs & Files", toolkits: [
    { id: "googledrive", label: "Google Drive", icon: FileText },
    { id: "googledocs", label: "Google Docs", icon: FileText },
    { id: "googlesheets", label: "Google Sheets", icon: BarChart3 },
    { id: "notion", label: "Notion", icon: BookOpen },
    { id: "dropbox", label: "Dropbox", icon: Database },
    { id: "onedrive", label: "OneDrive", icon: FileText },
  ]},
  { name: "Code & Dev", toolkits: [
    { id: "github", label: "GitHub", icon: GitFork },
    { id: "gitlab", label: "GitLab", icon: GitFork },
    { id: "jira", label: "Jira", icon: ListTodo },
    { id: "linear", label: "Linear", icon: ListTodo },
  ]},
  { name: "Productivity", toolkits: [
    { id: "trello", label: "Trello", icon: Kanban },
    { id: "asana", label: "Asana", icon: ListTodo },
    { id: "todoist", label: "Todoist", icon: ListTodo },
    { id: "airtable", label: "Airtable", icon: Database },
    { id: "clickup", label: "ClickUp", icon: ListTodo },
  ]},
  { name: "CRM & Sales", toolkits: [
    { id: "hubspot", label: "HubSpot", icon: Briefcase },
    { id: "salesforce", label: "Salesforce", icon: Briefcase },
  ]},
  { name: "Social", toolkits: [
    { id: "twitter", label: "Twitter / X", icon: MessageSquareMore },
    { id: "linkedin", label: "LinkedIn", icon: Globe },
  ]},
  { name: "Other", toolkits: [
    { id: "zoom", label: "Zoom", icon: Video },
    { id: "figma", label: "Figma", icon: Pen },
    { id: "stripe", label: "Stripe", icon: CreditCard },
  ]},
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
      if (!result.ok) setKeyError(result.error ?? "Failed to save key");
      else setApiKeyInput("");
    } finally { setSavingKey(false); }
  };

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
      if (!result.ok) { setConnectError(result.error ?? "Connect failed"); return; }
      if (!result.redirectUrl || !result.connectedAccountId) {
        if (result.ok) setConnectError("Connect succeeded but missing redirect info — please try again");
        return;
      }
      const oauthWindow = window.open(result.redirectUrl, "_blank");

      const { connected } = await Promise.race([
        waitForToolkit(result.connectedAccountId),
        windowClosed(oauthWindow).then(() => { cancelWait(); return { connected: false as const }; }),
      ]);
      if (!connected) setConnectError("Connection not confirmed");
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Unexpected error");
    } finally { setConnectingToolkit(null); }
  };

  const handleDisconnect = async (connectedAccountId: string) => {
    setDisconnectingId(connectedAccountId);
    setConnectError(null);
    try {
      const result = await disconnectAccount(connectedAccountId);
      if (!result.ok) setConnectError(result.error ?? "Disconnect failed");
    } finally { setDisconnectingId(null); }
  };

  return (
    <div className="space-y-3">
      {keyStatus?.configured && (
        <div className="space-y-2">
          {PLATFORM_CATEGORIES.map((category) => {
            const isExpanded = expandedCategory === category.name;
            const catAccountCount = category.toolkits.reduce(
              (sum, t) => sum + (connectionsByToolkit.get(t.id)?.length ?? 0), 0,
            );

            return (
              <div key={category.name} className="rounded-xl bg-white/50 border border-foreground/10 overflow-hidden">
                <button
                  onClick={() => setExpandedCategory(isExpanded ? null : category.name)}
                  className="w-full p-3 flex items-center gap-3 transition-colors hover:bg-foreground/5"
                >
                  <div className="flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground/80">{category.name}</span>
                      {catAccountCount > 0 && (
                        <span className="text-[10px] font-medium text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-md">
                          {catAccountCount} connected
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronDown size={14} className={`text-foreground/30 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`} />
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
                      <div className="px-3 pb-3 space-y-1">
                        <div className="h-px bg-foreground/10 mb-2" />
                        {category.toolkits.map((tk) => {
                          const Icon = tk.icon;
                          const accounts = connectionsByToolkit.get(tk.id) ?? [];
                          const isConnecting = connectingToolkit === tk.id;
                          const isBusy = !!connectingToolkit || !!disconnectingId;
                          const hasAccounts = accounts.length >= 1;

                          return (
                            <div key={tk.id} className="space-y-0.5">
                              {!hasAccounts && (
                                <div className="group flex items-center gap-2.5 rounded-lg px-3 py-2 transition-colors bg-foreground/5/50">
                                  <Icon size={14} strokeWidth={1.5} className="text-foreground/30 flex-shrink-0" />
                                  <span className="text-xs flex-1 text-foreground/40">{tk.label}</span>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleConnect(tk.id); }}
                                    disabled={isBusy}
                                    className="text-[10px] font-medium text-foreground/50 bg-foreground/10 rounded-lg px-2.5 py-0.5 hover:bg-foreground/15 transition-colors disabled:opacity-40"
                                  >
                                    {isConnecting ? <Loader2 size={10} className="animate-spin" /> : "Connect"}
                                  </button>
                                </div>
                              )}

                              {hasAccounts && (<>
                                <div className="flex items-center gap-2.5 rounded-lg px-3 py-2 bg-emerald-50/50">
                                  <Icon size={14} strokeWidth={1.5} className="text-emerald-600 flex-shrink-0" />
                                  <span className="text-xs text-foreground/80 font-medium flex-1">{tk.label}</span>
                                  {accounts.length > 1 && <span className="text-[10px] text-foreground/30">{accounts.length}</span>}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleConnect(tk.id); }}
                                    disabled={isBusy}
                                    className="text-[10px] font-medium text-foreground/50 bg-foreground/10 rounded-lg px-2 py-0.5 hover:bg-foreground/15 transition-colors disabled:opacity-40"
                                  >
                                    {isConnecting ? <Loader2 size={10} className="animate-spin" /> : <span className="flex items-center gap-1"><Plus size={10} /> Add</span>}
                                  </button>
                                </div>
                                {accounts.map((conn) => {
                                  const identity = extractIdentity(conn.userInfo);
                                  return (
                                    <div key={conn.connectedAccountId} className="group flex items-center gap-2.5 rounded-lg px-3 py-1.5 ml-6 bg-emerald-50/30">
                                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                                      <span className="text-[11px] text-foreground/50 flex-1 truncate">{identity ?? conn.connectedAccountId?.slice(0, 12) ?? ""}</span>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); conn.connectedAccountId && handleDisconnect(conn.connectedAccountId); }}
                                        disabled={isBusy}
                                        className="text-[10px] font-medium rounded-lg px-2 py-0.5 text-foreground/30 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40 opacity-0 group-hover:opacity-100"
                                      >
                                        {disconnectingId === conn.connectedAccountId ? <Loader2 size={10} className="animate-spin text-red-500" /> : "Disconnect"}
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

      {!keyStatus?.configured && !statusLoading && (
        <div className="bg-white/50 rounded-xl border border-foreground/10 p-4 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Key size={16} className="text-foreground/40" />
            <span className="text-sm font-medium text-foreground/80">Connect your apps</span>
          </div>
          <p className="text-xs text-foreground/40">
            Enter your Composio API key to connect apps. Find it at{" "}
            <a href="https://platform.composio.dev" target="_blank" rel="noopener noreferrer" className="underline text-foreground/50 hover:text-foreground/80">
              platform.composio.dev
            </a>
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="ak_..."
              value={apiKeyInput}
              onChange={(e) => { setApiKeyInput(e.target.value); setKeyError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveKey(); }}
              className="flex-1 text-xs bg-foreground/5 border border-foreground/10 rounded-lg px-3 py-2 text-foreground/80 placeholder:text-foreground/30 focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <button
              onClick={handleSaveKey}
              disabled={savingKey || !apiKeyInput.trim()}
              className="text-xs font-medium bg-foreground text-background rounded-lg px-4 py-2 hover:bg-foreground/85 transition-colors disabled:opacity-40"
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

      <AnimatePresence>
        {connectError && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-start gap-1.5 text-[11px] text-red-500"
          >
            <XCircle size={12} className="mt-0.5 flex-shrink-0" />
            <span>{connectError}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {connectingToolkit && (
        <div className="bg-foreground/5 border border-foreground/10 rounded-lg px-4 py-3 flex items-center justify-between">
          <p className="text-[11px] text-foreground/40 italic flex items-center gap-1.5">
            <Loader2 size={10} className="animate-spin" />
            Authorize in your browser
          </p>
          <button
            onClick={() => { cancelWait(); setConnectingToolkit(null); }}
            className="text-[10px] font-medium text-foreground/40 hover:text-foreground/60 px-2 py-0.5 rounded-lg hover:bg-foreground/10 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
