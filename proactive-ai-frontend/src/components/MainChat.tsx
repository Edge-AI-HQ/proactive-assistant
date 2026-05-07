import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { proxyPost } from "@/lib/api";
import MainChatView from "./main-chat/MainChatView";

interface MainChatProps {
  onBack: () => void;
}

// Per-user main-thread session_key cache. Backend (pai_chat_threads)
// is the source of truth — localStorage is only a perf optimization
// to skip the round-trip when the user reopens Main Chat in the same
// browser. If the cache is missing or stale (cleared / new device /
// incognito), backend looks up the user's most-recent main thread
// from pai_chat_threads and returns it, so history is never orphaned.
const STORAGE_PREFIX = "pinai:main-session:";

export default function MainChat({ onBack }: MainChatProps) {
  const { user } = useAuth();
  const [sessionKey, setSessionKey] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    const storageKey = STORAGE_PREFIX + user.id;
    let cancelled = false;

    void (async () => {
      // Always hit /init — sending the cached sessionKey if we have one
      // lets the backend validate it (RLS-scoped) and bring the metadata
      // row up to date. If we don't have one, backend either returns the
      // user's existing latest main thread or mints a fresh one. Either
      // way the response is the canonical sessionKey.
      const cached = localStorage.getItem(storageKey);
      try {
        const res = await proxyPost(
          "/chat-stream/init",
          cached ? { sessionKey: cached } : {},
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { sessionKey?: string };
        if (!data.sessionKey) return;
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
