/**
 * RN timeline store 单例：core 的 DatabasePort 背书 SqliteTimelineStore +
 * createExpoDatabase（和 ambient/ingest.ts 的 SqliteOutboxStore 同模式）。
 * durable（expo-sqlite），对齐 web 在 native 用 SqliteTimelineStore 的能力，
 * 不用会丢数据的 MemoryTimelineStore。
 */
import { SqliteTimelineStore, type AmbientTimelineStore } from "@pin-ai/core";

import { createExpoDatabase } from "../../lib/sync/expo-database";

const DB_NAME = "ambient_timeline";

let singleton: AmbientTimelineStore | null = null;
let db: ReturnType<typeof createExpoDatabase> | null = null;

export function getAmbientTimelineStore(): AmbientTimelineStore {
  if (!singleton) {
    db = createExpoDatabase(DB_NAME);
    singleton = new SqliteTimelineStore(db);
  }
  return singleton;
}

/**
 * 登出清空本设备 ambient 时间线（跨账号隐私：A 登出、B 登入不得看到 A 的
 * 时间线）。对齐 dev services/ambient/reset-sqlite.ts 的 clearAmbientSqliteData：
 * 删 ambient 时间线库的三张内容表。dev 在 web 靠 window.location.reload 清态、
 * native 本应靠这条 purge；RN 无 reload，由 sign-out.ts 显式调。
 *
 * 用 db（本会话已开的句柄）或直接按库名开一个新句柄——即使本会话没进过
 * Ambient 页（singleton 未建），上个账号遗留在磁盘上的行也要清掉。表未建
 * （该设备从未采集）时 DELETE 抛 no-such-table，吞掉即可。
 */
export async function resetAmbientTimelineStore(): Promise<void> {
  const handle = db ?? createExpoDatabase(DB_NAME);
  try {
    await handle.run("DELETE FROM ambient_timeline_events");
    await handle.run("DELETE FROM ambient_candidate_windows");
    await handle.run("DELETE FROM ambient_raw_events");
  } catch {
    // 表未建（从未采过 ambient）→ 无需清，忽略。
  }
  singleton = null;
  db = null;
}
