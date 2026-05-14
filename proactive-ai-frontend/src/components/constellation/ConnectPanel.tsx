import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Heart, Briefcase, User, TrendingUp, BookOpen, MapPin,
  ChevronDown, ChevronUp, Mail, Calendar, FolderOpen, MessageSquare,
  CreditCard, PiggyBank, FileText, Shield, Activity, Pill,
  Stethoscope, Watch, Users, ShoppingBag, Plane, Home,
  Globe, Smartphone, Brain, Eye, Clock, Wifi,
  Code, BarChart3, Building2, Handshake,
  Smartphone as PhoneIcon, Laptop, Watch as WatchIcon, Glasses, Camera,
  type LucideIcon,
} from "lucide-react";

interface DataSource {
  name: string;
  description: string;
  icon: LucideIcon;
  connected: boolean;
  tier: 0 | 1 | 2;
  stats?: string;
}

interface InputCategory {
  name: string;
  icon: LucideIcon;
  description: string;
  connectedCount: number;
  totalCount: number;
  sources: DataSource[];
}

const INPUT_CATEGORIES: InputCategory[] = [
  {
    name: "Health",
    icon: Heart,
    description: "Medical records, wearables, vitals, checkups, prescriptions",
    connectedCount: 1,
    totalCount: 15,
    sources: [
      { name: "Apple Health", description: "Steps, heart rate, sleep", icon: Watch, connected: true, tier: 0, stats: "Syncing daily" },
      { name: "Medical Records", description: "Lab results, diagnoses", icon: Stethoscope, connected: false, tier: 0 },
      { name: "Prescriptions", description: "Active medications", icon: Pill, connected: false, tier: 1 },
      { name: "Fitness Tracker", description: "Workouts, recovery", icon: Activity, connected: false, tier: 1 },
    ],
  },
  {
    name: "Finance",
    icon: TrendingUp,
    description: "Bank accounts, cards, bills, investments, insurance, tax documents",
    connectedCount: 2,
    totalCount: 9,
    sources: [
      { name: "Brex", description: "Corporate card transactions", icon: CreditCard, connected: true, tier: 0, stats: "47 transactions this month" },
      { name: "Bank Accounts", description: "Checking, savings", icon: PiggyBank, connected: true, tier: 0, stats: "2 accounts linked" },
      { name: "Investments", description: "Portfolio, holdings", icon: BarChart3, connected: false, tier: 1 },
      { name: "Tax Documents", description: "W-2, 1099, returns", icon: FileText, connected: false, tier: 1 },
      { name: "Insurance", description: "Health, auto, life", icon: Shield, connected: false, tier: 2 },
    ],
  },
  {
    name: "Personal",
    icon: User,
    description: "Identity, communication, travel, shopping, social, relationships",
    connectedCount: 2,
    totalCount: 20,
    sources: [
      { name: "Contacts", description: "Phone, social graph", icon: Users, connected: true, tier: 0, stats: "342 contacts" },
      { name: "Shopping", description: "Orders, wishlists", icon: ShoppingBag, connected: true, tier: 0, stats: "Amazon, etc." },
      { name: "Travel", description: "Flights, hotels, itineraries", icon: Plane, connected: false, tier: 1 },
      { name: "Home", description: "Smart home, utilities", icon: Home, connected: false, tier: 2 },
    ],
  },
  {
    name: "Work",
    icon: Briefcase,
    description: "Email, calendar, docs, collaboration, projects, code, CRM",
    connectedCount: 5,
    totalCount: 19,
    sources: [
      { name: "Work Email", description: "Gmail workspace", icon: Mail, connected: true, tier: 0, stats: "20 emails analyzed today" },
      { name: "Work Calendar", description: "Google Calendar", icon: Calendar, connected: true, tier: 0, stats: "15 events this week" },
      { name: "Files / Docs", description: "Google Drive indexed", icon: FolderOpen, connected: true, tier: 0, stats: "Drive indexed" },
      { name: "Slack", description: "Messages from channels", icon: MessageSquare, connected: true, tier: 0, stats: "20 messages from #dev" },
      { name: "Notion", description: "Workspace pages", icon: BookOpen, connected: true, tier: 1, stats: "10 pages indexed" },
      { name: "Code", description: "GitHub repositories", icon: Code, connected: false, tier: 1 },
      { name: "CRM", description: "Contacts, deals", icon: Handshake, connected: false, tier: 1 },
      { name: "Company", description: "Org chart, wiki", icon: Building2, connected: false, tier: 2 },
    ],
  },
  {
    name: "Knowledge",
    icon: BookOpen,
    description: "Reading, learning, research, bookmarks, notes",
    connectedCount: 1,
    totalCount: 12,
    sources: [
      { name: "Notion Notes", description: "Personal knowledge base", icon: BookOpen, connected: true, tier: 0, stats: "48 pages" },
      { name: "Bookmarks", description: "Saved articles, links", icon: Globe, connected: false, tier: 1 },
      { name: "Reading List", description: "Books, papers", icon: FileText, connected: false, tier: 1 },
      { name: "Research", description: "Academic, market research", icon: Brain, connected: false, tier: 2 },
    ],
  },
  {
    name: "Context",
    icon: MapPin,
    description: "Real-time environment, location, activity, focus — always-on perception layer",
    connectedCount: 0,
    totalCount: 7,
    sources: [
      { name: "Location", description: "GPS, places visited", icon: MapPin, connected: false, tier: 0 },
      { name: "Screen Time", description: "App usage, focus", icon: Smartphone, connected: false, tier: 0 },
      { name: "Attention", description: "Focus mode, deep work", icon: Eye, connected: false, tier: 1 },
      { name: "Time Patterns", description: "Routines, habits", icon: Clock, connected: false, tier: 1 },
      { name: "Network", description: "WiFi, Bluetooth context", icon: Wifi, connected: false, tier: 2 },
    ],
  },
];

