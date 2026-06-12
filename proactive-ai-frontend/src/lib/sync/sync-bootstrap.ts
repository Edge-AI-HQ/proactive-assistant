/**
 * 同步引擎启动与调度（Sync-B2 影子 → B3 门铃 → C outbox/搜索）。
 *
 * - startShadowSync(userId)：native / Electron + 登录后由 App 调（driver
 *   按平台注入：Capacitor 插件 vs node:sqlite over IPC）。**per-user 本地库**
 *   `pinai_sync_<uid>`（业界 per-account database 惯例）——换账号登录时数据/
 *   游标/outbox 天然隔离：FTS 搜不到别人的消息、threads 游标不串、A 积压的
 *   outbox 绝不会用 B 的 JWT 投递。进程内不换号（signOut 走 full reload），
 *   uid 变化只 warn。
 * - **全局串行队列 serialize()**：兑现 capacitor driver 的「连接无并发写者」
 *   契约——pass / 门铃 / drain 的每个引擎操作排队执行。单连接显式 BEGIN 下
 *   并发事务会嵌套交错；drain 的 DELETE 混进别人事务再随 ROLLBACK 复活，
 *   等于重复投递 feedback。粒度=单个 engine 调用（不是整个 pass），门铃
 *   可以插进 pass 的间隙，实时性不受 bootstrap 长事务拖累。
 * - notifyThreadActivity：门铃——turn finalize（chat:persisted/done）或
 *   thread 打开（访问驱动）时立即增量同步该 thread。**通知拉取分离**：
 *   客户端不把 SSE 帧拼成行。per-thread 去重 + trailing 合并（风暴只多跑
 *   一轮），顺手 drain（门铃响=网络刚证明可用）。
 * - 兜底轮询 30 分钟，pass 顺序 **push-then-pull**（先投递积压写，本轮
 *   拉取就能带回写的效果）。
 *
 * 失败只 log 不上抛——同步链路绝不影响主功能。
 */
import {
  drainOutbox,
  enqueueOutbox,
  readLocalHistoryPage,
  searchLocalCards,
  searchLocalMessages,
  SyncEngine,
  type CardSearchHit,
  type ConversationHistoryPage,
  type DatabasePort,
  type MessageSearchHit,
} from "@pin-ai/core";
import { isElectron, isNative } from "../platform";
import { createCapacitorDatabase } from "./capacitor-database";
import { createElectronDatabase } from "./electron-database";
import { notifyNewCards } from "./desktop-notifications";

const FALLBACK_INTERVAL_MS = 30 * 60 * 1000;

let startedForUser: string | null = null;
let engine: SyncEngine | null = null;
let db: DatabasePort | null = null;
let passRunning = false;

// ── 全局串行队列：所有触碰本地库写路径的操作（sync/drain）依次执行。
let serial: Promise<unknown> = Promise.resolve();

