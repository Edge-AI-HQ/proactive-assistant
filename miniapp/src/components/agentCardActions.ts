export const decideDataConnectorsAction = (
  isRuntimeRunning: boolean,
): "open" | "blocked" => {
  return isRuntimeRunning ? "open" : "blocked";
};
