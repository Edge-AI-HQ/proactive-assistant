import { useEffect } from "react";
import { createPortal } from "react-dom";
import useBodyScrollLock from "./useBodyScrollLock";

type ModelItem = {
  id: string;
  ref: string;
};

interface ModelPickerDialogProps {
  open: boolean;
  onClose: () => void;
  models?: {
    current: string | null;
    available: ModelItem[];
  } | null;
  modelBusy: boolean;
  onChangeModel: (modelRef: string) => void;
  onLoadModels: () => Promise<void>;
}

const IconBrain = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
  </svg>
);
const IconSparkles = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
  </svg>
);
const IconCpu = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
    <path d="M15 2v2" /><path d="M15 20v2" /><path d="M2 15h2" /><path d="M2 9h2" />
    <path d="M20 15h2" /><path d="M20 9h2" /><path d="M9 2v2" /><path d="M9 20v2" />
  </svg>
);
const IconZap = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
);
const IconBot = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 8V4H8" /><rect x="8" y="8" width="8" height="8" rx="1" />
    <path d="M2 12h2" /><path d="M20 12h2" /><path d="M12 2v2" /><path d="M12 20v2" />
  </svg>
);
const IconGlobe = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />
  </svg>
);
const IconWand = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 4V2" /><path d="M15 16v-2" /><path d="M8 9h2" /><path d="M20 9h2" /><path d="M17.8 11.8 19 13" /><path d="M15 9h.01" />
    <path d="M17.8 6.2 19 5" /><path d="m3 21 9-9" /><path d="M12.2 6.2 11 5" />
  </svg>
);

interface ModelDisplayInfo {
  name: string;
  desc: string;
  icon: () => JSX.Element;
}

const MODEL_DISPLAY: Record<string, ModelDisplayInfo> = {
  "claude-opus-4-6": { name: "Claude Opus 4.6", desc: "Most capable, best for complex tasks", icon: IconBrain },
  "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", desc: "Fast and highly intelligent", icon: IconSparkles },
  "claude-sonnet-4": { name: "Claude Sonnet 4", desc: "Fast and intelligent", icon: IconSparkles },
  "claude-haiku-3-5": { name: "Claude Haiku 3.5", desc: "Quick and lightweight", icon: IconZap },
  "gpt-4o": { name: "GPT-4o", desc: "OpenAI multimodal flagship", icon: IconCpu },
  "gpt-4o-mini": { name: "GPT-4o Mini", desc: "Lightweight and cost-effective", icon: IconZap },
  "gpt-4-turbo": { name: "GPT-4 Turbo", desc: "OpenAI high-performance model", icon: IconCpu },
  "gemini-2.5-pro": { name: "Gemini 2.5 Pro", desc: "Google's advanced model", icon: IconBot },
  "gemini-2.0-flash": { name: "Gemini 2.0 Flash", desc: "Google's fast model", icon: IconZap },
  "kimi-k2.6": { name: "Kimi K2.6", desc: "Moonshot's reasoning model", icon: IconGlobe },
  "kimi-k2": { name: "Kimi K2", desc: "Moonshot's versatile model", icon: IconGlobe },
  "minimax-m2.7": { name: "MiniMax M2.7", desc: "MiniMax latest flagship model", icon: IconWand },
  "minimax-m2.5": { name: "MiniMax M2.5", desc: "MiniMax multimodal model", icon: IconWand },
  "minimax-m1": { name: "MiniMax M1", desc: "MiniMax general model", icon: IconWand },
  "deepseek-r1": { name: "DeepSeek R1", desc: "DeepSeek reasoning model", icon: IconBrain },
  "deepseek-v3": { name: "DeepSeek V3", desc: "DeepSeek general model", icon: IconBrain },
  "seed-1.5-thinking": { name: "Seed 1.5 Thinking", desc: "ByteDance reasoning model", icon: IconSparkles },
};

const VENDOR_ICONS: { prefix: string; icon: () => JSX.Element; vendor: string }[] = [
  { prefix: "claude", icon: IconSparkles, vendor: "Anthropic" },
  { prefix: "gpt", icon: IconCpu, vendor: "OpenAI" },
  { prefix: "o1", icon: IconCpu, vendor: "OpenAI" },
  { prefix: "o3", icon: IconCpu, vendor: "OpenAI" },
  { prefix: "o4", icon: IconCpu, vendor: "OpenAI" },
  { prefix: "gemini", icon: IconBot, vendor: "Google" },
  { prefix: "kimi", icon: IconGlobe, vendor: "Moonshot" },
  { prefix: "minimax", icon: IconWand, vendor: "MiniMax" },
  { prefix: "deepseek", icon: IconBrain, vendor: "DeepSeek" },
  { prefix: "seed", icon: IconSparkles, vendor: "ByteDance" },
  { prefix: "qwen", icon: IconGlobe, vendor: "Alibaba" },
];

