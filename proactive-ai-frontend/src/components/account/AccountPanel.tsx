import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  Sparkles, Check, Bell, SlidersHorizontal, Radio, ChevronRight, ArrowLeft,
  CreditCard, Calendar, AlertTriangle, Receipt,
} from "lucide-react";
import AutoEvolutionSettings from "@/components/account/AutoEvolutionSettings";
import AutoGenerateSettings from "@/components/account/AutoGenerateSettings";
import ScheduledTasksSettings from "@/components/account/ScheduledTasksSettings";
import GenerationLanguageSettings from "@/components/account/GenerationLanguageSettings";
import AmbientSourceControlsPanel from "@/components/ambient/AmbientSourceControlsPanel";
import AmbientTimelineSummaryStatusPanel from "@/components/ambient/AmbientTimelineSummaryStatusPanel";
import VoiceIdentitySettings from "@/components/account/VoiceIdentitySettings";
import { isNative } from "@/lib/platform";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useUserSettings } from "@pin-ai/state";
import { cancelCurrentSubscription, createCheckout, getCurrentSubscription, getCustomerPortalUrl, getUsage, listInvoices, listPaymentMethods, reconcileSubscription, type InvoiceEntry, type PaymentMethodEntry, type PlanCode, type SubscriptionState, type UsageInfo } from "@pin-ai/core";
import { PLANS } from "@/components/account/PlanPaymentForm";
import { SubPageHeader, SubscriptionPanel, Text } from "@pin-ai/ui-web";
import SwipeBackLayer from "@/components/app/SwipeBackLayer";

// AmbientModelsPanel pulls in @pin/capacitor-ambient-ai which is
// rollup-external for the web build, so it must be loaded lazily and
// only mounted on native; the web bundle never references the bare
// specifier this way.
const AmbientModelsPanel = lazy(() => import("@/components/ambient/AmbientModelsPanel"));

type SettingsSubPage =
  | "main"
  | "subscription"
  | "preferences"
  | "notifications"
  | "ambient";

export interface AccountPanelProps {
  /** Display name shown on the profile card. Falls back to email prefix. */
  userName?: string;
  /** Single-letter avatar shown in the round chip. Falls back to first initial of userName. */
  avatarLetter?: string;
  /** Email shown on the profile card subtitle. */
  userEmail?: string;
  /** Optional sign-out handler. When provided, replaces the Edit button with Sign out. */
  onSignOut?: () => void;
  /**
   * Reserved for future re-introduction of an account-deletion entry
   * point. The Setting tab now matches the design which has no Danger
   * Zone surface; AppLayout still wires a real handler so we
   * can resurrect the flow under a different surface without API churn.
   */
  onDeleteAccount?: () => Promise<void>;
  /** Controlled current sub-page. Lifted to useAppNavigation so the global
   *  goBack() (left-edge swipe) can pop a sub-page back to "main". */
  subPage: SettingsSubPage;
  /** Setter for the controlled sub-page. */
  onSubPageChange: (p: SettingsSubPage) => void;
}

