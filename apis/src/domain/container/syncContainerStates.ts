import { config } from "../common/config.js";
import { listAssistants, updateAssistant } from "../common/db/index.js";
import { listMachines, getMachine } from "./providers/fly/fly_client.js";
import { isAssistantContainerName } from "./naming.js";

/**
 * 定期从 Fly API 同步容器状态，确保 DB 与实际状态一致
 * 用于：
 * 1. 修复异步探测失败导致的状态不一致
 * 2. 检测外部停止/销毁的容器
 * 3. 进程重启后恢复状态
 */
export async function syncFlyContainerStates(): Promise<{
  synced: number;
  errors: number;
}> {
  if (config.container.runtime !== "fly") {
    return { synced: 0, errors: 0 };
  }

  try {
    const machines = await listMachines();
    const assistants = await listAssistants();

    let synced = 0;
    let errors = 0;

    for (const assistant of assistants) {
      try {
        const containerId = assistant.container_id?.trim();
        if (!containerId) continue;

        // 从 container_id 解析 machine_id（格式：fly:machine_id 或 fly:machine_id|ip）
        if (!containerId.startsWith("fly:")) continue;

        const machineId = containerId.replace(/^fly:/, "").split("|")[0];
        if (!machineId) continue;

        // 查询 machine 实际状态
        let machine;
        try {
          machine = await getMachine(machineId);
        } catch (err) {
          // Machine 不存在，标记为 missing
          if (assistant.container_status !== "missing") {
            await updateAssistant(assistant.id, {
              container_status: "missing",
            });
            synced++;
          }
          continue;
        }

        // 映射 Fly machine state 到 DB status
        const machineState = (machine.state || "").toLowerCase();
        let expectedStatus: string;

        if (machineState === "started" || machineState === "running") {
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
