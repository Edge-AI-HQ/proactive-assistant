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

const MODEL_DISPLAY: Record<string, { name: string; desc: string; icon: () => JSX.Element }> = {
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    desc: "Most capable, best for complex tasks",
    icon: () => (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
        <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      </svg>
    ),
  },
  "claude-sonnet-4": {
    name: "Claude Sonnet 4",
    desc: "Fast and intelligent",
    icon: () => (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      </svg>
    ),
  },
  "gpt-4o": {
    name: "GPT-4o",
    desc: "OpenAI multimodal flagship",
    icon: () => (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M15 2v2" /><path d="M15 20v2" /><path d="M2 15h2" /><path d="M2 9h2" />
        <path d="M20 15h2" /><path d="M20 9h2" /><path d="M9 2v2" /><path d="M9 20v2" />
      </svg>
    ),
  },
  "gpt-4o-mini": {
    name: "GPT-4o Mini",
    desc: "Lightweight and cost-effective",
    icon: () => (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
  },
  "gemini-2.5-pro": {
    name: "Gemini 2.5 Pro",
    desc: "Google's advanced model",
    icon: () => (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 8V4H8" /><rect x="8" y="8" width="8" height="8" rx="1" />
        <path d="M2 12h2" /><path d="M20 12h2" /><path d="M12 2v2" /><path d="M12 20v2" />
      </svg>
    ),
  },
};

const defaultIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
  </svg>
);

const getModelDisplay = (modelId: string) => {
  return MODEL_DISPLAY[modelId] ?? { name: modelId, desc: "", icon: defaultIcon };
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
          <h3 className="text-lg font-bold text-foreground">Change Model</h3>
          <p className="text-xs text-muted-foreground">Select a model for your agent</p>
        </div>

        <div className="px-5 pb-5 pt-3 space-y-2">
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
): string => {
  if (!modelRef) return "Default";
  const tail = modelRef.split("/").pop() || modelRef;
  const display = MODEL_DISPLAY[tail];
  if (display) return display.name;
  const fromList = availableModels?.find((m) => m.ref === modelRef);
  if (fromList) {
    const d = MODEL_DISPLAY[fromList.id];
    if (d) return d.name;
  }
  return tail.length > 16 ? `${tail.slice(0, 16)}...` : tail;
};

export default ModelPickerDialog;