export default function AccountPanel({
  userName,
  avatarLetter,
  userEmail,
  onSignOut,
  subPage,
  onSubPageChange,
}: AccountPanelProps) {
  const { t } = useTranslation("account");
  const displayName = userName ?? t("panel.accountFallback");
  const initial = (avatarLetter ?? displayName.trim().slice(0, 1) ?? "?").toUpperCase();
  const subtitle = userEmail ?? t("panel.signedIn");
  // subPage is controlled by AppLayout via useAppNavigation so the
  // global goBack() (left-edge swipe) can pop a sub-page back to "main".
  // sessionStorage persistence now lives in the hook.
  const setSubPage = onSubPageChange;

  if (subPage !== "main") {
    // Each sub-page keeps its own ArrowLeft button; SwipeBackLayer adds the
    // iOS-style left-edge drag that also pops back to the settings main page.
    const sub =
      subPage === "subscription" ? <SubscriptionPanel onBack={() => setSubPage("main")} /> :
      subPage === "preferences" ? <PreferencesSubPage onBack={() => setSubPage("main")} /> :
      subPage === "notifications" ? <NotificationsSubPage onBack={() => setSubPage("main")} /> :
      <AmbientSubPage onBack={() => setSubPage("main")} />;
    return (
      <SwipeBackLayer onBack={() => setSubPage("main")} className="h-full">
        {sub}
      </SwipeBackLayer>
    );
  }

  return (
    <div
      className="flex flex-col h-full px-4 pb-2 overflow-y-auto overflow-x-hidden"
      style={{ paddingTop: "var(--constellation-header-top, 3.5rem)" }}
    >
      {/* Header — mirrors MinimalistSetting from the design source. */}
      <h1 className="text-2xl font-semibold text-foreground tracking-tight mb-0.5">{t("panel.title")}</h1>
      <p className="text-xs text-muted-foreground mb-5">{t("panel.subtitle")}</p>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="space-y-3"
      >
        {/* Profile card — kept on the Setting tab (design has no equivalent
            but we need a visible signed-in identity + sign-out entry). */}
        <div className="glass-card-strong p-4 flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-foreground/10 flex items-center justify-center flex-shrink-0">
            <span className="text-base font-semibold text-foreground/70">{initial}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{displayName}</p>
            <Text variant="caption" className="block text-foreground/50 truncate">{subtitle}</Text>
          </div>
          {onSignOut ? (
            <button
              onClick={onSignOut}
              className="text-caption font-medium text-foreground border border-foreground/12 rounded-lg px-3 py-1 hover:bg-foreground/[0.04] transition-colors"
            >
              {t("panel.signOut")}
            </button>
          ) : (
            <button className="text-caption font-medium text-foreground border border-foreground/12 rounded-lg px-3 py-1 hover:bg-foreground/[0.04] transition-colors">
              {t("panel.edit")}
            </button>
          )}
        </div>

        {/* Subscription & Billing — opens the existing plan-selection card
            below as a sub-page (preserves Stripe / billing UI). */}
        <button
          onClick={() => setSubPage("subscription")}
          className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors"
        >
          <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
            <Sparkles size={16} strokeWidth={1.5} className="text-foreground/70" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{t("panel.subscriptionTitle")}</p>
            <Text variant="caption" className="block text-foreground/50 mt-0.5">{t("panel.subscriptionDescription")}</Text>
          </div>
          <Text variant="micro" weight="bold" className="tracking-wider uppercase px-2 py-0.5 rounded-md bg-[hsl(304_75%_63%/0.12)] text-[hsl(304_75%_63%)] shrink-0">
            Pro
          </Text>
          <ChevronRight size={16} strokeWidth={1.5} className="text-foreground/35 shrink-0" />
        </button>

        {/* Preferences — auto-generate / dreaming / language. */}
        <button
          onClick={() => setSubPage("preferences")}
          className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors"
        >
          <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
            <SlidersHorizontal size={16} strokeWidth={1.5} className="text-foreground/70" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{t("panel.preferencesTitle")}</p>
            <Text variant="caption" className="block text-foreground/50 mt-0.5">{t("panel.preferencesDescription")}</Text>
          </div>
          <ChevronRight size={16} strokeWidth={1.5} className="text-foreground/35 shrink-0" />
        </button>

        {/* Push Notifications — OS permission + per-channel toggles. */}
        <button
          onClick={() => setSubPage("notifications")}
          className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors"
        >
          <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
            <Bell size={16} strokeWidth={1.5} className="text-foreground/70" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{t("panel.notificationsTitle")}</p>
            <Text variant="caption" className="block text-foreground/50 mt-0.5">{t("panel.notificationsDescription")}</Text>
          </div>
          <ChevronRight size={16} strokeWidth={1.5} className="text-foreground/35 shrink-0" />
        </button>

        {/* Ambient — on-device perception controls (not in the design's
            MinimalistSetting but preserved here because the underlying
            functionality is real and has no other surface). */}
        <button
          onClick={() => setSubPage("ambient")}
          className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors"
        >
          <div className="w-10 h-10 rounded-xl bg-foreground/[0.06] flex items-center justify-center flex-shrink-0">
            <Radio size={16} strokeWidth={1.5} className="text-foreground/70" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{t("panel.ambientTitle")}</p>
            <Text variant="caption" className="block text-foreground/50 mt-0.5">{t("panel.ambientDescription")}</Text>
          </div>
          <ChevronRight size={16} strokeWidth={1.5} className="text-foreground/35 shrink-0" />
        </button>
      </motion.div>
    </div>
  );
}

/* ── Preferences sub-page ──────────────────────────────────────────── */

function PreferencesSubPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation("account");
  return (
    <div
      className="flex flex-col h-full px-4 pb-2 overflow-y-auto overflow-x-hidden"
      style={{ paddingTop: "var(--constellation-header-top, 3.5rem)" }}
    >
      <SubPageHeader
        title={t("preferences.pageTitle")}
        subtitle={t("preferences.pageSubtitle")}
        onBack={onBack}
      />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="space-y-3"
      >
        <section className="glass-card-strong p-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">{t("preferences.evolutionTitle")}</h2>
            <Text variant="caption" className="block text-foreground/42 mt-1">
              {t("preferences.evolutionDescription")}
            </Text>
          </div>
          <AutoEvolutionSettings />
        </section>

        <section className="glass-card-strong p-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">{t("preferences.generationTitle")}</h2>
            <Text variant="caption" className="block text-foreground/42 mt-1">
              {t("preferences.generationDescription")}
            </Text>
          </div>
          <AutoGenerateSettings />
          <GenerationLanguageSettings />
        </section>

        <section className="glass-card-strong p-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">{t("preferences.scheduledTasksTitle")}</h2>
            <Text variant="caption" className="block text-foreground/42 mt-1">
              {t("preferences.scheduledTasksDescription")}
            </Text>
          </div>
          <ScheduledTasksSettings />
        </section>
      </motion.div>
    </div>
  );
}

/* ── Push Notifications sub-page ───────────────────────────────────── */

