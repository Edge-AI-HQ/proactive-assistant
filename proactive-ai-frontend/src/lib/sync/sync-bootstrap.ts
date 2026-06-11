/**
 * 同步引擎的影子模式启动（Sync-B2）—— 后台把 threads + main thread 的
 * messages 增量进本地 SQLite，**UI 完全不读它**：本阶段只为在真机上验证
 * 引擎正确性（对照 stats 日志与服务端数据），读路径切换是 Sync-B3。
 *
 * Gate：isNative（Capacitor 真机才有 driver）+ 登录后由 App 调
 * startShadowSync()。失败只 log 不上抛——影子链路绝不影响主功能。
 * 节奏：启动跑一次 + 5 分钟一次（影子验证用，非最终产品节奏；B3 接
 * resumable SSE ingest 后这层轮询退役）。
 */
import { SyncEngine, type DatabasePort } from "@pin-ai/core";
import { isNative } from "../platform";
import { createCapacitorDatabase } from "./capacitor-database";

const SHADOW_INTERVAL_MS = 5 * 60 * 1000;

let started = false;
let running = false;

async function mainThreadIds(db: DatabasePort): Promise<string[]> {
  // 本地 threads 表里非 archived 的 main thread（singleton，理论上一行）。
  const rows = await db.query(
    "SELECT thread_id FROM threads WHERE kind = 'main' AND archived = 0",
  );
  return rows.map((r) => String(r.thread_id));
}

async function runOnce(engine: SyncEngine, db: DatabasePort): Promise<void> {
  if (running) return; // 串行：上一轮没跑完不叠加
  running = true;
  try {
    const threads = await engine.syncThreads();
    // Lazy incomplete model：影子期只同步 main thread 的消息（产品的
    // 核心读面）；card threads 在 B3 按「打开过」的访问驱动接入。
    let pulled = 0;
    for (const tid of await mainThreadIds(db)) {
      pulled += (await engine.syncMessages(tid)).pulled;
    }
    console.log("[sync:shadow] pass done", {
      threadsPulled: threads.pulled,
      messagesPulled: pulled,
      stats: await engine.stats(),
    });
  } catch (err) {
    console.warn("[sync:shadow] pass failed (shadow-only, ignored):", err);
  } finally {
    running = false;
  }
}

export function startShadowSync(): void {
  if (started || !isNative) return;
  started = true;
  const db = createCapacitorDatabase();
  const engine = new SyncEngine({
    db,
    log: (msg, extra) => console.log(`[sync] ${msg}`, extra ?? {}),
  });
  void runOnce(engine, db);
  setInterval(() => void runOnce(engine, db), SHADOW_INTERVAL_MS);
}
