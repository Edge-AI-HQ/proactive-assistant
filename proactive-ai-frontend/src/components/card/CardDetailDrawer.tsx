import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import CardDrawerContent from "@/components/card/CardDrawerContent";
import type { Intent } from "@/components/now/cardModel";

interface CardDetailDrawerProps {
  open: boolean;
  /** The tapped card whose detail is shown; null collapses the body (the
   *  Drawer shell still animates closed via `open`). */
  card: Intent | null;
  onOpenChange: (open: boolean) => void;
  /** Whether the card is in a completed state — drives CardDrawerContent's
   *  read-only "completed" layout. Computed by the parent from the real
   *  card outcome + optimistic doneIds. */
  completed: boolean;
  pending: boolean;
  onExecute: (card: Intent) => void;
  onClose: () => void;
  onDismiss: (card: Intent) => void;
  onModify: (card: Intent) => void;
}

/**
 * Card detail bottom-sheet. Thin shell around CardDrawerContent: owns the
 * vaul Drawer chrome (glass background, sr-only header) and forwards the
 * tapped card plus its action callbacks. All card lifecycle logic
 * (execute / dismiss / modify / completed lookup) stays in the parent so
 * behavior is unchanged.
 */
export default function CardDetailDrawer({
  open,
  card,
  onOpenChange,
  completed,
  pending,
  onExecute,
  onClose,
  onDismiss,
  onModify,
}: CardDetailDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="max-h-[92vh] border-t-0 !bg-transparent"
        style={{
          background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.5) 0%, hsla(0, 0%, 100%, 0.7) 100%)",
          backdropFilter: "blur(40px) saturate(1.5)",
          WebkitBackdropFilter: "blur(40px) saturate(1.5)",
          border: "1px solid hsla(0, 0%, 100%, 0.4)",
          borderBottom: "none",
          borderRadius: "1.5rem 1.5rem 0 0",
        }}
        overlayClassName="!bg-foreground/5 backdrop-blur-[2px]"
      >
        <DrawerHeader className="sr-only">
          <DrawerTitle>{card?.title ?? "Card Detail"}</DrawerTitle>
          <DrawerDescription>Card detail view</DrawerDescription>
        </DrawerHeader>
        {card && (
          <CardDrawerContent
            card={card}
            completed={completed}
            pending={pending}
            onExecute={onExecute}
            onClose={onClose}
            onDismiss={onDismiss}
            onModify={onModify}
          />
        )}
      </DrawerContent>
    </Drawer>
  );
}
