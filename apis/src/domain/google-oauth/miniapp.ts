export type MiniGoogleReturnState =
  | { status: "connected" }
  | { status: "disconnected" }
  | { status: "error"; error: string };

export const buildMiniGoogleReturnUrl = (
  pathname: string,
  state: MiniGoogleReturnState,
): string => {
  const params = new URLSearchParams();
  params.set("google", state.status);
  params.set("manage", "1");
  if (state.status === "error") {
    params.set("reason", state.error);
  }
  return `${pathname}?${params.toString()}`;
};
