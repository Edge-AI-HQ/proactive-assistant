/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Supabase auth + Postgres REST. Both required.
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;

  // pinai-agents backend.
  // Native (Capacitor) bundle: absolute cloud URL, required.
  // Web bundle: ignored — same-origin fetches are reverse-proxied
  // through nginx in production / Vite dev server in development.
  readonly VITE_PIN_API_URL?: string;

  // Vite dev server only: where `/api/*` proxies to during `npm run dev`.
  // See vite.config.ts. Defaults to http://127.0.0.1:8000 when unset.
  readonly VITE_PIN_API_PROXY_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
