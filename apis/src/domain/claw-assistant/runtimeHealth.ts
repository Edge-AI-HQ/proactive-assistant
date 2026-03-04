export const isAssistantRuntimeHealthy = (
  containerStatus: string | null | undefined,
): boolean => {
  return String(containerStatus || "").trim().toLowerCase() === "running";
};

export const shouldEnsureAssistantRuntime = (
  containerStatus: string | null | undefined,
): boolean => {
  return !isAssistantRuntimeHealthy(containerStatus);
};
