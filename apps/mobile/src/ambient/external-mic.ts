/**
 * Ambient 外部麦克风协调（RN）—— web proactive-ai-frontend/src/services/ambient/
 * external-mic.ts 的对应物。voice 录音（声纹 enrollment，未来 chat-voice）经
 * expo-audio 抢占 iOS 共享 AVAudioSession，会掐掉 native ambient 的 AVAudioEngine
 * 且无中断回调，nothing tells ambient to come back。每次录音用 lease 包起来，
 * ambient 在 WebKit/expo-audio 抢会话前干净让出、录完再恢复：
 *
 *   const lease = await acquireExternalMic();
 *   try { ...record... } finally { await lease.release(); }
 *
 * 与 web 同设计：
 * - 引用计数：并发持有者只在「首个 acquire / 末个 release」翻转 native suppression。
 * - 单 promise 链串行：suppress 永远不会晚于配对的 resume 落地（短录音也不漂）。
 * - suppression 保留 ambient 的期望采集/分类状态 → ambient 关时是 no-op；resume
 *   端到端 best-effort：native 侧另有 watchdog，release 丢失（reload 中途 / 掉桥）
 *   也会自动清除 suppression。
 *
 * 走 native AmbientAudio.setExternalMicSuppressed（已从 Capacitor 插件移植，
 * AmbientAudioModule.swift → AudioStreamManager 含 watchdog），不 stop 源（stop
 * 会丢期望状态）。在 App.tsx 经 registerExternalMicAcquirer 注册进 core 端口，
 * 供 core acquireExternalMic 的所有消费者（VoiceIdentitySettings 等）调用。
 */
import type { ExternalMicLease } from "@pin-ai/core";

import { AmbientAudio } from "../../modules/ambient-audio";

const LOG_PREFIX = "[ambient] external-mic";

let holders = 0;
let chain: Promise<void> = Promise.resolve();

/**
 * 把 op 排到已入队的一切之后执行（无论前者成败），保证 suppress/resume 按调用序
 * 应用。错误只记 log 不抛：acquire/release 是 best-effort，一次失败的桥调用不能
 * 卡死链或 reject 调用方（native 未链接时调用会抛，这里吞掉即降级为 no-op）。
 */
function enqueue(op: () => Promise<void>): Promise<void> {
  chain = chain.then(op, op).catch((err) => {
    console.warn(`${LOG_PREFIX} op failed`, err);
  });
  return chain;
}

/**
 * 录音期间让出 native ambient 麦克风，返回 lease；release() 把麦克风还给 ambient。
 */
export async function acquireExternalMic(): Promise<ExternalMicLease> {
  await enqueue(async () => {
    holders += 1;
    if (holders === 1) {
      await AmbientAudio.setExternalMicSuppressed(true);
    }
  });
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await enqueue(async () => {
        holders = Math.max(0, holders - 1);
        if (holders === 0) {
          await AmbientAudio.setExternalMicSuppressed(false);
        }
      });
    },
  };
}
