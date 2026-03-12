import type {
  AssistantContainerDestroyRef,
  AssistantContainerGatewayRef,
  AssistantContainerParams,
  AssistantContainerRuntimeRef,
  ContainerRef,
  ContainerRuntime,
  GatewayTarget,
} from "./contracts.js";
import type {
  ContainerNotifier,
  ContainerStateStore,
  ReadAssistantLiteLLMVirtualKey,
  ContainerManagerConfig,
} from "./types.js";
import { containerNameForAssistant } from "./naming.js";
import { resolveAssistantLiteLLMApiKey as resolveAssistantLiteLLMApiKeyShared } from "./providers/shared/assistant_litellm_key.js";
import {
  readSkillsConfigFromRuntimeMetadata,
  toOpenclawSkillsPayload,
} from "../skills/openclaw_skills.js";
import { resolveExternalProfileForTelegramUser } from "../onboarding/profile_bootstrap.js";
import { GOOGLE_CREDENTIALS_RUNTIME_METADATA_KEY } from "./providers/shared/google_workspace_credentials.js";

const resolveTelegramWebhookPort = (): number =>
  Number(process.env.OPENCLAW_TELEGRAM_WEBHOOK_PORT || "8787");

const resolveTelegramWebhookPath = (): string => {
  const raw = (process.env.OPENCLAW_TELEGRAM_WEBHOOK_PATH || "/telegram-webhook").trim();
  if (!raw) return "/telegram-webhook";
  return raw.startsWith("/") ? raw : `/${raw}`;
};

// ---------------------------------------------------------------------------
// ContainerOrchestrator — owns all business logic, side effects, and state
// ---------------------------------------------------------------------------

