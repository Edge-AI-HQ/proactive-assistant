import { config } from "../config.js";
import { containerNameForAssistant } from "../../container/naming.js";
import type {
  AssistantMutableFields,
  AssistantRecord,
  CreateAssistantInput,
} from "../../../types.js";
import {
  allocatePortInTransaction,
  assistantFromClause,
  assistantSelectColumns,
  buildAssignments,
  fetchOne,
  nowIso,
  pool,
  readAssistantRuntime,
  withSchema,
} from "./core.js";

const assistantDataColumns = [
  "assistant_bot_id",
  "assistant_bot_token",
  "assistant_bot_username",
  "litellm_user_id",
  "litellm_key_alias",
  "litellm_virtual_key",
  "litellm_key_last4",
  "litellm_spend_usd",
  "litellm_budget_usd",
  "litellm_budget_duration",
  "litellm_rpm_limit",
  "litellm_tpm_limit",
  "litellm_last_synced_at",
] as const;

const assistantRuntimeColumns = [
  "container_name",
  "container_id",
  "container_port",
  "container_status",
] as const;

export const getAssistantById = async (
  id: number,
): Promise<AssistantRecord | undefined> => {
  await withSchema();
  return fetchOne<AssistantRecord>(
    pool,
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      WHERE assistants.id = $1
    `,
    [id],
  );
};

export const getAssistantByBotToken = async (
  assistantBotToken: string,
): Promise<AssistantRecord | undefined> => {
  await withSchema();
  return fetchOne<AssistantRecord>(
    pool,
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      WHERE assistants.assistant_bot_token = $1
    `,
    [assistantBotToken],
  );
};

export const getAssistantByBotId = async (
  assistantBotId: number,
): Promise<AssistantRecord | undefined> => {
  await withSchema();
  return fetchOne<AssistantRecord>(
    pool,
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      WHERE assistants.assistant_bot_id = $1
    `,
    [assistantBotId],
  );
};

export const listAssistantsByOwnerTelegramId = async (
  ownerTelegramUserId: number,
): Promise<AssistantRecord[]> => {
  await withSchema();
  const result = await pool.query<AssistantRecord>(
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      WHERE owners.telegram_user_id = $1
      ORDER BY assistants.created_at DESC, assistants.id DESC
    `,
    [ownerTelegramUserId],
  );
  return result.rows;
};

export const listAssistants = async (): Promise<AssistantRecord[]> => {
  await withSchema();
  const result = await pool.query<AssistantRecord>(
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      ORDER BY assistants.created_at DESC, assistants.id DESC
    `,
  );
  return result.rows;
};

export const listAssistantsWithLiteLLMKey = async (): Promise<
  AssistantRecord[]
> => {
  await withSchema();
  const result = await pool.query<AssistantRecord>(
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      WHERE assistants.litellm_virtual_key IS NOT NULL
        AND assistants.litellm_virtual_key != ''
      ORDER BY assistants.updated_at DESC, assistants.id DESC
    `,
  );
  return result.rows;
};

