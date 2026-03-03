#!/usr/bin/env tsx
// 手动创建 assistant 容器的脚本

import "../apis/src/domain/common/config.js";
import { prepareContainerRuntime } from "../apis/src/domain/container/index.js";
import { createAssistantContainerById } from "../apis/src/domain/container/usecases.js";

async function main() {
  const assistantId = Number.parseInt(process.argv[2] || "", 10);

  if (!Number.isFinite(assistantId)) {
    console.error(
      "Usage: tsx scripts/create-assistant-container.ts <assistant_id>",
    );
    process.exit(1);
  }

  console.log(`Creating container for assistant ${assistantId}...`);

  await prepareContainerRuntime();

  try {
    const result = await createAssistantContainerById(assistantId);
    console.log("✅ Container created:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("❌ Failed to create container:", error);
    process.exit(1);
  }
}

main().catch(console.error);
