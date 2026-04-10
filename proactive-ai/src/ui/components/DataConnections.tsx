import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Heart, Briefcase, User, TrendingUp, BookOpen, MapPin,
  ChevronDown, ChevronUp, Mail, Calendar, FolderOpen, MessageSquare,
  CreditCard, PiggyBank, FileText, Shield, Activity, Pill,
  Stethoscope, Watch, Users, ShoppingBag, Plane, Home,
  Globe, Smartphone, Brain, Eye, Clock, Wifi,
  Code, BarChart3, Building2, Handshake, Key, Loader2,
  type LucideIcon,
} from "lucide-react";
import type { ComposioState } from "@/hooks/use-composio";

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
    description: "Medical records, wearables, vitals, checkups, prescriptions",
    sources: [
      { name: "Apple Health", composioId: "applehealth", description: "Steps, heart rate, sleep", icon: Watch, tier: 0 },
      { name: "Medical Records", description: "Lab results, diagnoses", icon: Stethoscope, tier: 0 },
      { name: "Prescriptions", description: "Active medications", icon: Pill, tier: 1 },
      { name: "Fitness Tracker", description: "Workouts, recovery", icon: Activity, tier: 1 },
    ],
  },
  {
    name: "Finance",
    icon: TrendingUp,
    description: "Bank accounts, cards, bills, investments, insurance, tax documents",
    sources: [
      { name: "Brex", composioId: "brex", description: "Corporate card transactions", icon: CreditCard, tier: 0 },
      { name: "Bank Accounts", description: "Checking, savings", icon: PiggyBank, tier: 0 },
      { name: "Investments", description: "Portfolio, holdings", icon: BarChart3, tier: 1 },
      { name: "Tax Documents", description: "W-2, 1099, returns", icon: FileText, tier: 1 },
      { name: "Insurance", description: "Health, auto, life", icon: Shield, tier: 2 },
    ],
  },
  {
    name: "Personal",
    icon: User,
    description: "Identity, communication, travel, shopping, social, relationships",
    sources: [
      { name: "Contacts", description: "Phone, social graph", icon: Users, tier: 0 },
      { name: "Shopping", description: "Orders, wishlists", icon: ShoppingBag, tier: 0 },
      { name: "Travel", description: "Flights, hotels, itineraries", icon: Plane, tier: 1 },
      { name: "Home", description: "Smart home, utilities", icon: Home, tier: 2 },
    ],
  },
  {
    name: "Work",
    icon: Briefcase,
    description: "Email, calendar, docs, collaboration, projects, code, CRM",
    sources: [
      { name: "Gmail", composioId: "gmail", description: "Gmail workspace", icon: Mail, tier: 0 },
      { name: "Google Calendar", composioId: "googlecalendar", description: "Google Calendar", icon: Calendar, tier: 0 },
      { name: "Google Drive", composioId: "googledrive", description: "Google Drive indexed", icon: FolderOpen, tier: 0 },
      { name: "Slack", composioId: "slack", description: "Messages from channels", icon: MessageSquare, tier: 0 },
      { name: "Notion", composioId: "notion", description: "Workspace pages", icon: BookOpen, tier: 1 },
      { name: "GitHub", composioId: "github", description: "Repositories", icon: Code, tier: 1 },
      { name: "CRM", description: "Contacts, deals", icon: Handshake, tier: 1 },
      { name: "Company", description: "Org chart, wiki", icon: Building2, tier: 2 },
    ],
  },
  {
    name: "Knowledge",
    icon: BookOpen,
    description: "Reading, learning, research, bookmarks, notes",
    sources: [
      { name: "Notion Notes", composioId: "notion", description: "Personal knowledge base", icon: BookOpen, tier: 0 },
      { name: "Bookmarks", description: "Saved articles, links", icon: Globe, tier: 1 },
      { name: "Reading List", description: "Books, papers", icon: FileText, tier: 1 },
      { name: "Research", description: "Academic, market research", icon: Brain, tier: 2 },
    ],
  },
  {
    name: "Context",
    icon: MapPin,
    description: "Real-time environment, location, activity, focus — always-on perception layer",
    sources: [
      { name: "Location", description: "GPS, places visited", icon: MapPin, tier: 0 },
      { name: "Screen Time", description: "App usage, focus", icon: Smartphone, tier: 0 },
      { name: "Attention", description: "Focus mode, deep work", icon: Eye, tier: 1 },
      { name: "Time Patterns", description: "Routines, habits", icon: Clock, tier: 1 },
      { name: "Network", description: "WiFi, Bluetooth context", icon: Wifi, tier: 2 },
    ],
  },
];

