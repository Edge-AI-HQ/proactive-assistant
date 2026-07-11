import { motion, AnimatePresence } from "framer-motion";
import { Send, Radio, PanelLeft, ArrowRight, type LucideIcon } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Text } from "@/ui-web";
import { shortcutHint } from "@/lib/platform";

export interface PaletteNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  path: string;
}

/** palette 的卡片条目——展示就绪的形状（真实 IntentCard 在 Shell 侧映射）。 */
export interface PaletteCard {
  id: string;
  title: string;
  icon: LucideIcon;
  categoryLabel: string;
  searchText?: string;
}

/**
 * ⌘K command palette — Raycast/Linear-style quick switcher over the zebra
 * shell. Empty query leads with actions (so ⌘K → Enter still opens the
 * conversation); typing fuzzy-matches live cards and pages.
 */
export default function ZebraCommandPalette({
  open,
  onClose,
  cards,
  navItems,
  onSelectCard,
  onAskPinAi,
  onToggleAmbient,
  onToggleSidebar,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  cards: PaletteCard[];
  navItems: readonly PaletteNavItem[];
  onSelectCard: (id: string) => void;
  onAskPinAi: () => void;
  onToggleAmbient: () => void;
  onToggleSidebar: () => void;
  onNavigate: (path: string) => void;
}) {
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="palette-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[70] bg-foreground/10 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            key="palette"
            // 入场用纯 opacity fade（最便宜的动效，Dialog 业界 convention）——
            // backdrop-filter blur(48px) 模糊 ZebraBackdrop 常驻视频本就逐帧重算，
            // 改几何的入场动画(scale 重光栅、translateY 平移也要按新位置重采样
            // 动态背景)在 Electron(macOS)都会卡；纯 fade 几何不动只 alpha 合成
            // 最省（x:-50% 是静态水平居中、非动画）。
            initial={{ opacity: 0, x: "-50%" }}
            animate={{ opacity: 1, x: "-50%" }}
            exit={{ opacity: 0, x: "-50%" }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="fixed left-1/2 top-[16%] z-[71] w-[600px] max-w-[calc(100vw-2rem)] rounded-3xl overflow-hidden"
            style={{
              background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.75) 0%, hsla(0, 0%, 100%, 0.92) 100%)",
              backdropFilter: "blur(48px) saturate(1.5)",
              WebkitBackdropFilter: "blur(48px) saturate(1.5)",
              border: "1px solid hsla(0, 0%, 100%, 0.55)",
              boxShadow: "0 24px 80px hsl(280 20% 40% / 0.25)",
            }}
          >
            <Command loop className="bg-transparent">
              <CommandInput placeholder="Search cards, pages, actions…" autoFocus />
              <CommandList className="max-h-[420px]">
                <CommandEmpty>No results.</CommandEmpty>

                <CommandGroup heading="Actions">
                  <CommandItem value="ask pin ai conversation chat" onSelect={run(onAskPinAi)}>
                    <span
                      className="mr-2.5 w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
                      style={{ background: "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330 80% 65%) 100%)" }}
                    >
                      <Send size={12} strokeWidth={2.2} className="text-white" />
                    </span>
                    <span className="font-medium">Ask PIN AI</span>
                    <kbd className="ml-auto text-micro font-semibold text-foreground/40 bg-foreground/[0.06] rounded px-1.5 py-0.5">⏎</kbd>
                  </CommandItem>
                  <CommandItem value="toggle ambient sensing" onSelect={run(onToggleAmbient)}>
                    <span className="mr-2.5 w-6 h-6 rounded-lg bg-foreground/[0.06] flex items-center justify-center shrink-0">
                      <Radio size={12} strokeWidth={2} className="text-foreground/65" />
                    </span>
                    <span className="font-medium">Toggle Ambient</span>
                  </CommandItem>
                  <CommandItem value="toggle sidebar collapse" onSelect={run(onToggleSidebar)}>
                    <span className="mr-2.5 w-6 h-6 rounded-lg bg-foreground/[0.06] flex items-center justify-center shrink-0">
                      <PanelLeft size={12} strokeWidth={2} className="text-foreground/65" />
                    </span>
                    <span className="font-medium">Toggle sidebar</span>
                    <kbd className="ml-auto text-micro font-semibold text-foreground/40 bg-foreground/[0.06] rounded px-1.5 py-0.5">{shortcutHint("B")}</kbd>
                  </CommandItem>
                </CommandGroup>

                {cards.length > 0 && (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading="Cards">
                      {cards.map((card) => {
                        const Icon = card.icon;
                        return (
                          <CommandItem
                            key={card.id}
                            value={`${card.title} ${card.categoryLabel} ${card.searchText ?? ""}`}
                            onSelect={run(() => onSelectCard(card.id))}
                          >
                            <span className="mr-2.5 w-6 h-6 rounded-lg bg-foreground/[0.06] flex items-center justify-center shrink-0">
                              <Icon size={12} strokeWidth={1.8} className="text-foreground/65" />
                            </span>
                            <span className="truncate">{card.title}</span>
                            <Text variant="micro" weight="semibold" className="ml-auto pl-3 shrink-0 uppercase tracking-wide text-foreground/35">
                              {card.categoryLabel}
                            </Text>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </>
                )}

                <CommandSeparator />

                <CommandGroup heading="Go to">
                  {navItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <CommandItem
                        key={item.id}
                        value={`go to ${item.label}`}
                        onSelect={run(() => onNavigate(item.path))}
                      >
                        <span className="mr-2.5 w-6 h-6 rounded-lg bg-foreground/[0.06] flex items-center justify-center shrink-0">
                          <Icon size={12} strokeWidth={1.8} className="text-foreground/65" />
                        </span>
                        <span className="font-medium capitalize">{item.label.toLowerCase()}</span>
                        <ArrowRight size={12} strokeWidth={1.8} className="ml-auto text-foreground/30" />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
