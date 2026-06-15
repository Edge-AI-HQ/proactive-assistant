/**
 * Ambient 外部麦克风协调的注入点。voice 录音与 native ambient 采集共享一只麦克风:
 * native 端录音前 lease(暂停 ambient 采集),录完释放。各 app composition root 注册;
 * 无 ambient 采集的 app(apps/web)不注册 → 直通 no-op lease。平台无关。
 */
export interface ExternalMicLease {
  release: () => void | Promise<void>;
}

export type ExternalMicAcquirer = () => Promise<ExternalMicLease>;

let acquirer: ExternalMicAcquirer | null = null;

export function registerExternalMicAcquirer(fn: ExternalMicAcquirer): void {
  acquirer = fn;
}

export async function acquireExternalMic(): Promise<ExternalMicLease> {
  if (acquirer) return acquirer();
  return { release: () => {} };
}