const formatIdToName = (id: string): string => {
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const inferVendor = (id: string): { icon: () => JSX.Element; vendor: string } | null => {
  const lower = id.toLowerCase();
  for (const v of VENDOR_ICONS) {
    if (lower.startsWith(v.prefix)) return { icon: v.icon, vendor: v.vendor };
  }
  return null;
};

const getModelDisplay = (modelId: string): ModelDisplayInfo => {
  const known = MODEL_DISPLAY[modelId];
  if (known) return known;

  const vendor = inferVendor(modelId);
  return {
    name: formatIdToName(modelId),
    desc: vendor ? `${vendor.vendor} model` : "AI model",
    icon: vendor?.icon ?? IconBrain,
  };
};

const ModelPickerDialog = ({
  open,
  onClose,
  models,
  modelBusy,
  onChangeModel,
  onLoadModels,
}: ModelPickerDialogProps) => {
  useBodyScrollLock(open);

  useEffect(() => {
    if (open) void onLoadModels();
  }, [open]);

  if (!open) return null;

  const modelsLoading = !models;
  const available = models?.available ?? [];
  const currentRef = models?.current ?? null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div
        className="relative bg-background max-w-[340px] w-full rounded-3xl p-0 overflow-hidden shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-3 w-7 h-7 flex items-center justify-center rounded-full bg-secondary/80 hover:bg-secondary text-foreground/60 hover:text-foreground transition-all z-10"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>

        <div className="px-5 pt-5 pb-0">
          <h3 className="text-lg font-bold text-foreground">Change Model</h3>
          <p className="text-xs text-muted-foreground">Select a model for your agent</p>
        </div>

        <div className="px-5 pb-5 pt-3 space-y-2 max-h-[60vh] overflow-y-scroll overscroll-contain">
          {modelsLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="w-full flex items-center gap-2.5 rounded-xl px-3 py-3 animate-pulse">
                <div className="w-8 h-8 rounded-lg bg-secondary shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-28 bg-secondary rounded" />
                  <div className="h-2.5 w-40 bg-secondary/60 rounded" />
                </div>
              </div>
            ))
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground px-3 py-4 text-center">No models available.</p>
          ) : (
            available.map((m) => {
              const isActive = currentRef === m.ref;
              const display = getModelDisplay(m.id);
              const Icon = display.icon;
              return (
                <button
                  key={m.ref}
                  disabled={modelBusy}
                  onClick={() => {
                    if (!isActive) {
                      onChangeModel(m.ref);
                    }
                    onClose();
                  }}
                  className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-3 transition-all text-left ${
                    isActive
                      ? "bg-foreground text-background"
                      : "bg-card border border-border/40 hover:border-foreground/20"
                  } ${modelBusy ? "opacity-60 cursor-not-allowed" : ""}`}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                    isActive ? "bg-background/20" : "bg-secondary"
                  }`}>
                    <div className={isActive ? "text-background" : "text-foreground"}>
                      <Icon />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium truncate ${isActive ? "text-background" : "text-foreground"}`}>
                      {display.name}
                    </p>
                    <p className={`text-[10px] truncate ${isActive ? "text-background/60" : "text-muted-foreground"}`}>
                      {display.desc}
                    </p>
                  </div>
                  {isActive && (
                    <svg className="w-4 h-4 text-background shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export const formatModelName = (
  modelRef: string | null | undefined,
  availableModels?: { id: string; ref: string }[],
  modelsLoaded?: boolean,
): string => {
  if (modelsLoaded === false) return "Loading...";
  if (!modelRef) return "Default";

  const fromList = availableModels?.find((m) => m.ref === modelRef);
  if (fromList) return getModelDisplay(fromList.id).name;

  const tail = modelRef.split("/").pop() || modelRef;
  const known = MODEL_DISPLAY[tail];
  if (known) return known.name;

  const vendor = inferVendor(tail);
  if (vendor) return formatIdToName(tail);

  const formatted = formatIdToName(tail);
  return formatted.length > 20 ? `${formatted.slice(0, 18)}...` : formatted;
};

export default ModelPickerDialog;
