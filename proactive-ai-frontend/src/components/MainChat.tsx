import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { proxyPost } from "@/lib/api";
import MainChatView from "./main-chat/MainChatView";

interface MainChatProps {
  onBack: () => void;
}

// Per-user main-thread session_key cache. Keyed by Supabase user id so a
// different account on the same browser never inherits the previous user's
// LangGraph thread. Backend mints `main-<internal_user_id>-<uuid12>` when we
// post an empty body to /chat-stream/init; we persist that and reuse it on
// subsequent mounts so the user resumes their own conversation.
const STORAGE_PREFIX = "pinai:main-session:";

export default function MainChat({ onBack }: MainChatProps) {
  const { user } = useAuth();
  const [sessionKey, setSessionKey] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    const storageKey = STORAGE_PREFIX + user.id;
    const cached = localStorage.getItem(storageKey);
    if (cached) {
      setSessionKey(cached);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await proxyPost("/chat-stream/init", {});
        if (!res.ok) return;
        const data = (await res.json()) as { sessionKey?: string };
        if (cancelled || !data.sessionKey) return;
        localStorage.setItem(storageKey, data.sessionKey);
        setSessionKey(data.sessionKey);
      } catch {
        // Transient network failure — closing and reopening retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  if (!sessionKey) return null;
  return <MainChatView sessionKey={sessionKey} title="Chat" onBack={onBack} />;
}