const DEVICES_CATEGORY: InputCategory = {
  name: "Devices",
  icon: PhoneIcon,
  description: "Phones, laptops, wearables, glasses, cameras — encrypted peer-to-peer",
  connectedCount: 5,
  totalCount: 12,
  sources: [
    { name: "iPhone 17 Pro", description: "this device · LiterTLM 3.5 (3B q4) · 82%", icon: PhoneIcon, connected: true, tier: 0, stats: "142 today" },
    { name: "MacBook Pro M5", description: "runs OpenClaw · LiterTLM 3.5 (8B q8)", icon: Laptop, connected: true, tier: 0, stats: "218 today" },
    { name: "Apple Watch Ultra 3", description: "Apple Intelligence · 64%", icon: WatchIcon, connected: true, tier: 0, stats: "47 today" },
    { name: "Meta Ray-Ban", description: "standby · on-device vision · 71%", icon: Glasses, connected: true, tier: 1, stats: "12 today" },
    { name: "Home Camera", description: "scene + motion", icon: Camera, connected: true, tier: 1, stats: "63 today" },
  ],
};

export default function ConnectPanel() {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState(() => !localStorage.getItem("connect_intro_seen"));

  useEffect(() => {
    if (showIntro) localStorage.setItem("connect_intro_seen", "1");
  }, [showIntro]);

  const totalConnected = INPUT_CATEGORIES.reduce((sum, c) => sum + c.connectedCount, 0) + DEVICES_CATEGORY.connectedCount;
  const totalSources = INPUT_CATEGORIES.reduce((sum, c) => sum + c.totalCount, 0) + DEVICES_CATEGORY.totalCount;

  const toggleCategory = (name: string) => {
    setExpandedCategory(expandedCategory === name ? null : name);
  };

  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      <h1 className="text-2xl font-semibold text-foreground tracking-tight mb-0.5">Connect</h1>
      <p className="text-xs text-muted-foreground mb-5">Data sources & devices powering your AI</p>

      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
        {showIntro && (
          <div className="glass-card-strong p-4">
            <p className="text-sm text-foreground/70 leading-relaxed">
              <span className="font-medium text-foreground">Connect data sources and devices — they're the raw material of your Personal AI.</span>{" "}
              The richer the signals, the better it can watch, understand, and proactively help.
            </p>
          </div>
        )}

        <div className="glass-card p-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold text-foreground/50 uppercase tracking-[0.12em] mb-1">Connected</p>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold text-foreground leading-none">{totalConnected}</span>
              <span className="text-sm text-foreground/40 leading-none">of {totalSources}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-[11px] font-medium text-foreground/60">All syncing</span>
          </div>
        </div>

        {(() => {
          const category = DEVICES_CATEGORY;
          const isExpanded = expandedCategory === category.name;
          const Icon = category.icon;
          return (
            <div>
              <div className="flex items-center gap-2 mb-2 px-1">
                <span className="w-1 h-1 rounded-full bg-[hsl(304_75%_63%)]" />
                <span className="text-[10px] font-semibold text-[hsl(304_75%_63%)] uppercase tracking-[0.12em]">Your Mesh</span>
              </div>
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-2xl overflow-hidden border border-[hsl(304_75%_63%/0.25)] bg-[hsl(304_75%_63%/0.04)] backdrop-blur-xl shadow-[0_8px_24px_-12px_hsl(304_75%_63%/0.25)]"
              >
                <button onClick={() => toggleCategory(category.name)} className="w-full p-4 flex items-center gap-3 transition-colors hover:bg-[hsl(304_75%_63%/0.06)]">
                  <div className="w-10 h-10 rounded-xl bg-[hsl(304_75%_63%/0.12)] flex items-center justify-center flex-shrink-0">
                    <Icon size={18} strokeWidth={1.5} className="text-[hsl(304_75%_63%)]" />
                  </div>
                  <div className="flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{category.name}</span>
                      <span className="text-[10px] font-semibold text-[hsl(304_75%_63%)] bg-[hsl(304_75%_63%/0.1)] px-1.5 py-0.5 rounded-md">{category.connectedCount} active</span>
                    </div>
                    <p className="text-[11px] text-foreground/50 mt-0.5 leading-snug">{category.description}</p>
                  </div>
                  <div className="flex-shrink-0 text-foreground/30">
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </div>
                </button>
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: "easeInOut" }} className="overflow-hidden">
                      <div className="px-4 pb-4 space-y-1">
                        <div className="h-px bg-[hsl(304_75%_63%/0.15)] mb-2" />
                        {[0, 1, 2].map((tier) => {
                          const tierSources = category.sources.filter((s) => s.tier === tier);
                          if (tierSources.length === 0) return null;
                          const tierLabels = ["Priority", "Extended", "Optional"];
                          return (
                            <div key={tier}>
                              <div className="flex items-center gap-2 mb-1.5 mt-2.5">
                                <span className={`w-1.5 h-1.5 rounded-full ${tier === 0 ? "bg-foreground" : tier === 1 ? "bg-foreground/40" : "bg-foreground/20"}`} />
                                <span className="text-[10px] font-semibold text-foreground/50 uppercase tracking-wider">Tier {tier} — {tierLabels[tier]}</span>
                              </div>
                              <div className="space-y-1">
                                {tierSources.map((source) => {
                                  const SrcIcon = source.icon;
                                  return (
                                    <div key={source.name} className="flex items-center gap-2.5 rounded-xl px-3 py-2 bg-white/40">
                                      <SrcIcon size={14} strokeWidth={1.5} className="text-[hsl(304_75%_63%)] flex-shrink-0" />
                                      <div className="flex-1 min-w-0">
                                        <p className="text-xs font-medium text-foreground truncate">{source.name}</p>
                                        <p className="text-[10px] text-foreground/45 truncate">{source.description}</p>
                                      </div>
                                      {source.stats && <span className="text-[10px] font-medium text-foreground/50 flex-shrink-0">{source.stats}</span>}
                                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                        <button className="w-full mt-3 text-[11px] font-medium text-[hsl(304_75%_63%)] border border-[hsl(304_75%_63%/0.3)] rounded-xl py-2 hover:bg-[hsl(304_75%_63%/0.06)] transition-colors">+ Pair device</button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>

              <div className="flex items-center gap-2 mt-5 mb-2 px-1">
                <span className="w-1 h-1 rounded-full bg-foreground/40" />
                <span className="text-[10px] font-semibold text-foreground/50 uppercase tracking-[0.12em]">Data Sources</span>
              </div>
            </div>
          );
        })()}

        <div className="space-y-2.5">
          {INPUT_CATEGORIES.map((category, i) => {
            const isExpanded = expandedCategory === category.name;
            const Icon = category.icon;
            return (
              <motion.div key={category.name} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                <div className="glass-card-strong overflow-hidden">
                  <button onClick={() => toggleCategory(category.name)} className="w-full p-4 flex items-center gap-3 transition-colors hover:bg-white/20">
                    <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
                      <Icon size={18} strokeWidth={1.5} className="text-foreground/70" />
                    </div>
                    <div className="flex-1 text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{category.name}</span>
                        <span className="text-[10px] font-medium text-foreground/40 bg-foreground/[0.06] px-1.5 py-0.5 rounded-md">{category.connectedCount} / {category.totalCount}</span>
                      </div>
                      <p className="text-[11px] text-foreground/40 mt-0.5 leading-snug">{category.description}</p>
                    </div>
                    <div className="flex-shrink-0 text-foreground/30">
                      {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </div>
                  </button>
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: "easeInOut" }} className="overflow-hidden">
                        <div className="px-4 pb-4 space-y-1">
                          <div className="h-px bg-foreground/[0.06] mb-2" />
                          {[0, 1, 2].map((tier) => {
                            const tierSources = category.sources.filter((s) => s.tier === tier);
                            if (tierSources.length === 0) return null;
                            const tierLabels = ["Priority", "Extended", "Optional"];
                            return (
                              <div key={tier}>
                                <div className="flex items-center gap-2 mb-1.5 mt-2.5">
                                  <span className={`w-1.5 h-1.5 rounded-full ${tier === 0 ? "bg-foreground" : tier === 1 ? "bg-foreground/40" : "bg-foreground/20"}`} />
                                  <span className="text-[10px] font-semibold text-foreground/50 uppercase tracking-wider">Tier {tier} — {tierLabels[tier]}</span>
                                </div>
                                <div className="space-y-1">
                                  {tierSources.map((source) => {
                                    const SrcIcon = source.icon;
                                    const isConnected = source.connected;
                                    return (
                                      <div key={source.name} className={`flex items-center gap-2.5 rounded-xl px-3 py-2 transition-colors ${isConnected ? "bg-emerald-500/[0.06]" : "bg-foreground/[0.02]"}`}>
                                        <SrcIcon size={14} strokeWidth={1.5} className={isConnected ? "text-emerald-600 flex-shrink-0" : "text-foreground/30 flex-shrink-0"} />
                                        <span className={`text-xs flex-1 ${isConnected ? "text-foreground font-medium" : "text-foreground/45"}`}>{source.name}</span>
                                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isConnected ? "bg-emerald-500" : "bg-foreground/10"}`} />
                                        {isConnected ? (
                                          <button className="text-[10px] font-medium text-foreground/50 border border-foreground/10 rounded-lg px-2 py-0.5 hover:bg-foreground/[0.04] transition-colors">Manage</button>
                                        ) : (
                                          <button className="text-[10px] font-medium text-foreground bg-foreground/[0.06] border border-foreground/12 rounded-lg px-2.5 py-0.5 hover:bg-foreground/[0.1] transition-colors">Connect</button>
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
              </motion.div>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}
