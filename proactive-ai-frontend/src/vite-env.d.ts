/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Supabase auth + Postgres REST. Both required.
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;

  // backend backend.
  // Native (Capacitor) bundle: absolute cloud URL, required.
  // Web bundle: ignored — same-origin fetches are reverse-proxied
  // through nginx in production / Vite dev server in development.
  readonly VITE_PIN_API_URL?: string;

  // Vite dev server only: where `/api/*` proxies to during `npm run dev`.
  // See vite.config.ts. Defaults to http://127.0.0.1:8000 when unset.
  readonly VITE_PIN_API_PROXY_TARGET?: string;

  // Local Hot mode only: bypass Supabase OAuth with X-Dev-Auth.
  readonly VITE_PIN_LOCAL_DEV_AUTH?: string;

  // Native (Capacitor) bundle: OAuth deep-link scheme = this build's bundle
  // id (prod `ai.pin.proactive`, dev `ai.pin.proactive.development`). Injected at
  // build time so dev/prod apps coexist on one device without OAuth callback
  // collision. Web bundle: unused (web redirects to same-origin).
  readonly VITE_OAUTH_SCHEME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
