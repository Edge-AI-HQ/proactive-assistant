import { Command } from "commander";
import { CommanderError } from "commander";
import { homedir } from "node:os";

import { registerFeedbackCommands } from "./domains/feedback/register.js";
import { registerIngestCommands } from "./domains/ingest/register.js";
import { registerProfileCommands } from "./domains/profile/register.js";
import { registerPersonalCommands } from "./domains/personal/register.js";
import { registerPushCommands } from "./domains/push/register.js";
import { registerSysCommands } from "./domains/sys/register.js";
import { registerWorldCommands } from "./domains/world/register.js";
import { registerContextCommands } from "./domains/context/register.js";
import { registerLoopCommands } from "./domains/loop/register.js";
import { errorEnvelope } from "./output/envelope.js";
import { ErrorType } from "./output/errors.js";
import type { CliRuntimeInput, ResultRef, RunCliResult } from "./runtime.js";
import {
  appendCliTraceEvent,
  appendRunTraceEvent,
  redactCliArgv,
} from "../engine/pipeline/trace.js";

const createProgram = (runtime: CliRuntimeInput, resultRef: ResultRef): Command => {
  const program = new Command();
  program.name("pin").exitOverride();
  program.option("--format <fmt>", "output format: json | table | ndjson | pretty", "json");
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

  registerSysCommands(program, runtime, resultRef);
  registerProfileCommands(program, runtime, resultRef);
  registerWorldCommands(program, runtime, resultRef);
  registerIngestCommands(program, runtime, resultRef);
  registerContextCommands(program, runtime, resultRef);
  registerLoopCommands(program, runtime, resultRef);
  registerFeedbackCommands(program, runtime, resultRef);
  registerPushCommands(program, runtime, resultRef);
  registerPersonalCommands(program, runtime, resultRef);

  // Commander does not propagate exitOverride/configureOutput to subcommands.
  // Without this, bad args on nested commands (e.g. `personal exec` without --tool)
  // call process.exit(1), killing the host process when run in-process.
  const silentOutput = { writeOut: () => {}, writeErr: () => {} };
  const propagate = (cmd: Command) => {
    for (const sub of cmd.commands) {
      sub.exitOverride();
      sub.configureOutput(silentOutput);
      propagate(sub);
    }
  };
  propagate(program);

  return program;
};

export async function runCli(
  argv: string[],
  runtimeOverride?: Partial<CliRuntimeInput>,
): Promise<RunCliResult> {
  const resultRef: ResultRef = { current: null };
  const runtime: CliRuntimeInput = {
    env: { ...process.env, ...runtimeOverride?.env },
    homeDir: runtimeOverride?.homeDir || homedir(),
  };
  const program = createProgram(runtime, resultRef);
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const invocationId = `cli_${Math.random().toString(36).slice(2, 10)}`;
  const traceContext = runtime.env.PIN_TRACE_CONTEXT || null;
  const traceRunId = runtime.env.PIN_TRACE_RUN_ID || null;
  const tracedArgs = redactCliArgv(argv);

  await recordCliTrace("pin_cli.invoke", {
    invocationId,
    traceContext,
    runId: traceRunId,
    startedAt: startedAtIso,
    domain: tracedArgs.domain,
    command: tracedArgs.command,
    argvRedacted: tracedArgs.argvRedacted,
  });

  try {
    await program.parseAsync(["node", "pin", ...argv]);
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }

    const failure = {
      exitCode: 2,
      stdout: errorEnvelope(
        "cli",
        argv.join(" "),
        ErrorType.VALIDATION,
        "INVALID_ARGUMENT",
        "Unknown command",
        "run `pin --help` to see available commands",
      ),
    };
    await recordCliResult(failure);
    return failure;
  }

  if (resultRef.current) {
    await recordCliResult(resultRef.current);
    return resultRef.current;
  }

  const failure = {
    exitCode: 2,
    stdout: errorEnvelope(
      "cli",
      argv.join(" "),
      ErrorType.VALIDATION,
      "INVALID_ARGUMENT",
      "Unknown command",
      "run `pin --help` to see available commands",
    ),
  };
  await recordCliResult(failure);
  return failure;

  async function recordCliTrace(kind: string, attrs: Record<string, unknown>): Promise<void> {
    const timestamp = new Date().toISOString();
    const payload = {
      timestamp,
      kind,
      ...attrs,
    };

    await appendCliTraceEvent(runtime, payload).catch(() => {});
    if (traceRunId) {
      await appendRunTraceEvent(runtime, traceRunId, {
        timestamp,
        phase: traceContext?.split(":")[0] ?? "pin-cli",
        kind,
        name: traceContext ?? tracedArgs.command,
        attrs,
      }).catch(() => {});
    }
  }

  async function recordCliResult(result: RunCliResult): Promise<void> {
    await recordCliTrace("pin_cli.result", {
      invocationId,
      traceContext,
      runId: traceRunId,
      startedAt: startedAtIso,
      durationMs: Date.now() - startedAt,
      domain: result.stdout.meta.domain,
      command: result.stdout.meta.command,
      argvRedacted: tracedArgs.argvRedacted,
      exitCode: result.exitCode,
      ok: result.stdout.ok,
      requestId: result.stdout.meta.requestId,
      timestamp: result.stdout.meta.timestamp,
      errorCode: result.stdout.error?.code ?? null,
    });
  }
}
