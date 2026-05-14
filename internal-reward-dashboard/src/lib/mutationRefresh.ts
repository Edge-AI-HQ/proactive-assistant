export const staleMutationRefreshMessage = "页面已发起新的刷新，请以最新数据为准。";

export function staleMutationRefreshError(): Error {
  return new Error(staleMutationRefreshMessage);
}