function serialize<T>(op: () => Promise<T>): Promise<T> {
  const next = serial.then(op, op); // 前一个失败不阻断队列
  serial = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function mainThreadIds(database: DatabasePort): Promise<string[]> {
  const rows = await database.query(
    "SELECT thread_id FROM threads WHERE kind = 'main' AND archived = 0",
  );
  return rows.map((r) => String(r.thread_id));
}

// drain 去重闸：pass 与门铃同时触发时只排一次队（重复 drain 是空转）。
let drainQueued = false;

async function drainPending(): Promise<void> {
  if (!db || drainQueued) return;
  drainQueued = true;
  try {
    const database = db;
    const result = await serialize(() => drainOutbox(database));
    if (result.sent || result.failed || result.dropped) {
      console.log("[sync:outbox] drain", result);
    }
  } catch (err) {
    console.warn("[sync:outbox] drain failed (ignored):", err);
  } finally {
    drainQueued = false;
  }
}

async function runFullPass(): Promise<void> {
  if (!engine || !db || passRunning) return;
  passRunning = true;
  const e = engine;
  try {
    // push-then-pull：积压写先投递，下面的拉取带回写的效果（如 dismiss 后
    // 的 card outcome）。
    await drainPending();
    const threads = await serialize(() => e.syncThreads());
    let pulled = 0;
    for (const tid of await mainThreadIds(db)) {
      pulled += (await serialize(() => e.syncMessages(tid))).pulled;
    }
    const cards = await serialize(() => e.syncCards());
    // 桌面端：新卡（相对本地镜像的增量，bootstrap 轮为空）推系统通知。
    // notifyNewCards 自带 isElectron gate，native 上 no-op。
    void notifyNewCards(db, cards.newCardIds);
    console.log(
      "[sync:shadow] pass done",
      JSON.stringify({
        threadsPulled: threads.pulled,
        messagesPulled: pulled,
        cardsPulled: cards.pulled,
        newCards: cards.newCardIds.length,
        stats: await e.stats(),
      }),
    );
  } catch (err) {
    console.warn("[sync:shadow] pass failed (shadow-only, ignored):", err);
  } finally {
    passRunning = false;
  }
}

// 门铃的 per-thread 去重 + trailing 合并：同步中再次按铃只置脏标记，
// 当前轮结束后补跑一轮——风暴（连环 persisted 帧）收敛为最多两轮。
const inflightThreads = new Map<string, { rerun: boolean }>();

async function syncThread(threadId: string): Promise<void> {
  if (!engine) return;
  const e = engine;
  const slot = inflightThreads.get(threadId);
  if (slot) {
    slot.rerun = true;
    return;
  }
  const mySlot = { rerun: false };
  inflightThreads.set(threadId, mySlot);
  try {
    do {
      mySlot.rerun = false;
      const { pulled } = await serialize(() => e.syncMessages(threadId));
      if (pulled > 0) console.log("[sync:doorbell] pulled", { threadId, pulled });
    } while (mySlot.rerun);
  } catch (err) {
    console.warn("[sync:doorbell] failed (ignored):", err);
  } finally {
    inflightThreads.delete(threadId);
  }
}

/**
 * 门铃入口：turn finalize / thread 打开时调用。引擎未启动（web 浏览器
 * 无 driver、未登录、非 native）时 no-op——调用方无需 gate。
 */
export function notifyThreadActivity(threadId: string): void {
  if (!engine || !threadId) return;
  void syncThread(threadId);
  // 门铃响 = 网络刚证明可用——顺手投递积压的离线写。
  void drainPending();
}

/**
 * B3b 读路径：本地同步库的 history page（引擎未启动/空库/读失败返回
 * null——调用方直接走网络，行为不劣于切换前）。
 */
export async function readLocalHistory(
  threadId: string,
  limit = 200,
): Promise<ConversationHistoryPage | null> {
  if (!db || !threadId) return null;
  try {
    return await readLocalHistoryPage(db, threadId, limit);
  } catch (err) {
    console.warn("[sync:local-read] failed (falling back to network):", err);
    return null;
  }
}

/**
 * 离线可靠投递入口（Sync-C）：feedback 这类「失败被静默吞」的 POST，在
 * 网络失败时入队，由 pass/门铃驱动重放。引擎未启动（web/未登录）返回
 * false——调用方维持原有的吞错行为，不劣于切换前。
 */
export async function enqueueFeedback(body: unknown, dedupeKey?: string): Promise<boolean> {
  if (!db) return false;
  const database = db;
  try {
    await serialize(() => enqueueOutbox(database, "/feedback", body, dedupeKey));
    return true;
  } catch (err) {
    console.warn("[sync:outbox] enqueue failed (ignored):", err);
    return false;
  }
}

/**
 * 本地全文搜索（messages + cards FTS）。引擎未启动/失败返回空结果——
 * 搜索 UI 是后续产品迭代，API 先就绪。
 */
export async function searchLocal(
  query: string,
): Promise<{ messages: MessageSearchHit[]; cards: CardSearchHit[] }> {
  if (!db) return { messages: [], cards: [] };
  try {
    const [messages, cards] = await Promise.all([
      searchLocalMessages(db, query),
      searchLocalCards(db, query),
    ]);
    return { messages, cards };
  } catch (err) {
    console.warn("[sync:search] failed (ignored):", err);
    return { messages: [], cards: [] };
  }
}

export function startShadowSync(userId: string): void {
  if ((!isNative && !isElectron) || !userId) return;
  if (startedForUser) {
    if (startedForUser !== userId) {
      // signOut 走 full reload，进程内换号不应发生——真发生宁可不同步，
      // 也不能把 B 的数据写进 A 的库。
      console.warn("[sync] user changed without reload; sync stays on", startedForUser);
    }
    return;
  }
  startedForUser = userId;
  const dbName = `pinai_sync_${userId.replace(/[^A-Za-z0-9]/g, "_")}`;
  db = isNative ? createCapacitorDatabase(dbName) : createElectronDatabase(dbName);
  engine = new SyncEngine({
    db,
    log: (msg, extra) => console.log(`[sync] ${msg}`, JSON.stringify(extra ?? {})),
  });
  void runFullPass();
  setInterval(() => void runFullPass(), FALLBACK_INTERVAL_MS);
}