/**
 * Push Notifications sub-page — system permission is a capability,
 * `notifyNewCards` is the product-level preference.
 *
 * Web has no Capacitor push runtime, so on web the toggle is rendered
 * disabled with the design layout intact — keeps the sub-page non-empty
 * for dev previews without faking a granted state.
 */
function NotificationsSubPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation("account");
  const push = usePushNotifications();
  const userSettings = useUserSettings();
  const unsupported = push.permissionState === "unsupported";
  const granted = push.permissionState === "granted";
  const denied = push.permissionState === "denied";
  const promptable = push.permissionState === "prompt"
    || push.permissionState === "prompt-with-rationale";
  const notifyNewCards = userSettings.settings?.notifyNewCards ?? false;
  const isOn = granted && notifyNewCards;
  const busy = !push.ready || userSettings.loading || userSettings.saving;

  const handleToggle = async () => {
    if (unsupported || busy) return;

    if (!granted) {
      if (promptable) {
        const nextPermission = await push.requestPermission();
        if (nextPermission === "granted") {
          void userSettings.patch({ notifyNewCards: true });
        }
        return;
      }
      // Once iOS notification permission is denied/disabled, only the
      // system Settings app can re-enable it.
      window.location.href = "app-settings:";
      return;
    }

    if (!userSettings.settings) return;
    void userSettings.patch({ notifyNewCards: !notifyNewCards });
  };

  return (
    <div
      className="flex flex-col h-full px-4 pb-2 overflow-y-auto overflow-x-hidden"
      style={{ paddingTop: "var(--constellation-header-top, 3.5rem)" }}
    >
      <SubPageHeader
        title={t("notifications.pageTitle")}
        subtitle={t("notifications.pageSubtitle")}
        onBack={onBack}
      />

      <div className="space-y-3">
        <button
          type="button"
          onClick={handleToggle}
          aria-pressed={isOn}
          disabled={unsupported || busy}
          className="glass-card-strong w-full p-4 flex items-center gap-3 text-left hover:bg-white/20 transition-colors disabled:hover:bg-transparent disabled:cursor-default"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{t("notifications.cardGeneration")}</p>
            <Text variant="caption" className="block text-foreground/50 mt-0.5">
              {unsupported
                ? t("notifications.iosOnly")
                : denied
                  ? t("notifications.deniedHint")
                  : isOn
                    ? t("notifications.onHint")
                    : granted
                      ? t("notifications.pausedHint")
                      : t("notifications.enableHint")}
            </Text>
          </div>
          <span
            className={`relative w-10 h-6 rounded-full shrink-0 transition-colors ${
              isOn ? "bg-foreground" : "bg-foreground/20"
            }`}
            role="presentation"
          >
            <motion.span
              layout
              transition={{ type: "tween", duration: 0.2, ease: "easeInOut" }}
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-background shadow-sm ${
                isOn ? "left-[18px]" : "left-0.5"
              }`}
            />
          </span>
        </button>
      </div>
    </div>
  );
}

/* ── Ambient sub-page ──────────────────────────────────────────────── */

/**
 * Ambient sub-page — three real ambient-perception controls relocated
 * from the now-removed Control tab:
 *
 *   1. Source consent toggles (mic / location / motion / health / network …)
 *      → wired to pai_user_settings.ambient_source_consent via useUserSettings.
 *   2. Timeline summary status — live state of today's local LLM
 *      summarization pipeline (pending / summarized / failed windows).
 *   3. On-device models — Whisper.cpp / llama.cpp profile manager via the
 *      @pin/capacitor-ambient-ai native plugin. Native-only; web shows a
 *      "available only in iOS app" placeholder.
 */
function AmbientSubPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation("account");
  return (
    <div
      className="flex flex-col h-full px-4 pb-2 overflow-y-auto overflow-x-hidden"
      style={{ paddingTop: "var(--constellation-header-top, 3.5rem)" }}
    >
      <SubPageHeader
        title={t("ambientPage.pageTitle")}
        subtitle={t("ambientPage.pageSubtitle")}
        onBack={onBack}
      />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="space-y-3"
      >
        <AmbientSourceControlsPanel />

        <VoiceIdentitySettings />

        <AmbientTimelineSummaryStatusPanel />

        <section className="glass-card-strong p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t("ambientPage.modelsTitle")}</h2>
            <Text variant="caption" className="block text-foreground/42 mt-1 leading-relaxed">
              {t("ambientPage.modelsDescription")}
            </Text>
          </div>

          {isNative ? (
            <Suspense
              fallback={
                <Text variant="caption" className="block rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4 text-foreground/45">
                  {t("ambientPage.loadingManifest")}
                </Text>
              }
            >
              <AmbientModelsPanel />
            </Suspense>
          ) : (
            <Text variant="label" className="block rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4 text-foreground/60 leading-relaxed">
              {t("ambientPage.iosOnlyModels")}
            </Text>
          )}

          <Text variant="caption" className="block text-foreground/45 leading-snug">
            {t("ambientPage.localStorageNote")}
          </Text>
        </section>
      </motion.div>
    </div>
  );
}
