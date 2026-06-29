/**
 * Ambient 主开关（RN）：单一真源，Ambient tab 与 NOW 视图共用——从任一处
 * 翻转都同步（态走 useUserSettings 的共享 TQ cache，不存各自的 React
 * state，否则两个开关会 desync）。
 *
 * 与 web useAmbientToggle 同语义，但桥到 RN 自己的「手」：
 *  - consent（server）：patch /api/settings.ambientSources 全部源 on/off。
 *  - per-device 闸（local）：runtime 的 AsyncStorage flag（isAmbientEnabled），
 *    新装 / 换机清零 → 那台显示 off（隐私不变量：本机没显式开过就不采集）。
 *  ambientOn = server 有源开 && 本机 flag 开。
 */
import { useCallback, useEffect, useState } from "react";
import { useUserSettings } from "@pin-ai/state";

import { AMBIENT_SOURCE_KEYS } from "../ambient/keys";
import { isAmbientEnabled, startAmbient, stopAmbient } from "../ambient/runtime";

export interface UseAmbientToggleResult {
  /** 主开关是否打开（server consent 有源开 && 本机 opt-in）。 */
  ambientOn: boolean;
  /** patch + 启停在途；按钮应 disable 自己。 */
  togglePending: boolean;
  /** 翻转主开关：写全部源 consent + 启停 RN 采集 runtime。 */
  toggle: () => Promise<void>;
}

export function useAmbientToggle(userId: string | null): UseAmbientToggleResult {
  const { settings, patch } = useUserSettings();
  // AsyncStorage flag 是异步的（web 用同步 localStorage）；load 一次。
  // null = 还没读到，先按 off 渲染，读到再翻（冷启一帧 off 闪，可接受）。
  const [deviceEnabled, setDeviceEnabled] = useState<boolean | null>(null);
  const [togglePending, setTogglePending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void isAmbientEnabled().then((v) => {
      if (!cancelled) setDeviceEnabled(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const consentOn = settings
    ? Object.values(settings.ambientSources ?? {}).some((c) => c?.enabled === true)
    : null;
  const ambientOn =
    consentOn === null
      ? (deviceEnabled ?? false)
      : consentOn && (deviceEnabled ?? false);

  const toggle = useCallback(async () => {
    if (togglePending || deviceEnabled === null) return;
    const next = !ambientOn;
    setTogglePending(true);
    try {
      const consentPatch = Object.fromEntries(
        AMBIENT_SOURCE_KEYS.map((key) => [key, { enabled: next }]),
      );
      if (!next) {
        // 关：先停采集（runtime 清 AsyncStorage flag），再落 consent。
        await stopAmbient();
        setDeviceEnabled(false);
        await patch({ ambientSources: consentPatch });
        return;
      }
      if (!userId) return; // 没登录拿不到 owner，起不了采集。
      // 开：先落 consent；patch 失败就不启（避免「server off 但本机在采」）。
      const updated = await patch({ ambientSources: consentPatch });
      if (!updated) return;
      const started = await startAmbient(userId); // 设 flag + 启 sources
      if (started.length === 0) {
        // 一个源都没起来（权限全拒）→ 回滚本机闸，别留「开着但没采」。
        await stopAmbient();
        setDeviceEnabled(false);
      } else {
        setDeviceEnabled(true);
      }
    } finally {
      setTogglePending(false);
    }
  }, [ambientOn, deviceEnabled, patch, togglePending, userId]);

  return { ambientOn, togglePending, toggle };
}
