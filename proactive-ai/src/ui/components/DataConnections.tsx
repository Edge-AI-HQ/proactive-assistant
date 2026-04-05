import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Key, RefreshCw, ExternalLink, CheckCircle2, XCircle,
  Loader2, Plus, ChevronDown, type LucideIcon,
  Mail, Calendar, MessageSquare, BookOpen, FileText,
  Briefcase, Globe, Link2, Github, Trello,
  BarChart3, CreditCard, Video, Pen, ListTodo,
  Users, Database, Linkedin, Twitter,
} from "lucide-react";
import type { ComposioState } from "@/hooks/use-composio";

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
  const { keyStatus, connections, statusLoading, loadingConns, loadConnections, saveKey, connectToolkit, waitForToolkit } = composio;

  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectingToolkit, setConnectingToolkit] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const connectedSet = new Set(
    connections.filter(c => c.status === "ACTIVE").map(c => c.toolkit.toLowerCase())
  );
  const connectedCount = connectedSet.size;

  const handleSaveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setSaving(true);
    setError(null);
    const result = await saveKey(key);
    if (result.ok) {
      setKeyInput("");
    } else {
      setError(result.error ?? "Setup failed");
    }
    setSaving(false);
  };

  const handleConnect = async (toolkit: string) => {
    setConnectingToolkit(toolkit);
    setConnectError(null);
    const result = await connectToolkit(toolkit);
    if (result.ok && result.redirectUrl) {
      window.open(result.redirectUrl, "_blank", "noopener,noreferrer");
      await waitForToolkit(toolkit);
    } else if (!result.ok) {
      setConnectError(result.error ?? "Connect failed");
    }
    setConnectingToolkit(null);
  };

  return (
    <div className="space-y-3">
      {/* API Key Setup */}
      <div className="glass-card-strong overflow-hidden">
        <div className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Key size={14} strokeWidth={1.5} className="text-foreground/50" />
            <span className="text-xs font-semibold text-foreground/70">Composio API Key</span>
            {statusLoading ? (
              <Loader2 size={12} className="animate-spin text-foreground/30 ml-auto" />
            ) : keyStatus?.configured ? (
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                <CheckCircle2 size={10} />
                Connected
              </span>
            ) : (
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-foreground/40 bg-foreground/5 px-2 py-0.5 rounded-full">
                Not configured
              </span>
            )}
          </div>

          <p className="text-[11px] text-foreground/40 mb-3 leading-relaxed">
            Get your consumer key at{" "}
            <a
              href="https://dashboard.composio.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              dashboard.composio.dev
              <ExternalLink size={9} />
            </a>
          </p>

          <div className="flex gap-2">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={keyStatus?.configured ? `Key saved (${keyStatus.keyPrefix ?? "***"})` : "ck_..."}
              disabled={saving}
              onKeyDown={(e) => e.key === "Enter" && handleSaveKey()}
              className="flex-1 rounded-xl bg-foreground/5 border border-foreground/10 px-3 py-2 text-xs text-foreground font-mono placeholder:text-foreground/25 focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-40"
            />
            <button
              onClick={handleSaveKey}
              disabled={saving || !keyInput.trim()}
              className="rounded-xl bg-foreground text-background text-xs font-semibold px-4 py-2 hover:bg-foreground/85 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : "Save"}
            </button>
          </div>

          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-2 flex items-start gap-1.5 text-[11px] text-red-500"
              >
                <XCircle size={12} className="mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Connected summary */}
      {keyStatus?.configured && (
        <div className="glass-card p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Link2 size={14} strokeWidth={1.5} className="text-foreground/50" />
              <span className="text-sm font-semibold text-foreground">{connectedCount}</span>
              <span className="text-xs text-foreground/40">app{connectedCount !== 1 ? "s" : ""} connected</span>
              {loadingConns && <Loader2 size={10} className="animate-spin text-foreground/20" />}
            </div>
            <button
              onClick={loadConnections}
              disabled={loadingConns}
              className="inline-flex items-center gap-1 text-[10px] font-medium text-foreground/50 hover:text-foreground/70 transition-colors disabled:opacity-30"
            >
              <RefreshCw size={10} className={loadingConns ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>
      )}

      {/* Platforms by category */}
      {keyStatus?.configured && (
        <div className="space-y-2">
          {PLATFORM_CATEGORIES.map((category) => {
            const isExpanded = expandedCategory === category.name;
            const catConnected = category.toolkits.filter(t => connectedSet.has(t.id)).length;

            return (
              <div key={category.name} className="glass-card-strong overflow-hidden">
                <button
                  onClick={() => setExpandedCategory(isExpanded ? null : category.name)}
                  className="w-full p-4 flex items-center gap-3 transition-colors hover:bg-white/20"
                >
                  <div className="flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{category.name}</span>
                      <span className="text-[10px] font-medium text-foreground/40 bg-foreground/[0.06] px-1.5 py-0.5 rounded-md">
                        {catConnected} / {category.toolkits.length}
                      </span>
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
                          const isConnected = connectedSet.has(tk.id);
                          const isConnecting = connectingToolkit === tk.id;

                          return (
                            <div
                              key={tk.id}
                              className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-colors ${
                                isConnected ? "bg-emerald-500/[0.06]" : "bg-foreground/[0.02]"
                              }`}
                            >
                              <Icon
                                size={14}
                                strokeWidth={1.5}
                                className={isConnected ? "text-emerald-600 flex-shrink-0" : "text-foreground/30 flex-shrink-0"}
                              />
                              <span className={`text-xs flex-1 ${
                                isConnected ? "text-foreground font-medium" : "text-foreground/45"
                              }`}>
                                {tk.label}
                              </span>
                              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                isConnected ? "bg-emerald-500" : "bg-foreground/10"
                              }`} />
                              {isConnected ? (
                                <span className="text-[10px] font-medium text-emerald-600">Connected</span>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleConnect(tk.id); }}
                                  disabled={!!connectingToolkit}
                                  className="text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors disabled:opacity-40"
                                >
                                  {isConnecting ? (
                                    <Loader2 size={10} className="animate-spin" />
                                  ) : (
                                    "Connect"
                                  )}
                                </button>
                              )}
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

      {/* Not configured hint */}
      {!keyStatus?.configured && !statusLoading && (
        <div className="glass-card-strong p-6 text-center">
          <Plus size={24} className="mx-auto mb-2 text-foreground/30" />
          <p className="text-sm text-foreground/50">Configure your API key above to connect apps</p>
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
        <div className="glass-card px-4 py-3 text-center">
          <p className="text-[11px] text-foreground/40 italic">
            OAuth window opened — complete authorization, then wait...
          </p>
        </div>
      )}
    </div>
  );
}
