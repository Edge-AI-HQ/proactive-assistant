export type ContainerProvisionState = "ready" | "starting" | "failed";

export interface ContainerProvisionResult {
  label: string;
  state: ContainerProvisionState;
}

export interface ContainerProvisionSummary {
  ready: string[];
  starting: string[];
  failed: string[];
}

export const summarizeContainerProvisionResults = (
  results: ContainerProvisionResult[],
): ContainerProvisionSummary => {
  const summary: ContainerProvisionSummary = {
    ready: [],
    starting: [],
    failed: [],
  };

  for (const result of results) {
    if (result.state === "ready") {
      summary.ready.push(result.label);
      continue;
    }
    if (result.state === "starting") {
      summary.starting.push(result.label);
      continue;
    }
    summary.failed.push(result.label);
  }

  return summary;
};

