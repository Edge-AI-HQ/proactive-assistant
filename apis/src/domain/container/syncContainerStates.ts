import { config } from "../common/config.js";
import { updateAssistant } from "../common/db/index.js";
import { pool } from "../common/db/core.js";
import { listMachines } from "./providers/fly/fly_client.js";
import type { AssistantRecord } from "../../types/index.js";

const SYNC_BATCH_SIZE = 500; // 每批处理 500 个，避免内存占用过大
const SYNC_LOCK_KEY = 319_902; // Advisory lock key for container state sync

/**
 * 分批查询 assistants（避免一次加载过多）
 */
async function listAssistantsWithLimit(
  offset: number,
  limit: number,
): Promise<
  Array<{
    id: number;
    assistant_bot_id: number;
    container_status: string;
    container_id: string;
  }>
> {
  const result = await pool.query<{
    id: number;
    assistant_bot_id: number;
    container_status: string;
    container_id: string;
  }>(
    `
      SELECT 
        assistants.id,
        assistants.assistant_bot_id,
        COALESCE(runtime_instances.status, 'creating') as container_status,
        COALESCE(runtime_instances.runtime_ref, '') as container_id
      FROM assistants
      LEFT JOIN runtime_instances ON runtime_instances.assistant_id = assistants.id
      ORDER BY assistants.id ASC
      LIMIT $1 OFFSET $2
    `,
    [limit, offset],
  );
  return result.rows;
}

/**
 * 定期从 Fly API 同步容器状态，确保 DB 与实际状态一致
 *
 * 用途：
 * 1. 修复异步探测失败导致的状态不一致
 * 2. 检测外部停止/销毁的容器
 * 3. 进程重启后恢复状态
 *
 * 集群部署支持：
 * - 使用 PostgreSQL advisory lock 防止多实例重复执行
 * - 非阻塞锁（pg_try_advisory_lock），其他实例直接跳过
 * - 锁在函数结束时自动释放
 *
 * 性能优化：
 * - 分批查询 assistants（每批 500 个）
 * - 一次获取所有 machines（Fly API 限制）
 * - Map 查找 O(1)，支持 100 万+容器
 * - 峰值内存 < 100MB
 */
export async function syncFlyContainerStates(): Promise<{
  synced: number;
  errors: number;
}> {
  if (config.container.runtime !== "fly") {
    return { synced: 0, errors: 0 };
  }

  // 分布式锁：防止多个实例同时执行（集群部署场景）
  const client = await pool.connect();
  try {
    const lockResult = await client.query<{ got_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1) as got_lock",
      [SYNC_LOCK_KEY],
    );

    if (!lockResult.rows[0]?.got_lock) {
      console.log(
        "[container] State sync already running in another instance, skipping",
      );
      return { synced: 0, errors: 0 };
    }

    // 获取锁成功，执行同步
    try {
      return await performStateSync();
    } finally {
      // 释放锁
      await client.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/**
 * 执行实际的状态同步（已持有分布式锁）
 */
async function performStateSync(): Promise<{
  synced: number;
  errors: number;
}> {
  try {
    // Fly API 一次返回所有 machines（无法分页，但返回的是精简数据）
    const machines = await listMachines();

    // 构建 machine_id -> state 的 Map（O(1) 查找）
    const machineStateMap = new Map<string, string>();
    for (const machine of machines) {
      if (machine.id) {
        machineStateMap.set(machine.id, (machine.state || "").toLowerCase());
      }
    }

    let synced = 0;
    let errors = 0;

    // 分批处理 assistants（避免一次加载过多导致内存问题）
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      // 查询一批 assistants
      const assistantsBatch = await listAssistantsWithLimit(
        offset,
        SYNC_BATCH_SIZE,
      );

      if (assistantsBatch.length === 0) {
        hasMore = false;
        break;
      }

      for (const assistant of assistantsBatch) {
        try {
          const containerId = assistant.container_id?.trim();
          if (!containerId) continue;

          // 从 container_id 解析 machine_id（格式：fly:machine_id 或 fly:machine_id|ip）
          if (!containerId.startsWith("fly:")) continue;

          const machineId = containerId.replace(/^fly:/, "").split("|")[0];
          if (!machineId) continue;

          // 从 Map 中查找状态（不调用 API）
          const machineState = machineStateMap.get(machineId);
          let expectedStatus: string;

          if (!machineState) {
            // Machine 不在 Fly 上，可能被删除
            expectedStatus = "missing";
          } else if (machineState === "started" || machineState === "running") {
            expectedStatus = "running";
          } else if (machineState === "stopped") {
            expectedStatus = "stopped";
          } else if (machineState === "destroyed") {
            expectedStatus = "missing";
          } else {
            expectedStatus = "creating";
          }

          // 如果状态不一致，更新
          if (assistant.container_status !== expectedStatus) {
            await updateAssistant(assistant.id, {
              container_status: expectedStatus,
            });
            synced++;
            console.log(
              `[container] Synced state for assistant ${assistant.id}: ${assistant.container_status} → ${expectedStatus}`,
            );
          }
        } catch (err) {
          errors++;
          console.error(
            `[container] Failed to sync state for assistant ${assistant.id}`,
            err,
          );
        }
      }

      offset += assistantsBatch.length;

      // 如果返回数量少于批次大小，说明没有更多了
      if (assistantsBatch.length < SYNC_BATCH_SIZE) {
        hasMore = false;
      }
    }

    return { synced, errors };
  } catch (err) {
    console.error("[container] syncFlyContainerStates failed", err);
    return { synced: 0, errors: 1 };
  }
}

/**
 * Docker 容器状态同步（暂不实现，Docker 本地开发用，状态一般一致）
 */
export async function syncDockerContainerStates(): Promise<{
  synced: number;
  errors: number;
}> {
  // TODO: 如果需要，可以通过 docker ps 同步状态
  return { synced: 0, errors: 0 };
}

/**
 * 统一的容器状态同步入口
 */
export async function syncContainerStates(): Promise<void> {
  const result =
    config.container.runtime === "fly"
      ? await syncFlyContainerStates()
      : await syncDockerContainerStates();

  if (result.synced > 0 || result.errors > 0) {
    console.log("[container] State sync completed", result);
  }
}
