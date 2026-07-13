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
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useUserSettings } from "@pin-ai/state";

import { AMBIENT_SOURCE_KEYS } from "../ambient/keys";
import {
  getAmbientEnabledSnapshot,
  isAmbientEnabled,
  setAmbientEnabledFlag,
  setAmbientTranscriptionLanguage,
  startAmbient,
  stopAmbient,
  subscribeAmbientEnabled,
} from "../ambient/runtime";

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
  // 本机 opt-in 闸走 runtime 的共享 store（useSyncExternalStore）——NOW 与 Ambient 两处
  // 开关读同一个值、任一处翻转都同步（web 靠同步 localStorage + fan-out，RN 靠这个镜像）。
  // null = 还没读到 AsyncStorage，先按 off 渲染（冷启一帧 off 闪，可接受）。
  const deviceEnabled = useSyncExternalStore(subscribeAmbientEnabled, getAmbientEnabledSnapshot);
  const [togglePending, setTogglePending] = useState(false);

  // 首次挂载把 AsyncStorage 闸读进共享 store（幂等；多实例同时读也无妨）。
  useEffect(() => {
    void isAmbientEnabled();
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
      // pin_hardware 与手机收录互斥、由 Connect 设备页管理：master 开不带它
      // （patch false 顺带保证互斥），master 关（隐私总开关）连它一起关。
      const consentPatch = Object.fromEntries(
        AMBIENT_SOURCE_KEYS.map((key) => [key, { enabled: key === "pin_hardware" ? false : next }]),
      );
      if (!next) {
        // 关：先乐观清本机闸（UI 立刻 off），再停采集 + 落 consent。
        await setAmbientEnabledFlag(false);
        await stopAmbient();
        await patch({ ambientSources: consentPatch });
        return;
      }
      if (!userId) return; // 没登录拿不到 owner，起不了采集。
      // 开：先乐观置本机闸（UI 立刻 on，不等原生启源——对齐 dev 的 setPersistedAmbientEnabled）。
      // ambientOn = consent && 闸；随后 patch 落 consent（~一次 settings 往返），源在后台启。
      await setAmbientEnabledFlag(true);
      const updated = await patch({ ambientSources: consentPatch });
      if (!updated) {
        // consent 没落 → 回滚本机闸，别留「本机开着但 server off」。
        await setAmbientEnabledFlag(false);
        return;
      }
      // 转写语言 hint（dev useAmbientToggle:96-97：settings.generationLanguage
      // → lifecycle transcriptionLanguage → sound-classifier locale + ?language=）。
      setAmbientTranscriptionLanguage(
        updated.generationLanguage ?? settings?.generationLanguage ?? null,
      );
      const started = await startAmbient(userId); // 启 sources（闸已置）
      if (!started.includes("sound_classifier")) {
        // 核心源 sound_classifier 没起来（权限拒/原生失败）→ 回滚（dev
        // hasMissingCoreSource:99-102,122-130 语义：其余数据源可等 reconciler
        // 重试，核心音频源起不来则整个开关回滚）。stopAmbient 会清本机闸。
        await stopAmbient();
      }
    } finally {
      setTogglePending(false);
    }
  }, [ambientOn, deviceEnabled, patch, settings?.generationLanguage, togglePending, userId]);

  return { ambientOn, togglePending, toggle };
}
