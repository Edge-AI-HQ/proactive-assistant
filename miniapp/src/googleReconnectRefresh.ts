type ReconnectRefreshInput = {
  eventType: "visibilitychange" | "focus" | "pageshow";
  visibilityState: DocumentVisibilityState;
  loading: boolean;
  hasState: boolean;
  busy: string;
};

export const shouldRefreshAfterExternalOAuthReturn = (
  input: ReconnectRefreshInput,
): boolean => {
  if (input.loading) return false;
  if (!input.hasState) return false;
  if (input.eventType === "visibilitychange" && input.visibilityState !== "visible") {
    return false;
  }
  // Avoid refresh races while connect/disconnect requests are in-flight.
  if (input.busy === "google-connect" || input.busy === "google-disconnect") {
    return false;
  }
  return true;
};
