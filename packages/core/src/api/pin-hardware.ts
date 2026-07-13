import { readErrorMessage } from "../transport/errors";
import { proxyPost } from "../transport/http";

export interface PinHardwareAsrToken {
  url: string;
  voiceId: string;
  expiresAt: number;
  engineModelType: string;
  voiceFormat: string;
  sampleRateHz: number;
}

/** Server declines because Tencent ASR credentials are unset in this env. */
export class PinHardwareAsrNotConfiguredError extends Error {
  constructor(message = "PIN hardware ASR is not configured on the server") {
    super(message);
    this.name = "PinHardwareAsrNotConfiguredError";
  }
}

interface RawTencentMintResponse {
  url: string;
  voice_id: string;
  expires_at: number;
  engine_model_type: string;
  voice_format: string;
  sample_rate_hz: number;
}

/**
 * Fetch a short-lived signed WSS URL for Tencent Real-Time ASR from the
 * PIN AI api (`POST /api/voice/hardware/tencent-token`). The iOS
 * PinHardware plugin opens the websocket directly to Tencent using this
 * URL; the SecretKey never reaches the client.
 *
 * Throws `PinHardwareAsrNotConfiguredError` only when the server says so
 * (503 + detail marker) so callers can fall back to phone-mic capture.
 * A bare 503 also comes from the Fly edge during deploys — that must NOT
 * be treated as "not configured": the caller reacts by silently flipping
 * user consent, which should never happen on a transient outage.
 */
export async function mintPinHardwareAsrToken(): Promise<PinHardwareAsrToken> {
  const res = await proxyPost("/voice/hardware/tencent-token", {});
  if (res.status === 503) {
    const detail = await res
      .clone()
      .json()
      .then((body: { detail?: string }) => body?.detail)
      .catch(() => undefined);
    if (detail === "pin_hardware_asr_not_configured") {
      throw new PinHardwareAsrNotConfiguredError();
    }
  }
  if (!res.ok) {
    throw new Error(`pin_hardware_asr_mint_failed: ${await readErrorMessage(res)}`);
  }
  const json = (await res.json()) as RawTencentMintResponse;
  return {
    url: json.url,
    voiceId: json.voice_id,
    expiresAt: json.expires_at,
    engineModelType: json.engine_model_type,
    voiceFormat: json.voice_format,
    sampleRateHz: json.sample_rate_hz,
  };
}
