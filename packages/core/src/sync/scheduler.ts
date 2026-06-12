/**
 * 同步调度器（平台无关）—— 从 web 端 sync-bootstrap 提纯，三端（Capacitor /
 * Electron / RN）共用；平台壳只负责 driver 注入与生命周期（启动 gate、
 * 兜底 interval）。
 *
 * - **全局串行队列 serialize()**：兑现各 driver 的「连接无并发写者」契约
 *   ——pass / 门铃 / drain 的每个引擎操作排队执行。单连接显式 BEGIN 下
 *   并发事务会嵌套交错；drain 的 DELETE 混进别人事务再随 ROLLBACK 复活，
 *   等于重复投递 feedback。粒度=单个 engine 调用（不是整个 pass），门铃
 *   可以插进 pass 的间隙，实时性不受 bootstrap 长事务拖累。
 * - **门铃 notifyThreadActivity**：turn finalize（chat:persisted/done）或
 *   thread 打开（访问驱动）时立即增量同步该 thread。per-thread 去重 +
 *   trailing 合并（风暴只多跑一轮），顺手 drain（门铃响=网络刚证明可用）。
 * - **pass 顺序 push-then-pull**：先投递积压写，本轮拉取带回写的效果。
 *
 * 失败只 log 不上抛——同步链路绝不影响主功能。
 */
import type { ConversationHistoryPage } from "../api/conversation";
import type { DatabasePort } from "../ports/database";
import { SyncEngine, type SyncLogger } from "./engine";
import { readLocalHistoryPage } from "./local-read";
import { drainOutbox, enqueueOutbox } from "./outbox";
import {
  searchLocalCards,
  searchLocalMessages,
  type CardSearchHit,
  type MessageSearchHit,
} from "./search";

export interface SyncSchedulerOpts {
  db: DatabasePort;
  log?: SyncLogger;
  /** 平台通知钩子：pass 发现新卡（相对本地镜像的增量）时回调——Electron
   *  推系统通知；不传则忽略（iOS 卡片通知走 APNs，不在这条链）。 */
  onNewCards?: (db: DatabasePort, newCardIds: string[]) => void;
}

export interface SyncScheduler {
  /** 全量 pass：drain → threads → main-thread messages → cards。幂等防重入。 */
  runFullPass(): Promise<void>;
  /** 门铃：立即增量同步该 thread（去重 + trailing 合并），顺手 drain。 */
  notifyThreadActivity(threadId: string): void;
  /** 离线可靠投递：失败被静默吞的 POST 入队，pass/门铃驱动重放。 */
  enqueueFeedback(body: unknown, dedupeKey?: string): Promise<boolean>;
  /** 本地 history page（空库/失败返回 null——调用方走网络）。 */
  readLocalHistory(threadId: string, limit?: number): Promise<ConversationHistoryPage | null>;
  /** 本地全文搜索（messages + cards FTS）。 */
  searchLocal(query: string): Promise<{ messages: MessageSearchHit[]; cards: CardSearchHit[] }>;
}

export function createSyncScheduler(opts: SyncSchedulerOpts): SyncScheduler {
  const { db } = opts;
  const log: SyncLogger = opts.log ?? (() => {});
  const engine = new SyncEngine({ db, log });

  // ── 全局串行队列：所有触库写路径的操作（sync/drain/enqueue）依次执行。
  let serial: Promise<unknown> = Promise.resolve();
  function serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = serial.then(op, op); // 前一个失败不阻断队列
    serial = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function mainThreadIds(): Promise<string[]> {
    const rows = await db.query(
      "SELECT thread_id FROM threads WHERE kind = 'main' AND archived = 0",
    );
    return rows.map((r) => String(r.thread_id));
  }

  // drain 去重闸：pass 与门铃同时触发时只排一次队（重复 drain 是空转）。
  let drainQueued = false;
  async function drainPending(): Promise<void> {
    if (drainQueued) return;
    drainQueued = true;
    try {
      const result = await serialize(() => drainOutbox(db));
      if (result.sent || result.failed || result.dropped) {
        log("outbox:drain", { ...result });
      }
    } catch (err) {
      log("outbox:drain failed (ignored)", { error: String(err) });
    } finally {
      drainQueued = false;
    }
  }

  let passRunning = false;
  async function runFullPass(): Promise<void> {
    if (passRunning) return;
    passRunning = true;
    try {
      // push-then-pull：积压写先投递，下面的拉取带回写的效果（如 dismiss
      // 后的 card outcome）。
      await drainPending();
      const threads = await serialize(() => engine.syncThreads());
      let pulled = 0;
      for (const tid of await mainThreadIds()) {
        pulled += (await serialize(() => engine.syncMessages(tid))).pulled;
      }
      const cards = await serialize(() => engine.syncCards());
      if (cards.newCardIds.length > 0) {
        opts.onNewCards?.(db, cards.newCardIds);
      }
      log("pass done", {
        threadsPulled: threads.pulled,
        messagesPulled: pulled,
        cardsPulled: cards.pulled,
        newCards: cards.newCardIds.length,
        stats: await engine.stats(),
      });
    } catch (err) {
      log("pass failed (ignored)", { error: String(err) });
    } finally {
      passRunning = false;
    }
  }

  // 门铃的 per-thread 去重 + trailing 合并：同步中再次按铃只置脏标记，
  // 当前轮结束后补跑一轮——风暴（连环 persisted 帧）收敛为最多两轮。
  const inflightThreads = new Map<string, { rerun: boolean }>();
  async function syncThread(threadId: string): Promise<void> {
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
        const { pulled } = await serialize(() => engine.syncMessages(threadId));
        if (pulled > 0) log("doorbell pulled", { threadId, pulled });
      } while (mySlot.rerun);
    } catch (err) {
      log("doorbell failed (ignored)", { threadId, error: String(err) });
    } finally {
      inflightThreads.delete(threadId);
    }
  }

  return {
    runFullPass,
    notifyThreadActivity(threadId: string): void {
      if (!threadId) return;
      void syncThread(threadId);
      // 门铃响 = 网络刚证明可用——顺手投递积压的离线写。
      void drainPending();
    },
    async enqueueFeedback(body: unknown, dedupeKey?: string): Promise<boolean> {
      try {
        await serialize(() => enqueueOutbox(db, "/feedback", body, dedupeKey));
        return true;
      } catch (err) {
        log("outbox:enqueue failed (ignored)", { error: String(err) });
        return false;
      }
    },
    async readLocalHistory(threadId, limit = 200) {
      if (!threadId) return null;
      try {
        return await readLocalHistoryPage(db, threadId, limit);
      } catch (err) {
        log("local-read failed (falling back to network)", { error: String(err) });
        return null;
      }
    },
    async searchLocal(query) {
      try {
        const [messages, cards] = await Promise.all([
          searchLocalMessages(db, query),
          searchLocalCards(db, query),
        ]);
        return { messages, cards };
      } catch (err) {
        log("search failed (ignored)", { error: String(err) });
        return { messages: [], cards: [] };
      }
    },
  };
}