interface DataConnectionsProps {
  composio: ComposioState;
}

export default function DataConnections({ composio }: DataConnectionsProps) {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [connectingToolkit, setConnectingToolkit] = useState<string | null>(null);

  const isConnected = (composioId?: string) => {
    if (!composioId) return false;
    return composio.isToolkitConnected(composioId);
  };

  const countConnected = (category: InputCategory) =>
    category.sources.filter((s) => isConnected(s.composioId)).length;

  const totalConnected = INPUT_CATEGORIES.reduce((sum, c) => sum + countConnected(c), 0);
  const totalSources = INPUT_CATEGORIES.reduce((sum, c) => sum + c.sources.length, 0);

  const handleSaveKey = async () => {
    const key = apiKeyInput.trim();
    if (!key) return;
    setSavingKey(true);
    setKeyError(null);
    const result = await composio.saveApiKey(key);
    setSavingKey(false);
    if (result.ok) {
      setApiKeyInput("");
    } else {
      setKeyError(result.error ?? "Invalid key");
    }
  };

  const handleConnect = async (composioId: string) => {
    setConnectingToolkit(composioId);
    const result = await composio.connectToolkit(composioId);
    if (result.ok && result.redirectUrl) {
      window.open(result.redirectUrl, "_blank");
      await composio.waitForToolkit(composioId);
    }
    setConnectingToolkit(null);
  };

  const handleDisconnect = async (composioId: string) => {
    setConnectingToolkit(composioId);
    await composio.disconnectToolkit(composioId);
    setConnectingToolkit(null);
  };

  const configured = composio.keyStatus?.configured;

  return (
    <div>

      {/* API key setup */}
      {!configured && (
        <div className="glass-card p-3 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Key size={14} className="text-foreground/50" />
            <span className="text-xs font-medium text-foreground/70">Connect your apps</span>
          </div>
          <p className="text-[11px] text-foreground/40 mb-3">
            Enter your Composio API key to connect apps. Find it in your Composio workspace settings
          </p>
          <div className="flex gap-2">
            <input
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="ak_..."
              className="flex-1 rounded-lg bg-foreground/5 border border-foreground/10 px-3 py-1.5 text-xs font-mono text-foreground placeholder:text-foreground/25 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button
              onClick={handleSaveKey}
              disabled={savingKey || !apiKeyInput.trim()}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-foreground text-background hover:bg-foreground/85 transition-colors disabled:opacity-40"
            >
              {savingKey ? <Loader2 size={12} className="animate-spin" /> : "Save"}
            </button>
          </div>
          {keyError && <p className="text-[11px] text-destructive mt-1.5">{keyError}</p>}
        </div>
      )}

      {/* Stats row */}
      {configured && (
        <div className="grid grid-cols-4 gap-2 mb-4">
          {[
            { value: String(totalConnected), label: "Connected", sub: `of ${totalSources}` },
            { value: `${INPUT_CATEGORIES.filter((c) => countConnected(c) > 0).length}/${INPUT_CATEGORIES.length}`, label: "Layers", sub: "active" },
            { value: "2m", label: "Last Sync", sub: "ago" },
            { value: String(composio.connections.length), label: "Linked", sub: "apps" },
          ].map((stat) => (
            <div key={stat.label} className="glass-card p-2.5">
              <span className="text-lg font-semibold text-foreground">{stat.value}</span>
              <p className="text-[10px] text-foreground/50 mt-0.5 leading-tight">{stat.label}</p>
              <p className="text-[9px] text-foreground/30">{stat.sub}</p>
            </div>
          ))}
        </div>
      )}

      {/* Categories */}
      <div className="space-y-2.5">
        {INPUT_CATEGORIES.map((category, i) => {
          const isExpanded = expandedCategory === category.name;
          const CIcon = category.icon;
          const connected = countConnected(category);

          return (
            <motion.div
              key={category.name}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <div className="glass-card-strong overflow-hidden">
                <button
                  onClick={() => setExpandedCategory(isExpanded ? null : category.name)}
                  className="w-full p-4 flex items-center gap-3 transition-colors hover:bg-white/20"
                >
                  <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
                    <CIcon size={18} strokeWidth={1.5} className="text-foreground/70" />
                  </div>
                  <div className="flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{category.name}</span>
                      <span className="text-[10px] font-medium text-foreground/40 bg-foreground/[0.06] px-1.5 py-0.5 rounded-md">
                        {connected} / {category.sources.length}
                      </span>
                    </div>
                    <p className="text-[11px] text-foreground/40 mt-0.5 leading-snug">{category.description}</p>
                  </div>
                  <div className="flex-shrink-0 text-foreground/30">
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
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
                          const tierSources = category.sources.filter((s) => s.tier === tier);
                          if (tierSources.length === 0) return null;
                          const tierLabels = ["Priority", "Extended", "Optional"];
                          return (
                            <div key={tier}>
                              <div className="flex items-center gap-2 mb-1.5 mt-2.5">
                                <span className={`w-1.5 h-1.5 rounded-full ${
                                  tier === 0 ? "bg-foreground" : tier === 1 ? "bg-foreground/40" : "bg-foreground/20"
                                }`} />
                                <span className="text-[10px] font-semibold text-foreground/50 uppercase tracking-wider">
                                  Tier {tier} — {tierLabels[tier]}
                                </span>
                              </div>
                              <div className="space-y-1">
                                {tierSources.map((source) => {
                                  const SrcIcon = source.icon;
                                  const connected = isConnected(source.composioId);
                                  const isLoading = connectingToolkit === source.composioId;
                                  return (
                                    <div
                                      key={source.name}
                                      className={`flex items-center gap-2.5 rounded-xl px-3 py-2 transition-colors ${
                                        connected ? "bg-emerald-500/[0.06]" : "bg-foreground/[0.02]"
                                      }`}
                                    >
                                      <SrcIcon size={14} strokeWidth={1.5} className={
                                        connected ? "text-emerald-600 flex-shrink-0" : "text-foreground/30 flex-shrink-0"
                                      } />
                                      <span className={`text-xs flex-1 ${
                                        connected ? "text-foreground font-medium" : "text-foreground/45"
                                      }`}>{source.name}</span>
                                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                        connected ? "bg-emerald-500" : "bg-foreground/10"
                                      }`} />
                                      {source.composioId && configured ? (
                                        connected ? (
                                          <button
                                            onClick={() => handleDisconnect(source.composioId!)}
                                            disabled={isLoading}
                                            className="text-[10px] font-medium text-foreground/50 border border-foreground/10 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.04] transition-colors disabled:opacity-40"
                                          >
                                            {isLoading ? <Loader2 size={10} className="animate-spin" /> : "Manage"}
                                          </button>
                                        ) : (
                                          <button
                                            onClick={() => handleConnect(source.composioId!)}
                                            disabled={isLoading}
                                            className="text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors disabled:opacity-40"
                                          >
                                            {isLoading ? <Loader2 size={10} className="animate-spin" /> : "Connect"}
                                          </button>
                                        )
                                      ) : null}
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
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
