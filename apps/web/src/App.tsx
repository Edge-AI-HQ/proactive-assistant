import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { useUserSettings } from "@pin-ai/state";
import { useAuth, VoiceProvider, Text, useUiLanguageSync } from "@pin-ai/ui-web";
import ZebraShell from "@/components/zebra/ZebraShell";
import ZebraLogin from "@/components/zebra/ZebraLogin";
import ZebraOnboarding from "@/components/zebra/ZebraOnboarding";
import DesktopTitleBar from "@/components/DesktopTitleBar";

// dev-only 设计系统 Gallery（S3 验证基座）。仅 DEV 下 lazy 挂载，prod bundle
// 经 import.meta.env.DEV 静态求值 tree-shake 掉。路由见下方 /dev/gallery。
const Gallery = import.meta.env.DEV ? lazy(() => import("@/dev/Gallery")) : null;

/**
 * apps/web 顶层路由（URL 路由，桌面 deep-link 约定）：
 *   loading        → spinner
 *   no user        → /login（Supabase Google OAuth）
 *   user, settings bootstrap：
 *     loading      → spinner
 *     failed       → retry 屏
 *     onboarding   → ZebraOnboarding（首次登录连数据源）
 *     done         → ZebraShell（layout route 常驻；子路由 element={null}，
 *                    Shell 内部按 pathname 渲染主视图，conversation 是 overlay）
 */
function Spinner() {
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      <div className="absolute inset-0 animate-bg-flow opacity-60" />
      <div className="absolute inset-0 bg-white/20" />
      <div className="relative z-10 h-8 w-8 animate-spin rounded-full border-2 border-foreground/15 border-t-primary" />
    </div>
  );
}

// Shown when the settings bootstrap fails after its retries — gate the whole
// authed UI rather than flashing the shell. Retry re-issues the fetch in place.
function BootstrapError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden px-6">
      <div className="absolute inset-0 animate-bg-flow opacity-60" />
      <div className="absolute inset-0 bg-white/20" />
      <div className="glass-card-strong relative z-10 w-full max-w-sm p-8 text-center">
        <Text variant="bodySm" className="block text-foreground/80">
          Couldn't reach the server. Check your connection and try again.
        </Text>
        <button
          onClick={onRetry}
          className="mt-5 w-full rounded-2xl bg-foreground px-4 py-3 text-bodySm font-semibold text-background transition-opacity hover:opacity-90"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { loading, user } = useAuth();
  // settings gate 整个已登录 UI（onboarding 判定来自它）。未登录时 user 为
  // null，useUserSettings(null) 不发请求。
  const {
    settings,
    loading: settingsLoading,
    patch: patchSettings,
    refetch: refetchSettings,
  } = useUserSettings(user?.id ?? null);
  // UI 语言跟随 settings.generationLanguage（与 mobile 同款共享 hook）。
  useUiLanguageSync();

  // 已登录后的 onboarding 三态 gate（与 proactive-ai-frontend App.tsx 对齐）：
  // 加载中 spinner / 失败可重试 / 未完成 onboarding 进引导页；都不命中就落到
  // 下方 Routes（shell）。dev /dev/gallery 在未登录或已完成 onboarding 时仍可达。
  let authedGate: ReactNode = null;
  if (user) {
    if (settingsLoading) {
      authedGate = <Spinner />;
    } else if (settings === null) {
      authedGate = <BootstrapError onRetry={() => void refetchSettings()} />;
    } else if (!settings.onboardingCompletedAt) {
      authedGate = (
        <ZebraOnboarding
          onComplete={async () => {
            const next = await patchSettings({ onboardingCompleted: true });
            if (next === null) {
              throw new Error(
                "Couldn't save your onboarding progress. Check your connection and try again.",
              );
            }
          }}
        />
      );
    }
  }

  return (
    <>
      {/* Electron 桌面壳的隐藏拖拽标题栏(web 下不渲染)。顶层 overlay,
          login / shell 两态都覆盖。 */}
      <DesktopTitleBar />
      {/* ConversationView 的语音输入（useVoiceInput）需要 VoiceProvider。
          转写语言 M4 接 settings 后传 generationLanguage。 */}
      <VoiceProvider transcriptionLanguage={null}>
      <BrowserRouter>
        {loading ? (
          <Spinner />
        ) : authedGate ? (
          authedGate
        ) : (
          <Routes>
            {Gallery && (
              <Route
                path="/dev/gallery"
                element={
                  <Suspense fallback={null}>
                    <Gallery />
                  </Suspense>
                }
              />
            )}
            {user ? (
              <>
                <Route element={<ZebraShell />}>
                  <Route path="/now" element={null} />
                  <Route path="/ambient" element={null} />
                  <Route path="/tasks" element={null} />
                  <Route path="/connect" element={null} />
                  <Route path="/mirror" element={null} />
                  <Route path="/events" element={null} />
                  <Route path="/setting" element={null} />
                  <Route path="/subscription" element={null} />
                  <Route path="/notifications" element={null} />
                  <Route path="/preferences" element={null} />
                  <Route path="/conversation" element={null} />
                </Route>
                <Route path="*" element={<Navigate to="/now" replace />} />
              </>
            ) : (
              <>
                <Route path="/login" element={<ZebraLogin />} />
                <Route path="*" element={<Navigate to="/login" replace />} />
              </>
            )}
          </Routes>
        )}
      </BrowserRouter>
      </VoiceProvider>
      <Toaster position="bottom-right" />
    </>
  );
}
