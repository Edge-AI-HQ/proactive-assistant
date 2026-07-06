/**
 * Consent → 采集源实时调和 —— dev App.tsx:77-133 boot/settings 效应的 RN hook 版。
 *
 * 订阅共享 /settings TQ cache（useUserSettings 无参实例只读缓存），server
 * per-source consent（ambientSources）变化时把正在跑的源集合调和到 consent
 * 真集："which sources start follows the server consent, not all of them"。
 * enabledKey 签名与 dev 逐字一致：
 *  - settings 未加载（null）→ 不动；
 *  - 本机 opt-in 闸未开 → ""（空集也要触发，用户全关后 runtime 停掉在跑的源）；
 *  - 否则 = 已开 consent 源键排序串。
 * 本机闸和 dev 一样**非响应式**读取（dev memo 里同步读 localStorage、依赖只挂
 * ambientSources）——闸翻转本身不触发 reconcile（那是 useAmbientToggle /
 * resumeAmbientIfEnabled 的职责），否则 toggle 乐观置闸会和旧 consent 打架。
 * 同时把 settings.generationLanguage 喂给转写语言 hint（= dev 同一 effect）。
 *
 * Wiring：挂在 AppShell（登录后常驻树）——
 *   useAmbientConsentReconcile(user.id);
 * 60s watchdog / AppState 前台恢复由 runtime 内部兜底，这个 hook 只负责
 * 「settings 变化 → 实时 reconcile」。
 */
import { useEffect, useMemo } from "react";
import { useUserSettings } from "@pin-ai/state";

import {
  currentGateEpoch,
  getAmbientEnabledSnapshot,
  isAmbientEnabled,
  reconcileEnabledSources,
  setAmbientTranscriptionLanguage,
} from "../ambient/runtime";

export function useAmbientConsentReconcile(userId: string | null): void {
  const { settings } = useUserSettings();

  // 首次挂载把 AsyncStorage 闸读进共享镜像（幂等，与 useAmbientToggle 同款）。
  useEffect(() => {
    void isAmbientEnabled();
  }, []);

  // 稳定 key 签名（dev App.tsx enabledKey memo）：无关 settings 变化不触发
  // reconcile；null = settings（或本机闸）还没就绪，"" = 闸关/consent 全关。
  const enabledKey: string | null = useMemo(() => {
    if (!settings) return null;
    const deviceEnabled = getAmbientEnabledSnapshot();
    if (deviceEnabled === null) return null; // AsyncStorage 还没读到，先不动
    if (!deviceEnabled) return "";
    return Object.entries(settings.ambientSources ?? {})
      .filter(([, v]) => v?.enabled === true)
      .map(([k]) => k)
      .sort()
      .join(",");
  }, [settings?.ambientSources]);

  const generationLanguage = settings?.generationLanguage ?? null;

  useEffect(() => {
    if (!userId || enabledKey === null) return;
    setAmbientTranscriptionLanguage(generationLanguage);
    // 读闸与下发在同一同步段 + 携带关闸代际：memo 里的闸值可能是 render 时的旧读数
    // （关闸后 ms 级窗口），effect 时重读最新镜像;之后再关闸则由代际让 reconcile
    // 整体作废——两层合起来关死「显示关但在采」的复活竞态（2026-07-05 审查 F1）。
    const gateEpoch = currentGateEpoch();
    const gateOpen = getAmbientEnabledSnapshot() === true;
    const keys = gateOpen && enabledKey ? enabledKey.split(",") : [];
    void reconcileEnabledSources(userId, keys, { interactivePermissions: false, gateEpoch });
  }, [userId, enabledKey, generationLanguage]);
}
