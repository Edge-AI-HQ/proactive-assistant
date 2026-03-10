export type ProvisionNotifyState = "ready" | "starting" | "failed";

export type ProvisionNotifyResult = {
  assistantId: number;
  label: string;
  state: ProvisionNotifyState;
};

const mapContainerStatusToNotifyState = (
  containerStatus: string | null | undefined,
): ProvisionNotifyState => {
  const normalized = (containerStatus || "").trim().toLowerCase();
  if (normalized === "running") return "ready";
  if (normalized === "creating") return "starting";
  return "failed";
};

export const reconcileProvisionResultsForNotification = (
  results: ProvisionNotifyResult[],
  latestStatuses: Map<number, string>,
): ProvisionNotifyResult[] => {
  return results.map((result) => {
    if (result.state !== "failed") return result;
    const latestStatus = latestStatuses.get(result.assistantId);
    if (!latestStatus) return result;
    return {
      ...result,
      state: mapContainerStatusToNotifyState(latestStatus),
    };
  });
};
