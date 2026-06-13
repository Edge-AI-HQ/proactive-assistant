import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { useAuth, VoiceProvider } from "@pin-ai/ui-web";
import ZebraShell from "@/components/zebra/ZebraShell";
import ZebraLogin from "@/components/zebra/ZebraLogin";

/**
 * apps/web 顶层路由（URL 路由，桌面 deep-link 约定）：
 *   loading → spinner
 *   no user → /login（Supabase Google OAuth）
 *   user    → ZebraShell（layout route 常驻；子路由 element={null}，Shell
 *             内部按 pathname 渲染主视图，conversation 是 overlay）
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

export default function App() {
  const { loading, user } = useAuth();

  return (
    <>
      {/* ConversationView 的语音输入（useVoiceInput）需要 VoiceProvider。
          转写语言 M4 接 settings 后传 generationLanguage。 */}
      <VoiceProvider transcriptionLanguage={null}>
      <BrowserRouter>
        {loading ? (
          <Spinner />
        ) : (
          <Routes>
            {user ? (
              <>
                <Route element={<ZebraShell />}>
                  <Route path="/now" element={null} />
                  <Route path="/ambient" element={null} />
                  <Route path="/tasks" element={null} />
                  <Route path="/connect" element={null} />
                  <Route path="/mirror" element={null} />
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
