/**
 * 壳级副作用宿主——null 渲染（WS1）。把「订阅了会触发重渲、但 AppShell 的渲染输出
 * 并不依赖」的 hook/effect 从 AppShell 抽到这里：
 *   - usePipeline（内部 useActiveAgentRuns：in-flight 4s / idle 30s 轮询 agent runs）
 *   - useAmbientToggle / useAmbientConsentReconcile（都订阅 useUserSettings）
 *   - 三个只用 queryClient 的 effect：Siri shortcut 绑定 / run 完成刷卡 / 登录后空闲预取
 *
 * 抽出前：每个轮询 tick、每次 settings 写入都重渲 AppShell → 连带把所有常驻 keep-alive
 * 屏 + 聊天栈重渲一遍（P5 级联）。抽出后：这些订阅只重渲本组件（return null，无 UI 代价），
 * AppShell 不再随后台轮询空转，切页/点击不再和轮询抢同一根 JS 线程。
 *
 * AppShell 只把 userId 传进来；行为与抽出前逐字一致（代码原样搬迁，非重写）。
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchPortrait, listUserDevices } from "@pin-ai/core";
import { cardsKeys, portraitKeys, userDevicesKeys, usePipeline } from "@pin-ai/state";

import { useAmbientConsentReconcile } from "../../hooks/useAmbientConsentReconcile";
import { useAmbientToggle } from "../../hooks/useAmbientToggle";
import { bindSystemShortcutActions } from "../../lib/system-shortcuts";

export default function ShellEffects({ userId }: { userId: string }) {
  const queryClient = useQueryClient();

  // consent → 采集源实时调和：server ambientSources 变化时把在采源集合调和到 consent 真集。
  useAmbientConsentReconcile(userId);

  // Siri Shortcuts 深链（ref 间接层）：绑定只挂一次（冷启 URL 重放 + 前台监听），
  // 动作经 ref 永远打到最新 toggle/pipeline。useAmbientToggle 是纯编排 hook
  // （态在共享 TQ cache + runtime store），本组件再实例化与 NOW/Ambient 的开关同步，安全。
  const { toggle } = useAmbientToggle(userId);
  const pipeline = usePipeline();
  const shortcutRef = useRef({ onToggleAmbient: () => {}, onGenerateCards: () => {} });
  useEffect(
    () =>
      bindSystemShortcutActions({
        onToggleAmbient: () => shortcutRef.current.onToggleAmbient(),
        onGenerateCards: () => shortcutRef.current.onGenerateCards(),
      }),
    [],
  );
  useEffect(() => {
    shortcutRef.current = {
      onToggleAmbient: () => {
        void toggle();
      },
      onGenerateCards: () => {
        pipeline.generate();
      },
    };
  }, [toggle, pipeline.generate]);

  // 生成完成 → 立即刷卡（generate 跑完球面不再等 30s 轮询）。runId 去重防 run state
  // 重渲重复触发。
  const lastCompleteRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (pipeline.run.status !== "complete" || !pipeline.run.runId) return;
    if (pipeline.run.runId === lastCompleteRunIdRef.current) return;
    lastCompleteRunIdRef.current = pipeline.run.runId;
    void queryClient.invalidateQueries({ queryKey: cardsKeys.all });
  }, [pipeline.run.runId, pipeline.run.status, queryClient]);

  // 登录后空闲预取：把用户迟早会进的页面数据先填进 TQ 缓存（SWR——进页秒出缓存、后台
  // 再刷新）。cards/settings/composio 已由常驻消费者天然暖着，无需重复。延迟 1.2s 避开
  // 首屏渲染与 NOW 首拉的窗口。
  useEffect(() => {
    const timer = setTimeout(() => {
      // Lifelong-memory：老 profile snapshot / memories 预取退役，PROFILE 屏
      // 数据 = L2 portrait（usePortrait 同 key，SWR 秒出）。events 由 NOW/
      // Ambient 常驻消费者天然暖着，不重复预取。
      void queryClient.prefetchQuery({
        queryKey: portraitKeys.slots(),
        queryFn: ({ signal }) => fetchPortrait(signal),
      });
      void queryClient.prefetchQuery({
        queryKey: userDevicesKeys.all,
        queryFn: () => listUserDevices(),
      });
    }, 1_200);
    return () => clearTimeout(timer);
  }, [queryClient]);

  return null;
}