export class ContainerOrchestrator {
  private readonly ensureInFlight = new Map<
    number,
    Promise<{ containerId: string; ready: boolean }>
  >();

  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly store: ContainerStateStore,
    private readonly notifier: ContainerNotifier,
    private readonly config: ContainerManagerConfig,
    private readonly readAssistantLiteLLMVirtualKey: ReadAssistantLiteLLMVirtualKey,
  ) {}

  // -----------------------------------------------------------------------
  // Public: prepareRuntime
  // -----------------------------------------------------------------------

  async prepareRuntime(): Promise<void> {
    await this.runtime.prepare();
  }

  // -----------------------------------------------------------------------
  // Public: ensureAssistantContainer (with in-flight deduplication)
  // -----------------------------------------------------------------------

  async ensureAssistantContainer(
    assistant: AssistantContainerRuntimeRef,
    gatewayToken: string,
  ): Promise<{ containerId: string; ready: boolean }> {
    const key = assistant.id;
    const existing = this.ensureInFlight.get(key);
    if (existing) return existing;

    const job = this.runEnsureAssistantContainer(
      assistant,
      gatewayToken,
    ).finally(() => {
      if (this.ensureInFlight.get(key) === job) {
        this.ensureInFlight.delete(key);
      }
    });

    this.ensureInFlight.set(key, job);
    return job;
  }

  // -----------------------------------------------------------------------
  // Public: destroyAssistantContainer
  // -----------------------------------------------------------------------

  async destroyAssistantContainer(
    assistant: AssistantContainerDestroyRef,
  ): Promise<{ deleted: boolean }> {
    const botIdForContainer = assistant.assistant_bot_id ?? assistant.id;
    const fallbackName =
      assistant.container_name?.trim() ||
      containerNameForAssistant(botIdForContainer);
    const fallbackNames = [
      fallbackName,
      containerNameForAssistant(botIdForContainer),
    ];

    const container = await this.runtime.findContainer(
      assistant.container_id,
      fallbackNames,
    );

    if (!container) {
      await this.store.updateAssistant(assistant.id, {
        container_status: "missing",
        container_id: "",
        container_name: fallbackName,
      });
      return { deleted: false };
    }

    await this.runtime.destroyContainer(container.id);

    await this.store.updateAssistant(assistant.id, {
      container_status: "missing",
      container_id: "",
      container_name: fallbackName,
    });

    return { deleted: true };
  }

  // -----------------------------------------------------------------------
  // Public: stopAssistantContainer
  // -----------------------------------------------------------------------

  async stopAssistantContainer(
    assistant: AssistantContainerDestroyRef,
  ): Promise<{ stopped: boolean }> {
    const botIdForContainer = assistant.assistant_bot_id ?? assistant.id;
    const fallbackName =
      assistant.container_name?.trim() ||
      containerNameForAssistant(botIdForContainer);
    const fallbackNames = [
      fallbackName,
      containerNameForAssistant(botIdForContainer),
    ];

    const container = await this.runtime.findContainer(
      assistant.container_id,
      fallbackNames,
    );

    if (!container) {
      await this.store.updateAssistant(assistant.id, {
        container_status: "missing",
        container_id: "",
        container_name: fallbackName,
      });
      return { stopped: false };
    }

    if (container.state === "stopped") {
      await this.store.updateAssistant(assistant.id, {
        container_status: "stopped",
      });
      return { stopped: false };
    }

    await this.runtime.stopContainer(container.id);

    await this.store.updateAssistant(assistant.id, {
      container_status: "stopped",
      container_name: fallbackName,
    });
    return { stopped: true };
  }

  // -----------------------------------------------------------------------
  // Public: resolveGatewayTargetForAssistant
  // -----------------------------------------------------------------------

  resolveGatewayTargetForAssistant(
    assistant: AssistantContainerGatewayRef,
  ): GatewayTarget {
    // Build a minimal ContainerRef from the assistant record
    const ref: ContainerRef = {
      id: assistant.container_id,
      name: "",
      state: "running",
      metadata: {
        hostPort: String(assistant.container_port || ""),
      },
    };

    // For Fly, the metadata needs machineId/privateIp which are encoded in container_id
    // The runtime's resolveGatewayTarget handles parsing this
    return this.runtime.resolveGatewayTarget(ref);
  }

  // -----------------------------------------------------------------------
  // Public: syncContainerStates
  // -----------------------------------------------------------------------

  async syncContainerStates(
    listAssistants: (
      offset: number,
      limit: number,
    ) => Promise<
      Array<{
        id: number;
        assistant_bot_id: number;
        container_status: string;
        container_id: string;
        owner_telegram_user_id: string | null;
      }>
    >,
  ): Promise<{ synced: number; errors: number }> {
    const containers = await this.runtime.listContainers();

    // Build lookup maps for O(1) matching.
    // Use both full ref ID and container name as keys — the DB may store
    // a ref that includes a stale private IP (e.g. "fly:machineId|oldIp")
    // while the runtime returns "fly:machineId|newIp". Name-based lookup
    // is stable and handles this drift.
    const byId = new Map<string, ContainerRef>();
    const byName = new Map<string, ContainerRef>();
    for (const container of containers) {
      byId.set(container.id, container);
      if (container.name) byName.set(container.name, container);
    }

    let synced = 0;
    let errors = 0;
    const BATCH_SIZE = 500;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const batch = await listAssistants(offset, BATCH_SIZE);
      if (batch.length === 0) break;

      for (const assistant of batch) {
        try {
          const containerId = assistant.container_id?.trim();
          if (!containerId) continue;

          // Look up by full ref first, then fall back to name
          const container =
            byId.get(containerId) ?? byName.get(containerNameForAssistant(assistant.assistant_bot_id));
          let expectedStatus: string;

          if (!container) {
            expectedStatus = "missing";
          } else {
            expectedStatus = container.state;
          }

          if (assistant.container_status !== expectedStatus) {
            // When transitioning to running, do a quick probe first
            if (
              expectedStatus === "running" &&
              assistant.container_status !== "running" &&
              container
            ) {
              const webhookPort = resolveTelegramWebhookPort();
              const webhookPath = resolveTelegramWebhookPath();
              const ready = await this.runtime.probeReady(container, {
                timeoutMs: 3000,
                gatewayPort: this.config.openclaw.gatewayPort,
                additionalPorts: [webhookPort],
                httpProbes: [{ port: webhookPort, path: webhookPath }],
              });
              if (!ready) continue; // Skip this cycle
            }

            await this.store.updateAssistant(assistant.id, {
              container_status: expectedStatus,
            });
            synced++;
            console.log(
              `[container] Synced state for assistant ${assistant.id}: ${assistant.container_status} → ${expectedStatus}`,
            );

            // Notify user if container became running
            if (
              expectedStatus === "running" &&
              assistant.container_status !== "running" &&
              assistant.owner_telegram_user_id
            ) {
              this.notifier
                .notifyReady(Number(assistant.owner_telegram_user_id), {
                  assistantId: assistant.id,
                })
                .catch((e) =>
                  console.warn(
                    `[container] notify failed for assistant ${assistant.id}`,
                    e,
                  ),
                );
            }
          }
        } catch (err) {
          errors++;
          console.error(
            `[container] Failed to sync state for assistant ${assistant.id}`,
            err,
          );
        }
      }

      offset += batch.length;
      if (batch.length < BATCH_SIZE) hasMore = false;
    }

    return { synced, errors };
  }

  // -----------------------------------------------------------------------
  // Private: the core ensure lifecycle
  // -----------------------------------------------------------------------

  private async runEnsureAssistantContainer(
    assistant: AssistantContainerRuntimeRef,
    gatewayToken: string,
  ): Promise<{ containerId: string; ready: boolean }> {
    const normalizedGatewayToken = gatewayToken.trim();
    if (!normalizedGatewayToken) {
      throw new Error(
        `Assistant ${assistant.assistant_bot_id} missing gateway_token.`,
      );
    }

    const params = await this.buildParams(assistant, normalizedGatewayToken);
    const fallbackNames = this.buildFallbackNames(assistant);

    // 1. Find existing container
    let container = await this.runtime.findContainer(
      assistant.container_id,
      fallbackNames,
    );

    // 2. Check drift → recreate if needed
    if (container && (await this.runtime.needsRecreation(container, params))) {
      await this.runtime.destroyContainer(container.id);
      container = null;
      await this.store.updateAssistant(assistant.id, {
        container_status: "creating",
        container_id: "",
        container_name: params.containerName,
      });
    }

    // 3. Create if missing
    if (!container || container.state === "missing") {
      container = await this.runtime.createContainer(params);
    }

    // 4. Start if not running
    if (container.state !== "running") {
      container = await this.runtime.startContainer(container.id);
    }

    // 5. Decide whether to probe
    const shouldProbe =
      container.state === "running" &&
      (this.config.fly?.gatewayProbe ?? true);

    // 6. Persist container ref + optimistic status
    await this.store.updateAssistant(assistant.id, {
      container_id: container.id,
      container_name: container.name || params.containerName,
      container_status: shouldProbe
        ? "creating" // will be updated to "running" after probe succeeds
        : container.state === "running"
          ? "running"
          : container.state,
    });

    // 7. Background probe → update DB + notify (only when probe is enabled)
    if (shouldProbe) {
      void this.probeAndNotify(assistant, container, normalizedGatewayToken);
    }

    return { containerId: container.id, ready: !shouldProbe && container.state === "running" };
  }

  // -----------------------------------------------------------------------
  // Private: background probe + notification
  // -----------------------------------------------------------------------

  private async probeAndNotify(
    assistant: AssistantContainerRuntimeRef,
    container: ContainerRef,
    gatewayToken: string,
  ): Promise<void> {
    try {
      const webhookPort = resolveTelegramWebhookPort();
      const webhookPath = resolveTelegramWebhookPath();
      const probeTimeoutMs = Math.max(
        this.config.fly?.gatewayProbeTimeoutMs ?? 120_000,
        600_000,
      );

      let earlyMarked = false;

      const ready = await this.runtime.probeReady(container, {
        timeoutMs: probeTimeoutMs,
        gatewayToken,
        gatewayPort: this.config.openclaw.gatewayPort,
        additionalPorts: [webhookPort],
        httpProbes: [
          { port: webhookPort, path: webhookPath },
        ],
        onGatewayReady: () => {
          // Mark running as soon as gateway hello succeeds — don't wait for
          // supplementary port/HTTP probes which can add 10-20s of delay.
          earlyMarked = true;
          console.log(
            `[orchestrator] Gateway ready for assistant ${assistant.id}, marking running early`,
          );
          void this.store.updateAssistant(assistant.id, {
            container_status: "running",
          });
          if (assistant.owner_telegram_user_id) {
            void this.notifier
              .notifyReady(Number(assistant.owner_telegram_user_id), {
                assistantId: assistant.id,
              })
              .catch((e) =>
                console.warn(
                  `[orchestrator] notify failed for assistant ${assistant.id}`,
                  e,
                ),
              );
          }
        },
      });

      // If onGatewayReady never fired (e.g. no gatewayToken), fall back to
      // the final probe result.
      if (!earlyMarked) {
        await this.store.updateAssistant(assistant.id, {
          container_status: ready ? "running" : "error",
        });
        if (ready && assistant.owner_telegram_user_id) {
          console.log(
            `[orchestrator] Fully ready for assistant ${assistant.id}, notifying user ${assistant.owner_telegram_user_id}`,
          );
          await this.notifier
            .notifyReady(Number(assistant.owner_telegram_user_id), {
              assistantId: assistant.id,
            })
            .catch((e) =>
              console.warn(
                `[orchestrator] notify failed for assistant ${assistant.id}`,
                e,
              ),
            );
        }
      }
    } catch (err) {
      console.error(
        `[orchestrator] Async probe failed for assistant ${assistant.id}`,
        err,
      );
      await this.store.updateAssistant(assistant.id, {
        container_status: "error",
      });
    }
  }

  // -----------------------------------------------------------------------
  // Private: helpers
  // -----------------------------------------------------------------------

  private async buildParams(
    assistant: AssistantContainerRuntimeRef,
    gatewayToken: string,
  ): Promise<AssistantContainerParams> {
    const botIdForContainer = assistant.assistant_bot_id ?? assistant.id;
    const containerName =
      assistant.container_name?.trim() ||
      containerNameForAssistant(botIdForContainer);

    const liteLlmApiKey = resolveAssistantLiteLLMApiKeyShared(
      assistant,
      this.config.litellm.enabled,
      this.readAssistantLiteLLMVirtualKey,
    );

    const runtimeMetadata = await this.store.readAssistantRuntimeMetadata(
      assistant.id,
    );
    const googleCredentialsB64 = readGoogleCredentialsB64FromRuntimeMetadata(
      runtimeMetadata,
    );
    const skillsConfig = toOpenclawSkillsPayload(
      readSkillsConfigFromRuntimeMetadata(runtimeMetadata),
    );
    const legacyProfile = await resolveExternalProfileForTelegramUser(
      assistant.owner_telegram_user_id,
    );

    return {
      assistantBotId: botIdForContainer,
      assistantId: assistant.id,
      ownerTelegramUserId:
        assistant.owner_telegram_user_id != null
          ? String(assistant.owner_telegram_user_id)
          : null,
      containerName,
      gatewayToken,
      assistantBotToken: assistant.assistant_bot_token ?? null,
      liteLlmApiKey,
      onboardingProfileText: legacyProfile?.profileText || null,
      onboardingProfileSource: legacyProfile?.source || null,
      ...(googleCredentialsB64 ? { googleCredentialsB64 } : {}),
      ...(skillsConfig ? { skillsConfig } : {}),
      containerPort: assistant.container_port,
    };
  }

  private buildFallbackNames(
    assistant: AssistantContainerRuntimeRef | AssistantContainerDestroyRef,
  ): string[] {
    const botIdForContainer =
      assistant.assistant_bot_id ?? (assistant as { id: number }).id;
    return Array.from(
      new Set(
        [
          assistant.container_name?.trim(),
          containerNameForAssistant(botIdForContainer),
        ].filter((v): v is string => Boolean(v)),
      ),
    );
  }
}

const readGoogleCredentialsB64FromRuntimeMetadata = (
  metadata: Record<string, unknown> | null | undefined,
): string | null => {
  const raw = metadata?.[GOOGLE_CREDENTIALS_RUNTIME_METADATA_KEY];
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  return normalized || null;
};
