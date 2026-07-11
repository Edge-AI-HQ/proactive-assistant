import { useState } from "react";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useAuth, Text, initialOAuthError } from "@/ui-web";
import ZebraBackdrop from "./ZebraBackdrop";

const EASE = [0.32, 0.72, 0, 1] as const;

/**
 * Desktop (zebra) login — reduced to the absolute minimum: the ambient
 * nebula backdrop carries the entire atmosphere, and a single dark Google
 * button is the only element on screen. Sign-in is the real Supabase Google
 * OAuth web flow (redirect; detectSessionInUrl resolves the session when the
 * provider sends us back, and App's auth gate switches to the shell).
 */
export default function ZebraLogin() {
  const { signInWithGoogle } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  // OAuth web 回调失败时由 supabase.ts 在整页加载时抓到（见 initialOAuthError）。
  const [authError, setAuthError] = useState(initialOAuthError);

  const handleGoogle = async () => {
    if (signingIn) return;
    setAuthError(null);
    setSigningIn(true);
    try {
      // Web flow redirects the whole page to the provider; the spinner only
      // shows for the instant before navigation (and stays on failure reset).
      await signInWithGoogle();
    } catch (err) {
      console.error("[auth] Google sign-in failed:", err);
      setSigningIn(false);
    }
  };

  return (
    <div className="relative h-screen w-full overflow-hidden">
      <ZebraBackdrop />

      {/* Centered sign-in */}
      <div className="relative z-10 h-full flex flex-col items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15, ease: EASE }}
          className="w-full max-w-[360px]"
        >
          {authError && (
            <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-center">
              <Text variant="bodySm" className="text-red-600">
                Couldn't sign you in. {authError}
              </Text>
            </div>
          )}
          <button
            onClick={handleGoogle}
            disabled={signingIn}
            className="w-full flex items-center justify-center gap-3 px-5 py-3.5 rounded-2xl bg-foreground text-background transition-all hover:bg-foreground/85 hover:shadow-xl disabled:cursor-default"
            style={{ boxShadow: "0 8px 32px hsl(0 0% 0% / 0.18)" }}
          >
            {signingIn ? (
              <>
                <Loader2 size={18} className="animate-spin text-background/70" />
                <Text variant="body" weight="medium" className="text-background/80">Signing in…</Text>
              </>
            ) : (
              <>
                <span className="w-[18px] h-[18px] shrink-0">
                  <GoogleG />
                </span>
                <Text variant="body" weight="medium" className="text-background">Continue with Google</Text>
              </>
            )}
          </button>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.35, ease: EASE }}
          className="mt-7 text-caption text-foreground/40 text-center leading-relaxed"
        >
          By continuing, you agree to PIN AI's{" "}
          <a
            href="https://www.pinai.io/terms"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground/60 transition-colors"
          >
            Terms
          </a>
          {" "}and{" "}
          <a
            href="https://www.pinai.io/privacy"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground/60 transition-colors"
          >
            Privacy Policy
          </a>.
        </motion.p>
      </div>
    </div>
  );
}

function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" className="w-full h-full">
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
