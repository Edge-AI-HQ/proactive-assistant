import { useState } from "react";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Text } from "@pin-ai/ui-web";
import LoginBackdrop from "./LoginBackdrop";

const EASE = [0.32, 0.72, 0, 1] as const;

interface LoginPageProps {
  /** Supabase Google OAuth（web redirect / native PKCE），由 App.tsx 注入。 */
  onSignIn: () => void | Promise<void>;
}

/**
 * Login — 与 apps/web 的 ZebraLogin 视觉统一的极简款：nebula backdrop 承载
 * 全部氛围，中央一个深色 Google 按钮，底部 Terms/Privacy。去掉了旧版的玻璃
 * 卡片与 "PIN AI" 标题。signingIn 只在点击到导航/回调之间短暂显示 spinner
 * （web redirect 时整页跳走；失败时复位）。
 */
export default function LoginPage({ onSignIn }: LoginPageProps) {
  const { t } = useTranslation("auth");
  const [signingIn, setSigningIn] = useState(false);

  const handleGoogle = async () => {
    if (signingIn) return;
    setSigningIn(true);
    try {
      await onSignIn();
    } catch (err) {
      console.error("[auth] Google sign-in failed:", err);
      setSigningIn(false);
    }
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      <LoginBackdrop />

      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15, ease: EASE }}
          className="w-full max-w-[360px]"
        >
          <button
            onClick={handleGoogle}
            disabled={signingIn}
            className="flex w-full items-center justify-center gap-3 rounded-2xl bg-foreground px-5 py-3.5 text-background transition-all hover:bg-foreground/85 hover:shadow-xl disabled:cursor-default"
            style={{ boxShadow: "0 8px 32px hsl(0 0% 0% / 0.18)" }}
          >
            {signingIn ? (
              <>
                <Loader2 size={18} className="animate-spin text-background/70" />
                <Text variant="body" weight="medium" className="text-background/80">
                  {t("login.signingIn")}
                </Text>
              </>
            ) : (
              <>
                <span className="h-[18px] w-[18px] shrink-0">
                  <GoogleG />
                </span>
                <Text variant="body" weight="medium" className="text-background">
                  Continue with Google
                </Text>
              </>
            )}
          </button>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.35, ease: EASE }}
          className="mt-7 text-center text-caption leading-relaxed text-foreground/40"
        >
          <Trans
            t={t}
            i18nKey="legal.agreement"
            components={{
              terms: (
                <a
                  href="https://www.pinai.io/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 transition-colors hover:text-foreground/60"
                />
              ),
              privacy: (
                <a
                  href="https://www.pinai.io/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 transition-colors hover:text-foreground/60"
                />
              ),
            }}
          />
        </motion.p>
      </div>
    </div>
  );
}

function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" className="h-full w-full">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
