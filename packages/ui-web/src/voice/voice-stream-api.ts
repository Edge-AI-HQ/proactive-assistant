import { authHeaders } from "../auth/transport-bootstrap";
import { PIN_API_BASE } from "../auth/platform";

export interface BuildVoiceStreamUrlOptions {
  language?: string;
}

export type VoiceStreamAuthMessage =
  | { type: "auth"; token: string }
  | { type: "auth"; dev_auth: string }
  | { type: "auth" };

export async function buildVoiceStreamUrl(
  options: BuildVoiceStreamUrlOptions = {},
): Promise<string> {
  const base = PIN_API_BASE || window.location.origin;
  const url = new URL("/api/voice/transcribe-stream", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const language = options.language?.trim();
  if (language) url.searchParams.set("language", language);

  return url.toString();
}

export async function buildVoiceStreamAuthMessage(): Promise<VoiceStreamAuthMessage> {
  const headers = await authHeaders();
  const authorization = headers.Authorization;
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return { type: "auth", token: authorization.slice("Bearer ".length) };
  }
  const devAuth = headers["X-Dev-Auth"];
  if (devAuth) return { type: "auth", dev_auth: devAuth };

  return { type: "auth" };
}
