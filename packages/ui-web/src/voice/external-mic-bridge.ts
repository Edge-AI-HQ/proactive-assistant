/**
 * Ambient 外部麦克风协调的注入点。voice 录音与 native ambient 采集共享
 * 一只麦克风：native 端在录音前要 lease（暂停 ambient 采集），录完释放。
 *
 * proactive-ai-frontend 在 main.tsx 注册 services/ambient/external-mic 的
 * acquireExternalMic（保持原 dynamic import，web bundle 不带 native 代码）；
 * apps/web 无 ambient 采集，不注册 → 直通 no-op lease。
 */
export interface ExternalMicLease {
  release: () => void | Promise<void>;
}

type Acquirer = () => Promise<ExternalMicLease>;

let acquirer: Acquirer | null = null;

export function registerExternalMicAcquirer(fn: Acquirer): void {
  acquirer = fn;
}

export async function acquireExternalMic(): Promise<ExternalMicLease> {
  if (acquirer) return acquirer();
  return { release: () => {} };
}
