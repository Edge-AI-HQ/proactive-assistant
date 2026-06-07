import { useState } from "react";
import { Bell } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
} from "@/components/ui/drawer";

/**
 * In-app pre-prompt for notification permission. Mounts once per user
 * (gated on settings.notifyPermissionPromptedAt being null + native
 * runtime) on the first home-screen visit after sign-in.
 *
 * Why a pre-prompt before the OS prompt:
 *   - We can explain the WHY (async card generation). The OS dialog
 *     only gets one short system-rendered line.
 *   - Once denied at the OS level, iOS won't show that prompt again.
 *     If the user is in the "not sure" zone, the pre-prompt lets them
 *     defer without burning the OS permission slot.
 *
 * Both CTAs stamp notifyPermissionPromptedAt server-side so we never
 * re-show this automatically. The Account → Notifications toggle is
 * the only way to revisit the choice.
 */
export interface PreNotificationPromptProps {
  open: boolean;
  /** Called when the user taps "开启通知". Should request OS permission
   * and stamp notifyPermissionPromptedAt + (on grant) notifyNewCards=true.
   * Resolves after the parent finishes its write so the sheet stays
   * mounted during the network round-trip — no flash-of-empty. */
  onAccept: () => Promise<void>;
  /** Called when the user taps "稍后". Should stamp
   * notifyPermissionPromptedAt only (don't touch notifyNewCards). */
  onDecline: () => Promise<void>;
}

export function PreNotificationPrompt({
  open,
  onAccept,
  onDecline,
}: PreNotificationPromptProps) {
  const [busy, setBusy] = useState(false);

  const handleAccept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onAccept();
    } finally {
      setBusy(false);
    }
  };

  const handleDecline = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDecline();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      // Tapping outside the sheet counts as "later" — same outcome as
      // the explicit button, so we don't drop the prompted_at stamp.
      onOpenChange={(next) => {
        if (!next && open && !busy) {
          void handleDecline();
        }
      }}
    >
      <DrawerContent className="max-w-md mx-auto pb-6">
        <DrawerHeader className="flex flex-col items-center gap-3 pt-2">
          <div className="rounded-full bg-primary/10 p-3">
            <Bell className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <DrawerTitle className="text-center">开启通知</DrawerTitle>
          <DrawerDescription className="text-center text-base leading-relaxed">
            卡片生成可能需要几分钟到几小时。开通知后,生成完成时会立刻提醒你,
            不用一直盯着 app。
          </DrawerDescription>
        </DrawerHeader>
        <DrawerFooter className="gap-2">
          <button
            type="button"
            onClick={handleAccept}
            disabled={busy}
            className="w-full rounded-md bg-primary text-primary-foreground py-3 text-sm font-medium disabled:opacity-60"
          >
            好的,开启
          </button>
          <button
            type="button"
            onClick={handleDecline}
            disabled={busy}
            className="w-full rounded-md bg-transparent text-muted-foreground py-3 text-sm disabled:opacity-60"
          >
            稍后
          </button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
