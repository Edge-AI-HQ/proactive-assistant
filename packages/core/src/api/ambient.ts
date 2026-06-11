import { readErrorMessage } from "../transport/errors";
import { proxyPost } from "../transport/http";

export interface AmbientCloudSummaryDraft {
  title: string;
  summary: string;
  tags: string[];
  confidence: number;
  confidenceLabel: "certain" | "uncertain";
}

export interface AmbientCloudSummaryResponse {
  ok: true;
  draft: AmbientCloudSummaryDraft;
  modelId: string;
}

export async function summarizeAmbientWithCloud(
  context: unknown,
  signal?: AbortSignal,
): Promise<AmbientCloudSummaryResponse> {
  const res = await proxyPost("/ambient/summary", { context }, signal);
  if (!res.ok) throw new Error(`/ambient/summary failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as Partial<AmbientCloudSummaryResponse>;
  if (!data.ok || !data.draft || typeof data.modelId !== "string") {
    throw new Error("/ambient/summary returned invalid response");
  }
  return data as AmbientCloudSummaryResponse;
}