export const createAssistant = async (
  assistant: CreateAssistantInput,
): Promise<AssistantRecord | undefined> => {
  await withSchema();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ownerRow = await fetchOne<{ id: number }>(
      client,
      "SELECT id FROM users WHERE telegram_user_id = $1 FOR UPDATE",
      [assistant.owner_telegram_user_id],
    );
    if (!ownerRow) {
      throw new Error(
        `Cannot create assistant: owner telegram user ${assistant.owner_telegram_user_id} not found`,
      );
    }

    const containerName =
      assistant.container_name?.trim() ||
      (assistant.assistant_bot_id
        ? containerNameForAssistant(assistant.assistant_bot_id)
        : `assistant-${assistant.owner_telegram_user_id}`);
    const runtimeRef = assistant.container_id?.trim() || containerName;
    const requestedPort = Number.isFinite(assistant.container_port ?? NaN)
      ? Math.trunc(assistant.container_port as number)
      : 0;
    const hostPort =
      requestedPort > 0
        ? requestedPort
        : await allocatePortInTransaction(client);

    const assistantInsert = await client.query<{ id: number }>(
      `
        INSERT INTO assistants (
          owner_user_id,
          assistant_bot_id,
          assistant_bot_token,
          assistant_bot_username,
          litellm_user_id,
          litellm_key_alias,
          litellm_virtual_key,
          litellm_key_last4,
          litellm_spend_usd,
          litellm_budget_usd,
          litellm_budget_duration,
          litellm_rpm_limit,
          litellm_tpm_limit,
          litellm_last_synced_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15
        )
        RETURNING id
      `,
      [
        ownerRow.id,
        assistant.assistant_bot_id,
        assistant.assistant_bot_token,
        assistant.assistant_bot_username,
        assistant.litellm_user_id ?? null,
        assistant.litellm_key_alias ?? null,
        assistant.litellm_virtual_key ?? null,
        assistant.litellm_key_last4 ?? null,
        assistant.litellm_spend_usd ?? 0,
        assistant.litellm_budget_usd ?? null,
        assistant.litellm_budget_duration ?? null,
        assistant.litellm_rpm_limit ?? null,
        assistant.litellm_tpm_limit ?? null,
        assistant.litellm_last_synced_at ?? null,
        nowIso(),
      ],
    );

    const assistantId = assistantInsert.rows[0]?.id;
    if (!assistantId) {
      throw new Error("Failed to create assistant record");
    }

    await client.query(
      `
        INSERT INTO runtime_instances (
          owner_user_id,
          assistant_id,
          scope,
          runtime_provider,
          container_name,
          runtime_ref,
          host_port,
          status,
          last_active_at
        ) VALUES (
          $1, $2, 'assistant', $3,
          $4, $5, $6, $7, NOW()
        )
      `,
      [
        ownerRow.id,
        assistantId,
        config.container.runtime,
        containerName,
        runtimeRef,
        hostPort,
        assistant.container_status ?? "creating",
      ],
    );

    await client.query("COMMIT");

    return getAssistantById(assistantId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const updateAssistant = async (
  id: number,
  fields: AssistantMutableFields,
): Promise<AssistantRecord | undefined> => {
  await withSchema();

  const dataAssignments = buildAssignments(fields, assistantDataColumns);
  const runtimeAssignments = buildAssignments(fields, assistantRuntimeColumns);

  if (!dataAssignments.sql && !runtimeAssignments.sql) {
    return getAssistantById(id);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (dataAssignments.sql) {
      const updatedAtIndex = dataAssignments.values.length + 1;
      const idIndex = dataAssignments.values.length + 2;
      await client.query(
        `
          UPDATE assistants
          SET ${dataAssignments.sql}, updated_at = $${updatedAtIndex}
          WHERE id = $${idIndex}
        `,
        [...dataAssignments.values, nowIso(), id],
      );
    }

    if (runtimeAssignments.columns.length) {
      const current = await readAssistantRuntime(client, id);
      if (!current) {
        throw new Error(`Assistant ${id} not found`);
      }

      const nextContainerName =
        (fields.container_name !== undefined
          ? String(fields.container_name || "").trim()
          : current.container_name) ||
        containerNameForAssistant(current.assistant_bot_id);
      const nextRuntimeRef =
        (fields.container_id !== undefined
          ? String(fields.container_id || "").trim()
          : current.runtime_ref) || nextContainerName;
      const nextHostPort =
        fields.container_port !== undefined
          ? Math.trunc(Number(fields.container_port) || 0)
          : current.host_port;
      const nextStatus =
        fields.container_status !== undefined
          ? String(fields.container_status || "").trim() || current.status
          : current.status;

      await client.query(
        `
          INSERT INTO runtime_instances (
            owner_user_id,
            assistant_id,
            scope,
            runtime_provider,
            container_name,
            runtime_ref,
            host_port,
            status,
            updated_at,
            last_active_at
          ) VALUES (
            $1, $2, 'assistant', $3,
            $4, $5, $6, $7, $8::timestamptz, NOW()
          )
          ON CONFLICT (assistant_id)
          WHERE assistant_id IS NOT NULL
          DO UPDATE SET
            container_name = EXCLUDED.container_name,
            runtime_ref = EXCLUDED.runtime_ref,
            host_port = EXCLUDED.host_port,
            status = EXCLUDED.status,
            runtime_provider = EXCLUDED.runtime_provider,
            updated_at = EXCLUDED.updated_at
        `,
        [
          current.owner_user_id,
          id,
          config.container.runtime,
          nextContainerName,
          nextRuntimeRef,
          nextHostPort,
          nextStatus,
          nowIso(),
        ],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getAssistantById(id);
};

export const deleteAssistantById = async (
  id: number,
): Promise<AssistantRecord | undefined> => {
  await withSchema();
  const existing = await getAssistantById(id);
  if (!existing) return undefined;

  await pool.query("DELETE FROM assistants WHERE id = $1", [id]);
  return existing;
};
