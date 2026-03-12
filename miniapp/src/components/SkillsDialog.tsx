import { createPortal } from "react-dom";
import useBodyScrollLock from "./useBodyScrollLock";

type SkillItem = {
  key: string;
  name: string;
  description: string;
  installed: boolean;
  enabled: boolean;
};

interface SkillsDialogProps {
  open: boolean;
  onClose: () => void;
  skills: SkillItem[];
}

const SKILL_ICON_MAP: Record<string, JSX.Element> = {
  "gws": (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" />
    </svg>
  ),
  "gws-gmail": (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  ),
  "gws-shared": (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  "gemini": (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" /><path d="M5.5 6.5 12 12l6.5-5.5" /><path d="M5.5 17.5 12 12l6.5 5.5" />
    </svg>
  ),
  "sag": (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </svg>
  ),
  "peekaboo": (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ),
  "nano-banana-pro": (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8V4H8" /><rect x="8" y="8" width="8" height="8" rx="1" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="m4.93 19.07 1.41-1.41" /><path d="m17.66 6.34 1.41-1.41" />
    </svg>
  ),
  "openai-whisper-api": (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  ),
  "openai-image-gen": (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  ),
};

const DEFAULT_ICON = (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
);

const getSkillIcon = (key: string) => SKILL_ICON_MAP[key] ?? DEFAULT_ICON;

const SKILL_SHORT_DESC: Record<string, string> = {
  "gws": "Google Workspace CLI access",
  "gws-gmail": "Read & search Gmail",
  "gws-shared": "Workspace auth & helpers",
  "gemini": "Gemini model integration",
  "sag": "Web search & grounding",
  "peekaboo": "Page snapshot & peek",
  "nano-banana-pro": "Multimodal agent boost",
  "openai-whisper-api": "Speech-to-text via Whisper",
  "openai-image-gen": "Image gen via DALL-E",
};

const getShortDesc = (key: string, fallback: string) =>
  SKILL_SHORT_DESC[key] ?? (fallback.length > 30 ? fallback.slice(0, 30) + "..." : fallback);

const AVAILABLE_SKILLS: { id: string; name: string; desc: string }[] = [
  { id: "content-writer", name: "Content Writer", desc: "Blog posts & summaries" },
  { id: "web-research", name: "Web Research", desc: "Deep search & fact-check" },
  { id: "deal-finder", name: "Deal Finder", desc: "Compare prices & deals" },
  { id: "data-analyst", name: "Data Analyst", desc: "Charts, trends & insights" },
  { id: "social-media", name: "Social Media", desc: "Post scheduling" },
  { id: "code-helper", name: "Code Helper", desc: "Debug & review code" },
  { id: "translator", name: "Translator", desc: "Multi-language translation" },
  { id: "finance-tracker", name: "Finance Tracker", desc: "Budget & expenses" },
  { id: "travel-planner", name: "Travel Planner", desc: "Itineraries & flights" },
  { id: "study-buddy", name: "Study Buddy", desc: "Flashcards & quizzes" },
];

const AVAILABLE_ICON_MAP: Record<string, JSX.Element> = {
  "content-writer": (
    <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" />
    </svg>
  ),
  "web-research": (
    <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />
    </svg>
  ),
  "deal-finder": (
    <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="21" r="1" /><circle cx="19" cy="21" r="1" /><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
    </svg>
  ),
  "data-analyst": (
    <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" />
    </svg>
  ),
  "social-media": (
    <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  ),
  "code-helper": (
    <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  "translator": (
    <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />
    </svg>
  ),
  "finance-tracker": (
    <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" /><path d="M12 10v4" /><path d="M2 10h20" />
    </svg>
  ),
  "travel-planner": (
    <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
    </svg>
  ),
  "study-buddy": (
    <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    </svg>
  ),
};

const SkillsDialog = ({ open, onClose, skills }: SkillsDialogProps) => {
  useBodyScrollLock(open);
  if (!open) return null;

  const installedSkills = skills.filter((s) => s.installed);

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div
        className="relative bg-background max-w-sm w-full rounded-3xl p-0 overflow-hidden shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 transition-opacity z-10"
        >
          <svg className="h-4 w-4 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="px-5 pt-5 pb-0">
          <h3 className="text-lg font-bold text-foreground">Skills</h3>
          <p className="text-xs text-muted-foreground">
            {installedSkills.length} installed · {AVAILABLE_SKILLS.length} available
          </p>
        </div>

        <div className="px-5 pb-5 pt-3 max-h-[75vh] overflow-y-scroll overscroll-contain">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Installed</p>
          {installedSkills.length === 0 ? (
            <p className="text-xs text-muted-foreground py-3 mb-4">No skills installed yet.</p>
          ) : (
            <div className="space-y-2 mb-4">
              {installedSkills.map((skill) => (
                <div
                  key={skill.key}
                  className="flex items-center gap-2.5 bg-foreground/5 border border-foreground/15 rounded-xl px-3 py-2.5 transition-all hover:border-foreground/30"
                >
                  <div className="w-8 h-8 rounded-lg bg-foreground text-background flex items-center justify-center shrink-0">
                    {getSkillIcon(skill.key)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{skill.name}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{getShortDesc(skill.key, skill.description)}</p>
                  </div>
                  {skill.enabled && (
                    <svg className="w-3.5 h-3.5 text-foreground shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 mb-2">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Available</p>
            <span className="text-[9px] font-medium text-muted-foreground bg-secondary rounded-full px-2 py-0.5">Coming Soon</span>
          </div>
          <div className="space-y-2 opacity-60">
            {AVAILABLE_SKILLS.map((skill) => (
              <div key={skill.id} className="flex items-center gap-2.5 bg-card border border-border/40 rounded-xl px-3 py-2.5">
                <div className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                  {AVAILABLE_ICON_MAP[skill.id] ?? DEFAULT_ICON}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-muted-foreground truncate">{skill.name}</p>
                  <p className="text-[10px] text-muted-foreground/60 truncate">{skill.desc}</p>
                </div>
                <div className="shrink-0 w-7 h-7 flex items-center justify-center bg-muted text-muted-foreground rounded-lg cursor-not-allowed">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default SkillsDialog;
