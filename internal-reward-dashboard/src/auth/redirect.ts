const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
const DEFAULT_LOCAL_PORT = "3004";

function normalizeRedirectRoot(origin: string): string {
  return origin.endsWith("/") ? origin : `${origin}/`;
}

export function oauthRedirectOriginFromHref(href: string): string {
  const url = new URL(href);
  if (LOCAL_HOSTS.has(url.hostname)) {
    return normalizeRedirectRoot(`http://localhost:${url.port || DEFAULT_LOCAL_PORT}`);
  }
  return normalizeRedirectRoot(url.origin);
}

export function oauthRedirectTo(): string {
  return oauthRedirectOriginFromHref(window.location.href);
}
